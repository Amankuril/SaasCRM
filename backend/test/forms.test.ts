import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAiProvider } from '../src/modules/ai/provider.js';
import { Contact } from '../src/modules/contacts/contact.model.js';
import { FlowExecution } from '../src/modules/flows/flow.model.js';
import { FormSubmission } from '../src/modules/forms/form.model.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { FakeAi } from './fakeAi.js';
import { FakeProvider, inboundFormReplyPayload, inboundPayload, sign } from './fakeProvider.js';
import { api, createWorkspace, signup, type TestUser } from './helpers.js';

const PHONE_ID = '1112223334445';
const CUSTOMER = '919811112222';
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

let wa: FakeProvider;
let ai: FakeAi;
beforeEach(() => {
  wa = new FakeProvider();
  ai = new FakeAi();
  setWhatsAppProvider(wa);
  setAiProvider(ai);
});
afterEach(() => {
  setWhatsAppProvider(undefined);
  setAiProvider(undefined);
});

let seq = 0;
async function post(payload: unknown) {
  const body = JSON.stringify(payload);
  await api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body).expect(200);
}
const say = (text: string, from = CUSTOMER) => post(inboundPayload(PHONE_ID, { id: `wamid.f.${++seq}`, from, text }));
const submit = (response: Record<string, unknown>, from = CUSTOMER) => post(inboundFormReplyPayload(PHONE_ID, { id: `wamid.fr.${++seq}`, from, response }));

const FIELDS = [
  { key: 'name', label: 'Patient name', type: 'short_text', required: true, saveTo: 'name' },
  { key: 'email', label: 'Email', type: 'email', required: false, saveTo: 'email' },
  { key: 'service', label: 'Service', type: 'dropdown', required: true, options: [{ id: 'cleaning', title: 'Teeth cleaning' }, { id: 'checkup', title: 'Check-up' }], saveTo: 'custom.service' },
  { key: 'date', label: 'Preferred date', type: 'date', required: true },
  { key: 'consent', label: 'I agree to be contacted on WhatsApp', type: 'opt_in', required: true },
];

async function setup() {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  const base = `/api/workspaces/${ws.id}`;
  await api().put(`${base}/whatsapp/connection`).set(auth(owner)).send({ wabaId: '9998887776665', phoneNumberId: PHONE_ID, accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
  const form = (await api().post(`${base}/forms`).set(auth(owner)).send({ name: 'Appointment request' }).expect(201)).body.form;
  return { owner, ws, base, form };
}

async function publishedForm() {
  const ctx = await setup();
  await api()
    .patch(`${ctx.base}/forms/${ctx.form.id}`)
    .set(auth(ctx.owner))
    .send({ fields: FIELDS, intro: 'Book your visit', successMessage: 'Thanks {{name}}! We will confirm your slot shortly.' })
    .expect(200);
  await api().post(`${ctx.base}/forms/${ctx.form.id}/publish`).set(auth(ctx.owner)).expect(200);
  return ctx;
}

async function sendTo(ctx: Awaited<ReturnType<typeof setup>>, from = CUSTOMER) {
  await say('hi, I want an appointment', from);
  await api().post(`${ctx.base}/forms/${ctx.form.id}/send`).set(auth(ctx.owner)).send({ phone: `+${from}` }).expect(202);
  const sent = wa.sent.filter((s) => s.message.type === 'flow').at(-1)!.message as { flowToken: string };
  return sent.flowToken;
}

describe('form publishing', () => {
  it('checks WhatsApp limits before publishing', async () => {
    const { owner, base, form } = await setup();
    await api()
      .patch(`${base}/forms/${form.id}`)
      .set(auth(owner))
      .send({ fields: [{ key: 'pick', label: 'Choose your preferred branch', type: 'dropdown', required: true, options: [] }, { key: 'pick', label: 'Dup', type: 'short_text' }] })
      .expect(200);
    const res = await api().post(`${base}/forms/${form.id}/publish`).set(auth(owner));
    expect(res.status).toBe(422);
    expect(res.body.error.details.issues).toEqual(
      expect.arrayContaining(['"Choose your preferred branch" is longer than 20 characters (WhatsApp limit).', 'Two fields use the key "pick".']),
    );
    expect(wa.published).toHaveLength(0);
  });

  it('publishes a navigate-only flow whose submit returns every field', async () => {
    const { form } = await publishedForm();
    const json = wa.published[0]!.flowJson as { screens: { id: string; terminal: boolean; layout: { children: Record<string, unknown>[] } }[] };
    const children = json.screens[0]!.layout.children;
    expect(json.screens[0]).toMatchObject({ id: 'FORM', terminal: true });
    expect(children.map((c) => c.type)).toEqual(['TextInput', 'TextInput', 'Dropdown', 'DatePicker', 'OptIn', 'Footer']);
    expect(children[1]).toMatchObject({ 'input-type': 'email', name: 'email' });
    expect(children.at(-1)).toMatchObject({ 'on-click-action': { name: 'complete', payload: { name: '${form.name}', service: '${form.service}', consent: '${form.consent}' } } });
    expect(form.id).toBeTruthy();
  });

  it('surfaces validation errors reported by WhatsApp', async () => {
    const { owner, base, form } = await setup();
    wa.flowValidationErrors = ['Invalid component property'];
    const res = await api().post(`${base}/forms/${form.id}/publish`).set(auth(owner));
    expect(res.body.error.details.issues).toEqual(['Invalid component property']);
  });
});

describe('sending and submissions', () => {
  it('sends the form inside the 24h window only', async () => {
    const ctx = await publishedForm();
    const outside = await api().post(`${ctx.base}/forms/${ctx.form.id}/send`).set(auth(ctx.owner)).send({ phone: '+919899990000' });
    expect(outside.status).toBe(400); // no such contact yet

    const token = await sendTo(ctx);
    expect(token).toMatch(new RegExp(`^zf_${ctx.form.id}_1_`));
    expect(wa.sent.at(-1)!.message).toMatchObject({ type: 'flow', ctaText: 'Open form', screen: 'FORM', body: 'Book your visit' });
  });

  it('stores a valid submission once, copies answers to the contact and confirms', async () => {
    const ctx = await publishedForm();
    const token = await sendTo(ctx);
    const answers = { name: 'Priya Sharma', email: 'Priya@Example.com', service: 'cleaning', date: '2026-11-02', consent: true, flow_token: token };

    await submit(answers);
    await submit(answers); // replayed / resubmitted token
    const subs = await FormSubmission.find({}).setOptions({ skipTenantScope: true });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ valid: true, formVersion: 1 });

    const contact = await Contact.findOne({ workspaceId: ctx.ws.id, phoneE164: `+${CUSTOMER}` });
    expect(contact).toMatchObject({ name: 'Priya Sharma', email: 'priya@example.com', customFields: { service: 'cleaning' } });
    expect(wa.sent.at(-1)!.message).toMatchObject({ type: 'text', text: 'Thanks {{name}}! We will confirm your slot shortly.' });

    const list = await api().get(`${ctx.base}/forms/${ctx.form.id}/submissions`).set(auth(ctx.owner)).expect(200);
    expect(list.body.submissions[0].values).toMatchObject({ service: 'Teeth cleaning', consent: 'Yes' });
    // The AI never answers form submissions.
    expect(ai.requests).toHaveLength(0);
  });

  it('records invalid submissions without acting on them, and ignores foreign tokens', async () => {
    const ctx = await publishedForm();
    const token = await sendTo(ctx);
    const before = wa.sent.length;
    await submit({ name: '', service: 'unknown', date: '2026-11-02', consent: true, flow_token: token });
    const sub = await FormSubmission.findOne({}).setOptions({ skipTenantScope: true });
    expect(sub!.valid).toBe(false);
    expect(sub!.issues).toEqual(['Patient name is required.', 'Service has an unknown choice.']);
    expect(wa.sent).toHaveLength(before);

    // A token naming a form that isn't in this workspace.
    const foreign = 'zf_0123456789abcdef01234567_1_abcdefghijkl';
    await submit({ name: 'X', service: 'cleaning', date: '2026-11-02', consent: true, flow_token: foreign });
    expect(await FormSubmission.countDocuments({ workspaceId: ctx.ws.id })).toBe(1);
  });
});

describe('forms in flows', () => {
  it('a flow sends the form, waits for it, and continues with the answers', async () => {
    const ctx = await publishedForm();
    const flow = (await api().post(`${ctx.base}/flows`).set(auth(ctx.owner)).send({ name: 'Booking' })).body.flow;
    await api()
      .patch(`${ctx.base}/flows/${flow.id}`)
      .set(auth(ctx.owner))
      .send({
        draftGraph: {
          nodes: [
            { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { event: 'keyword', keywords: ['book'] } },
            { id: 'f', type: 'send_form', position: { x: 0, y: 1 }, data: { formId: ctx.form.id, text: 'Fill this to book' } },
            { id: 'ok', type: 'send_text', position: { x: 0, y: 2 }, data: { text: 'Got it, {{vars.form_name}}. Checking {{vars.form_date}}.' } },
          ],
          edges: [
            { id: 'e1', source: 't', sourceHandle: 'next', target: 'f' },
            { id: 'e2', source: 'f', sourceHandle: 'submitted', target: 'ok' },
          ],
        },
      });
    await api().post(`${ctx.base}/flows/${flow.id}/publish`).set(auth(ctx.owner)).expect(200);

    await say('book');
    const token = (wa.sent.at(-1)!.message as { flowToken: string }).flowToken;
    expect(wa.sent.at(-1)!.message).toMatchObject({ type: 'flow', body: 'Fill this to book' });
    await submit({ name: 'Priya', service: 'checkup', date: '2026-11-05', consent: true, flow_token: token });

    expect(wa.sent.at(-1)!.message).toMatchObject({ type: 'text', text: 'Got it, Priya. Checking 2026-11-05.' });
    const [exec] = await FlowExecution.find({}).setOptions({ skipTenantScope: true });
    expect(exec!.status).toBe('completed');
  });

  it('a "form submitted" trigger starts a flow after valid submissions only', async () => {
    const ctx = await publishedForm();
    const flow = (await api().post(`${ctx.base}/flows`).set(auth(ctx.owner)).send({ name: 'After form' })).body.flow;
    await api()
      .patch(`${ctx.base}/flows/${flow.id}`)
      .set(auth(ctx.owner))
      .send({
        draftGraph: {
          nodes: [
            { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { event: 'form_submitted', formId: ctx.form.id } },
            { id: 'tag', type: 'update_contact', position: { x: 0, y: 1 }, data: { actions: [{ type: 'set_stage', stage: 'hot' }] } },
          ],
          edges: [{ id: 'e1', source: 't', sourceHandle: 'next', target: 'tag' }],
        },
      });
    await api().post(`${ctx.base}/flows/${flow.id}/publish`).set(auth(ctx.owner)).expect(200);

    const token = await sendTo(ctx);
    await submit({ name: 'Priya', service: 'checkup', date: '2026-11-05', consent: true, flow_token: token });
    const contact = await Contact.findOne({ workspaceId: ctx.ws.id, phoneE164: `+${CUSTOMER}` });
    expect(contact!.lifecycleStage).toBe('hot');
  });
});

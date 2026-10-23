import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Contact } from '../src/modules/contacts/contact.model.js';
import { processFlowResume } from '../src/modules/flows/engine.js';
import { FlowExecution } from '../src/modules/flows/flow.model.js';
import { Conversation } from '../src/modules/inbox/conversation.model.js';
import { MessageTemplate } from '../src/modules/templates/template.model.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { FakeProvider, inboundButtonPayload, inboundPayload, sign } from './fakeProvider.js';
import { addMember, api, createWorkspace, signup, type TestUser } from './helpers.js';

const PHONE_ID = '1112223334445';
const CUSTOMER = '919811112222';
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

let fake: FakeProvider;
beforeEach(() => {
  fake = new FakeProvider();
  setWhatsAppProvider(fake);
});
afterEach(() => setWhatsAppProvider(undefined));

let seq = 0;
async function post(payload: unknown) {
  const body = JSON.stringify(payload);
  await api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body).expect(200);
}
const say = (text: string, from = CUSTOMER) => post(inboundPayload(PHONE_ID, { id: `wamid.t.${++seq}`, from, text }));
const tap = (buttonId: string, title: string, from = CUSTOMER) => post(inboundButtonPayload(PHONE_ID, { id: `wamid.b.${++seq}`, from, buttonId, title }));

async function setup() {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  const base = `/api/workspaces/${ws.id}`;
  await api().put(`${base}/whatsapp/connection`).set(auth(owner)).send({ wabaId: '9998887776665', phoneNumberId: PHONE_ID, accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
  const vip = (await api().post(`${base}/tags`).set(auth(owner)).send({ name: 'Reviewed' })).body.tag;
  return { owner, ws, base, vip };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function createFlow(ctx: Ctx, graph: unknown, settings?: object) {
  const flow = (await api().post(`${ctx.base}/flows`).set(auth(ctx.owner)).send({ name: 'Clinic review flow' }).expect(201)).body.flow;
  await api().patch(`${ctx.base}/flows/${flow.id}`).set(auth(ctx.owner)).send({ draftGraph: graph, ...(settings ? { settings } : {}) }).expect(200);
  return flow.id as string;
}
const publish = (ctx: Ctx, id: string) => api().post(`${ctx.base}/flows/${id}/publish`).set(auth(ctx.owner)).send({});

const n = (id: string, type: string, data: object = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (source: string, target: string, sourceHandle = 'next') => ({ id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle });

/** The Getgabs-style review flow from the requirements. */
function reviewGraph(tagId: string) {
  return {
    nodes: [
      n('t', 'trigger', { event: 'keyword', keywords: ['review'], match: 'exact' }),
      n('ask_visit', 'send_buttons', {
        text: 'Hi {{contact.first_name}}! Did you visit us recently?',
        buttons: [
          { id: 'yes', title: 'Yes' },
          { id: 'no', title: 'Not yet' },
        ],
        timeoutMinutes: 60,
      }),
      n('tag', 'update_contact', { actions: [{ type: 'add_tag', tagId }, { type: 'set_stage', stage: 'converted' }] }),
      n('cta', 'send_cta', { text: 'Wonderful! Would you share a quick review?', buttonText: 'Share review', url: 'https://g.page/r/clinic/review' }),
      n('wait', 'delay', { amount: 1, unit: 'minutes' }),
      n('email', 'ask', { question: "What's your email for the receipt?", saveTo: 'email', validation: 'email', timeoutMinutes: 60 }),
      n('done', 'exit', { goal: 'review_requested' }),
      n('human', 'handoff', { message: 'No problem, a teammate will help you book.', note: 'Patient has not visited yet' }),
    ],
    edges: [
      e('t', 'ask_visit'),
      e('ask_visit', 'tag', 'btn:yes'),
      e('ask_visit', 'human', 'btn:no'),
      e('ask_visit', 'human', 'no_reply'),
      e('tag', 'cta'),
      e('cta', 'wait'),
      e('wait', 'email'),
      e('email', 'done', 'answered'),
    ],
  };
}

const executions = () => FlowExecution.find({}).setOptions({ skipTenantScope: true }).sort({ createdAt: 1 });
const sentTypes = () => fake.sent.map((s) => s.message.type);

describe('publishing', () => {
  it('rejects incomplete or unsafe graphs with per-step issues', async () => {
    const ctx = await setup();
    const id = await createFlow(ctx, {
      nodes: [
        n('t', 'trigger', { event: 'keyword', keywords: [], match: 'exact' }),
        n('b', 'send_buttons', { text: 'Pick', buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `Option ${i}` })) }),
        n('orphan', 'send_text', { text: 'nobody reaches me' }),
        n('x', 'send_text', { text: '' }),
      ],
      edges: [e('t', 'b'), e('b', 'x', 'btn:b1'), e('x', 'x')],
    });
    const res = await publish(ctx, id);
    expect(res.status).toBe(422);
    const issues = res.body.error.details.issues as { nodeId: string | null; message: string }[];
    const msgs = issues.map((i) => `${i.nodeId}: ${i.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        't: Add at least one keyword.',
        'b: WhatsApp allows at most 3 reply buttons.',
        'orphan: This step is not connected to the flow.',
        'x: Write a message.',
        'null: The flow loops back without a wait, question or buttons step in between.',
      ]),
    );
  });

  it('blocks keyword clashes with another live flow and unapproved templates', async () => {
    const ctx = await setup();
    const first = await createFlow(ctx, reviewGraph(ctx.vip.id));
    await publish(ctx, first).expect(200);

    const clash = await createFlow(ctx, { nodes: [n('t', 'trigger', { event: 'keyword', keywords: ['REVIEW'] }), n('s', 'send_text', { text: 'hi' })], edges: [e('t', 's')] });
    const res = await publish(ctx, clash);
    expect(res.body.error.details.issues[0].message).toBe('Keyword "review" is already used by the live flow "Clinic review flow".');

    await MessageTemplate.create({ workspaceId: ctx.ws.id, name: 'promo', language: 'en', category: 'MARKETING', status: 'PENDING', components: [{ type: 'BODY', text: 'Hi' }] });
    const tpl = await MessageTemplate.findOne({ workspaceId: ctx.ws.id, name: 'promo' });
    const t2 = await createFlow(ctx, { nodes: [n('t', 'trigger', { event: 'keyword', keywords: ['promo'] }), n('s', 'send_template', { templateId: tpl!.id })], edges: [e('t', 's')] });
    expect((await publish(ctx, t2)).body.error.details.issues[0].message).toBe('Template "promo" is not approved yet.');
  });

  it('only admins and owners manage flows', async () => {
    const ctx = await setup();
    const agent = await signup();
    await addMember(ctx.owner, ctx.ws.id, agent, 'agent');
    await api().post(`${ctx.base}/flows`).set(auth(agent)).send({}).expect(403);
    await api().get(`${ctx.base}/flows`).set(auth(agent)).expect(200);
  });
});

describe('running a flow', () => {
  it('walks a customer through buttons, CRM updates, a delay and a validated question', async () => {
    const ctx = await setup();
    await publish(ctx, await createFlow(ctx, reviewGraph(ctx.vip.id))).expect(200);

    await say('hello'); // no keyword: nothing happens
    expect(fake.sent).toHaveLength(0);

    await say('Review');
    expect(fake.sent[0]!.message).toMatchObject({
      type: 'buttons',
      body: 'Hi Customer! Did you visit us recently?',
      buttons: [
        { id: 'yes', title: 'Yes' },
        { id: 'no', title: 'Not yet' },
      ],
    });
    let [exec] = await executions();
    expect(exec).toMatchObject({ status: 'waiting', currentNodeId: 'ask_visit', waiting: { kind: 'reply' } });

    // Typing the keyword again while waiting doesn't start a second run.
    await say('review');
    expect(await executions()).toHaveLength(1);

    await tap('yes', 'Yes');
    const contact = await Contact.findOne({ workspaceId: ctx.ws.id, phoneE164: `+${CUSTOMER}` });
    expect(contact!.tags.map(String)).toEqual([ctx.vip.id]);
    expect(contact!.lifecycleStage).toBe('converted');
    expect(fake.sent[1]!.message).toMatchObject({ type: 'cta_url', buttonText: 'Share review', url: 'https://g.page/r/clinic/review' });
    [exec] = await executions();
    expect(exec).toMatchObject({ status: 'waiting', currentNodeId: 'wait', waiting: { kind: 'delay' } });

    // The delay survives a restart: it's a persisted job that resumes by token.
    await processFlowResume({ workspaceId: ctx.ws.id, executionId: exec!.id, token: 'stale-token' }, { attempt: 1, maxAttempts: 1 });
    expect((await executions())[0]!.currentNodeId).toBe('wait');
    await FlowExecution.updateOne({ _id: exec!._id, workspaceId: ctx.ws.id }, { 'waiting.until': new Date(Date.now() - 1000) });
    await processFlowResume({ workspaceId: ctx.ws.id, executionId: exec!.id, token: exec!.waiting!.token }, { attempt: 1, maxAttempts: 1 });
    expect(fake.sent[2]!.message).toMatchObject({ type: 'text', text: "What's your email for the receipt?" });

    await say('not an email');
    expect(fake.sent[3]!.message).toMatchObject({ type: 'text', text: "That doesn't look right. Please try again." });
    await say('priya@example.com');

    [exec] = await executions();
    expect(exec).toMatchObject({ status: 'completed', goal: 'review_requested', exitReason: 'exit' });
    expect((await Contact.findOne({ workspaceId: ctx.ws.id, phoneE164: `+${CUSTOMER}` }))!.email).toBe('priya@example.com');
    expect(exec!.log.map((l) => `${l.nodeId}:${l.outcome}`)).toEqual([
      't:started',
      'ask_visit:waiting',
      'ask_visit:btn:yes',
      'tag:next',
      'cta:next',
      'wait:waiting',
      'wait:resumed',
      'email:waiting',
      'email:answered',
      'done:completed',
    ]);
  });

  it('hands off to a human: bot pauses until the conversation is resolved', async () => {
    const ctx = await setup();
    await publish(ctx, await createFlow(ctx, reviewGraph(ctx.vip.id))).expect(200);
    await say('review');
    await tap('no', 'Not yet');

    expect(fake.sent[1]!.message).toMatchObject({ type: 'text', text: 'No problem, a teammate will help you book.' });
    const conv = await Conversation.findOne({ workspaceId: ctx.ws.id });
    expect(conv!.botPaused).toBe(true);
    expect((await executions())[0]).toMatchObject({ status: 'completed', exitReason: 'handoff' });

    const timeline = await api().get(`${ctx.base}/conversations/${conv!.id}/timeline`).set(auth(ctx.owner));
    expect(timeline.body.items.find((i: { kind: string }) => i.kind === 'note').body).toBe('[Bot handoff] Patient has not visited yet');
    expect(timeline.body.items.filter((i: { sentBy?: string }) => i.sentBy === 'Bot')).toHaveLength(2);

    await say('review'); // paused: no new run
    expect(await executions()).toHaveLength(1);

    await api().patch(`${ctx.base}/conversations/${conv!.id}`).set(auth(ctx.owner)).send({ status: 'resolved' }).expect(200);
    await say('review');
    expect(await executions()).toHaveLength(2);
  });

  it('a button wait times out onto the no-reply branch', async () => {
    const ctx = await setup();
    await publish(ctx, await createFlow(ctx, reviewGraph(ctx.vip.id))).expect(200);
    await say('review');
    const [exec] = await executions();
    await FlowExecution.updateOne({ _id: exec!._id, workspaceId: ctx.ws.id }, { 'waiting.until': new Date(Date.now() - 1000) });
    await processFlowResume({ workspaceId: ctx.ws.id, executionId: exec!.id, token: exec!.waiting!.token }, { attempt: 1, maxAttempts: 1 });
    expect((await executions())[0]).toMatchObject({ status: 'completed', exitReason: 'handoff' });
  });

  it('running executions stay on the version they started with', async () => {
    const ctx = await setup();
    const graph = (text: string) => ({
      nodes: [n('t', 'trigger', { event: 'keyword', keywords: ['hi'] }), n('w', 'delay', { amount: 1, unit: 'minutes' }), n('s', 'send_text', { text })],
      edges: [e('t', 'w'), e('w', 's')],
    });
    const id = await createFlow(ctx, graph('Version one'));
    await publish(ctx, id).expect(200);
    await say('hi');

    await api().patch(`${ctx.base}/flows/${id}`).set(auth(ctx.owner)).send({ draftGraph: graph('Version two') });
    await publish(ctx, id).expect(200);

    const [exec] = await executions();
    await FlowExecution.updateOne({ _id: exec!._id, workspaceId: ctx.ws.id }, { 'waiting.until': new Date(Date.now() - 1000) });
    await processFlowResume({ workspaceId: ctx.ws.id, executionId: exec!.id, token: exec!.waiting!.token }, { attempt: 1, maxAttempts: 1 });
    expect(fake.sent.at(-1)!.message).toMatchObject({ text: 'Version one' });
  });

  it('exit-on-reply and deactivation end waiting runs', async () => {
    const ctx = await setup();
    const graph = {
      nodes: [n('t', 'trigger', { event: 'keyword', keywords: ['drip'] }), n('w', 'delay', { amount: 1, unit: 'days' }), n('s', 'send_text', { text: 'Day 2' })],
      edges: [e('t', 'w'), e('w', 's')],
    };
    const id = await createFlow(ctx, graph, { allowReentry: false, exitOnReply: true });
    await publish(ctx, id).expect(200);

    await say('drip');
    await say('actually I have a question');
    expect((await executions())[0]).toMatchObject({ status: 'exited', exitReason: 'contact_replied' });

    await say('drip', '919822223333');
    await api().post(`${ctx.base}/flows/${id}/deactivate`).set(auth(ctx.owner)).expect(200);
    expect((await executions())[1]).toMatchObject({ status: 'exited', exitReason: 'flow_deactivated' });
    await say('drip', '919833334444');
    expect(await executions()).toHaveLength(2);
  });

  it('falls back to an "any message" flow when no keyword matches, starting only one flow', async () => {
    const ctx = await setup();
    await publish(ctx, await createFlow(ctx, reviewGraph(ctx.vip.id))).expect(200);
    const fallback = await createFlow(ctx, { nodes: [n('t', 'trigger', { event: 'any_message' }), n('s', 'send_text', { text: 'Thanks for writing to us!' })], edges: [e('t', 's')] });
    await publish(ctx, fallback).expect(200);

    await say('what are your timings?');
    expect(fake.sent.map((s) => (s.message as { text?: string }).text)).toEqual(['Thanks for writing to us!']);
    await say('review', '919822223333');
    expect(sentTypes().at(-1)).toBe('buttons');
    expect(await executions()).toHaveLength(2);
  });

  it('a tag added by a teammate starts a "tag added" flow with a template', async () => {
    const ctx = await setup();
    fake.templates = [
      { providerTemplateId: 'tpl', name: 'welcome_vip', language: 'en', category: 'UTILITY', status: 'APPROVED', rejectedReason: null, components: [{ type: 'BODY', text: 'Welcome {{1}}, you are now a VIP!' }] },
    ];
    await api().post(`${ctx.base}/templates/sync`).set(auth(ctx.owner)).expect(200);
    const tpl = await MessageTemplate.findOne({ workspaceId: ctx.ws.id, name: 'welcome_vip' });
    const id = await createFlow(ctx, {
      nodes: [
        n('t', 'trigger', { event: 'tag_added', tagId: ctx.vip.id }),
        n('s', 'send_template', { templateId: tpl!.id, bodyVariables: [{ source: 'field', value: 'first_name', fallback: 'friend' }] }),
      ],
      edges: [e('t', 's')],
    });
    await publish(ctx, id).expect(200);

    const c = (await api().post(`${ctx.base}/contacts`).set(auth(ctx.owner)).send({ phone: '+919855556666', name: 'Anita Desai' })).body.contact;
    await api().patch(`${ctx.base}/contacts/${c.id}`).set(auth(ctx.owner)).send({ tags: [ctx.vip.id] }).expect(200);
    expect(fake.sent[0]!.message).toMatchObject({ type: 'template', to: '+919855556666', template: { name: 'welcome_vip', bodyParams: ['Anita'] } });
  });

  it('records a clear error when a step cannot run (free text outside the 24h window)', async () => {
    const ctx = await setup();
    const id = await createFlow(ctx, { nodes: [n('t', 'trigger', { event: 'tag_added', tagId: ctx.vip.id }), n('s', 'send_text', { text: 'Hi!' })], edges: [e('t', 's')] });
    await publish(ctx, id).expect(200);
    const c = (await api().post(`${ctx.base}/contacts`).set(auth(ctx.owner)).send({ phone: '+919855556666' })).body.contact;
    await api().patch(`${ctx.base}/contacts/${c.id}`).set(auth(ctx.owner)).send({ tags: [ctx.vip.id] });

    const res = await api().get(`${ctx.base}/flows/${id}/executions`).set(auth(ctx.owner)).expect(200);
    expect(res.body.executions[0]).toMatchObject({ status: 'failed', contact: { phone: '+919855556666' } });
    expect(res.body.executions[0].error).toMatch(/24 hours/);
  });
});

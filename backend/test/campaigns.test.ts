import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Campaign, CampaignRecipient } from '../src/modules/campaigns/campaign.model.js';
import { processCampaignDispatch, quietHoursWait } from '../src/modules/campaigns/campaign.service.js';
import { Contact } from '../src/modules/contacts/contact.model.js';
import { MessageTemplate } from '../src/modules/templates/template.model.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { FakeProvider, failWith, inboundPayload, sign, statusPayload } from './fakeProvider.js';
import { addMember, api, createWorkspace, signup, type TestUser } from './helpers.js';

const PHONE_ID = '1112223334445';
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

let fake: FakeProvider;
beforeEach(() => {
  fake = new FakeProvider();
  setWhatsAppProvider(fake);
});
afterEach(() => setWhatsAppProvider(undefined));

const APPROVED = {
  providerTemplateId: 'tpl-offer',
  name: 'festive_offer',
  language: 'en',
  category: 'MARKETING',
  status: 'APPROVED',
  rejectedReason: null,
  components: [{ type: 'BODY' as const, text: 'Hi {{1}}, enjoy {{2}} off this Diwali at our clinic!' }],
};

async function setup() {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  const base = `/api/workspaces/${ws.id}`;
  await api().put(`${base}/whatsapp/connection`).set(auth(owner)).send({ wabaId: '9998887776665', phoneNumberId: PHONE_ID, accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
  fake.templates = [APPROVED];
  await api().post(`${base}/templates/sync`).set(auth(owner)).expect(200);
  const template = await MessageTemplate.findOne({ workspaceId: ws.id, name: 'festive_offer' });
  const vip = (await api().post(`${base}/tags`).set(auth(owner)).send({ name: 'VIP' })).body.tag;

  const contact = async (phone: string, body: object = {}) => (await api().post(`${base}/contacts`).set(auth(owner)).send({ phone, ...body }).expect(201)).body.contact;
  return { owner, ws, base, templateId: template!.id as string, vip, contact };
}

const bodyVars = [
  { source: 'field', value: 'first_name', fallback: '' },
  { source: 'static', value: '20%' },
];

async function draft(ctx: Awaited<ReturnType<typeof setup>>, overrides: object = {}) {
  const res = await api()
    .post(`${ctx.base}/campaigns`)
    .set(auth(ctx.owner))
    .send({
      name: 'Diwali offer',
      templateId: ctx.templateId,
      headerVariables: [],
      bodyVariables: bodyVars,
      audience: { type: 'filter', segmentId: null, filter: { tagsAny: [ctx.vip.id], excludeTags: [], stages: [], requireOptIn: false } },
      sendRatePerMinute: 60,
      quietHours: { enabled: false, start: '21:00', end: '09:00' },
      ...overrides,
    })
    .expect(201);
  return res.body.campaign as { id: string };
}

const dispatch = (ctx: { ws: { id: string } }, campaignId: string) => processCampaignDispatch({ workspaceId: ctx.ws.id, campaignId }, { attempt: 1, maxAttempts: 1 });
const recipients = (campaignId: string) => CampaignRecipient.find({ campaignId }).setOptions({ skipTenantScope: true }).lean();

describe('campaign audience and launch', () => {
  it('previews exactly what launch will do: opted-out and missing-variable contacts are skipped with a reason', async () => {
    const ctx = await setup();
    await ctx.contact('+919811111111', { name: 'Priya Sharma', tags: [ctx.vip.id] });
    await ctx.contact('+919822222222', { name: 'Rahul', tags: [ctx.vip.id], consentStatus: 'opted_out' });
    await ctx.contact('+919833333333', { tags: [ctx.vip.id] }); // no name -> missing {{1}}
    await ctx.contact('+919844444444', { name: 'Not VIP' });
    const c = await draft(ctx);

    const preview = await api().post(`${ctx.base}/campaigns/${c.id}/preview`).set(auth(ctx.owner)).expect(200);
    expect(preview.body.preview).toMatchObject({ matched: 3, eligible: 1, skipped: { opted_out: 1, missing_variable: 1 } });
    expect(preview.body.preview.samples[0]).toMatchObject({ contact: 'Priya Sharma', preview: 'Hi Priya, enjoy 20% off this Diwali at our clinic!' });

    // A fallback rescues the contact without a name.
    await api()
      .patch(`${ctx.base}/campaigns/${c.id}`)
      .set(auth(ctx.owner))
      .send({ bodyVariables: [{ source: 'field', value: 'first_name', fallback: 'there' }, bodyVars[1]] })
      .expect(200);

    const launched = await api().post(`${ctx.base}/campaigns/${c.id}/launch`).set(auth(ctx.owner)).send({}).expect(200);
    expect(launched.body.campaign.status).toBe('completed');
    expect(launched.body.campaign.stats).toMatchObject({ total: 3, submitted: 2, skipped: 1 });
    expect(fake.sent.map((s) => s.message)).toEqual([
      { type: 'template', to: '+919811111111', template: { name: 'festive_offer', language: 'en', headerParams: [], bodyParams: ['Priya', '20%'] } },
      { type: 'template', to: '+919833333333', template: { name: 'festive_offer', language: 'en', headerParams: [], bodyParams: ['there', '20%'] } },
    ]);
    const skipped = (await recipients(c.id)).find((r) => r.status === 'skipped');
    expect(skipped).toMatchObject({ phone: '+919822222222', skipReason: 'opted_out' });
  });

  it('refuses to launch with an unapproved template, unmapped variables or nobody to send to', async () => {
    const ctx = await setup();
    const c = await draft(ctx);
    const launch = () => api().post(`${ctx.base}/campaigns/${c.id}/launch`).set(auth(ctx.owner)).send({});

    expect((await launch()).body.error.code).toBe('NO_ELIGIBLE_RECIPIENTS');

    await ctx.contact('+919811111111', { name: 'Priya', tags: [ctx.vip.id] });
    await api().patch(`${ctx.base}/campaigns/${c.id}`).set(auth(ctx.owner)).send({ bodyVariables: [bodyVars[0]] });
    expect((await launch()).status).toBe(400);

    await api().patch(`${ctx.base}/campaigns/${c.id}`).set(auth(ctx.owner)).send({ bodyVariables: bodyVars });
    await MessageTemplate.updateOne({ _id: ctx.templateId, workspaceId: ctx.ws.id }, { status: 'PAUSED' });
    expect((await launch()).body.error.code).toBe('TEMPLATE_NOT_APPROVED');
    expect(fake.sent).toHaveLength(0);
  });

  it('agents cannot create or launch campaigns', async () => {
    const ctx = await setup();
    const agent = await signup();
    await addMember(ctx.owner, ctx.ws.id, agent, 'agent');
    await api().post(`${ctx.base}/campaigns`).set(auth(agent)).send({ name: 'x' }).expect(403);
    await api().get(`${ctx.base}/campaigns`).set(auth(agent)).expect(200);
  });
});

describe('dispatch', () => {
  async function launchedCampaign(count: number, rate: number) {
    const ctx = await setup();
    for (let i = 0; i < count; i++) await ctx.contact(`+9198110000${String(i).padStart(2, '0')}`, { name: `Customer ${i}`, tags: [ctx.vip.id] });
    const c = await draft(ctx, { sendRatePerMinute: rate });
    await api().post(`${ctx.base}/campaigns/${c.id}/launch`).set(auth(ctx.owner)).send({}).expect(200);
    return { ctx, id: c.id };
  }

  it('sends in rate-limited batches and completes when nobody is pending', async () => {
    const { ctx, id } = await launchedCampaign(5, 2);
    expect(fake.sent).toHaveLength(2); // first batch ran at launch
    expect((await Campaign.findOne({ _id: id }).setOptions({ skipTenantScope: true }))!.status).toBe('running');

    await dispatch(ctx, id);
    expect(fake.sent).toHaveLength(4);
    await dispatch(ctx, id);
    expect(fake.sent).toHaveLength(5);
    expect((await Campaign.findOne({ _id: id }).setOptions({ skipTenantScope: true }))!.status).toBe('completed');

    // Re-running a finished campaign's dispatch never re-sends.
    await dispatch(ctx, id);
    expect(fake.sent).toHaveLength(5);
  });

  it('overlapping dispatch runs never send to the same contact twice', async () => {
    const { ctx, id } = await launchedCampaign(6, 2);
    await Promise.all([dispatch(ctx, id), dispatch(ctx, id), dispatch(ctx, id)]);
    const phones = fake.sent.map((s) => s.message.to);
    expect(new Set(phones).size).toBe(phones.length);
    expect(phones).toHaveLength(6);
  });

  it('delivery receipts update recipients and the report reconciles', async () => {
    const { ctx, id } = await launchedCampaign(3, 10);
    const rows = await recipients(id);
    const msgIds = await Promise.all(rows.map(async (r) => (await api().get(`${ctx.base}/messages?contactId=${r.contactId}`).set(auth(ctx.owner))).body.messages[0].providerMessageId));
    const t = Math.floor(Date.now() / 1000);
    const post = async (p: unknown) => {
      const body = JSON.stringify(p);
      await api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body).expect(200);
    };
    await post(statusPayload(PHONE_ID, msgIds[0], 'read', t));
    await post(statusPayload(PHONE_ID, msgIds[1], 'delivered', t));
    await post(statusPayload(PHONE_ID, msgIds[2], 'failed', t, { code: 131026, title: 'Undeliverable' }));
    // The first customer replies.
    await post(inboundPayload(PHONE_ID, { id: 'wamid.reply.1', from: rows[0]!.phone.slice(1), text: 'Interested!' }));

    const res = await api().get(`${ctx.base}/campaigns/${id}`).set(auth(ctx.owner)).expect(200);
    expect(res.body.campaign.stats).toEqual({ total: 3, read: 1, delivered: 1, failed: 1, replied: 1 });
    const failed = await api().get(`${ctx.base}/campaigns/${id}/recipients?status=failed`).set(auth(ctx.owner));
    expect(failed.body.recipients[0].error).toMatchObject({ code: '131026' });
  });

  it('retargets by outcome and hands replies to the campaign teammates in turn', async () => {
    const ctx = await setup();
    const agent = await signup();
    await addMember(ctx.owner, ctx.ws.id, agent, 'agent');
    for (let i = 0; i < 3; i++) await ctx.contact(`+91982200000${i}`, { name: `C${i}`, tags: [ctx.vip.id] });
    const c = await draft(ctx, { assigneeIds: [ctx.owner.id, agent.id] });
    expect((await api().get(`${ctx.base}/campaigns/${c.id}`).set(auth(ctx.owner))).body.campaign.assigneeIds).toEqual([ctx.owner.id, agent.id]);
    await api().patch(`${ctx.base}/campaigns/${c.id}`).set(auth(ctx.owner)).send({ assigneeIds: ['64b000000000000000000000'] }).expect(400);
    await api().post(`${ctx.base}/campaigns/${c.id}/launch`).set(auth(ctx.owner)).send({}).expect(200);

    const rows = await recipients(c.id);
    const msgId = async (contactId: unknown) => (await api().get(`${ctx.base}/messages?contactId=${contactId}`).set(auth(ctx.owner))).body.messages[0].providerMessageId;
    const t = Math.floor(Date.now() / 1000);
    const post = async (p: unknown) => {
      const body = JSON.stringify(p);
      await api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body).expect(200);
    };
    await post(statusPayload(PHONE_ID, await msgId(rows[0]!.contactId), 'read', t));
    await post(statusPayload(PHONE_ID, await msgId(rows[1]!.contactId), 'delivered', t));
    await post(inboundPayload(PHONE_ID, { id: 'wamid.r.1', from: rows[0]!.phone.slice(1), text: 'Yes' }));
    await post(inboundPayload(PHONE_ID, { id: 'wamid.r.2', from: rows[1]!.phone.slice(1), text: 'Me too' }));
    const convs = (await api().get(`${ctx.base}/conversations?view=all`).set(auth(ctx.owner))).body.conversations as { contact: { phone: string }; assignee: { id: string } | null }[];
    const assigneeOf = (phone: string) => convs.find((x) => x.contact.phone === phone)?.assignee?.id;
    expect([assigneeOf(rows[0]!.phone), assigneeOf(rows[1]!.phone)]).toEqual([ctx.owner.id, agent.id]);

    // Retarget only people who received it but did not read it.
    const retarget = await draft(ctx, {
      name: 'Reminder',
      audience: { type: 'retarget', segmentId: null, filter: { tagsAny: [], excludeTags: [], stages: [], requireOptIn: false }, retarget: { campaignId: c.id, outcomes: ['delivered'] } },
    });
    const preview = await api().post(`${ctx.base}/campaigns/${retarget.id}/preview`).set(auth(ctx.owner)).expect(200);
    expect(preview.body.preview).toMatchObject({ matched: 1, eligible: 1, samples: [{ phone: rows[1]!.phone }] });
    await api()
      .patch(`${ctx.base}/campaigns/${retarget.id}`)
      .set(auth(ctx.owner))
      .send({ audience: { type: 'retarget', segmentId: null, filter: { tagsAny: [], excludeTags: [], stages: [], requireOptIn: false }, retarget: { campaignId: c.id, outcomes: ['sent'] } } })
      .expect(200);
    expect((await api().post(`${ctx.base}/campaigns/${retarget.id}/preview`).set(auth(ctx.owner))).body.preview.matched).toBe(3);
    // A draft can't be retargeted.
    await api()
      .post(`${ctx.base}/campaigns`)
      .set(auth(ctx.owner))
      .send({ name: 'x', audience: { type: 'retarget', segmentId: null, filter: {}, retarget: { campaignId: retarget.id, outcomes: ['read'] } } })
      .expect(400);
  });

  it('a provider failure fails only that recipient', async () => {
    const ctx = await setup();
    await ctx.contact('+919811111111', { name: 'A', tags: [ctx.vip.id] });
    await ctx.contact('+919822222222', { name: 'B', tags: [ctx.vip.id] });
    const c = await draft(ctx);
    fake.nextSend(failWith('permanent', '131026', 'Not on WhatsApp'));
    const res = await api().post(`${ctx.base}/campaigns/${c.id}/launch`).set(auth(ctx.owner)).send({}).expect(200);
    expect(res.body.campaign.stats).toMatchObject({ total: 2, failed: 1, submitted: 1 });
  });

  it('pause stops sending, resume continues, cancel drops pending recipients', async () => {
    const { ctx, id } = await launchedCampaign(6, 2);
    await api().post(`${ctx.base}/campaigns/${id}/pause`).set(auth(ctx.owner)).expect(200);
    await dispatch(ctx, id);
    expect(fake.sent).toHaveLength(2);

    await api().post(`${ctx.base}/campaigns/${id}/resume`).set(auth(ctx.owner)).expect(200); // runs a batch inline
    expect(fake.sent).toHaveLength(4);

    const cancelled = await api().post(`${ctx.base}/campaigns/${id}/cancel`).set(auth(ctx.owner)).expect(200);
    expect(cancelled.body.campaign.status).toBe('cancelled');
    await dispatch(ctx, id);
    expect(fake.sent).toHaveLength(4);
    const skipped = (await recipients(id)).filter((r) => r.skipReason === 'cancelled');
    expect(skipped).toHaveLength(2);
    await api().post(`${ctx.base}/campaigns/${id}/resume`).set(auth(ctx.owner)).expect(409);
  });

  it('scheduled campaigns wait for their time', async () => {
    const ctx = await setup();
    await ctx.contact('+919811111111', { name: 'Priya', tags: [ctx.vip.id] });
    const c = await draft(ctx);
    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await api().post(`${ctx.base}/campaigns/${c.id}/launch`).set(auth(ctx.owner)).send({ scheduledAt: at }).expect(200);
    expect(res.body.campaign).toMatchObject({ status: 'scheduled', scheduledAt: at });

    await dispatch(ctx, c.id); // too early
    expect(fake.sent).toHaveLength(0);

    await Campaign.updateOne({ _id: c.id, workspaceId: ctx.ws.id }, { scheduledAt: new Date(Date.now() - 1000) });
    await dispatch(ctx, c.id);
    expect(fake.sent).toHaveLength(1);
  });

  it('pauses itself if the template stops being approved mid-campaign', async () => {
    const { ctx, id } = await launchedCampaign(4, 2);
    await MessageTemplate.updateOne({ _id: ctx.templateId, workspaceId: ctx.ws.id }, { status: 'PAUSED' });
    await dispatch(ctx, id);
    const campaign = await Campaign.findOne({ _id: id }).setOptions({ skipTenantScope: true });
    expect(campaign).toMatchObject({ status: 'paused', failureReason: 'Template "festive_offer" is no longer approved.' });
    expect(fake.sent).toHaveLength(2);
  });
});

describe('consent and quiet hours', () => {
  it('STOP opts a contact out and START opts them back in', async () => {
    const ctx = await setup();
    const post = async (id: string, text: string) => {
      const body = JSON.stringify(inboundPayload(PHONE_ID, { id, from: '919811111111', text }));
      await api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body).expect(200);
    };
    await post('wamid.s1', 'STOP');
    let contact = await Contact.findOne({ workspaceId: ctx.ws.id, phoneE164: '+919811111111' });
    expect(contact!.consent).toMatchObject({ status: 'opted_out', source: 'keyword' });
    await post('wamid.s2', 'please stop sending offers'); // not an exact keyword
    await post('wamid.s3', 'Start');
    contact = await Contact.findOne({ workspaceId: ctx.ws.id, phoneE164: '+919811111111' });
    expect(contact!.consent?.status).toBe('opted_in');
  });

  it('computes the wait until quiet hours end in the workspace timezone', () => {
    const q = { quietHours: { enabled: true, start: '21:00', end: '09:00' } };
    // 22:30 IST = 17:00 UTC -> 10h30m until 09:00
    expect(quietHoursWait(q, 'Asia/Kolkata', new Date('2026-10-23T17:00:00Z'))).toBe(630 * 60_000);
    // 12:00 IST -> sending allowed
    expect(quietHoursWait(q, 'Asia/Kolkata', new Date('2026-10-23T06:30:00Z'))).toBe(0);
    expect(quietHoursWait({ quietHours: { enabled: false, start: '00:00', end: '23:59' } }, 'UTC')).toBe(0);
  });
});

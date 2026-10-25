import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptSecret } from '../src/lib/crypto.js';
import { Contact } from '../src/modules/contacts/contact.model.js';
import { Message } from '../src/modules/messages/message.model.js';
import { processSendJob } from '../src/modules/messages/message.service.js';
import { ProviderConnection } from '../src/modules/whatsapp/connection.model.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { ProviderError } from '../src/modules/whatsapp/provider/types.js';
import { processWebhookJob } from '../src/modules/whatsapp/webhook.processor.js';
import { WebhookEvent } from '../src/modules/whatsapp/webhookEvent.model.js';
import { FakeProvider, failWith, inboundPayload, sign, statusPayload, templateStatusPayload } from './fakeProvider.js';
import { addMember, api, createWorkspace, signup, type TestUser } from './helpers.js';

const PHONE_ID = '1112223334445';
const WABA_ID = '9998887776665';
const TOKEN = 'EAAG-test-access-token-0123456789';

let fake: FakeProvider;
beforeEach(() => {
  fake = new FakeProvider();
  setWhatsAppProvider(fake);
});
afterEach(() => setWhatsAppProvider(undefined));

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

async function connected(phoneNumberId = PHONE_ID) {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  await api()
    .put(`/api/workspaces/${ws.id}/whatsapp/connection`)
    .set(auth(owner))
    .send({ wabaId: WABA_ID, phoneNumberId, accessToken: TOKEN })
    .expect(200);
  return { owner, ws };
}

function postWebhook(payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  return api()
    .post('/api/webhooks/whatsapp')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signature ?? sign(body))
    .send(body);
}

async function customerWrites(text = 'Hi, I need an appointment', from = '919811112222') {
  await postWebhook(inboundPayload(PHONE_ID, { id: `wamid.in.${Math.random()}`, from, text })).expect(200);
}

describe('WhatsApp connection', () => {
  it('owner connects; token is encrypted at rest and never returned', async () => {
    const { owner, ws } = await connected();

    const res = await api().get(`/api/workspaces/${ws.id}/whatsapp/connection`).set(auth(owner)).expect(200);
    expect(res.body.connection).toMatchObject({ phoneNumberId: PHONE_ID, displayPhoneNumber: '+91 98765 43210', status: 'connected' });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);

    const stored = await ProviderConnection.findOne({ phoneNumberId: PHONE_ID }).setOptions({ skipTenantScope: true }).select('+accessTokenEncrypted');
    expect(stored!.accessTokenEncrypted).not.toContain(TOKEN);
    expect(decryptSecret(stored!.accessTokenEncrypted)).toBe(TOKEN);

    const ctx = await api().get(`/api/workspaces/${ws.id}`).set(auth(owner)).expect(200);
    expect(ctx.body.workspace.status).toBe('active');
  });

  it('only owners can connect, and bad credentials save nothing', async () => {
    const owner = await signup();
    const admin = await signup();
    const ws = await createWorkspace(owner);
    await addMember(owner, ws.id, admin, 'admin');
    const body = { wabaId: WABA_ID, phoneNumberId: PHONE_ID, accessToken: TOKEN };

    await api().put(`/api/workspaces/${ws.id}/whatsapp/connection`).set(auth(admin)).send(body).expect(403);

    fake.getPhoneError = new ProviderError('Invalid OAuth access token.', 'auth', '190', 401);
    const bad = await api().put(`/api/workspaces/${ws.id}/whatsapp/connection`).set(auth(owner)).send(body);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('PROVIDER_AUTH_FAILED');
    expect(await ProviderConnection.countDocuments({ workspaceId: ws.id })).toBe(0);
  });

  it('a number can only be connected to one workspace', async () => {
    await connected();
    const other = await signup();
    const ws2 = await createWorkspace(other, 'Copycat');
    const res = await api()
      .put(`/api/workspaces/${ws2.id}/whatsapp/connection`)
      .set(auth(other))
      .send({ wabaId: WABA_ID, phoneNumberId: PHONE_ID, accessToken: TOKEN });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NUMBER_IN_USE');
  });
});

describe('Embedded Signup', () => {
  const finish = (owner: TestUser, wsId: string, body: object) => api().post(`/api/workspaces/${wsId}/whatsapp/connection/embedded-signup`).set(auth(owner)).send(body);

  it('exchanges the code, connects, subscribes and registers the number with a new PIN', async () => {
    const owner = await signup();
    const ws = await createWorkspace(owner);
    const res = await finish(owner, ws.id, { code: 'signup-code-123', wabaId: WABA_ID, phoneNumberId: PHONE_ID }).expect(200);

    expect(fake.exchanged).toEqual(['signup-code-123']);
    expect(res.body.connection).toMatchObject({ status: 'connected', connectedVia: 'embedded_signup', registered: true, phoneNumberId: PHONE_ID });
    expect(res.body.warning).toBeNull();
    expect(res.body.pin).toMatch(/^\d{6}$/);
    expect(fake.registered).toEqual([{ phoneNumberId: PHONE_ID, pin: res.body.pin }]);
    // The business token from the exchange is what gets stored (encrypted).
    const conn = await ProviderConnection.findOne({ workspaceId: ws.id }).select('+accessTokenEncrypted');
    expect(decryptSecret(conn!.accessTokenEncrypted)).toBe('EAAG-business-token-for-signup-code-123-0123456789');
    expect(JSON.stringify(res.body)).not.toContain('EAAG-business-token');
  });

  it('keeps the connection but warns when registration needs the existing PIN, then registers with it', async () => {
    const owner = await signup();
    const ws = await createWorkspace(owner);
    fake.registerError = new ProviderError('Two-step verification PIN mismatch', 'permanent', '133005');
    const res = await finish(owner, ws.id, { code: 'signup-code-456', wabaId: WABA_ID, phoneNumberId: PHONE_ID }).expect(200);
    expect(res.body.connection).toMatchObject({ status: 'connected', registered: false });
    expect(res.body.warning).toContain('PIN');
    expect(res.body.pin).toBeNull();

    fake.registerError = null;
    const reg = await api().post(`/api/workspaces/${ws.id}/whatsapp/connection/register`).set(auth(owner)).send({ pin: '246810' }).expect(200);
    expect(reg.body.connection.registered).toBe(true);
    expect(fake.registered.at(-1)).toEqual({ phoneNumberId: PHONE_ID, pin: '246810' });
    await api().post(`/api/workspaces/${ws.id}/whatsapp/connection/register`).set(auth(owner)).send({ pin: '12' }).expect(400);
  });

  it('an expired code saves nothing; only owners can connect', async () => {
    const owner = await signup();
    const ws = await createWorkspace(owner);
    const expired = await finish(owner, ws.id, { code: 'expired-code-000', wabaId: WABA_ID, phoneNumberId: PHONE_ID }).expect(400);
    expect(expired.body.error.message).toContain('again');
    expect(await ProviderConnection.countDocuments({ workspaceId: ws.id })).toBe(0);

    const admin = await signup();
    await addMember(owner, ws.id, admin, 'admin');
    await finish(admin, ws.id, { code: 'signup-code-789', wabaId: WABA_ID, phoneNumberId: PHONE_ID }).expect(403);
  });

  it('the connection page says whether Facebook signup is available', async () => {
    const owner = await signup();
    const ws = await createWorkspace(owner);
    const res = await api().get(`/api/workspaces/${ws.id}/whatsapp/connection`).set(auth(owner)).expect(200);
    // Tests run without META_APP_ID / META_ES_CONFIG_ID.
    expect(res.body.embeddedSignup).toEqual({ enabled: false });
  });
});

describe('webhook receiver', () => {
  it('answers the verification handshake only with the right token', async () => {
    const ok = await api().get('/api/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': '12345' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('12345');
    await api().get('/api/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }).expect(403);
  });

  it('rejects payloads with a missing or wrong signature', async () => {
    const payload = inboundPayload(PHONE_ID, { id: 'wamid.x', from: '919811112222', text: 'hi' });
    await postWebhook(payload, 'sha256=deadbeef').expect(401);
    await postWebhook(payload, '').expect(401);
    expect(await WebhookEvent.countDocuments()).toBe(0);
  });

  it('stores inbound messages once, even when Meta redelivers them', async () => {
    const { owner, ws } = await connected();
    const payload = inboundPayload(PHONE_ID, { id: 'wamid.in.1', from: '919811112222', text: 'Hello clinic', name: 'Priya' });

    await postWebhook(payload).expect(200);
    await postWebhook(payload).expect(200); // identical redelivery
    // Same message id inside a different envelope (e.g. batched with other events).
    await postWebhook({ ...payload, entry: [...payload.entry, { id: 'WABA', changes: [] }] }).expect(200);

    const messages = await api().get(`/api/workspaces/${ws.id}/messages`).set(auth(owner)).expect(200);
    expect(messages.body.messages).toHaveLength(1);
    expect(messages.body.messages[0]).toMatchObject({ direction: 'inbound', status: 'received', content: { text: 'Hello clinic' }, contact: { phone: '+919811112222', name: 'Priya' } });

    const contact = await Contact.findOne({ workspaceId: ws.id, phoneE164: '+919811112222' });
    expect(contact!.lastInboundAt).toBeInstanceOf(Date);
  });

  it('ignores events for numbers no workspace owns', async () => {
    await postWebhook(inboundPayload('0000000000', { id: 'wamid.orphan', from: '919811112222', text: 'hi' })).expect(200);
    expect(await Message.countDocuments({}).setOptions({ skipTenantScope: true })).toBe(0);
  });
});

describe('sending messages', () => {
  it('blocks free-form text outside the 24h window, allows it after the customer writes', async () => {
    const { owner, ws } = await connected();
    const send = () => api().post(`/api/workspaces/${ws.id}/messages`).set(auth(owner)).send({ type: 'text', to: '+91 98111 12222', text: 'Your appointment is confirmed' });

    const blocked = await send();
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('OUTSIDE_SERVICE_WINDOW');

    await customerWrites();
    const ok = await send().expect(202);
    expect(ok.body.message).toMatchObject({ direction: 'outbound', status: 'submitted', providerMessageId: 'wamid.fake.1' });
    expect(fake.sent[0]!.message).toEqual({ type: 'text', to: '+919811112222', text: 'Your appointment is confirmed' });
    expect(fake.sent[0]!.creds.accessToken).toBe(TOKEN);
  });

  it('reconciles delivery receipts that arrive out of order or twice', async () => {
    const { owner, ws } = await connected();
    await customerWrites();
    const sent = await api().post(`/api/workspaces/${ws.id}/messages`).set(auth(owner)).send({ type: 'text', to: '919811112222', text: 'Hi' }).expect(202);
    const wamid = sent.body.message.providerMessageId as string;
    const t = Math.floor(Date.now() / 1000);

    await postWebhook(statusPayload(PHONE_ID, wamid, 'read', t + 3)).expect(200);
    await postWebhook(statusPayload(PHONE_ID, wamid, 'delivered', t + 2)).expect(200);
    await postWebhook(statusPayload(PHONE_ID, wamid, 'sent', t + 1)).expect(200);
    await postWebhook(statusPayload(PHONE_ID, wamid, 'read', t + 3)).expect(200);
    // A failure after delivery does not undo the delivery.
    await postWebhook(statusPayload(PHONE_ID, wamid, 'failed', t + 4, { code: 131026, title: 'Undeliverable' })).expect(200);

    const msg = await Message.findOne({ workspaceId: ws.id, providerMessageId: wamid });
    expect(msg!.status).toBe('read');
    expect(msg!.sentAt!.getTime()).toBe((t + 1) * 1000);
    expect(msg!.deliveredAt!.getTime()).toBe((t + 2) * 1000);
    expect(msg!.readAt!.getTime()).toBe((t + 3) * 1000);
  });

  it('marks a message failed with the provider error when delivery fails', async () => {
    const { owner, ws } = await connected();
    await customerWrites();
    const sent = await api().post(`/api/workspaces/${ws.id}/messages`).set(auth(owner)).send({ type: 'text', to: '919811112222', text: 'Hi' });
    await postWebhook(statusPayload(PHONE_ID, sent.body.message.providerMessageId, 'failed', Math.floor(Date.now() / 1000), { code: 131026, title: 'Message undeliverable' }));

    const msg = await Message.findOne({ workspaceId: ws.id, _id: sent.body.message.id });
    expect(msg!.status).toBe('failed');
    expect(msg!.error).toMatchObject({ code: '131026', title: 'Message undeliverable' });
  });

  it('idempotency keys prevent duplicate sends on client retries', async () => {
    const { owner, ws } = await connected();
    await customerWrites();
    const send = () =>
      api().post(`/api/workspaces/${ws.id}/messages`).set(auth(owner)).set('Idempotency-Key', 'order-42-confirmation').send({ type: 'text', to: '919811112222', text: 'Order confirmed' });

    const first = await send().expect(202);
    const second = await send().expect(200);
    expect(second.body.message.id).toBe(first.body.message.id);
    expect(fake.sent).toHaveLength(1);
  });

  it('retries transient errors, then gives up; permanent errors fail at once', async () => {
    const { owner, ws } = await connected();
    await customerWrites();

    // Inline queue runs a single attempt, which leaves a transient failure marked failed.
    fake.nextSend(failWith('transient', '131000'));
    const one = await api().post(`/api/workspaces/${ws.id}/messages`).set(auth(owner)).send({ type: 'text', to: '919811112222', text: 'a' });
    expect(one.body.message.status).toBe('failed');

    // Drive the worker directly to check the retry policy.
    const msg = await Message.create({ workspaceId: ws.id, contactId: one.body.message.contactId, direction: 'outbound', type: 'text', content: { text: 'b' }, status: 'queued' });
    const job = { workspaceId: ws.id, messageId: msg.id as string };
    fake.nextSend(failWith('rate_limit', '130429'), failWith('transient'));
    await expect(processSendJob(job, { attempt: 1, maxAttempts: 3 })).rejects.toThrow();
    await expect(processSendJob(job, { attempt: 2, maxAttempts: 3 })).rejects.toThrow();
    expect((await Message.findOne({ workspaceId: ws.id, _id: msg._id }))!.status).toBe('queued');
    await processSendJob(job, { attempt: 3, maxAttempts: 3 });
    const done = await Message.findOne({ workspaceId: ws.id, _id: msg._id });
    expect(done).toMatchObject({ status: 'submitted', attempts: 3 });

    fake.nextSend(failWith('permanent', '131026', 'Recipient cannot be reached'));
    const perm = await api().post(`/api/workspaces/${ws.id}/messages`).set(auth(owner)).send({ type: 'text', to: '919811112222', text: 'c' });
    expect(perm.body.message).toMatchObject({ status: 'failed', error: { code: '131026', message: 'Recipient cannot be reached' } });
  });

  it('pauses the connection when the provider rejects the token', async () => {
    const { owner, ws } = await connected();
    await customerWrites();
    fake.nextSend(failWith('auth', '190', 'Session has expired'));
    await api().post(`/api/workspaces/${ws.id}/messages`).set(auth(owner)).send({ type: 'text', to: '919811112222', text: 'a' });

    const conn = await api().get(`/api/workspaces/${ws.id}/whatsapp/connection`).set(auth(owner));
    expect(conn.body.connection).toMatchObject({ status: 'error', lastError: 'Session has expired' });
    const next = await api().post(`/api/workspaces/${ws.id}/messages`).set(auth(owner)).send({ type: 'text', to: '919811112222', text: 'b' });
    expect(next.body.error.code).toBe('WHATSAPP_CONNECTION_ERROR');
  });

  it('analysts cannot send', async () => {
    const { owner, ws } = await connected();
    const analyst = await signup();
    await addMember(owner, ws.id, analyst, 'analyst');
    await api().post(`/api/workspaces/${ws.id}/messages`).set(auth(analyst)).send({ type: 'text', to: '919811112222', text: 'x' }).expect(403);
  });

  it('retries a status receipt that arrives before its message is saved, then gives up', async () => {
    await connected();
    const event = await WebhookEvent.create({
      provider: 'meta_cloud',
      payloadHash: 'h1',
      payload: statusPayload(PHONE_ID, 'wamid.unknown', 'delivered', Math.floor(Date.now() / 1000)),
    });
    await expect(processWebhookJob({ eventId: event.id }, { attempt: 1, maxAttempts: 3 })).rejects.toThrow(/before their message/);
    await processWebhookJob({ eventId: event.id }, { attempt: 3, maxAttempts: 3 });
    expect((await WebhookEvent.findById(event.id))!.status).toBe('processed');
  });
});

describe('templates', () => {
  const approved = {
    providerTemplateId: 'tpl-appt',
    name: 'appointment_reminder',
    language: 'en',
    category: 'UTILITY',
    status: 'APPROVED',
    rejectedReason: null,
    components: [
      { type: 'HEADER' as const, format: 'TEXT', text: 'Hi {{1}}' },
      { type: 'BODY' as const, text: 'Your appointment is on {{1}} at {{2}}. Reply to reschedule.' },
    ],
  };

  it('syncs from the provider and sends approved templates with the right parameters', async () => {
    const { owner, ws } = await connected();
    fake.templates = [approved, { ...approved, providerTemplateId: 'tpl-2', name: 'promo', status: 'PENDING' }];

    const sync = await api().post(`/api/workspaces/${ws.id}/templates/sync`).set(auth(owner)).expect(200);
    expect(sync.body.synced).toBe(2);
    const list = await api().get(`/api/workspaces/${ws.id}/templates`).set(auth(owner)).expect(200);
    const appt = list.body.templates.find((t: { name: string }) => t.name === 'appointment_reminder');
    const promo = list.body.templates.find((t: { name: string }) => t.name === 'promo');
    expect(appt.variables).toEqual({ header: 1, body: 2 });

    const send = (body: object) => api().post(`/api/workspaces/${ws.id}/messages`).set(auth(owner)).send({ type: 'template', to: '919811112222', ...body });

    const pending = await send({ templateId: promo.id });
    expect(pending.body.error.code).toBe('TEMPLATE_NOT_APPROVED');
    const wrongParams = await send({ templateId: appt.id, bodyParams: ['Monday'] });
    expect(wrongParams.status).toBe(400);
    expect(Object.keys(wrongParams.body.error.details)).toEqual(expect.arrayContaining(['headerParams', 'bodyParams']));

    // Templates work outside the 24h window.
    const ok = await send({ templateId: appt.id, headerParams: ['Priya'], bodyParams: ['Monday', '10:30 AM'] }).expect(202);
    expect(ok.body.message.content.preview).toBe('Hi Priya\n\nYour appointment is on Monday at 10:30 AM. Reply to reschedule.');
    expect(fake.sent[0]!.message).toEqual({
      type: 'template',
      to: '+919811112222',
      template: { name: 'appointment_reminder', language: 'en', headerParams: ['Priya'], bodyParams: ['Monday', '10:30 AM'] },
    });

    // Removed on the provider side -> removed locally on next sync.
    fake.templates = [approved];
    const resync = await api().post(`/api/workspaces/${ws.id}/templates/sync`).set(auth(owner)).expect(200);
    expect(resync.body.removed).toBe(1);
  });

  it('validates new templates before submitting, stores them as PENDING, and applies the review result', async () => {
    const { owner, ws } = await connected();
    const create = (body: object) => api().post(`/api/workspaces/${ws.id}/templates`).set(auth(owner)).send(body);

    const invalid = await create({ name: 'Bad Name', language: 'en', category: 'UTILITY', body: { text: '{{2}} is ready', examples: ['x'] } });
    expect(invalid.status).toBe(400);
    expect(Object.keys(invalid.body.error.details)).toEqual(expect.arrayContaining(['name', 'body']));
    expect(fake.created).toHaveLength(0);

    const res = await create({
      name: 'order_ready',
      language: 'en_US',
      category: 'UTILITY',
      body: { text: 'Hello {{1}}, your order {{2}} is ready for pickup.', examples: ['Priya', '#1234'] },
      footer: { text: 'Sharma Store' },
      buttons: [{ type: 'QUICK_REPLY', text: 'Thanks' }],
    }).expect(201);
    expect(res.body.template).toMatchObject({ name: 'order_ready', status: 'PENDING', variables: { header: 0, body: 2 } });
    expect(fake.created[0]!.components).toEqual([
      { type: 'BODY', text: 'Hello {{1}}, your order {{2}} is ready for pickup.', example: { body_text: [['Priya', '#1234']] } },
      { type: 'FOOTER', text: 'Sharma Store' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Thanks' }] },
    ]);

    await postWebhook(templateStatusPayload(WABA_ID, 'tpl-1', 'APPROVED')).expect(200);
    const after = await api().get(`/api/workspaces/${ws.id}/templates/${res.body.template.id}`).set(auth(owner));
    expect(after.body.template.status).toBe('APPROVED');

    const dup = await create({ name: 'order_ready', language: 'en_US', category: 'UTILITY', body: { text: 'Hi there friend', examples: [] } });
    expect(dup.body.error.code).toBe('TEMPLATE_EXISTS');
  });
});

describe('isolation', () => {
  it("workspace B can't see A's messages, and webhooks route by phone number", async () => {
    const a = await connected(PHONE_ID);
    const b = await connected('5556667778889');
    await customerWrites('For A');
    await postWebhook(inboundPayload('5556667778889', { id: 'wamid.b1', from: '919822223333', text: 'For B' })).expect(200);

    const listA = await api().get(`/api/workspaces/${a.ws.id}/messages`).set(auth(a.owner));
    const listB = await api().get(`/api/workspaces/${b.ws.id}/messages`).set(auth(b.owner));
    expect(listA.body.messages.map((m: { content: { text: string } }) => m.content.text)).toEqual(['For A']);
    expect(listB.body.messages.map((m: { content: { text: string } }) => m.content.text)).toEqual(['For B']);

    await api().get(`/api/workspaces/${b.ws.id}/messages`).set(auth(a.owner)).expect(404);
    await api().get(`/api/workspaces/${b.ws.id}/templates`).set(auth(a.owner)).expect(404);
  });
});

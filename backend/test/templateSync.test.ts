import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { env } from '../src/config/env.js';
import { MessageTemplate } from '../src/modules/templates/template.model.js';
import { nextSyncDue, reconcileTemplates, SYNC_INTERVALS } from '../src/modules/templates/templateSync.js';
import { ProviderConnection } from '../src/modules/whatsapp/connection.model.js';
import { setWhatsAppProvider, type ProviderTemplate } from '../src/modules/whatsapp/provider/index.js';
import { WebhookEvent } from '../src/modules/whatsapp/webhookEvent.model.js';
import { FakeProvider, failWith, sign, TEST_APP_SECRET, templateStatusPayload } from './fakeProvider.js';
import { api, createWorkspace, signup, type TestUser } from './helpers.js';

const WABA = '9998887776665';
let fake: FakeProvider;
beforeEach(() => {
  fake = new FakeProvider();
  setWhatsAppProvider(fake);
  env.META_APP_SECRET = TEST_APP_SECRET;
});
afterEach(() => setWhatsAppProvider(undefined));

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
let phone = 700000000;
async function connected(wabaId = WABA) {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  await api().put(`/api/workspaces/${ws.id}/whatsapp/connection`).set(auth(owner)).send({ wabaId, phoneNumberId: String(phone++), accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
  return { owner, ws, base: `/api/workspaces/${ws.id}/templates`, as: auth(owner) };
}
const submit = (base: string, as: object, name = 'order_ready') =>
  api().post(base).set(as as Record<string, string>).send({ name, language: 'en_US', category: 'UTILITY', body: { text: 'Hello {{1}}, your order is ready.', examples: ['Priya'] } }).expect(201);
const remote = (over: Partial<ProviderTemplate> = {}): ProviderTemplate => ({
  providerTemplateId: 'tpl-1',
  name: 'order_ready',
  language: 'en_US',
  category: 'UTILITY',
  status: 'APPROVED',
  components: [{ type: 'BODY', text: 'Hello {{1}}, your order is ready.' }],
  rejectedReason: null,
  ...over,
});
async function webhook(payload: unknown, raw = JSON.stringify(payload)) {
  return api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw)).send(raw).expect(200);
}
const get = async (base: string, as: object, id: string) => (await api().get(`${base}/${id}`).set(as as Record<string, string>).expect(200)).body.template;

describe('template approval sync', () => {
  it('turns Pending into Approved without any webhook, and the template becomes selectable and sendable', async () => {
    const { ws, base, as } = await connected();
    const { body } = await submit(base, as);
    expect(body.template.status).toBe('PENDING');

    // Meta is still reviewing: stays Pending.
    fake.templates = [remote({ status: 'PENDING' })];
    await reconcileTemplates(new Date(Date.now() + 3 * 60_000));
    expect((await get(base, as, body.template.id)).status).toBe('PENDING');

    fake.templates = [remote()];
    await ProviderConnection.updateMany({ workspaceId: ws.id }, { 'templateSync.lastAttemptAt': new Date(Date.now() - 5 * 60_000) });
    await reconcileTemplates();
    const t = await get(base, as, body.template.id);
    expect(t.status).toBe('APPROVED');
    expect(t.statusHistory.map((h: { status: string; source: string }) => [h.status, h.source])).toEqual([['PENDING', 'submit'], ['APPROVED', 'reconcile']]);

    const approved = await api().get(`${base}?status=APPROVED`).set(as).expect(200);
    expect(approved.body.templates.map((x: { id: string }) => x.id)).toEqual([body.template.id]);
    await api().post(`/api/workspaces/${ws.id}/messages`).set(as).send({ type: 'template', to: '919811112222', templateId: body.template.id, bodyParams: ['Priya'] }).expect(202);
  });

  it('matches webhooks by exact long ids, and by name + language when the id is unknown', async () => {
    const { ws, base, as } = await connected();
    const { body } = await submit(base, as);
    // 17+ digits: JSON.parse alone would round this and never match.
    const longId = '24685713902468135';
    await MessageTemplate.updateOne({ workspaceId: ws.id, _id: body.template.id }, { providerTemplateId: longId });
    const raw = JSON.stringify(templateStatusPayload(WABA, 'X', 'APPROVED')).replace('"X"', longId);
    await webhook(null, raw);
    expect((await get(base, as, body.template.id)).status).toBe('APPROVED');
    const stored = await WebhookEvent.findOne().lean();
    expect(JSON.stringify(stored!.payload)).toContain(`"message_template_id":"${longId}"`);

    await MessageTemplate.updateOne({ workspaceId: ws.id, _id: body.template.id }, { status: 'PENDING', providerTemplateId: 'stale-id' });
    await webhook(templateStatusPayload(WABA, '555', 'APPROVED', { message_template_name: 'order_ready', message_template_language: 'en_US' }));
    const t = await get(base, as, body.template.id);
    expect(t).toMatchObject({ status: 'APPROVED', providerTemplateId: '555' });
    expect(await MessageTemplate.countDocuments({ workspaceId: ws.id })).toBe(1);
  });

  it('keeps rejected, paused and unknown events distinct and never invents an approval', async () => {
    const { base, as } = await connected();
    const { body } = await submit(base, as);
    await webhook(templateStatusPayload(WABA, 'tpl-1', 'REJECTED', { reason: 'INVALID_FORMAT', rejection_info: { reason: 'Variables are not numbered.' } }));
    expect(await get(base, as, body.template.id)).toMatchObject({ status: 'REJECTED', rejectedReason: 'INVALID_FORMAT: Variables are not numbered.' });
    await webhook(templateStatusPayload(WABA, 'tpl-1', 'PAUSED', { reason: 'NONE' }));
    expect(await get(base, as, body.template.id)).toMatchObject({ status: 'PAUSED', rejectedReason: null });
    // "REINSTATED" is not a status: wait for the API to confirm one.
    await webhook(templateStatusPayload(WABA, 'tpl-1', 'REINSTATED'));
    expect((await get(base, as, body.template.id)).status).toBe('PAUSED');
  });

  it('updates every workspace that shares the WhatsApp account, and only that account', async () => {
    const a = await connected();
    const b = await connected();
    const other = await connected('1110002223334');
    fake.templates = [remote({ status: 'PENDING' })];
    for (const w of [a, b, other]) await api().post(`${w.base}/sync`).set(w.as).expect(200);
    await webhook(templateStatusPayload(WABA, 'tpl-1', 'APPROVED'));
    const status = async (id: string) => (await MessageTemplate.findOne({ workspaceId: new Types.ObjectId(id) }))!.status;
    expect([await status(a.ws.id), await status(b.ws.id), await status(other.ws.id)]).toEqual(['APPROVED', 'APPROVED', 'PENDING']);
  });

  it('does not duplicate records on repeated syncs and webhooks, and keeps a just-submitted template Meta has not listed yet', async () => {
    const { ws, base, as } = await connected();
    const { body } = await submit(base, as);
    fake.templates = [];
    await api().post(`${base}/sync`).set(as).expect(200);
    expect((await get(base, as, body.template.id)).status).toBe('PENDING');

    fake.templates = [remote({ providerTemplateId: 'recreated-in-meta' })];
    for (let i = 0; i < 3; i++) await api().post(`${base}/sync`).set(as).expect(200);
    await webhook(templateStatusPayload(WABA, 'recreated-in-meta', 'APPROVED'));
    await webhook(templateStatusPayload(WABA, 'recreated-in-meta', 'APPROVED', { again: 1 }));
    expect(await MessageTemplate.countDocuments({ workspaceId: ws.id })).toBe(1);
    expect(await get(base, as, body.template.id)).toMatchObject({ status: 'APPROVED', providerTemplateId: 'recreated-in-meta' });

    // Listed once and now gone: deleted in Meta.
    fake.templates = [];
    const gone = await api().post(`${base}/sync`).set(as).expect(200);
    expect(gone.body.removed).toBe(1);
  });

  it('stores and returns sync failures, explains permissions, and clears them after a good sync', async () => {
    const { base, as } = await connected();
    try {
      failWith('permanent', '200', 'Permissions error')();
    } catch (err) {
      fake.listTemplatesError = err as never;
    }
    const failed = await api().post(`${base}/sync`).set(as).expect(400);
    expect(failed.body.error.message).toContain('whatsapp_business_management');
    let s = (await api().get(`${base}/sync-status`).set(as).expect(200)).body.sync;
    expect(s).toMatchObject({ lastSyncedAt: null, lastErrorCode: '200', running: false });
    expect(s.lastError).toContain(WABA);

    fake.listTemplatesError = null;
    await api().post(`${base}/sync`).set(as).expect(200);
    s = (await api().get(`${base}/sync-status`).set(as).expect(200)).body.sync;
    expect(s.lastError).toBeNull();
    expect(s.lastSyncedAt).toBeTruthy();
  });

  it('checks often while something is in review, rarely otherwise, and backs off after failures', () => {
    const now = new Date();
    const last = new Date(now.getTime() - 3 * 60_000);
    expect(nextSyncDue(null, { pending: 0, newest: null }, now) <= now).toBe(true);
    expect(nextSyncDue({ lastAttemptAt: last }, { pending: 1, newest: now }, now) <= now).toBe(true);
    expect(nextSyncDue({ lastAttemptAt: last }, { pending: 0, newest: null }, now).getTime()).toBe(last.getTime() + SYNC_INTERVALS.idle);
    expect(nextSyncDue({ lastAttemptAt: last, failures: 3 }, { pending: 1, newest: now }, now) > now).toBe(true);
  });
});

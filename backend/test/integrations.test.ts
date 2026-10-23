import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { ApiKey, WebhookDelivery, WebhookEndpoint } from '../src/modules/developer/developer.model.js';
import { DISABLE_AFTER_FAILURES, MAX_ATTEMPTS, processWebhookDelivery } from '../src/modules/developer/webhook.service.js';
import { FlowExecution } from '../src/modules/flows/flow.model.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { FakeProvider, inboundPayload, sign } from './fakeProvider.js';
import { addMember, api, createWorkspace, signup, type TestUser } from './helpers.js';

const PHONE_ID = '1112223334445';
const CUSTOMER = '919811112222';
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

// ---- a local HTTP server standing in for the customer's systems ----

interface Hit {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}
let server: Server;
let baseUrl: string;
let hits: Hit[] = [];
/** Status + body the fake customer server answers with next (default 200 {}). */
let respond: (hit: Hit) => { status: number; body?: unknown } = () => ({ status: 200, body: { ok: true } });

beforeAll(async () => {
  env.ALLOW_PRIVATE_OUTBOUND_URLS = true;
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const hit = { method: req.method!, url: req.url!, headers: req.headers, body };
      hits.push(hit);
      const out = respond(hit);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  env.ALLOW_PRIVATE_OUTBOUND_URLS = false;
  await new Promise((resolve) => server.close(resolve));
});

let wa: FakeProvider;
beforeEach(() => {
  hits = [];
  respond = () => ({ status: 200, body: { ok: true } });
  wa = new FakeProvider();
  setWhatsAppProvider(wa);
});
afterEach(() => setWhatsAppProvider(undefined));

let seq = 0;
async function say(text: string, from = CUSTOMER) {
  const body = JSON.stringify(inboundPayload(PHONE_ID, { id: `wamid.i.${++seq}`, from, text, name: 'Riya' }));
  await api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body).expect(200);
}

const APPROVED = {
  providerTemplateId: 'tpl-order',
  name: 'order_update',
  language: 'en',
  category: 'UTILITY',
  status: 'APPROVED',
  rejectedReason: null,
  components: [{ type: 'BODY' as const, text: 'Hi {{1}}, your order {{2}} is on its way.' }],
};

async function setup() {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  const base = `/api/workspaces/${ws.id}`;
  await api().put(`${base}/whatsapp/connection`).set(auth(owner)).send({ wabaId: '9998887776665', phoneNumberId: PHONE_ID, accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
  return { owner, ws, base };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function newKey(ctx: Ctx, scopes: string[], extra: object = {}) {
  const res = await api().post(`${ctx.base}/developer/api-keys`).set(auth(ctx.owner)).send({ name: 'Zapier', scopes, ...extra }).expect(201);
  return { key: res.body.key as string, id: res.body.apiKey.id as string };
}

async function newWebhook(ctx: Ctx, events: string[], path = '/hook') {
  const res = await api().post(`${ctx.base}/developer/webhooks`).set(auth(ctx.owner)).send({ url: `${baseUrl}${path}`, events }).expect(201);
  return { id: res.body.webhook.id as string, secret: res.body.secret as string };
}

function verifySignature(hit: Hit, secret: string): boolean {
  const header = String(hit.headers['zeta-signature']);
  const t = /t=(\d+)/.exec(header)![1]!;
  const expected = createHmac('sha256', secret).update(`${t}.${hit.body}`).digest('hex');
  return header.split(',').includes(`v1=${expected}`);
}

describe('API keys', () => {
  it('shows the key once, stores only a hash and authenticates /v1 calls', async () => {
    const ctx = await setup();
    const { key, id } = await newKey(ctx, ['contacts:read']);
    expect(key).toMatch(/^zc_live_[a-z0-9]{8}_[A-Za-z0-9]{32}$/);

    const stored = await ApiKey.findOne({ _id: id, workspaceId: ctx.ws.id }).select('+hash').lean();
    expect(stored!.hash).not.toContain(key.slice(-10));
    const list = await api().get(`${ctx.base}/developer/api-keys`).set(auth(ctx.owner)).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect(list.body.apiKeys[0].hint).toBe(`${key.slice(0, 17)}…${key.slice(-4)}`);

    const me = await api().get('/api/v1/me').set(bearer(key)).expect(200);
    expect(me.body.data.workspace.id).toBe(ctx.ws.id);
    expect(me.headers['zeta-api-version']).toBeTruthy();
    await api().get('/api/v1/me').set('X-API-Key', key).expect(200);

    // Missing, malformed, in the query string: all refused with the error envelope.
    const missing = await api().get('/api/v1/me').expect(401);
    expect(missing.body.error).toMatchObject({ code: 'API_KEY_MISSING', request_id: expect.any(String) });
    await api().get(`/api/v1/me?api_key=${key}`).expect(401);
    await api().get('/api/v1/me').set(bearer(`${key.slice(0, -1)}X`)).expect(401);
    expect((await ApiKey.findOne({ _id: id, workspaceId: ctx.ws.id }))!.lastUsedAt).toBeTruthy();
  });

  it('enforces scopes, revocation, expiry and who may manage keys', async () => {
    const ctx = await setup();
    const { key, id } = await newKey(ctx, ['contacts:read']);
    await api().get('/api/v1/contacts').set(bearer(key)).expect(200);
    const denied = await api().post('/api/v1/contacts').set(bearer(key)).send({ phone: '+919800000001' }).expect(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_SCOPE');

    const agent = await signup();
    await addMember(ctx.owner, ctx.ws.id, agent, 'agent');
    await api().get(`${ctx.base}/developer/api-keys`).set(auth(agent)).expect(403);
    await api().post(`${ctx.base}/developer/api-keys`).set(auth(ctx.owner)).send({ name: 'x', scopes: ['nope'] }).expect(400);

    await api().delete(`${ctx.base}/developer/api-keys/${id}`).set(auth(ctx.owner)).expect(200);
    expect((await api().get('/api/v1/me').set(bearer(key)).expect(401)).body.error.code).toBe('API_KEY_REVOKED');

    const expiring = await newKey(ctx, []);
    await ApiKey.updateOne({ _id: expiring.id, workspaceId: ctx.ws.id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await api().get('/api/v1/me').set(bearer(expiring.key)).expect(401)).body.error.code).toBe('API_KEY_EXPIRED');
  });

  it('rolls a key: the new key works and the old one has a 24h grace period', async () => {
    const ctx = await setup();
    const old = await newKey(ctx, ['contacts:read']);
    const rolled = await api().post(`${ctx.base}/developer/api-keys/${old.id}/roll`).set(auth(ctx.owner)).expect(201);
    expect(rolled.body.apiKey.scopes).toEqual(['contacts:read']);
    await api().get('/api/v1/contacts').set(bearer(rolled.body.key)).expect(200);
    await api().get('/api/v1/contacts').set(bearer(old.key)).expect(200);
    const graceEnd = new Date(rolled.body.previous.expiresAt).getTime();
    expect(graceEnd - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(graceEnd - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    await api().post(`${ctx.base}/developer/api-keys/${old.id}/roll`).set(auth(ctx.owner)).expect(409);
  });

  it('never reaches another workspace', async () => {
    const a = await setup();
    const owner2 = await signup();
    const ws2 = await createWorkspace(owner2, 'Other Clinic');
    const theirs = await api().post(`/api/workspaces/${ws2.id}/contacts`).set(auth(owner2)).send({ phone: '+919811100000' }).expect(201);
    const { key } = await newKey(a, ['contacts:read', 'contacts:write']);
    await api().get(`/api/v1/contacts/${theirs.body.contact.id}`).set(bearer(key)).expect(404);
    await api().patch(`/api/v1/contacts/${theirs.body.contact.id}`).set(bearer(key)).send({ name: 'x' }).expect(404);
    expect((await api().get('/api/v1/contacts').set(bearer(key)).expect(200)).body.data).toHaveLength(0);
  });
});

describe('contacts API', () => {
  it('upserts by phone, takes tags by name and merges custom fields', async () => {
    const ctx = await setup();
    const { key } = await newKey(ctx, ['contacts:read', 'contacts:write']);
    const first = await api()
      .post('/api/v1/contacts')
      .set(bearer(key))
      .send({ phone: '98111 22233', name: 'Asha', tags: ['Lead', 'website'], custom_fields: { city: 'Pune', plan: 'gold' } })
      .expect(201);
    expect(first.body).toMatchObject({ created: true, data: { phone: '+919811122233', name: 'Asha', tags: ['Lead', 'website'], source: 'api' } });

    const second = await api()
      .post('/api/v1/contacts')
      .set(bearer(key))
      .send({ phone: '+919811122233', tags: ['LEAD', 'vip'], custom_fields: { plan: null, visits: '3' } })
      .expect(200);
    expect(second.body.created).toBe(false);
    expect(second.body.data.name).toBe('Asha'); // untouched
    expect(second.body.data.tags).toEqual(['Lead', 'website', 'vip']); // "LEAD" matched case-insensitively
    expect(second.body.data.custom_fields).toEqual({ city: 'Pune', visits: '3' });

    const tagged = await api().post(`/api/v1/contacts/${first.body.data.id}/tags`).set(bearer(key)).send({ add: ['paid'], remove: ['lead'] }).expect(200);
    expect(tagged.body.data.tags).toEqual(['website', 'vip', 'paid']);

    const byTag = await api().get('/api/v1/contacts?tag=VIP').set(bearer(key)).expect(200);
    expect(byTag.body.data.map((c: { id: string }) => c.id)).toEqual([first.body.data.id]);
    const byPhone = await api().get('/api/v1/contacts?phone=9811122233').set(bearer(key)).expect(200);
    expect(byPhone.body.data).toHaveLength(1);
    await api().post('/api/v1/contacts').set(bearer(key)).send({ phone: '123' }).expect(400);
  });

  it('paginates with a cursor', async () => {
    const ctx = await setup();
    const { key } = await newKey(ctx, ['contacts:read', 'contacts:write']);
    for (let i = 0; i < 5; i++) await api().post('/api/v1/contacts').set(bearer(key)).send({ phone: `+91981110000${i}` }).expect(201);
    const p1 = await api().get('/api/v1/contacts?limit=2').set(bearer(key)).expect(200);
    expect(p1.body).toMatchObject({ has_more: true });
    const p2 = await api().get(`/api/v1/contacts?limit=2&cursor=${p1.body.next_cursor}`).set(bearer(key)).expect(200);
    const p3 = await api().get(`/api/v1/contacts?limit=2&cursor=${p2.body.next_cursor}`).set(bearer(key)).expect(200);
    expect(p3.body).toMatchObject({ has_more: false, next_cursor: null });
    const phones = [...p1.body.data, ...p2.body.data, ...p3.body.data].map((c: { phone: string }) => c.phone);
    expect(new Set(phones).size).toBe(5);
  });

  it('replays Idempotency-Key retries and rejects reuse with a different body', async () => {
    const ctx = await setup();
    const { key } = await newKey(ctx, ['contacts:write']);
    const body = { phone: '+919811122299', name: 'Kiran' };
    const a = await api().post('/api/v1/contacts').set(bearer(key)).set('Idempotency-Key', 'create-kiran-1').send(body).expect(201);
    const b = await api().post('/api/v1/contacts').set(bearer(key)).set('Idempotency-Key', 'create-kiran-1').send(body).expect(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body).toEqual(a.body);
    const reused = await api().post('/api/v1/contacts').set(bearer(key)).set('Idempotency-Key', 'create-kiran-1').send({ ...body, name: 'Other' }).expect(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('messages API', () => {
  it('sends an approved template by name, with idempotent retries', async () => {
    const ctx = await setup();
    wa.templates = [APPROVED];
    await api().post(`${ctx.base}/templates/sync`).set(auth(ctx.owner)).expect(200);
    const { key } = await newKey(ctx, ['messages:send', 'messages:read', 'templates:read']);

    const templates = await api().get('/api/v1/templates').set(bearer(key)).expect(200);
    expect(templates.body.data[0]).toMatchObject({ name: 'order_update', body_params: 2 });

    const body = { to: '+919811122233', type: 'template', template: { name: 'order_update' }, body_params: ['Asha', '#A12'] };
    const sent = await api().post('/api/v1/messages').set(bearer(key)).set('Idempotency-Key', 'order-A12').send(body).expect(202);
    expect(sent.body.data).toMatchObject({ type: 'template', text: 'Hi Asha, your order #A12 is on its way.' });
    const again = await api().post('/api/v1/messages').set(bearer(key)).set('Idempotency-Key', 'order-A12').send(body).expect(200);
    expect(again.body.data.id).toBe(sent.body.data.id);
    expect(wa.sent).toHaveLength(1);

    const status = await api().get(`/api/v1/messages/${sent.body.data.id}`).set(bearer(key)).expect(200);
    expect(status.body.data.status).toBe('submitted');

    // Free text needs an open 24h window.
    const text = await api().post('/api/v1/messages').set(bearer(key)).send({ to: '+919811199999', type: 'text', text: 'hello' }).expect(422);
    expect(text.body.error.code).toBe('OUTSIDE_SERVICE_WINDOW');
    await api().post('/api/v1/messages').set(bearer(key)).send({ ...body, template: { name: 'missing' } }).expect(400);
  });
});

describe('webhooks', () => {
  it('delivers signed events for subscribed types only', async () => {
    const ctx = await setup();
    const hook = await newWebhook(ctx, ['message.received', 'contact.created']);
    await say('Hi, is the clinic open today?');

    const types = hits.map((h) => h.headers['zeta-event-type']);
    expect(types.sort()).toEqual(['contact.created', 'message.received']);
    const msg = hits.find((h) => h.headers['zeta-event-type'] === 'message.received')!;
    expect(verifySignature(msg, hook.secret)).toBe(true);
    const event = JSON.parse(msg.body);
    expect(event).toMatchObject({
      event_id: expect.stringMatching(/^evt_/),
      event_type: 'message.received',
      workspace_id: ctx.ws.id,
      data: { message: { direction: 'inbound', text: 'Hi, is the clinic open today?' }, contact: { phone: `+${CUSTOMER}`, name: 'Riya' } },
    });
    expect(msg.headers['zeta-event-id']).toBe(event.event_id);

    // Second message from the same customer: no new contact.created.
    hits = [];
    await say('Thanks');
    expect(hits.map((h) => h.headers['zeta-event-type'])).toEqual(['message.received']);

    // Delivery log hides personal data.
    const log = await api().get(`${ctx.base}/developer/webhooks/${hook.id}/deliveries`).set(auth(ctx.owner)).expect(200);
    const logged = JSON.stringify(log.body.deliveries);
    expect(logged).not.toContain('Thanks');
    expect(logged).not.toContain(CUSTOMER);
    expect(logged).toContain('2222');
    expect(log.body.deliveries[0]).toMatchObject({ status: 'succeeded', attempts: [{ statusCode: 200 }] });
  });

  it('retries failures with backoff, then dead-letters', async () => {
    const ctx = await setup();
    const hook = await newWebhook(ctx, ['message.received']);
    respond = () => ({ status: 500, body: { error: 'down' } });
    await say('hello');

    let delivery = (await WebhookDelivery.findOne({ workspaceId: ctx.ws.id, endpointId: hook.id }))!;
    expect(delivery.status).toBe('retrying');
    expect(delivery.attempts).toHaveLength(1);
    expect(delivery.attempts[0]).toMatchObject({ statusCode: 500, error: 'HTTP 500' });
    expect(delivery.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(20_000);

    // A stale job (old token) is ignored.
    await processWebhookDelivery({ workspaceId: ctx.ws.id, deliveryId: delivery.id, token: 'stale' }, { attempt: 1, maxAttempts: 1 });
    expect(hits).toHaveLength(1);

    while (delivery.status === 'retrying') {
      await processWebhookDelivery({ workspaceId: ctx.ws.id, deliveryId: delivery.id, token: delivery.token! }, { attempt: 1, maxAttempts: 1 });
      delivery = (await WebhookDelivery.findOne({ _id: delivery._id, workspaceId: ctx.ws.id }))!;
    }
    expect(delivery.status).toBe('dead');
    expect(delivery.attempts).toHaveLength(MAX_ATTEMPTS);
    expect(new Set(hits.map((h) => h.headers['zeta-event-id'])).size).toBe(1); // same event id every attempt
    expect(hits.map((h) => h.headers['zeta-delivery-attempt'])).toEqual(Array.from({ length: MAX_ATTEMPTS }, (_, i) => String(i + 1)));

    // Manual redelivery once the receiver is fixed.
    respond = () => ({ status: 204 });
    const redo = await api().post(`${ctx.base}/developer/webhooks/${hook.id}/deliveries/${delivery.id}/redeliver`).set(auth(ctx.owner)).expect(200);
    expect(redo.body.delivery.status).toBe('succeeded');
    const endpoint = await WebhookEndpoint.findOne({ _id: hook.id, workspaceId: ctx.ws.id });
    expect(endpoint!.consecutiveFailures).toBe(0);
  });

  it('switches off an endpoint after repeated failures and holds deliveries while paused', async () => {
    const ctx = await setup();
    const hook = await newWebhook(ctx, ['message.received']);
    await WebhookEndpoint.updateOne({ _id: hook.id, workspaceId: ctx.ws.id }, { consecutiveFailures: DISABLE_AFTER_FAILURES - 1 });
    respond = () => ({ status: 503 });
    await say('one');
    const endpoint = await WebhookEndpoint.findOne({ _id: hook.id, workspaceId: ctx.ws.id });
    expect(endpoint).toMatchObject({ status: 'disabled' });
    expect(endpoint!.disabledReason).toContain(String(DISABLE_AFTER_FAILURES));

    // Disabled: new events are not recorded; the held retry waits.
    await say('two');
    expect(await WebhookDelivery.countDocuments({ workspaceId: ctx.ws.id })).toBe(1);
    const held = (await WebhookDelivery.findOne({ workspaceId: ctx.ws.id }))!;
    await processWebhookDelivery({ workspaceId: ctx.ws.id, deliveryId: held.id, token: held.token! }, { attempt: 1, maxAttempts: 1 });
    expect(hits).toHaveLength(1);

    // Re-enabling resets health and re-sends held deliveries.
    respond = () => ({ status: 200 });
    const resumed = await api().patch(`${ctx.base}/developer/webhooks/${hook.id}`).set(auth(ctx.owner)).send({ status: 'active' }).expect(200);
    expect(resumed.body.webhook).toMatchObject({ status: 'active', consecutiveFailures: 0, disabledReason: null });
    expect((await WebhookDelivery.findOne({ _id: held._id, workspaceId: ctx.ws.id }))!.status).toBe('succeeded');
  });

  it('test pings, secret rotation with overlap, and URL safety', async () => {
    const ctx = await setup();
    const hook = await newWebhook(ctx, ['contact.created']);
    const ping = await api().post(`${ctx.base}/developer/webhooks/${hook.id}/test`).set(auth(ctx.owner)).expect(200);
    expect(ping.body.delivery).toMatchObject({ eventType: 'webhook.test', status: 'succeeded' });
    expect(verifySignature(hits[0]!, hook.secret)).toBe(true);

    const rotated = await api().post(`${ctx.base}/developer/webhooks/${hook.id}/rotate-secret`).set(auth(ctx.owner)).expect(200);
    expect(rotated.body.secret).not.toBe(hook.secret);
    expect(rotated.body.webhook.secretRotating).toBe(true);
    hits = [];
    await api().post(`${ctx.base}/developer/webhooks/${hook.id}/test`).set(auth(ctx.owner)).expect(200);
    // Both the new and the previous secret verify during the overlap.
    expect(verifySignature(hits[0]!, rotated.body.secret)).toBe(true);
    expect(verifySignature(hits[0]!, hook.secret)).toBe(true);

    await api().post(`${ctx.base}/developer/webhooks`).set(auth(ctx.owner)).send({ url: baseUrl, events: ['nope'] }).expect(400);
    env.ALLOW_PRIVATE_OUTBOUND_URLS = false;
    try {
      const unsafe = await api().post(`${ctx.base}/developer/webhooks`).set(auth(ctx.owner)).send({ url: `${baseUrl}/x`, events: ['contact.created'] }).expect(400);
      expect(unsafe.body.error.details.url[0]).toMatch(/https/);
      const internal = await api().post(`${ctx.base}/developer/webhooks`).set(auth(ctx.owner)).send({ url: 'https://127.0.0.1/x', events: ['contact.created'] }).expect(400);
      expect(internal.body.error.details.url[0]).toMatch(/private network/);
    } finally {
      env.ALLOW_PRIVATE_OUTBOUND_URLS = true;
    }
  });

  it('can be managed with an API key that has webhooks:manage', async () => {
    const ctx = await setup();
    const { key } = await newKey(ctx, ['webhooks:manage']);
    const created = await api().post('/api/v1/webhooks').set(bearer(key)).send({ url: `${baseUrl}/zap`, events: ['form.submitted'] }).expect(201);
    expect(created.body.data.secret).toMatch(/^whsec_/);
    const list = await api().get('/api/v1/webhooks').set(bearer(key)).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(created.body.data.secret);
    await api().delete(`/api/v1/webhooks/${created.body.data.id}`).set(bearer(key)).expect(204);
  });
});

describe('flows: API trigger + HTTP request step', () => {
  const n = (id: string, type: string, data: object = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
  const e = (source: string, target: string, sourceHandle = 'next') => ({ id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle });

  async function orderFlow(ctx: Ctx, url: string) {
    const flow = (await api().post(`${ctx.base}/flows`).set(auth(ctx.owner)).send({ name: 'Order status' }).expect(201)).body.flow;
    const graph = {
      nodes: [
        n('t', 'trigger', { event: 'api' }),
        n('lookup', 'http_request', {
          method: 'POST',
          url,
          headers: [{ key: 'Authorization', value: 'Bearer shop-secret' }],
          body: '{"order": "{{vars.order_id}}", "customer": "{{contact.name}}"}',
          saveResponse: [{ path: 'order.status', var: 'status' }, { path: 'order.items[0].name', var: 'item' }],
        }),
        n('ok', 'send_text', { text: 'Your {{vars.item}} is {{vars.status}}.' }),
        n('bad', 'send_text', { text: 'Sorry, we could not find order {{vars.order_id}} (HTTP {{vars.http_status}}).' }),
      ],
      edges: [e('t', 'lookup'), e('lookup', 'ok', 'success'), e('lookup', 'bad', 'failed')],
    };
    await api().patch(`${ctx.base}/flows/${flow.id}`).set(auth(ctx.owner)).send({ draftGraph: graph }).expect(200);
    await api().post(`${ctx.base}/flows/${flow.id}/publish`).set(auth(ctx.owner)).send({}).expect(200);
    return flow.id as string;
  }

  it('runs an API-triggered flow that calls an external API and uses the response', async () => {
    const ctx = await setup();
    await say('hi'); // opens the 24h window
    await api().patch(`${ctx.base}/contacts/${(await api().get(`${ctx.base}/contacts`).set(auth(ctx.owner))).body.contacts[0].id}`).set(auth(ctx.owner)).send({ name: 'Riya "R" Shah' });
    const hook = await newWebhook(ctx, ['flow.completed']);
    respond = (hit) => (hit.url === '/orders' ? { status: 200, body: { order: { status: 'shipped', items: [{ name: 'Night guard' }] } } } : { status: 200 });
    const flowId = await orderFlow(ctx, `${baseUrl}/orders`);
    const { key } = await newKey(ctx, ['flows:run', 'flows:read']);

    const flows = await api().get('/api/v1/flows').set(bearer(key)).expect(200);
    expect(flows.body.data[0]).toMatchObject({ id: flowId, trigger: 'api', api_runnable: true });

    const run = await api().post(`/api/v1/flows/${flowId}/runs`).set(bearer(key)).send({ phone: `+${CUSTOMER}`, variables: { order_id: 'A-1001' } }).expect(202);
    expect(run.body.data.status).toBe('completed');

    const call = hits.find((h) => h.url === '/orders')!;
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe('Bearer shop-secret');
    expect(call.headers['zeta-execution-id']).toBe(run.body.data.id);
    // Values are JSON-escaped, so quotes in a name can't break the body.
    expect(JSON.parse(call.body)).toEqual({ order: 'A-1001', customer: 'Riya "R" Shah' });
    expect(wa.sent.at(-1)!.message).toMatchObject({ type: 'text', text: 'Your Night guard is shipped.' });

    const exec = await FlowExecution.findOne({ _id: run.body.data.id, workspaceId: ctx.ws.id }).lean();
    expect(exec!.vars).toMatchObject({ order_id: 'A-1001', status: 'shipped', http_status: '200' });
    const done = hits.find((h) => h.headers['zeta-event-type'] === 'flow.completed')!;
    expect(verifySignature(done, hook.secret)).toBe(true);
    expect(JSON.parse(done.body).data).toMatchObject({ flow_id: flowId, execution_id: run.body.data.id });
  });

  it('takes the failed branch on errors and refuses non-API flows', async () => {
    const ctx = await setup();
    await say('hi');
    respond = () => ({ status: 404, body: { error: 'not found' } });
    const flowId = await orderFlow(ctx, `${baseUrl}/orders`);
    const { key } = await newKey(ctx, ['flows:run']);
    await api().post(`/api/v1/flows/${flowId}/runs`).set(bearer(key)).send({ phone: `+${CUSTOMER}`, variables: { order_id: 'X' } }).expect(202);
    expect(wa.sent.at(-1)!.message).toMatchObject({ text: 'Sorry, we could not find order X (HTTP 404).' });

    const keywordFlow = (await api().post(`${ctx.base}/flows`).set(auth(ctx.owner)).send({ name: 'Keyword' }).expect(201)).body.flow;
    await api()
      .patch(`${ctx.base}/flows/${keywordFlow.id}`)
      .set(auth(ctx.owner))
      .send({ draftGraph: { nodes: [n('t', 'trigger', { event: 'keyword', keywords: ['menu'] }), n('s', 'send_text', { text: 'Menu' })], edges: [e('t', 's')] } })
      .expect(200);
    await api().post(`${ctx.base}/flows/${keywordFlow.id}/publish`).set(auth(ctx.owner)).send({}).expect(200);
    const refused = await api().post(`/api/v1/flows/${keywordFlow.id}/runs`).set(bearer(key)).send({ phone: `+${CUSTOMER}` }).expect(409);
    expect(refused.body.error.code).toBe('FLOW_NOT_API');
  });

  it('validates HTTP step config at publish', async () => {
    const ctx = await setup();
    const flow = (await api().post(`${ctx.base}/flows`).set(auth(ctx.owner)).send({ name: 'Bad' }).expect(201)).body.flow;
    await api()
      .patch(`${ctx.base}/flows/${flow.id}`)
      .set(auth(ctx.owner))
      .send({
        draftGraph: {
          nodes: [
            n('t', 'trigger', { event: 'api' }),
            n('h1', 'http_request', { url: 'https://{{vars.host}}/x', body: '' }),
            n('h2', 'http_request', { url: 'https://api.example.com/x', body: '{"age": {{vars.age}}}' }),
          ],
          edges: [e('t', 'h1'), e('h1', 'h2', 'success')],
        },
      })
      .expect(200);
    const res = await api().post(`${ctx.base}/flows/${flow.id}/publish`).set(auth(ctx.owner)).send({}).expect(422);
    const issues = res.body.error.details.issues as { nodeId: string; message: string }[];
    expect(issues.find((i) => i.nodeId === 'h1')!.message).toMatch(/host/);
    expect(issues.find((i) => i.nodeId === 'h2')!.message).toMatch(/JSON/);
  });
});

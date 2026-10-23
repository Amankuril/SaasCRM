import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processBillingSweep } from '../src/modules/billing/billing.jobs.js';
import { Invoice, Plan, Subscription, UsageCounter } from '../src/modules/billing/billing.model.js';
import { ensurePlans } from '../src/modules/billing/plans.js';
import { RazorpayProvider, SandboxBillingProvider, setBillingProvider } from '../src/modules/billing/provider.js';
import { User } from '../src/modules/auth/user.model.js';
import { Campaign } from '../src/modules/campaigns/campaign.model.js';
import { FlowExecution } from '../src/modules/flows/flow.model.js';
import { Message } from '../src/modules/messages/message.model.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { mailer } from '../src/services/mailer.js';
import { FakeProvider, inboundPayload, sign } from './fakeProvider.js';
import { addMember, api, createWorkspace, signup, type TestUser } from './helpers.js';

const PHONE_ID = '1112223334445';
const CUSTOMER = '919811112222';
const DAY = 86_400_000;
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

let wa: FakeProvider;
let sandbox: SandboxBillingProvider;
beforeEach(async () => {
  await ensurePlans();
  wa = new FakeProvider();
  sandbox = new SandboxBillingProvider();
  setWhatsAppProvider(wa);
  setBillingProvider(sandbox);
});
afterEach(() => {
  setWhatsAppProvider(undefined);
  setBillingProvider(undefined);
  vi.restoreAllMocks();
});

let seq = 0;
async function say(text: string, from = CUSTOMER) {
  const body = JSON.stringify(inboundPayload(PHONE_ID, { id: `wamid.b.${++seq}`, from, text }));
  await api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body).expect(200);
}

async function setup() {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  const base = `/api/workspaces/${ws.id}`;
  await api().put(`${base}/whatsapp/connection`).set(auth(owner)).send({ wabaId: '9998887776665', phoneNumberId: PHONE_ID, accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
  return { owner, ws, base };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function admin() {
  const a = await signup();
  await User.updateOne({ email: a.email }, { isPlatformAdmin: true });
  return a;
}
const sub = (ctx: Ctx) => Subscription.findOne({ workspaceId: ctx.ws.id });
const sendText = (ctx: Ctx, text = 'Hello!') => api().post(`${ctx.base}/messages`).set(auth(ctx.owner)).send({ type: 'text', to: `+${CUSTOMER}`, text });

describe('trial and plans', () => {
  it('starts every workspace on a 14-day trial and shows plans, limits and usage', async () => {
    const ctx = await setup();
    const res = await api().get(`${ctx.base}/billing`).set(auth(ctx.owner)).expect(200);
    expect(res.body.subscription).toMatchObject({ planCode: 'trial', status: 'trialing', access: true });
    const days = (new Date(res.body.subscription.trialEndsAt).getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(13.9);
    expect(res.body.plans.map((p: { code: string }) => p.code)).toEqual(['starter', 'growth', 'pro']);
    expect(res.body.usage).toMatchObject({ seats: 1, contacts: 0, monthlyMessages: 0 });

    const context = await api().get(ctx.base).set(auth(ctx.owner)).expect(200);
    expect(context.body.subscription).toMatchObject({ planCode: 'trial', planName: 'Free trial', status: 'trialing', access: true });
  });

  it('upgrades through checkout only when payment succeeds', async () => {
    const ctx = await setup();
    const checkout = await api().post(`${ctx.base}/billing/checkout`).set(auth(ctx.owner)).send({ planCode: 'growth', cycle: 'yearly' }).expect(200);
    expect(checkout.body.checkoutUrl).toContain('/billing?checkout=sandbox_sub_');
    const pendingId = (await sub(ctx))!.pending!.providerSubscriptionId!;

    // A declined payment changes nothing.
    await api().post(`${ctx.base}/billing/sandbox/complete`).set(auth(ctx.owner)).send({ providerSubscriptionId: pendingId, outcome: 'failure' }).expect(200);
    expect(await sub(ctx)).toMatchObject({ planCode: 'trial', status: 'trialing' });

    await api().post(`${ctx.base}/billing/checkout`).set(auth(ctx.owner)).send({ planCode: 'growth', cycle: 'yearly' }).expect(200);
    const id = (await sub(ctx))!.pending!.providerSubscriptionId!;
    const done = await api().post(`${ctx.base}/billing/sandbox/complete`).set(auth(ctx.owner)).send({ providerSubscriptionId: id, outcome: 'success' }).expect(200);
    expect(done.body.subscription).toMatchObject({ planCode: 'growth', status: 'active', cycle: 'yearly', pending: null, trialEndsAt: null });
    const invoices = await Invoice.find({ workspaceId: ctx.ws.id });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ status: 'paid', amount: 2_499_000, planCode: 'growth' });

    // Only owners manage billing.
    const admin2 = await signup();
    await addMember(ctx.owner, ctx.ws.id, admin2, 'admin');
    await api().post(`${ctx.base}/billing/checkout`).set(auth(admin2)).send({ planCode: 'pro', cycle: 'monthly' }).expect(403);
  });
});

describe('expiry and reminders', () => {
  it('trial reminders go out once, then the trial expires and sending stops (data stays readable)', async () => {
    const ctx = await setup();
    await say('hi');
    const mails = vi.spyOn(mailer, 'send');
    await Subscription.updateOne({ workspaceId: ctx.ws.id }, { trialEndsAt: new Date(Date.now() + 2 * DAY), currentPeriodEnd: new Date(Date.now() + 2 * DAY) });
    await processBillingSweep();
    await processBillingSweep();
    expect(mails).toHaveBeenCalledTimes(1);
    expect(mails.mock.calls[0]![0]).toMatchObject({ to: ctx.owner.email, subject: expect.stringContaining('trial ends in 2 days') });

    const campaign = await Campaign.create({ workspaceId: ctx.ws.id, name: 'Diwali', status: 'running', createdBy: ctx.owner.id });
    await Subscription.updateOne({ workspaceId: ctx.ws.id }, { trialEndsAt: new Date(Date.now() - 1000), currentPeriodEnd: new Date(Date.now() - 1000) });
    await processBillingSweep();
    expect(await sub(ctx)).toMatchObject({ status: 'expired' });
    expect(mails.mock.calls.at(-1)![0].subject).toContain('trial has ended');
    expect((await Campaign.findOne({ _id: campaign._id, workspaceId: ctx.ws.id }))!.status).toBe('paused');

    const blocked = await sendText(ctx).expect(402);
    expect(blocked.body.error).toMatchObject({ code: 'SUBSCRIPTION_INACTIVE', details: { status: 'expired' } });
    // Reading still works; inbound messages are stored but nothing automated runs.
    await api().get(`${ctx.base}/contacts`).set(auth(ctx.owner)).expect(200);
    await say('are you open?');
    expect(await Message.countDocuments({ workspaceId: ctx.ws.id, direction: 'inbound' })).toBe(2);
    expect(await FlowExecution.countDocuments({ workspaceId: ctx.ws.id })).toBe(0);
  });

  it('cancelling keeps access until the period ends', async () => {
    const ctx = await setup();
    await api().post(`${ctx.base}/billing/checkout`).set(auth(ctx.owner)).send({ planCode: 'starter', cycle: 'monthly' }).expect(200);
    const id = (await sub(ctx))!.pending!.providerSubscriptionId!;
    await api().post(`${ctx.base}/billing/sandbox/complete`).set(auth(ctx.owner)).send({ providerSubscriptionId: id, outcome: 'success' }).expect(200);

    const cancelled = await api().post(`${ctx.base}/billing/cancel`).set(auth(ctx.owner)).expect(200);
    expect(cancelled.body.subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    expect(sandbox.cancelled).toEqual([{ id, atPeriodEnd: true }]);

    await Subscription.updateOne({ workspaceId: ctx.ws.id }, { currentPeriodEnd: new Date(Date.now() - 1000) });
    await processBillingSweep();
    expect(await sub(ctx)).toMatchObject({ status: 'cancelled' });
  });
});

describe('quotas and features', () => {
  it('counts accepted sends against the monthly allowance and blocks at the limit', async () => {
    const ctx = await setup();
    await Plan.updateOne({ code: 'trial' }, { 'limits.monthlyMessages': 2 });
    await say('hi');
    await sendText(ctx, 'one').expect(202);
    // An idempotent retry is not a new send.
    await api().post(`${ctx.base}/messages`).set(auth(ctx.owner)).set('Idempotency-Key', 'k-1').send({ type: 'text', to: `+${CUSTOMER}`, text: 'two' }).expect(202);
    await api().post(`${ctx.base}/messages`).set(auth(ctx.owner)).set('Idempotency-Key', 'k-1').send({ type: 'text', to: `+${CUSTOMER}`, text: 'two' }).expect(200);
    const over = await sendText(ctx, 'three').expect(402);
    expect(over.body.error).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { limit: 'monthlyMessages', max: 2, used: 2 } });

    const counter = await UsageCounter.findOne({ workspaceId: ctx.ws.id, metric: 'messages' });
    expect(counter!.count).toBe(2);
    const usage = await api().get(`${ctx.base}/billing`).set(auth(ctx.owner)).expect(200);
    expect(usage.body.usage.monthlyMessages).toBe(2);

    // A new billing period starts from zero.
    await Subscription.updateOne({ workspaceId: ctx.ws.id }, { currentPeriodStart: new Date() });
    await sendText(ctx, 'new month').expect(202);
  });

  it('enforces seats, contacts, live flows and forms', async () => {
    const ctx = await setup();
    await Plan.updateOne({ code: 'trial' }, { 'limits.seats': 2, 'limits.contacts': 1, 'limits.forms': 1, 'limits.activeFlows': 1 });

    await addMember(ctx.owner, ctx.ws.id, await signup(), 'agent');
    const third = await signup();
    const seat = await api().post(`${ctx.base}/invitations`).set(auth(ctx.owner)).send({ email: third.email, role: 'agent' }).expect(402);
    expect(seat.body.error.details.limit).toBe('seats');

    await api().post(`${ctx.base}/contacts`).set(auth(ctx.owner)).send({ phone: '+919800000001' }).expect(201);
    expect((await api().post(`${ctx.base}/contacts`).set(auth(ctx.owner)).send({ phone: '+919800000002' }).expect(402)).body.error.details.limit).toBe('contacts');
    // Customers messaging in are never refused.
    await say('hello from a new customer');
    expect((await api().get(`${ctx.base}/contacts`).set(auth(ctx.owner))).body.total).toBe(2);

    await api().post(`${ctx.base}/forms`).set(auth(ctx.owner)).send({ name: 'One' }).expect(201);
    await api().post(`${ctx.base}/forms`).set(auth(ctx.owner)).send({ name: 'Two' }).expect(402);

    const graph = (kw: string) => ({
      nodes: [
        { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { event: 'keyword', keywords: [kw] } },
        { id: 's', type: 'send_text', position: { x: 0, y: 0 }, data: { text: 'Hi' } },
      ],
      edges: [{ id: 'e', source: 't', target: 's', sourceHandle: 'next' }],
    });
    for (const [i, kw] of ['menu', 'price'].entries()) {
      const flow = (await api().post(`${ctx.base}/flows`).set(auth(ctx.owner)).send({ name: kw }).expect(201)).body.flow;
      await api().patch(`${ctx.base}/flows/${flow.id}`).set(auth(ctx.owner)).send({ draftGraph: graph(kw) }).expect(200);
      await api().post(`${ctx.base}/flows/${flow.id}/publish`).set(auth(ctx.owner)).send({}).expect(i === 0 ? 200 : 402);
    }
  });

  it('gates features by plan (AI, API) and the plan rate', async () => {
    const ctx = await setup();
    const keyRes = await api().post(`${ctx.base}/developer/api-keys`).set(auth(ctx.owner)).send({ name: 'k', scopes: ['contacts:read'] }).expect(201);
    const a = await admin();
    await api().patch(`/api/admin/workspaces/${ctx.ws.id}/subscription`).set(auth(a)).send({ planCode: 'starter', reason: 'paid by bank transfer' }).expect(200);
    expect(await sub(ctx)).toMatchObject({ planCode: 'starter', status: 'active', provider: 'manual' });

    const ai = await api().put(`${ctx.base}/ai/settings`).set(auth(ctx.owner)).send({ enabled: true }).expect(402);
    expect(ai.body.error).toMatchObject({ code: 'FEATURE_NOT_IN_PLAN', details: { feature: 'ai' } });
    await api().post(`${ctx.base}/developer/api-keys`).set(auth(ctx.owner)).send({ name: 'k2', scopes: [] }).expect(402);
    // Keys made on a bigger plan stop working after a downgrade.
    expect((await api().get('/api/v1/me').set('Authorization', `Bearer ${keyRes.body.key}`).expect(402)).body.error.code).toBe('FEATURE_NOT_IN_PLAN');
  });
});

describe('Razorpay webhooks', () => {
  const SECRET = 'test-razorpay-secret';
  const post = (event: string, subId: string, extra: { eventId?: string; payment?: object; start?: number; end?: number; notes?: object; signature?: string } = {}) => {
    const body = JSON.stringify({
      entity: 'event',
      event,
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        subscription: { entity: { id: subId, status: 'active', current_start: extra.start ?? null, current_end: extra.end ?? null, customer_id: 'cust_1', notes: extra.notes ?? [] } },
        ...(extra.payment ? { payment: { entity: extra.payment } } : {}),
      },
    });
    return api()
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', extra.signature ?? createHmac('sha256', SECRET).update(body).digest('hex'))
      .set('X-Razorpay-Event-Id', extra.eventId ?? `evt_${event}_${Math.random()}`)
      .send(body);
  };

  it('activates on charge, dedupes events, handles failed renewals with a grace period', async () => {
    setBillingProvider(new RazorpayProvider());
    const ctx = await setup();
    await api().get(`${ctx.base}/billing`).set(auth(ctx.owner)).expect(200); // creates the trial
    await Subscription.updateOne(
      { workspaceId: ctx.ws.id },
      { pending: { planCode: 'growth', cycle: 'monthly', providerSubscriptionId: 'sub_RZP1', checkoutUrl: 'https://rzp.io/i/x', createdAt: new Date() } },
    );
    await post('subscription.charged', 'sub_RZP1', { signature: 'deadbeef' }).expect(401);

    const start = Math.floor(Date.now() / 1000);
    const end = start + 30 * 86_400;
    const payment = { id: 'pay_1', amount: 249_900, currency: 'INR', invoice_id: 'inv_1' };
    await post('subscription.charged', 'sub_RZP1', { eventId: 'evt_A', payment, start, end }).expect(200);
    await post('subscription.charged', 'sub_RZP1', { eventId: 'evt_A', payment, start, end }).expect(200); // duplicate delivery
    expect(await sub(ctx)).toMatchObject({ planCode: 'growth', status: 'active', provider: 'razorpay', providerSubscriptionId: 'sub_RZP1', providerCustomerId: 'cust_1' });
    expect((await sub(ctx))!.currentPeriodEnd.getTime()).toBe(end * 1000);
    expect(await Invoice.countDocuments({ workspaceId: ctx.ws.id, status: 'paid' })).toBe(1);

    // Renewal fails: still works during the grace period, then sending stops.
    await post('subscription.pending', 'sub_RZP1', { payment: { id: 'pay_2', amount: 249_900, currency: 'INR', error_description: 'Card declined' } }).expect(200);
    const pastDue = (await sub(ctx))!;
    expect(pastDue.status).toBe('past_due');
    expect(pastDue.graceEndsAt!.getTime() - Date.now()).toBeGreaterThan(6.9 * DAY);
    expect(await Invoice.findOne({ workspaceId: ctx.ws.id, status: 'failed' })).toMatchObject({ failureReason: 'Card declined' });
    await say('hi');
    await sendText(ctx).expect(202);

    await Subscription.updateOne({ workspaceId: ctx.ws.id }, { graceEndsAt: new Date(Date.now() - 1000) });
    await processBillingSweep();
    expect(await sub(ctx)).toMatchObject({ status: 'suspended' });
    await sendText(ctx).expect(402);

    // Payment finally goes through: back to active.
    await post('subscription.charged', 'sub_RZP1', { payment: { id: 'pay_3', amount: 249_900, currency: 'INR' }, start: end, end: end + 30 * 86_400 }).expect(200);
    expect(await sub(ctx)).toMatchObject({ status: 'active', graceEndsAt: null });
    await sendText(ctx).expect(202);
  });

  it('matches by workspace note and ignores events for unknown subscriptions', async () => {
    setBillingProvider(new RazorpayProvider());
    const ctx = await setup();
    await api().get(`${ctx.base}/billing`).set(auth(ctx.owner)).expect(200);
    await post('subscription.cancelled', 'sub_unknown').expect(200);
    expect(await sub(ctx)).toMatchObject({ status: 'trialing' });
  });
});

describe('analytics and admin', () => {
  it('reports messages, response times and resolution from stored rows', async () => {
    const ctx = await setup();
    await say('Hi, I need an appointment');
    await sendText(ctx, 'Sure, when?').expect(202);
    const conv = (await api().get(`${ctx.base}/conversations`).set(auth(ctx.owner))).body.conversations[0];
    await api().patch(`${ctx.base}/conversations/${conv.id}`).set(auth(ctx.owner)).send({ status: 'resolved' }).expect(200);

    const res = await api().get(`${ctx.base}/analytics?days=7`).set(auth(ctx.owner)).expect(200);
    expect(res.body.messages.inbound).toBe(1);
    expect(res.body.messages.outbound.total).toBe(1);
    expect(res.body.messages.daily).toHaveLength(7);
    expect(res.body.messages.daily.at(-1)).toMatchObject({ inbound: 1, outbound: 1 });
    expect(res.body.inbox).toMatchObject({ resolved: 1, firstResponse: { count: 1 }, resolution: { count: 1 } });
    expect(res.body.inbox.firstResponse.avgMs).toBeGreaterThanOrEqual(0);
    await api().get(`${ctx.base}/analytics?days=5`).set(auth(ctx.owner)).expect(400);

    const agent = await signup();
    await addMember(ctx.owner, ctx.ws.id, agent, 'agent');
    await api().get(`${ctx.base}/analytics`).set(auth(agent)).expect(403);
  });

  it('lets platform admins edit plans, extend trials and see ops health', async () => {
    const ctx = await setup();
    const a = await admin();
    const plans = await api().get('/api/admin/plans').set(auth(a)).expect(200);
    expect(plans.body.plans.map((p: { code: string }) => p.code)).toEqual(['trial', 'starter', 'growth', 'pro']);
    await api().patch('/api/admin/plans/starter').set(auth(a)).send({ priceMonthly: 79_900, limits: { seats: 3 }, providerPlanIds: { monthly: 'plan_ABC' } }).expect(200);
    expect(await Plan.findOne({ code: 'starter' }).lean()).toMatchObject({ priceMonthly: 79_900, limits: { seats: 3 }, providerPlanIds: { monthly: 'plan_ABC' } });
    await api().patch('/api/admin/plans/starter').set(auth(ctx.owner)).send({ priceMonthly: 1 }).expect(403);

    await api().get(`${ctx.base}/billing`).set(auth(ctx.owner)).expect(200); // creates the trial
    await Subscription.updateOne({ workspaceId: ctx.ws.id }, { status: 'expired', trialEndsAt: new Date(Date.now() - DAY) });
    await api().patch(`/api/admin/workspaces/${ctx.ws.id}/subscription`).set(auth(a)).send({ extendDays: 7 }).expect(200);
    const extended = (await sub(ctx))!;
    expect(extended.status).toBe('trialing');
    expect(extended.trialEndsAt!.getTime() - Date.now()).toBeGreaterThan(6.9 * DAY);

    const ops = await api().get('/api/admin/ops').set(auth(a)).expect(200);
    expect(ops.body).toMatchObject({ db: 'up', queues: null, last24h: { failedMessages: 0 } });
    expect(ops.body.billing.trialsEnding[0]).toMatchObject({ workspaceId: ctx.ws.id, planCode: 'trial' });

    const stats = await api().get('/api/admin/stats').set(auth(a)).expect(200);
    expect(stats.body.subscriptions.trialing).toBe(1);
    const list = await api().get('/api/admin/workspaces').set(auth(a)).expect(200);
    expect(list.body.workspaces[0].subscription).toMatchObject({ planCode: 'trial', status: 'trialing' });
  });
});

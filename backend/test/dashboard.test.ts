import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { User } from '../src/modules/auth/user.model.js';
import { RazorpayProvider, SandboxBillingProvider, setBillingProvider } from '../src/modules/billing/provider.js';
import { api, createWorkspace, signup, type TestUser } from './helpers.js';

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

beforeEach(() => setBillingProvider(new SandboxBillingProvider()));
afterEach(() => setBillingProvider(undefined));

describe('main dashboard', () => {
  it('loads for a workspace without WhatsApp and points at what needs attention', async () => {
    const owner = await signup();
    const ws = await createWorkspace(owner);
    const base = `/api/workspaces/${ws.id}`;

    const res = await api().get(`${base}/dashboard`).set(auth(owner)).expect(200);
    expect(res.body.waba).toBeNull();
    expect(res.body.health).toBeNull();
    expect(res.body.metaError).toBeNull();
    expect(res.body.overview).toMatchObject({ contacts: 0, conversationsToday: 0, activeFlows: 0, campaignsRunning: 0, messages: { sent: 0, delivered: 0, read: 0 } });
    expect(res.body.profile).toMatchObject({ businessName: 'Acme Clinic', plan: { status: 'trialing' } });
    expect(res.body.limits.templates).toMatchObject({ total: 0, quota: 250 });
    expect(res.body.connectors.map((c: { key: string }) => c.key)).toEqual(['google_sheets', 'webhooks', 'meta_ads', 'crm']);

    const notes = await api().get(`${base}/dashboard/notifications`).set(auth(owner)).expect(200);
    expect(notes.body.notifications.map((n: { id: string }) => n.id)).toContain('wa-none');
  });

  it('is private to the workspace', async () => {
    const owner = await signup();
    const ws = await createWorkspace(owner);
    const stranger = await signup();
    await api().get(`/api/workspaces/${ws.id}/dashboard`).set(auth(stranger)).expect(404);
  });
});

describe('super admin revenue', () => {
  it('reports recurring revenue and lists, filters and exports payments', async () => {
    const admin = await signup();
    await User.updateOne({ email: admin.email }, { isPlatformAdmin: true });
    const owner = await signup();
    const ws = await createWorkspace(owner, 'Paying Clinic');
    const base = `/api/workspaces/${ws.id}`;

    await api().get('/api/admin/revenue').set(auth(owner)).expect(403);

    const checkout = await api().post(`${base}/billing/checkout`).set(auth(owner)).send({ planCode: 'starter', cycle: 'monthly' }).expect(200);
    await api().post(`${base}/billing/sandbox/complete`).set(auth(owner)).send({ providerSubscriptionId: checkout.body.providerSubscriptionId, outcome: 'success' }).expect(200);

    const revenue = await api().get('/api/admin/revenue?days=30').set(auth(admin)).expect(200);
    expect(revenue.body).toMatchObject({ mrr: 99_900, arr: 99_900 * 12, payingCustomers: 1, arpa: 99_900, collected: 99_900, payments: 1 });
    expect(revenue.body.series).toHaveLength(30);
    expect(revenue.body.planMix).toEqual([{ planCode: 'starter', planName: 'Starter', customers: 1, mrr: 99_900 }]);

    const list = await api().get('/api/admin/payments?q=paying').set(auth(admin)).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.payments[0]).toMatchObject({ workspaceName: 'Paying Clinic', planName: 'Starter', amount: 99_900, status: 'paid' });
    expect((await api().get('/api/admin/payments?status=failed').set(auth(admin)).expect(200)).body.total).toBe(0);

    const csv = await api().get('/api/admin/payments?format=csv').set(auth(admin)).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')).toHaveLength(2);
    expect(csv.text).toContain('Paying Clinic,Starter,monthly,999.00,INR,paid');
  });

  it('creates a plan from a copy of another plan', async () => {
    const admin = await signup();
    await User.updateOne({ email: admin.email }, { isPlatformAdmin: true });
    const body = { code: 'enterprise', name: 'Enterprise', priceMonthly: 1_500_000, priceYearly: 15_000_000, copyFrom: 'pro' };
    const created = await api().post('/api/admin/plans').set(auth(admin)).send(body).expect(201);
    expect(created.body.plan).toMatchObject({ code: 'enterprise', isPublic: false, limits: { contacts: 100_000, seats: 15 }, features: { ai: true } });
    expect((await api().post('/api/admin/plans').set(auth(admin)).send(body).expect(409)).body.error.code).toBe('PLAN_EXISTS');
    const plans = await api().get('/api/admin/plans').set(auth(admin)).expect(200);
    expect(plans.body.plans.map((p: { code: string }) => p.code)).toContain('enterprise');
  });
});

describe('razorpay checkout confirmation', () => {
  it('rejects a payment whose signature does not match', async () => {
    const secret = env.RAZORPAY_KEY_SECRET;
    env.RAZORPAY_KEY_SECRET = 'test_secret';
    try {
      const provider = new RazorpayProvider();
      const proof = { paymentId: 'pay_1', subscriptionId: 'sub_1', signature: createHmac('sha256', 'someone_else').update('pay_1|sub_1').digest('hex') };
      await expect(provider.confirmCheckout(proof, 'ws')).rejects.toMatchObject({ code: 'PAYMENT_NOT_VERIFIED' });
    } finally {
      env.RAZORPAY_KEY_SECRET = secret;
    }
  });
});

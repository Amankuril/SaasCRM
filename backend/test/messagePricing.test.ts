import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { User } from '../src/modules/auth/user.model.js';
import { Contact } from '../src/modules/contacts/contact.model.js';
import { Message } from '../src/modules/messages/message.model.js';
import { MessageDailyRollup, RateCard } from '../src/modules/reports/messagePricing.model.js';
import { rateFor } from '../src/modules/reports/messagePricing.service.js';
import { parsePricing } from '../src/modules/whatsapp/provider/metaWebhook.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { Workspace } from '../src/modules/workspaces/workspace.model.js';
import { FakeProvider, inboundPayload, sign, statusPayload } from './fakeProvider.js';
import { addMember, api, createWorkspace, signup, type TestUser } from './helpers.js';

const PHONE_ID = '1112223334445';
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

let fake: FakeProvider;
beforeEach(() => {
  fake = new FakeProvider();
  setWhatsAppProvider(fake);
});
afterEach(() => setWhatsAppProvider(undefined));

function postWebhook(payload: unknown) {
  const body = JSON.stringify(payload);
  return api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body);
}

async function setup() {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  await api().put(`/api/workspaces/${ws.id}/whatsapp/connection`).set(auth(owner)).send({ wabaId: '9998887776665', phoneNumberId: PHONE_ID, accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
  const contact = await Contact.create({ workspaceId: ws.id, phoneE164: '+919811112222', name: 'Ravi' });
  return { owner, ws, base: `/api/workspaces/${ws.id}/reports/message-pricing`, contact };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** A stored message at an exact instant, optionally already priced. */
function seed(ctx: Ctx, at: string, direction: 'inbound' | 'outbound', pricing?: { type: string; category: string; billable: boolean; market?: string }, extra: object = {}) {
  return Message.create({
    workspaceId: ctx.ws.id,
    contactId: ctx.contact._id,
    direction,
    type: direction === 'inbound' ? 'text' : 'template',
    status: direction === 'inbound' ? 'received' : 'delivered',
    source: direction === 'outbound' ? 'broadcast' : null,
    pricing: pricing ? { model: 'PMP', market: 'IN', raw: { ...pricing }, ...pricing } : null,
    createdAt: new Date(at),
    ...extra,
  });
}

describe('Meta pricing object', () => {
  it('reads per-message pricing: only `regular` is billable', () => {
    expect(parsePricing({ billable: true, pricing_model: 'PMP', type: 'regular', category: 'MARKETING' })).toMatchObject({ billable: true, model: 'PMP', type: 'regular', category: 'marketing' });
    expect(parsePricing({ billable: false, pricing_model: 'PMP', type: 'free_customer_service', category: 'service' })).toMatchObject({ billable: false, type: 'free_customer_service' });
    expect(parsePricing({ pricing_model: 'PMP', type: 'free_entry_point', category: 'marketing' })!.billable).toBe(false);
    // Conversation-based webhooks (before July 2025) only carry `billable`.
    expect(parsePricing({ billable: true, pricing_model: 'CBP', category: 'utility' })).toMatchObject({ billable: true, type: null, model: 'CBP' });
    expect(parsePricing(undefined)).toBeNull();
    expect(parsePricing('x')).toBeNull();
  });

  it('picks the country rate first, then "*", by date', () => {
    const rates = [
      { market: 'IN', category: 'marketing', priceInr: 0.78, validFrom: '2025-01-01', validTo: '2025-12-31' },
      { market: 'IN', category: 'marketing', priceInr: 0.86, validFrom: '2026-01-01', validTo: null },
      { market: '*', category: 'marketing', priceInr: 4.5, validFrom: '2025-01-01', validTo: null },
    ];
    expect(rateFor(rates, 'IN', 'marketing', '2025-06-01')).toBe(0.78);
    expect(rateFor(rates, 'IN', 'marketing', '2026-02-01')).toBe(0.86);
    expect(rateFor(rates, 'AE', 'marketing', '2026-02-01')).toBe(4.5);
    expect(rateFor(rates, 'IN', 'utility', '2026-02-01')).toBeNull();
    expect(rateFor(rates, 'IN', 'marketing', '2024-12-31')).toBeNull();
  });
});

describe('pricing capture from webhooks', () => {
  it('stores the first pricing Meta sends, the recipient market and the sender', async () => {
    const ctx = await setup();
    await postWebhook(inboundPayload(PHONE_ID, { id: 'wamid.in.1', from: '919811112222', text: 'Hi' })).expect(200);
    const sent = await api().post(`/api/workspaces/${ctx.ws.id}/messages`).set(auth(ctx.owner)).send({ type: 'text', to: '919811112222', text: 'Hello!' }).expect(202);
    const wamid = sent.body.message.providerMessageId as string;
    const t = Math.floor(Date.now() / 1000);
    await postWebhook(statusPayload(PHONE_ID, wamid, 'sent', t, undefined, { billable: false, pricing_model: 'PMP', type: 'free_customer_service', category: 'service' })).expect(200);
    // A later receipt with different pricing does not overwrite the first.
    await postWebhook(statusPayload(PHONE_ID, wamid, 'delivered', t + 1, undefined, { billable: true, pricing_model: 'PMP', type: 'regular', category: 'marketing' })).expect(200);

    const msg = await Message.findOne({ workspaceId: ctx.ws.id, providerMessageId: wamid }).lean();
    expect(msg!.source).toBe('inbox');
    expect(msg!.status).toBe('delivered');
    expect(msg!.pricing).toMatchObject({ billable: false, type: 'free_customer_service', category: 'service', market: 'IN', model: 'PMP' });
    expect(msg!.pricing!.raw).toEqual({ billable: false, pricing_model: 'PMP', type: 'free_customer_service', category: 'service' });
    const inbound = await Message.findOne({ workspaceId: ctx.ws.id, direction: 'inbound' }).lean();
    expect(inbound!.source).toBeNull();
  });
});

describe('message pricing report', () => {
  it('counts by IST day, splits billable by type and category, and estimates cost', async () => {
    const ctx = await setup();
    await RateCard.create({ market: 'IN', category: 'marketing', priceInr: 0.8, validFrom: '2026-01-01' });
    await RateCard.create({ market: 'IN', category: 'utility', priceInr: 0.15, validFrom: '2026-01-01' });
    // 23:50 IST on 10 Nov is 18:20 UTC: it belongs to 10 Nov, not 11 Nov.
    await seed(ctx, '2026-11-10T18:20:00Z', 'outbound', { type: 'regular', category: 'marketing', billable: true });
    // 00:10 IST on 11 Nov is still 10 Nov in UTC.
    await seed(ctx, '2026-11-10T18:40:00Z', 'outbound', { type: 'regular', category: 'utility', billable: true });
    await seed(ctx, '2026-11-11T05:00:00Z', 'outbound', { type: 'free_customer_service', category: 'service', billable: false });
    await seed(ctx, '2026-11-11T06:00:00Z', 'outbound'); // no pricing from Meta
    await seed(ctx, '2026-11-11T04:00:00Z', 'inbound');
    await seed(ctx, '2026-11-12T04:00:00Z', 'inbound');
    await seed(ctx, '2026-10-01T04:00:00Z', 'outbound', { type: 'regular', category: 'marketing', billable: true }); // out of range

    const res = await api().get(`${ctx.base}?from=2026-11-10&to=2026-11-12`).set(auth(ctx.owner)).expect(200);
    expect(res.body.totals).toEqual({ total: 6, incoming: 2, outgoing: 4, billable: 2, estCost: 0.95, unpricedBillable: 0 });
    expect(res.body.series).toEqual([
      { date: '2026-11-10', incoming: 0, outgoing: 1, billable: 1, estCost: 0.8 },
      { date: '2026-11-11', incoming: 1, outgoing: 3, billable: 1, estCost: 0.15 },
      { date: '2026-11-12', incoming: 1, outgoing: 0, billable: 0, estCost: 0 },
    ]);
    expect(res.body.breakdown).toEqual(
      expect.arrayContaining([
        { type: 'regular', category: 'marketing', total: 1, billable: 1, estCost: 0.8, unpricedBillable: 0 },
        { type: 'regular', category: 'utility', total: 1, billable: 1, estCost: 0.15, unpricedBillable: 0 },
        { type: 'free_customer_service', category: 'service', total: 1, billable: 0, estCost: 0, unpricedBillable: 0 },
        { type: 'not_available', category: 'not_available', total: 1, billable: 0, estCost: 0, unpricedBillable: 0 },
      ]),
    );
    // Finished days were stored for next time.
    expect(await MessageDailyRollup.countDocuments({ workspaceId: ctx.ws.id, day: { $in: ['2026-11-10', '2026-11-11', '2026-11-12'] }, rows: { $ne: null } })).toBe(3);

    // Filters: a pricing filter shows outgoing only; direction filters; markup applies to cost.
    const marketing = await api().get(`${ctx.base}?from=2026-11-10&to=2026-11-12&category=marketing`).set(auth(ctx.owner)).expect(200);
    expect(marketing.body.totals).toMatchObject({ total: 1, incoming: 0, outgoing: 1, billable: 1 });
    const na = await api().get(`${ctx.base}?from=2026-11-10&to=2026-11-12&type=not_available`).set(auth(ctx.owner)).expect(200);
    expect(na.body.totals.outgoing).toBe(1);
    const incoming = await api().get(`${ctx.base}?from=2026-11-10&to=2026-11-12&direction=incoming`).set(auth(ctx.owner)).expect(200);
    expect(incoming.body.totals).toMatchObject({ total: 2, outgoing: 0, billable: 0 });

    await Workspace.updateOne({ _id: ctx.ws.id }, { pricingMarkupPct: 20 });
    const marked = await api().get(`${ctx.base}?from=2026-11-10&to=2026-11-12`).set(auth(ctx.owner)).expect(200);
    expect(marked.body.totals.estCost).toBe(1.14);
    expect(marked.body.markupPct).toBe(20);

    const weekly = await api().get(`${ctx.base}?from=2026-11-10&to=2026-11-12&group=weekly`).set(auth(ctx.owner)).expect(200);
    expect(weekly.body.series).toEqual([{ date: '2026-11-09', incoming: 2, outgoing: 4, billable: 2, estCost: 1.14 }]);
  });

  it('flags billable messages with no rate instead of guessing a cost', async () => {
    const ctx = await setup();
    await seed(ctx, '2026-11-11T05:00:00Z', 'outbound', { type: 'regular', category: 'authentication', billable: true });
    const res = await api().get(`${ctx.base}?from=2026-11-11&to=2026-11-11`).set(auth(ctx.owner)).expect(200);
    expect(res.body.totals).toMatchObject({ billable: 1, estCost: 0, unpricedBillable: 1 });
  });

  it('recounts a stored day when pricing arrives later', async () => {
    const ctx = await setup();
    await seed(ctx, '2026-11-11T05:00:00Z', 'outbound', undefined, { providerMessageId: 'wamid.late', status: 'sent' });
    const before = await api().get(`${ctx.base}?from=2026-11-11&to=2026-11-11`).set(auth(ctx.owner)).expect(200);
    expect(before.body.totals.billable).toBe(0);

    await postWebhook(statusPayload(PHONE_ID, 'wamid.late', 'delivered', Math.floor(Date.now() / 1000), undefined, { billable: true, pricing_model: 'PMP', type: 'regular', category: 'marketing' })).expect(200);
    const after = await api().get(`${ctx.base}?from=2026-11-11&to=2026-11-11`).set(auth(ctx.owner)).expect(200);
    expect(after.body.totals.billable).toBe(1);
    expect(after.body.breakdown[0]).toMatchObject({ type: 'regular', category: 'marketing' });
  });

  it('matches raw message counts for every filter combination', async () => {
    const ctx = await setup();
    const kinds = [
      { type: 'regular', category: 'marketing', billable: true },
      { type: 'regular', category: 'utility', billable: true },
      { type: 'free_entry_point', category: 'marketing', billable: false },
      { type: 'free_customer_service', category: 'service', billable: false },
      undefined,
    ];
    for (let i = 0; i < 40; i += 1) {
      const day = 10 + (i % 5);
      await seed(ctx, `2026-11-${day}T0${i % 10}:00:00Z`, i % 4 === 0 ? 'inbound' : 'outbound', i % 4 === 0 ? undefined : kinds[i % kinds.length]);
    }
    const wsId = new Types.ObjectId(ctx.ws.id as string);
    for (const direction of ['all', 'incoming', 'outgoing'] as const) {
      for (const type of ['all', 'regular', 'free_entry_point', 'not_available']) {
        const res = await api().get(`${ctx.base}?from=2026-11-10&to=2026-11-14&direction=${direction}&type=${type}`).set(auth(ctx.owner)).expect(200);
        const filter: Record<string, unknown> = { workspaceId: wsId };
        if (direction === 'incoming') filter.direction = 'inbound';
        if (direction === 'outgoing' || type !== 'all') filter.direction = direction === 'incoming' ? '__none__' : 'outbound';
        if (type === 'not_available') filter['pricing.type'] = null;
        else if (type !== 'all') filter['pricing.type'] = type;
        expect(res.body.totals.total, `${direction}/${type}`).toBe(await Message.countDocuments(filter));
      }
    }
  });

  it('validates the range and checks permissions', async () => {
    const ctx = await setup();
    const tooLong = await api().get(`${ctx.base}?from=2025-01-01&to=2026-11-01`).set(auth(ctx.owner)).expect(400);
    expect(tooLong.body.error.details.from[0]).toMatch(/365/);
    await api().get(`${ctx.base}?from=2026-11-10&to=2026-11-01`).set(auth(ctx.owner)).expect(400);
    // Defaults to the last 30 days.
    const def = await api().get(ctx.base).set(auth(ctx.owner)).expect(200);
    expect(def.body.series).toHaveLength(30);

    const agent = await signup({ email: 'agent@example.com' });
    await addMember(ctx.owner, ctx.ws.id as string, agent, 'agent');
    await api().get(ctx.base).set(auth(agent)).expect(403);

    const csv = await api().get(`${ctx.base}/export?from=2026-11-10&to=2026-11-12`).set(auth(ctx.owner)).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Pricing type,Pricing category,Total messages,Billable,Est. cost (INR)');
    expect(csv.text).toContain('2026-11-11,0,0,0,0.00');
  });
});

describe('rate cards (Super Admin)', () => {
  it('creates, edits and soft-deletes rates, and only admins may', async () => {
    const admin = await signup({ email: 'root@example.com' });
    await User.updateOne({ email: admin.email }, { isPlatformAdmin: true });
    const owner = await signup({ email: 'clinic@example.com' });

    await api().get('/api/admin/rate-cards').set(auth(owner)).expect(403);
    const bad = await api().post('/api/admin/rate-cards').set(auth(admin)).send({ market: 'India', category: 'marketing', priceInr: 0.8, validFrom: '2026-01-01' }).expect(400);
    expect(bad.body.error.details.market).toBeDefined();
    const created = await api().post('/api/admin/rate-cards').set(auth(admin)).send({ market: 'in', category: 'Marketing', priceInr: 0.8, validFrom: '2026-01-01' }).expect(201);
    expect(created.body.rate).toMatchObject({ market: 'IN', category: 'marketing', priceInr: 0.8, validTo: null });
    const id = created.body.rate.id as string;

    await api().patch(`/api/admin/rate-cards/${id}`).set(auth(admin)).send({ validTo: '2025-12-31' }).expect(400);
    await api().patch(`/api/admin/rate-cards/${id}`).set(auth(admin)).send({ priceInr: 0.86 }).expect(200);
    await api().delete(`/api/admin/rate-cards/${id}`).set(auth(admin)).expect(204);
    expect((await api().get('/api/admin/rate-cards').set(auth(admin)).expect(200)).body.rates).toEqual([]);
    expect(await RateCard.findById(id).lean()).toMatchObject({ priceInr: 0.86, deletedAt: expect.any(Date) });
  });
});

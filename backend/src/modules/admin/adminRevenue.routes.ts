import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { csvCell } from '../../lib/csv.js';
import { conflict } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { FEATURE_KEYS, Invoice, LIMIT_KEYS, Plan, Subscription } from '../billing/billing.model.js';
import { toPublicPlan } from '../billing/billing.routes.js';
import { ensurePlans } from '../billing/plans.js';
import { Workspace } from '../workspaces/workspace.model.js';
import { adminLog } from './admin.service.js';
import { escapeRegex } from './adminUsers.routes.js';

const DAY = 86_400_000;

/** Mounted at /api/admin (platform admins only). All queries are deliberate cross-tenant reads. */
export const adminRevenueRouter = Router();

const revenueSchema = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) });

/** Money in: MRR/ARR, collections, failures, churn and what's renewing soon. */
adminRevenueRouter.get('/revenue', async (req, res) => {
  const { days } = parse(revenueSchema, req.query);
  await ensurePlans();
  const now = new Date();
  const from = new Date(now.getTime() - days * DAY);
  const prevFrom = new Date(from.getTime() - days * DAY);
  const x = { skipTenantScope: true };

  const [plans, subRows, daily, byPlan, previous, failed, churned, trialsStarted, renewals] = await Promise.all([
    Plan.find().lean(),
    Subscription.aggregate<{ _id: { status: string; plan: string; cycle: string }; n: number }>([{ $group: { _id: { status: '$status', plan: '$planCode', cycle: '$cycle' }, n: { $sum: 1 } } }]).option(x),
    Invoice.aggregate<{ _id: string; amount: number; n: number }>([
      { $match: { status: 'paid', paidAt: { $gte: from } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt' } }, amount: { $sum: '$amount' }, n: { $sum: 1 } } },
    ]).option(x),
    Invoice.aggregate<{ _id: string; amount: number; n: number }>([{ $match: { status: 'paid', paidAt: { $gte: from } } }, { $group: { _id: '$planCode', amount: { $sum: '$amount' }, n: { $sum: 1 } } }, { $sort: { amount: -1 } }]).option(x),
    Invoice.aggregate<{ _id: null; amount: number }>([{ $match: { status: 'paid', paidAt: { $gte: prevFrom, $lt: from } } }, { $group: { _id: null, amount: { $sum: '$amount' } } }]).option(x),
    Invoice.aggregate<{ _id: null; amount: number; n: number }>([{ $match: { status: 'failed', createdAt: { $gte: from } } }, { $group: { _id: null, amount: { $sum: '$amount' }, n: { $sum: 1 } } }]).option(x),
    Subscription.countDocuments({ status: { $in: ['cancelled', 'suspended'] }, endedAt: { $gte: from }, planCode: { $ne: 'trial' } }).setOptions(x),
    Subscription.countDocuments({ createdAt: { $gte: from } }).setOptions(x),
    Subscription.find({ status: 'active', provider: { $ne: 'none' }, currentPeriodEnd: { $gte: now, $lte: new Date(now.getTime() + 14 * DAY) } })
      .setOptions(x)
      .sort({ currentPeriodEnd: 1 })
      .limit(10)
      .lean(),
  ]);

  const planOf = new Map(plans.map((p) => [p.code, p]));
  let mrr = 0;
  let paying = 0;
  let trialing = 0;
  let pastDue = 0;
  const mix = new Map<string, { customers: number; mrr: number }>();
  for (const r of subRows) {
    if (r._id.status === 'trialing') trialing += r.n;
    if (r._id.status === 'past_due') pastDue += r.n;
    const p = planOf.get(r._id.plan);
    if (!p || !(r._id.status === 'active' || r._id.status === 'past_due') || p.priceMonthly === 0) continue;
    const monthly = r.n * (r._id.cycle === 'yearly' ? p.priceYearly / 12 : p.priceMonthly);
    mrr += monthly;
    paying += r.n;
    const row = mix.get(p.code) ?? { customers: 0, mrr: 0 };
    mix.set(p.code, { customers: row.customers + r.n, mrr: row.mrr + monthly });
  }

  const byDay = new Map(daily.map((d) => [d._id, d]));
  const series = Array.from({ length: days }, (_, i) => {
    const date = new Date(from.getTime() + (i + 1) * DAY).toISOString().slice(0, 10);
    return { date, amount: byDay.get(date)?.amount ?? 0, payments: byDay.get(date)?.n ?? 0 };
  });
  const collected = daily.reduce((n, d) => n + d.amount, 0);
  const names = await Workspace.find({ _id: { $in: renewals.map((r) => r.workspaceId) } }).select('name').lean();
  const nameOf = new Map(names.map((w) => [w._id.toString(), w.name]));

  res.json({
    currency: 'INR',
    days,
    mrr: Math.round(mrr),
    arr: Math.round(mrr * 12),
    payingCustomers: paying,
    arpa: paying ? Math.round(mrr / paying) : 0,
    trialing,
    pastDue,
    collected,
    collectedPrevious: previous[0]?.amount ?? 0,
    payments: daily.reduce((n, d) => n + d.n, 0),
    failed: { count: failed[0]?.n ?? 0, amount: failed[0]?.amount ?? 0 },
    churned,
    trialsStarted,
    series,
    byPlan: byPlan.map((p) => ({ planCode: p._id, planName: planOf.get(p._id)?.name ?? p._id, amount: p.amount, payments: p.n })),
    planMix: [...mix.entries()].map(([code, v]) => ({ planCode: code, planName: planOf.get(code)?.name ?? code, customers: v.customers, mrr: Math.round(v.mrr) })).sort((a, b) => b.mrr - a.mrr),
    renewals: renewals.map((r) => {
      const p = planOf.get(r.planCode);
      return {
        workspaceId: r.workspaceId.toString(),
        workspaceName: nameOf.get(r.workspaceId.toString()) ?? 'Deleted business',
        planName: p?.name ?? r.planCode,
        cycle: r.cycle,
        amount: p ? (r.cycle === 'yearly' ? p.priceYearly : p.priceMonthly) : 0,
        renewsAt: r.currentPeriodEnd,
        cancelAtPeriodEnd: r.cancelAtPeriodEnd,
      };
    }),
  });
});

const paymentsSchema = z.object({
  status: z.enum(['paid', 'failed']).optional(),
  q: z.string().trim().max(100).optional(),
  days: z.coerce.number().int().min(1).max(730).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  format: z.enum(['json', 'csv']).default('json'),
});

/** Every payment across all businesses, newest first. `format=csv` downloads the filtered list. */
adminRevenueRouter.get('/payments', async (req, res) => {
  const input = parse(paymentsSchema, req.query);
  const filter: Record<string, unknown> = {};
  if (input.status) filter.status = input.status;
  if (input.days) filter.createdAt = { $gte: new Date(Date.now() - input.days * DAY) };
  if (input.q) {
    const rx = new RegExp(escapeRegex(input.q), 'i');
    const matches = await Workspace.find({ name: rx }).select('_id').limit(200).lean();
    filter.$or = [{ number: rx }, { providerPaymentId: rx }, { workspaceId: { $in: matches.map((w) => w._id) } }];
  }
  const csv = input.format === 'csv';
  const [rows, total] = await Promise.all([
    Invoice.find(filter)
      .setOptions({ skipTenantScope: true })
      .sort({ createdAt: -1 })
      .skip(csv ? 0 : (input.page - 1) * input.limit)
      .limit(csv ? 5_000 : input.limit)
      .lean(),
    Invoice.countDocuments(filter).setOptions({ skipTenantScope: true }),
  ]);
  const [names, plans] = await Promise.all([Workspace.find({ _id: { $in: rows.map((r) => r.workspaceId) } }).select('name').lean(), Plan.find().select('code name').lean()]);
  const nameOf = new Map(names.map((w) => [w._id.toString(), w.name]));
  const planName = new Map(plans.map((p) => [p.code, p.name]));
  const payments = rows.map((i) => ({
    id: i._id.toString(),
    number: i.number,
    workspaceId: (i.workspaceId as unknown as Types.ObjectId).toString(),
    workspaceName: nameOf.get((i.workspaceId as unknown as Types.ObjectId).toString()) ?? 'Deleted business',
    planCode: i.planCode,
    planName: planName.get(i.planCode) ?? i.planCode,
    cycle: i.cycle,
    amount: i.amount,
    currency: i.currency,
    status: i.status,
    provider: i.provider,
    providerPaymentId: i.providerPaymentId,
    failureReason: i.failureReason,
    paidAt: i.paidAt,
    createdAt: i.createdAt,
  }));

  if (csv) {
    const lines = [['invoice', 'date', 'business', 'plan', 'cycle', 'amount', 'currency', 'status', 'provider', 'payment_id', 'failure_reason'].join(',')];
    for (const p of payments) lines.push([p.number, new Date(p.createdAt).toISOString(), p.workspaceName, p.planName, p.cycle, (p.amount / 100).toFixed(2), p.currency, p.status, p.provider, p.providerPaymentId, p.failureReason].map(csvCell).join(','));
    await adminLog(req, { action: 'admin.payments_exported', metadata: { rows: payments.length, filter: { status: input.status, q: input.q, days: input.days } } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payments-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
    return;
  }
  res.json({ payments, total, pages: Math.max(1, Math.ceil(total / input.limit)) });
});

const planCreateSchema = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{1,29}$/, 'Use 2 to 30 lowercase letters, digits, - or _ (start with a letter).'),
  name: z.string().trim().min(1, 'Enter a name.').max(60),
  description: z.string().trim().max(300).default(''),
  priceMonthly: z.number().int().min(0).max(100_000_000),
  priceYearly: z.number().int().min(0).max(1_000_000_000),
  /** Limits and features start as a copy of this plan. */
  copyFrom: z.string().trim().min(1),
  isPublic: z.boolean().default(false),
});

/** A new plan (e.g. a custom enterprise deal). Limits and features are copied from an existing plan, then edited. */
adminRevenueRouter.post('/plans', async (req, res) => {
  const input = parse(planCreateSchema, req.body);
  await ensurePlans();
  const source = await Plan.findOne({ code: input.copyFrom });
  if (!source) throw conflict('PLAN_NOT_FOUND', 'The plan to copy from no longer exists.');
  if (await Plan.exists({ code: input.code })) throw conflict('PLAN_EXISTS', 'A plan with this code already exists.');
  const last = await Plan.findOne().sort({ sortOrder: -1 }).select('sortOrder').lean();
  const from = source.toObject();
  const plan = await Plan.create({
    code: input.code,
    name: input.name,
    description: input.description,
    priceMonthly: input.priceMonthly,
    priceYearly: input.priceYearly,
    currency: from.currency,
    limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, from.limits?.[k] ?? null])),
    features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, from.features?.[k] ?? false])),
    trialDays: 0,
    graceDays: from.graceDays,
    isPublic: input.isPublic,
    sortOrder: (last?.sortOrder ?? 0) + 1,
  });
  await adminLog(req, { action: 'admin.plan_created', targetType: 'plan', targetId: plan.code, metadata: { copyFrom: source.code, priceMonthly: plan.priceMonthly, priceYearly: plan.priceYearly } });
  res.status(201).json({ plan: toPublicPlan(plan) });
});

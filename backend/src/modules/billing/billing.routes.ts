import express, { Router } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { isProd } from '../../config/env.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { audit } from '../audit/audit.service.js';
import { Contact } from '../contacts/contact.model.js';
import { Flow } from '../flows/flow.model.js';
import { Form } from '../forms/form.model.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { ACCESS_STATUSES, Invoice, LIMIT_KEYS, Plan, type PlanDoc, type SubscriptionDoc, type SubscriptionStatus } from './billing.model.js';
import { addCycle, applyProviderEvent, getEntitlements, getPlan, usageFor } from './billing.service.js';
import { ensurePlans } from './plans.js';
import { billingProvider, type BillingCycle } from './provider.js';

export function toPublicPlan(p: PlanDoc) {
  return {
    code: p.code,
    name: p.name,
    description: p.description,
    currency: p.currency,
    priceMonthly: p.priceMonthly,
    priceYearly: p.priceYearly,
    limits: p.limits,
    features: p.features,
    trialDays: p.trialDays,
    graceDays: p.graceDays,
    isPublic: p.isPublic,
    purchasable: { monthly: !!p.providerPlanIds?.monthly, yearly: !!p.providerPlanIds?.yearly },
  };
}

export function toPublicSubscription(s: SubscriptionDoc) {
  return {
    planCode: s.planCode,
    status: s.status,
    access: ACCESS_STATUSES.has(s.status as SubscriptionStatus),
    cycle: s.cycle,
    currentPeriodStart: s.currentPeriodStart,
    currentPeriodEnd: s.currentPeriodEnd,
    trialEndsAt: s.trialEndsAt,
    graceEndsAt: s.graceEndsAt,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    endedAt: s.endedAt,
    provider: s.provider,
    pending: s.pending?.planCode ? { planCode: s.pending.planCode, cycle: s.pending.cycle, checkoutUrl: s.pending.checkoutUrl, createdAt: s.pending.createdAt } : null,
    lastPaymentAt: s.lastPaymentAt,
  };
}

/** Current counts for every limit, for quota bars. */
export async function usageSummary(workspaceId: Types.ObjectId, periodStart: Date) {
  const [metered, contacts, seats, activeFlows, forms] = await Promise.all([
    usageFor(workspaceId, periodStart),
    Contact.countDocuments({ workspaceId }),
    WorkspaceMember.countDocuments({ workspaceId }),
    Flow.countDocuments({ workspaceId, status: 'active' }),
    Form.countDocuments({ workspaceId }),
  ]);
  return { contacts, seats, monthlyMessages: metered.messages, activeFlows, forms, aiRepliesPerMonth: metered.ai_replies, apiRequests: metered.api_requests };
}

const checkoutSchema = z.object({ planCode: z.string().trim().min(1), cycle: z.enum(['monthly', 'yearly']) });

/** Mounted at /api/workspaces/:workspaceId/billing (workspace already loaded). */
export const billingRouter = Router({ mergeParams: true });

billingRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const e = await getEntitlements(workspaceId);
  await ensurePlans();
  const [plans, invoices, usage] = await Promise.all([
    Plan.find({ isPublic: true }).sort({ sortOrder: 1 }),
    Invoice.find({ workspaceId }).sort({ createdAt: -1 }).limit(24).lean(),
    usageSummary(workspaceId, e.subscription.currentPeriodStart),
  ]);
  res.json({
    subscription: toPublicSubscription(e.subscription),
    plan: toPublicPlan(e.plan),
    usage,
    limitKeys: LIMIT_KEYS,
    plans: plans.map(toPublicPlan),
    provider: billingProvider().name,
    invoices: invoices.map((i) => ({
      id: i._id.toString(),
      number: i.number,
      planCode: i.planCode,
      cycle: i.cycle,
      amount: i.amount,
      currency: i.currency,
      status: i.status,
      periodStart: i.periodStart,
      periodEnd: i.periodEnd,
      failureReason: i.failureReason,
      paidAt: i.paidAt,
      createdAt: i.createdAt,
    })),
  });
});

/** Starts a payment for a plan; the plan switches only when the provider confirms payment. */
billingRouter.post('/checkout', requirePermission('billing:manage'), async (req, res) => {
  const { planCode, cycle } = parse(checkoutSchema, req.body);
  const workspaceId = req.workspace!._id;
  const plan = await Plan.findOne({ code: planCode, isPublic: true });
  if (!plan) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', { planCode: ['Choose a plan.'] });
  const { subscription: sub } = await getEntitlements(workspaceId);
  if (sub.status === 'active' && sub.planCode === plan.code && sub.cycle === cycle && !sub.cancelAtPeriodEnd) {
    throw conflict('ALREADY_ON_PLAN', `You are already on the ${plan.name} plan.`);
  }

  const session = await billingProvider().createCheckout({ workspaceId: workspaceId.toString(), plan, cycle, email: req.user!.email });
  sub.set({ pending: { planCode: plan.code, cycle, providerSubscriptionId: session.providerSubscriptionId, checkoutUrl: session.checkoutUrl, createdAt: new Date() } });
  await sub.save();
  await audit(req, { workspaceId, action: 'billing.checkout_started', metadata: { plan: plan.code, cycle, provider: billingProvider().name } });
  res.json({ checkoutUrl: session.checkoutUrl, provider: billingProvider().name });
});

billingRouter.post('/cancel', requirePermission('billing:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const { subscription: sub } = await getEntitlements(workspaceId);
  if (sub.status !== 'active' || sub.provider === 'none') throw conflict('NOTHING_TO_CANCEL', 'There is no paid plan to cancel.');
  if (sub.providerSubscriptionId && (sub.provider === 'razorpay' || sub.provider === 'sandbox')) await billingProvider().cancel(sub.providerSubscriptionId, true);
  sub.cancelAtPeriodEnd = true;
  await sub.save();
  await audit(req, { workspaceId, action: 'billing.cancel_scheduled', metadata: { plan: sub.planCode, endsAt: sub.currentPeriodEnd } });
  res.json({ subscription: toPublicSubscription(sub) });
});

billingRouter.post('/checkout/discard', requirePermission('billing:manage'), async (req, res) => {
  const { subscription: sub } = await getEntitlements(req.workspace!._id);
  sub.set({ pending: { planCode: null, cycle: null, providerSubscriptionId: null, checkoutUrl: null, createdAt: null } });
  await sub.save();
  res.json({ subscription: toPublicSubscription(sub) });
});

const sandboxSchema = z.object({ providerSubscriptionId: z.string().min(1), outcome: z.enum(['success', 'failure']) });

/**
 * Sandbox only: completes a fake checkout the way a Razorpay webhook would
 * (development/demos, never in production).
 */
billingRouter.post('/sandbox/complete', requirePermission('billing:manage'), async (req, res) => {
  if (isProd || billingProvider().name !== 'sandbox') throw notFound();
  const { providerSubscriptionId, outcome } = parse(sandboxSchema, req.body);
  const workspaceId = req.workspace!._id;
  const { subscription: sub } = await getEntitlements(workspaceId);
  if (sub.pending?.providerSubscriptionId !== providerSubscriptionId) throw conflict('CHECKOUT_NOT_FOUND', 'This checkout is no longer open.');
  const plan = await getPlan(sub.pending.planCode!);
  const cycle = sub.pending.cycle as BillingCycle;
  const now = new Date();
  const base = { providerSubscriptionId, workspaceId: workspaceId.toString(), customerId: null };
  if (outcome === 'success') {
    await applyProviderEvent('sandbox', {
      ...base,
      eventId: `sandbox:${providerSubscriptionId}:charged`,
      type: 'charged',
      periodStart: now,
      periodEnd: addCycle(now, cycle),
      payment: { id: `sandbox_pay_${providerSubscriptionId}`, amount: cycle === 'yearly' ? plan.priceYearly : plan.priceMonthly, currency: plan.currency, invoiceId: null, failureReason: null },
    });
  } else {
    // A declined first payment leaves the current plan untouched.
    sub.set({ pending: { planCode: null, cycle: null, providerSubscriptionId: null, checkoutUrl: null, createdAt: null } });
    await sub.save();
  }
  const fresh = await getEntitlements(workspaceId);
  res.json({ subscription: toPublicSubscription(fresh.subscription), plan: toPublicPlan(fresh.plan) });
});

/** Razorpay webhook. Mounted under /api/webhooks (raw body, before the JSON parser). */
export const billingWebhookRouter = Router();

billingWebhookRouter.post('/razorpay', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const provider = billingProvider();
  if (provider.name !== 'razorpay') throw notFound();
  const events = provider.parseWebhook(raw, {
    'x-razorpay-signature': req.get('x-razorpay-signature'),
    'x-razorpay-event-id': req.get('x-razorpay-event-id'),
  });
  for (const event of events) {
    const matched = await applyProviderEvent('razorpay', event);
    if (!matched) logger.warn({ eventId: event.eventId }, 'Unmatched Razorpay event');
  }
  res.json({ ok: true });
});

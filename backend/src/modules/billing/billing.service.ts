import { Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import {
  ACCESS_STATUSES,
  FEATURE_KEYS,
  LIMIT_KEYS,
  BillingEvent,
  Invoice,
  Plan,
  Subscription,
  UsageCounter,
  type FeatureKey,
  type LimitKey,
  type PlanDoc,
  type SubscriptionDoc,
  type SubscriptionStatus,
  type UsageMetric,
} from './billing.model.js';
import { TRIAL_PLAN, ensurePlans } from './plans.js';
import type { BillingCycle, BillingProviderEvent } from './provider.js';

const DAY = 86_400_000;
/** A Razorpay renewal that hasn't reported back this long after period end counts as failed. */
const RENEWAL_SLACK_MS = 3 * DAY;

export function addCycle(from: Date, cycle: BillingCycle): Date {
  const d = new Date(from);
  if (cycle === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

export async function getPlan(code: string): Promise<PlanDoc> {
  await ensurePlans();
  const plan = await Plan.findOne({ code });
  if (plan) return plan;
  // A plan removed from the catalog: fall back to the trial limits rather than crash.
  logger.error({ code }, 'Subscription references a missing plan');
  return (await Plan.findOne({ code: TRIAL_PLAN }))!;
}

/** The workspace's subscription, created as a trial on first use. Time-based transitions are applied. */
export async function getSubscription(workspaceId: Types.ObjectId): Promise<SubscriptionDoc> {
  let sub = await Subscription.findOne({ workspaceId });
  if (!sub) {
    const trial = await getPlan(TRIAL_PLAN);
    const now = new Date();
    const ends = new Date(now.getTime() + trial.trialDays * DAY);
    try {
      sub = await Subscription.create({ workspaceId, planCode: TRIAL_PLAN, status: 'trialing', currentPeriodStart: now, currentPeriodEnd: ends, trialEndsAt: ends });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      sub = (await Subscription.findOne({ workspaceId }))!;
    }
  }
  await refreshState(sub);
  return sub;
}

/**
 * Applies transitions that happen with time: trial end, grace end, scheduled
 * cancellation and renewals without a provider (sandbox/manual). Idempotent.
 */
export async function refreshState(sub: SubscriptionDoc, now = new Date()): Promise<SubscriptionDoc> {
  const plan = await getPlan(sub.planCode);
  const before = sub.status as SubscriptionStatus;

  if (sub.status === 'trialing' && sub.trialEndsAt && sub.trialEndsAt <= now) {
    sub.set({ status: 'expired', endedAt: sub.trialEndsAt });
  } else if (sub.status === 'past_due' && sub.graceEndsAt && sub.graceEndsAt <= now) {
    sub.set({ status: 'suspended' });
  } else if (sub.status === 'active' && sub.currentPeriodEnd <= now) {
    if (sub.cancelAtPeriodEnd) {
      sub.set({ status: 'cancelled', endedAt: sub.currentPeriodEnd });
    } else if (sub.provider === 'sandbox') {
      // The sandbox "charges" automatically so demos keep working.
      while (sub.currentPeriodEnd <= now) {
        const start = sub.currentPeriodEnd;
        sub.set({ currentPeriodStart: start, currentPeriodEnd: addCycle(start, sub.cycle as BillingCycle), lastPaymentAt: now });
        await recordInvoice(sub, plan, { status: 'paid', provider: 'sandbox', paymentId: null });
      }
    } else if (sub.provider !== 'razorpay' || sub.currentPeriodEnd.getTime() + RENEWAL_SLACK_MS <= now.getTime()) {
      sub.set({ status: 'past_due', graceEndsAt: new Date(now.getTime() + plan.graceDays * DAY) });
    }
  }
  if (sub.isModified()) {
    await sub.save();
    if (sub.status !== before) await onStatusChanged(sub, before);
  }
  return sub;
}

/** Side effects when access is lost: pause broadcasts (flows and sends check access themselves). */
async function onStatusChanged(sub: SubscriptionDoc, from: SubscriptionStatus) {
  logger.info({ workspaceId: sub.workspaceId.toString(), from, to: sub.status }, 'Subscription status changed');
  if (ACCESS_STATUSES.has(from) && !ACCESS_STATUSES.has(sub.status as SubscriptionStatus)) {
    const { Campaign } = await import('../campaigns/campaign.model.js');
    await Campaign.updateMany(
      { workspaceId: sub.workspaceId, status: { $in: ['scheduled', 'running'] } },
      { status: 'paused', failureReason: 'Paused because the subscription is not active. Renew to resume.' },
    );
  }
}

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

export interface Entitlements {
  plan: PlanDoc;
  subscription: SubscriptionDoc;
  /** Full access (sending, automations). False = read-only messaging. */
  access: boolean;
  limits: Record<LimitKey, number | null>;
  features: Record<FeatureKey, boolean>;
}

export async function getEntitlements(workspaceId: Types.ObjectId): Promise<Entitlements> {
  const subscription = await getSubscription(workspaceId);
  const plan = await getPlan(subscription.planCode);
  return {
    plan,
    subscription,
    access: ACCESS_STATUSES.has(subscription.status as SubscriptionStatus),
    limits: { ...(plan.toObject().limits as Record<LimitKey, number | null>), ...pick(subscription.limitOverrides, LIMIT_KEYS) },
    features: { ...(plan.toObject().features as Record<FeatureKey, boolean>), ...pick(subscription.featureOverrides, FEATURE_KEYS) },
  };
}

function pick<K extends string>(source: unknown, keys: readonly K[]): Partial<Record<K, never>> {
  const obj = (source ?? {}) as Record<string, never>;
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]])) as Partial<Record<K, never>>;
}

const STATUS_MESSAGE: Record<string, string> = {
  expired: 'Your free trial has ended. Choose a plan on the Billing page to keep sending messages.',
  suspended: 'Your subscription payment is overdue. Update payment on the Billing page to keep sending messages.',
  cancelled: 'Your subscription has ended. Choose a plan on the Billing page to keep sending messages.',
};

function inactiveError(e: Entitlements) {
  return new AppError(402, 'SUBSCRIPTION_INACTIVE', STATUS_MESSAGE[e.subscription.status] ?? 'Your subscription is not active.', { status: e.subscription.status });
}

export async function assertAccess(workspaceId: Types.ObjectId): Promise<Entitlements> {
  const e = await getEntitlements(workspaceId);
  if (!e.access) throw inactiveError(e);
  return e;
}

export async function hasAccess(workspaceId: Types.ObjectId): Promise<boolean> {
  return (await getEntitlements(workspaceId)).access;
}

const FEATURE_NAMES: Record<FeatureKey, string> = { campaigns: 'Broadcasts', flows: 'Flows', forms: 'WhatsApp Forms', ai: 'The AI agent', api: 'API access and webhooks' };

export async function assertFeature(workspaceId: Types.ObjectId, feature: FeatureKey): Promise<Entitlements> {
  const e = await assertAccess(workspaceId);
  if (!e.features[feature]) {
    throw new AppError(402, 'FEATURE_NOT_IN_PLAN', `${FEATURE_NAMES[feature]} ${feature === 'api' ? 'are' : 'is'} not included in the ${e.plan.name} plan. Upgrade on the Billing page.`, { feature, plan: e.plan.code });
  }
  return e;
}

const LIMIT_NAMES: Record<LimitKey, string> = {
  contacts: 'contacts',
  seats: 'team members',
  monthlyMessages: 'messages this billing period',
  activeFlows: 'live flows',
  forms: 'forms',
  aiRepliesPerMonth: 'AI replies this billing period',
  apiRequestsPerMinute: 'API requests per minute',
};

export function limitError(e: Entitlements, key: LimitKey, used: number) {
  const limit = e.limits[key]!;
  return new AppError(402, 'PLAN_LIMIT_REACHED', `The ${e.plan.name} plan allows ${limit.toLocaleString('en-IN')} ${LIMIT_NAMES[key]}. Upgrade on the Billing page for more.`, { limit: key, max: limit, used });
}

/** Throws when adding `adding` more of a counted resource (contacts, seats, flows, forms) would exceed the plan. */
export async function assertWithinLimit(workspaceId: Types.ObjectId, key: LimitKey, current: number, adding = 1): Promise<Entitlements> {
  const e = await assertAccess(workspaceId);
  const limit = e.limits[key];
  if (limit !== null && limit !== undefined && current + adding > limit) throw limitError(e, key, current);
  return e;
}

// ---------------------------------------------------------------------------
// Metered usage (messages, AI replies, API requests) per billing period
// ---------------------------------------------------------------------------

const METRIC_LIMIT: Partial<Record<UsageMetric, LimitKey>> = { messages: 'monthlyMessages', ai_replies: 'aiRepliesPerMonth' };

/**
 * Counts usage for the current billing period. Metrics with a plan limit are
 * enforced atomically: the increment is undone and an error thrown when it
 * would go over.
 */
export async function consume(workspaceId: Types.ObjectId, metric: UsageMetric, amount = 1): Promise<void> {
  const e = await assertAccess(workspaceId);
  const periodStart = e.subscription.currentPeriodStart;
  const counter = await UsageCounter.findOneAndUpdate({ workspaceId, periodStart, metric }, { $inc: { count: amount } }, { upsert: true, new: true });
  const key = METRIC_LIMIT[metric];
  const limit = key ? e.limits[key] : null;
  if (key && limit !== null && limit !== undefined && counter.count > limit) {
    await UsageCounter.updateOne({ workspaceId, periodStart, metric }, { $inc: { count: -amount } });
    throw limitError(e, key, counter.count - amount);
  }
}

/** Gives back usage counted for something that did not happen (e.g. a duplicate send). */
export async function refund(workspaceId: Types.ObjectId, metric: UsageMetric, amount = 1): Promise<void> {
  const sub = await Subscription.findOne({ workspaceId }).select('currentPeriodStart').lean();
  if (!sub) return;
  await UsageCounter.updateOne({ workspaceId, periodStart: sub.currentPeriodStart, metric, count: { $gte: amount } }, { $inc: { count: -amount } });
}

/** Counts without enforcing (API requests). Never throws. */
export async function track(workspaceId: Types.ObjectId, periodStart: Date, metric: UsageMetric): Promise<void> {
  await UsageCounter.updateOne({ workspaceId, periodStart, metric }, { $inc: { count: 1 } }, { upsert: true }).catch(() => undefined);
}

export async function usageFor(workspaceId: Types.ObjectId, periodStart: Date): Promise<Record<UsageMetric, number>> {
  const rows = await UsageCounter.find({ workspaceId, periodStart }).lean();
  const out = { messages: 0, ai_replies: 0, api_requests: 0 } as Record<UsageMetric, number>;
  for (const r of rows) out[r.metric as UsageMetric] = r.count;
  return out;
}

// ---------------------------------------------------------------------------
// Payment provider events
// ---------------------------------------------------------------------------

async function nextInvoiceNumber(workspaceId: Types.ObjectId) {
  const count = await Invoice.countDocuments({ workspaceId });
  return `ZC-${workspaceId.toString().slice(-6).toUpperCase()}-${String(count + 1).padStart(4, '0')}`;
}

async function recordInvoice(
  sub: SubscriptionDoc,
  plan: PlanDoc,
  opts: { status: 'paid' | 'failed'; provider: string; paymentId: string | null; amount?: number; currency?: string; invoiceId?: string | null; failureReason?: string | null },
) {
  try {
    await Invoice.create({
      workspaceId: sub.workspaceId,
      number: await nextInvoiceNumber(sub.workspaceId as unknown as Types.ObjectId),
      planCode: plan.code,
      cycle: sub.cycle,
      amount: opts.amount ?? (sub.cycle === 'yearly' ? plan.priceYearly : plan.priceMonthly),
      currency: opts.currency ?? plan.currency,
      status: opts.status,
      periodStart: sub.currentPeriodStart,
      periodEnd: sub.currentPeriodEnd,
      provider: opts.provider,
      providerPaymentId: opts.paymentId,
      providerInvoiceId: opts.invoiceId ?? null,
      failureReason: opts.failureReason ?? null,
      paidAt: opts.status === 'paid' ? new Date() : null,
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err; // same payment reported twice
  }
}

/**
 * Applies one verified provider event. Duplicate deliveries (same event id) are
 * ignored. Returns false when the event doesn't match any workspace.
 */
export async function applyProviderEvent(provider: string, event: BillingProviderEvent): Promise<boolean> {
  // Deliberate cross-tenant lookup: the provider's subscription id identifies the workspace.
  let sub = await Subscription.findOne({ $or: [{ providerSubscriptionId: event.providerSubscriptionId }, { 'pending.providerSubscriptionId': event.providerSubscriptionId }] }).setOptions({
    skipTenantScope: true,
  });
  if (!sub && event.workspaceId && Types.ObjectId.isValid(event.workspaceId)) sub = await Subscription.findOne({ workspaceId: event.workspaceId });
  if (!sub) {
    logger.warn({ provider, type: event.type, sub: event.providerSubscriptionId }, 'Billing event for unknown subscription');
    return false;
  }

  try {
    await BillingEvent.create({ provider, eventId: event.eventId, type: event.type, workspaceId: sub.workspaceId });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return true; // already applied
    throw err;
  }

  const isPending = sub.pending?.providerSubscriptionId === event.providerSubscriptionId;
  const isCurrent = sub.providerSubscriptionId === event.providerSubscriptionId;
  const before = sub.status as SubscriptionStatus;
  const now = new Date();

  if (event.type === 'activated' || event.type === 'charged') {
    let replaced: string | null = null;
    if (isPending) {
      // Checkout completed: switch to the purchased plan.
      replaced = sub.providerSubscriptionId && sub.provider === provider ? sub.providerSubscriptionId : null;
      sub.set({
        planCode: sub.pending!.planCode,
        cycle: sub.pending!.cycle,
        provider,
        providerSubscriptionId: event.providerSubscriptionId,
        pending: { planCode: null, cycle: null, providerSubscriptionId: null, checkoutUrl: null, createdAt: null },
      });
    } else if (!isCurrent) {
      return true; // an old, replaced subscription
    }
    const start = event.periodStart ?? (isPending ? now : sub.currentPeriodStart);
    const end = event.periodEnd ?? addCycle(start, sub.cycle as BillingCycle);
    sub.set({ status: 'active', currentPeriodStart: start, currentPeriodEnd: end, trialEndsAt: null, graceEndsAt: null, endedAt: null, cancelAtPeriodEnd: false });
    if (event.customerId) sub.providerCustomerId = event.customerId;
    if (event.type === 'charged') {
      sub.lastPaymentAt = now;
      await sub.save();
      await recordInvoice(sub, await getPlan(sub.planCode), {
        status: 'paid',
        provider,
        paymentId: event.payment?.id ?? `${event.eventId}`,
        amount: event.payment?.amount,
        currency: event.payment?.currency,
        invoiceId: event.payment?.invoiceId,
      });
    }
    if (replaced && replaced !== event.providerSubscriptionId) {
      const { billingProvider } = await import('./provider.js');
      await billingProvider()
        .cancel(replaced, false)
        .catch((err) => logger.error({ err, replaced }, 'Could not cancel the replaced subscription'));
    }
  } else if (!isCurrent) {
    // Failures/cancellations of an unpaid checkout or an old subscription don't touch access.
    if (isPending && (event.type === 'cancelled' || event.type === 'halted')) sub.set({ pending: { planCode: null, cycle: null, providerSubscriptionId: null, checkoutUrl: null, createdAt: null } });
  } else if (event.type === 'payment_failed') {
    const plan = await getPlan(sub.planCode);
    if (sub.status === 'active') sub.set({ status: 'past_due', graceEndsAt: new Date(now.getTime() + plan.graceDays * DAY) });
    await recordInvoice(sub, plan, { status: 'failed', provider, paymentId: event.payment?.id ?? null, amount: event.payment?.amount, currency: event.payment?.currency, failureReason: event.payment?.failureReason ?? 'Payment failed' });
  } else if (event.type === 'halted') {
    // Provider stopped retrying; access ends when the grace period does.
    if (sub.status === 'active') sub.set({ status: 'past_due', graceEndsAt: now });
    else if (sub.status === 'past_due' && sub.graceEndsAt && sub.graceEndsAt <= now) sub.set({ status: 'suspended' });
  } else if (event.type === 'cancelled' || event.type === 'completed') {
    if (sub.cancelAtPeriodEnd && sub.currentPeriodEnd > now) {
      // Scheduled cancellation acknowledged; access continues until period end.
    } else {
      sub.set({ status: 'cancelled', endedAt: now, cancelAtPeriodEnd: false });
    }
  }

  await sub.save();
  if (sub.status !== before) await onStatusChanged(sub, before);
  await refreshState(sub);
  return true;
}

/** Admin override: set plan/status/period by hand (offline payment, extension). */
export async function adminUpdateSubscription(
  workspaceId: Types.ObjectId,
  input: { planCode?: string; status?: SubscriptionStatus; extendDays?: number; cycle?: BillingCycle },
): Promise<SubscriptionDoc> {
  const sub = await getSubscription(workspaceId);
  const before = sub.status as SubscriptionStatus;
  const now = new Date();
  if (input.planCode) {
    const plan = await Plan.findOne({ code: input.planCode });
    if (!plan) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', { planCode: ['Unknown plan.'] });
    sub.planCode = plan.code;
    if (plan.code !== TRIAL_PLAN && sub.status === 'trialing') sub.set({ status: 'active', provider: 'manual', trialEndsAt: null, currentPeriodStart: now, currentPeriodEnd: addCycle(now, input.cycle ?? 'monthly') });
  }
  if (input.cycle) sub.cycle = input.cycle;
  if (input.status) {
    sub.status = input.status;
    if (input.status === 'active') {
      sub.set({ graceEndsAt: null, endedAt: null });
      if (sub.provider === 'none') sub.provider = 'manual';
      if (sub.currentPeriodEnd <= now) sub.set({ currentPeriodStart: now, currentPeriodEnd: addCycle(now, sub.cycle as BillingCycle) });
    }
    if (['cancelled', 'expired', 'suspended'].includes(input.status)) sub.endedAt ??= now;
  }
  if (input.extendDays) {
    const ms = input.extendDays * DAY;
    if (sub.status === 'trialing' || (sub.status === 'expired' && sub.planCode === TRIAL_PLAN)) {
      const base = sub.trialEndsAt && sub.trialEndsAt > now ? sub.trialEndsAt : now;
      sub.set({ status: 'trialing', trialEndsAt: new Date(base.getTime() + ms), currentPeriodEnd: new Date(base.getTime() + ms), endedAt: null });
    } else {
      const base = sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
      sub.set({ currentPeriodEnd: new Date(base.getTime() + ms) });
      if (sub.status === 'past_due' || sub.status === 'suspended') sub.set({ status: 'active', graceEndsAt: null });
    }
  }
  await sub.save();
  if (sub.status !== before) await onStatusChanged(sub, before);
  return sub;
}

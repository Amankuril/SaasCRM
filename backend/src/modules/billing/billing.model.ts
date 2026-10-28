import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

/** Numeric plan limits. `null` = unlimited. */
export const LIMIT_KEYS = ['contacts', 'seats', 'monthlyMessages', 'activeFlows', 'forms', 'aiRepliesPerMonth', 'apiRequestsPerMinute'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export const FEATURE_KEYS = ['campaigns', 'flows', 'forms', 'ai', 'api'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

const limitsShape = Object.fromEntries(LIMIT_KEYS.map((k) => [k, { type: Number, default: null, min: 0 }])) as Record<LimitKey, { type: NumberConstructor; default: null; min: number }>;
const featuresShape = Object.fromEntries(FEATURE_KEYS.map((k) => [k, { type: Boolean, default: false }])) as Record<FeatureKey, { type: BooleanConstructor; default: boolean }>;

/** Platform-wide plan catalog (not tenant-owned). Edited by platform admins. */
const planSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 300, default: '' },
    currency: { type: String, default: 'INR' },
    // Prices in the currency's smallest unit (paise).
    priceMonthly: { type: Number, required: true, min: 0 },
    priceYearly: { type: Number, required: true, min: 0 },
    limits: limitsShape,
    features: featuresShape,
    trialDays: { type: Number, default: 0, min: 0 },
    // Days of full access after a failed renewal before sending is blocked.
    graceDays: { type: Number, default: 7, min: 0 },
    // Shown on the pricing/billing page. The trial plan is assigned, not bought.
    isPublic: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    // Razorpay plan ids (create the plans in the Razorpay dashboard and paste them here).
    providerPlanIds: { monthly: { type: String, default: null }, yearly: { type: String, default: null } },
  },
  { timestamps: true },
);

export type PlanDoc = HydratedDocument<InferSchemaType<typeof planSchema>>;
export const Plan = model('Plan', planSchema);

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'suspended', 'cancelled', 'expired'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
/** Statuses with full access. Everything else is read-only for messaging. */
export const ACCESS_STATUSES = new Set<SubscriptionStatus>(['trialing', 'active', 'past_due']);

/** One subscription per workspace. */
const subscriptionSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    planCode: { type: String, required: true },
    status: { type: String, enum: SUBSCRIPTION_STATUSES, required: true },
    cycle: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
    // Usage counters reset when a new period starts.
    currentPeriodStart: { type: Date, required: true },
    currentPeriodEnd: { type: Date, required: true },
    trialEndsAt: { type: Date, default: null },
    graceEndsAt: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    endedAt: { type: Date, default: null },
    provider: { type: String, enum: ['razorpay', 'sandbox', 'manual', 'none'], default: 'none' },
    providerSubscriptionId: { type: String, default: null },
    providerCustomerId: { type: String, default: null },
    // A checkout started but not paid yet.
    pending: {
      planCode: { type: String, default: null },
      cycle: { type: String, default: null },
      providerSubscriptionId: { type: String, default: null },
      checkoutUrl: { type: String, default: null },
      createdAt: { type: Date, default: null },
    },
    // Reminder emails already sent, e.g. "trial_3d:2026-10-01".
    notices: { type: [String], default: [] },
    lastPaymentAt: { type: Date, default: null },
    // Platform admin overrides on top of the plan, e.g. { contacts: 50000 } or { ai: true }.
    // A key that is present wins over the plan (a `null` limit = unlimited).
    limitOverrides: { type: Schema.Types.Mixed, default: () => ({}) },
    featureOverrides: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true, minimize: false },
);
subscriptionSchema.plugin(tenantScoped);
subscriptionSchema.index({ workspaceId: 1 }, { unique: true });
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });
subscriptionSchema.index({ providerSubscriptionId: 1 }, { sparse: true });

export type SubscriptionDoc = HydratedDocument<InferSchemaType<typeof subscriptionSchema>>;
export const Subscription = model('Subscription', subscriptionSchema);

export const USAGE_METRICS = ['messages', 'ai_replies', 'api_requests'] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

/** Aggregated usage per billing period (atomic increments). */
const usageCounterSchema = new Schema({
  workspaceId: workspaceIdField,
  periodStart: { type: Date, required: true },
  metric: { type: String, enum: USAGE_METRICS, required: true },
  count: { type: Number, default: 0 },
});
usageCounterSchema.plugin(tenantScoped);
usageCounterSchema.index({ workspaceId: 1, periodStart: 1, metric: 1 }, { unique: true });

export const UsageCounter = model('UsageCounter', usageCounterSchema);

/** A payment record shown in invoice history. */
const invoiceSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    number: { type: String, required: true },
    planCode: { type: String, required: true },
    cycle: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: ['paid', 'failed'], required: true },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    provider: { type: String, required: true },
    providerPaymentId: { type: String, default: null },
    providerInvoiceId: { type: String, default: null },
    failureReason: { type: String, default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true },
);
invoiceSchema.plugin(tenantScoped);
invoiceSchema.index({ workspaceId: 1, createdAt: -1 });
invoiceSchema.index({ provider: 1, providerPaymentId: 1 }, { unique: true, partialFilterExpression: { providerPaymentId: { $type: 'string' } } });

export type InvoiceDoc = HydratedDocument<InferSchemaType<typeof invoiceSchema>>;
export const Invoice = model('Invoice', invoiceSchema);

/** Payment provider webhooks we already applied (dedupe by provider event id). Kept 90 days. */
const billingEventSchema = new Schema({
  provider: { type: String, required: true },
  eventId: { type: String, required: true },
  type: { type: String, required: true },
  workspaceId: { type: Schema.Types.ObjectId, default: null },
  createdAt: { type: Date, default: Date.now, expires: 90 * 24 * 60 * 60 },
});
billingEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

export const BillingEvent = model('BillingEvent', billingEventSchema);

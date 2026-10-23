import { logger } from '../../lib/logger.js';
import { Plan, type FeatureKey, type LimitKey } from './billing.model.js';

interface PlanSeed {
  code: string;
  name: string;
  description: string;
  priceMonthly: number;
  priceYearly: number;
  limits: Record<LimitKey, number | null>;
  features: Record<FeatureKey, boolean>;
  trialDays: number;
  graceDays: number;
  isPublic: boolean;
  sortOrder: number;
}

export const TRIAL_PLAN = 'trial';

/**
 * Starting catalog, inserted once. Prices are in paise and are placeholders:
 * platform admins edit plans in the Admin panel afterwards.
 * WhatsApp message fees are billed by Meta to the business, not included here.
 */
export const DEFAULT_PLANS: PlanSeed[] = [
  {
    code: TRIAL_PLAN,
    name: 'Free trial',
    description: 'Everything in Growth for 14 days, with a smaller message allowance.',
    priceMonthly: 0,
    priceYearly: 0,
    limits: { contacts: 1_000, seats: 5, monthlyMessages: 1_000, activeFlows: 10, forms: 5, aiRepliesPerMonth: 200, apiRequestsPerMinute: 60 },
    features: { campaigns: true, flows: true, forms: true, ai: true, api: true },
    trialDays: 14,
    graceDays: 0,
    isPublic: false,
    sortOrder: 0,
  },
  {
    code: 'starter',
    name: 'Starter',
    description: 'Team inbox, broadcasts and basic automations for small businesses.',
    priceMonthly: 99_900,
    priceYearly: 999_000,
    limits: { contacts: 2_000, seats: 2, monthlyMessages: 5_000, activeFlows: 3, forms: 2, aiRepliesPerMonth: 0, apiRequestsPerMinute: 0 },
    features: { campaigns: true, flows: true, forms: true, ai: false, api: false },
    trialDays: 0,
    graceDays: 7,
    isPublic: true,
    sortOrder: 1,
  },
  {
    code: 'growth',
    name: 'Growth',
    description: 'AI agent, API & webhooks and more automations for growing teams.',
    priceMonthly: 249_900,
    priceYearly: 2_499_000,
    limits: { contacts: 10_000, seats: 5, monthlyMessages: 25_000, activeFlows: 15, forms: 10, aiRepliesPerMonth: 2_000, apiRequestsPerMinute: 120 },
    features: { campaigns: true, flows: true, forms: true, ai: true, api: true },
    trialDays: 0,
    graceDays: 7,
    isPublic: true,
    sortOrder: 2,
  },
  {
    code: 'pro',
    name: 'Pro',
    description: 'High volume, unlimited automations and a bigger team.',
    priceMonthly: 599_900,
    priceYearly: 5_999_000,
    limits: { contacts: 100_000, seats: 15, monthlyMessages: 100_000, activeFlows: null, forms: null, aiRepliesPerMonth: 10_000, apiRequestsPerMinute: 300 },
    features: { campaigns: true, flows: true, forms: true, ai: true, api: true },
    trialDays: 0,
    graceDays: 7,
    isPublic: true,
    sortOrder: 3,
  },
];

const CODES = DEFAULT_PLANS.map((p) => p.code);

/** Inserts missing default plans (never overwrites admin edits). Cheap when nothing is missing. */
export async function ensurePlans(): Promise<void> {
  if ((await Plan.countDocuments({ code: { $in: CODES } })) === CODES.length) return;
  for (const p of DEFAULT_PLANS) {
    await Plan.updateOne({ code: p.code }, { $setOnInsert: p }, { upsert: true }).catch((err: { code?: number }) => {
      if (err.code !== 11000) {
        logger.error({ err }, 'Failed to seed plans');
        throw err;
      }
    });
  }
}

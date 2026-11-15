import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { PlanDoc } from './billing.model.js';

export type BillingCycle = 'monthly' | 'yearly';

/** Provider webhooks normalized into what the subscription state machine needs. */
export interface BillingProviderEvent {
  eventId: string;
  type: 'activated' | 'charged' | 'payment_failed' | 'halted' | 'cancelled' | 'completed';
  providerSubscriptionId: string;
  /** From the subscription's notes (set at checkout). */
  workspaceId: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  customerId: string | null;
  payment: { id: string; amount: number; currency: string; invoiceId: string | null; failureReason: string | null } | null;
}

export interface CheckoutSession {
  providerSubscriptionId: string;
  /** Where to send the customer to pay (Razorpay hosted page, or the sandbox page). */
  checkoutUrl: string;
}

/** What the browser sends back after paying in Razorpay Checkout. */
export interface CheckoutProof {
  paymentId: string;
  subscriptionId: string;
  signature: string;
}

export interface BillingProvider {
  readonly name: 'razorpay' | 'sandbox';
  createCheckout(args: { workspaceId: string; plan: PlanDoc; cycle: BillingCycle; email: string }): Promise<CheckoutSession>;
  cancel(providerSubscriptionId: string, atPeriodEnd: boolean): Promise<void>;
  /** Verifies the signature and normalizes the payload. Throws 401 on a bad signature. */
  parseWebhook(raw: Buffer, headers: Record<string, string | undefined>): BillingProviderEvent[];
}

// ---------------------------------------------------------------------------
// Razorpay Subscriptions (https://razorpay.com/docs/api/payments/subscriptions/)
// ---------------------------------------------------------------------------

const RAZORPAY_API = 'https://api.razorpay.com/v1';
const RAZORPAY_EVENTS: Record<string, BillingProviderEvent['type']> = {
  'subscription.activated': 'activated',
  'subscription.charged': 'charged',
  'subscription.pending': 'payment_failed',
  'subscription.halted': 'halted',
  'subscription.cancelled': 'cancelled',
  'subscription.completed': 'completed',
};

const fromUnix = (v: unknown) => (typeof v === 'number' && v > 0 ? new Date(v * 1000) : null);

export class RazorpayProvider implements BillingProvider {
  readonly name = 'razorpay' as const;

  /** POST with a body, GET without. */
  private async call<T>(path: string, body?: unknown): Promise<T> {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) throw new AppError(503, 'BILLING_NOT_CONFIGURED', 'Online payments are not set up yet. Contact support.');
    const res = await fetch(`${RAZORPAY_API}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new AppError(502, 'BILLING_PROVIDER_UNAVAILABLE', 'The payment provider could not be reached. Try again.');
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { description?: string } } & T;
    if (!res.ok) {
      logger.warn({ status: res.status, path, error: json.error }, 'Razorpay request failed');
      throw new AppError(502, 'BILLING_PROVIDER_ERROR', json.error?.description ?? 'The payment provider rejected the request.');
    }
    return json;
  }

  async createCheckout({ workspaceId, plan, cycle }: { workspaceId: string; plan: PlanDoc; cycle: BillingCycle }): Promise<CheckoutSession> {
    const planId = await this.planIdFor(plan, cycle);
    const sub = await this.call<{ id: string; short_url: string }>('/subscriptions', {
      plan_id: planId,
      // Renews until cancelled (Razorpay needs a finite count).
      total_count: cycle === 'monthly' ? 120 : 10,
      customer_notify: true,
      notes: { workspace_id: workspaceId, plan_code: plan.code, cycle },
    });
    return { providerSubscriptionId: sub.id, checkoutUrl: sub.short_url };
  }

  /**
   * The Razorpay plan for this price. Created on first use, and again after a
   * price change (Razorpay plans are immutable). Ids pasted by an admin are used as they are.
   */
  private async planIdFor(plan: PlanDoc, cycle: BillingCycle): Promise<string> {
    const amount = cycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;
    const existing = plan.providerPlanIds?.[cycle];
    const madeFor = plan.providerPlanAmounts?.[cycle] ?? null;
    if (existing && (madeFor === null || madeFor === amount)) return existing;
    if (!(amount > 0)) throw new AppError(409, 'PLAN_NOT_PURCHASABLE', `The ${plan.name} plan is not available for ${cycle} billing yet.`);
    const created = await this.call<{ id: string }>('/plans', {
      period: cycle,
      interval: 1,
      item: { name: `${plan.name} (${cycle})`, amount, currency: plan.currency, description: plan.description.slice(0, 250) },
      notes: { plan_code: plan.code, cycle },
    });
    plan.set(`providerPlanIds.${cycle}`, created.id);
    plan.set(`providerPlanAmounts.${cycle}`, amount);
    await plan.save();
    return created.id;
  }

  async cancel(providerSubscriptionId: string, atPeriodEnd: boolean): Promise<void> {
    await this.call(`/subscriptions/${encodeURIComponent(providerSubscriptionId)}/cancel`, { cancel_at_cycle_end: atPeriodEnd });
  }

  /**
   * Confirms a payment made in Razorpay Checkout so the plan switches right away
   * (the webhook reports the same payment later and is ignored as a duplicate).
   * razorpay_signature = hex HMAC-SHA256 of "payment_id|subscription_id" with the key secret.
   */
  async confirmCheckout(proof: CheckoutProof, workspaceId: string): Promise<BillingProviderEvent> {
    if (!env.RAZORPAY_KEY_SECRET) throw new AppError(503, 'BILLING_NOT_CONFIGURED', 'Online payments are not set up yet. Contact support.');
    const expected = createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${proof.paymentId}|${proof.subscriptionId}`).digest();
    const received = Buffer.from(proof.signature, 'hex');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new AppError(400, 'PAYMENT_NOT_VERIFIED', 'This payment could not be verified. If money was deducted, it will be confirmed or refunded automatically.');
    const id = encodeURIComponent(proof.subscriptionId);
    const [sub, pay] = await Promise.all([
      this.call<{ current_start?: number; current_end?: number; customer_id?: string }>(`/subscriptions/${id}`),
      this.call<{ amount?: number; currency?: string; invoice_id?: string; status?: string }>(`/payments/${encodeURIComponent(proof.paymentId)}`),
    ]);
    if (pay.status === 'failed') throw new AppError(402, 'PAYMENT_FAILED', 'The payment did not go through. Try again.');
    return {
      eventId: `checkout:${proof.paymentId}`,
      type: 'charged',
      providerSubscriptionId: proof.subscriptionId,
      workspaceId,
      periodStart: fromUnix(sub.current_start),
      periodEnd: fromUnix(sub.current_end),
      customerId: typeof sub.customer_id === 'string' ? sub.customer_id : null,
      payment: { id: proof.paymentId, amount: Number(pay.amount ?? 0), currency: String(pay.currency ?? 'INR'), invoiceId: typeof pay.invoice_id === 'string' ? pay.invoice_id : null, failureReason: null },
    };
  }

  parseWebhook(raw: Buffer, headers: Record<string, string | undefined>): BillingProviderEvent[] {
    if (!env.RAZORPAY_WEBHOOK_SECRET) throw new AppError(503, 'WEBHOOK_NOT_CONFIGURED', 'RAZORPAY_WEBHOOK_SECRET is not configured.');
    // X-Razorpay-Signature = hex HMAC-SHA256 of the raw body with the webhook secret.
    const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest();
    const received = Buffer.from(headers['x-razorpay-signature'] ?? '', 'hex');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature.');
    }
    const body = JSON.parse(raw.toString('utf8')) as {
      event: string;
      created_at?: number;
      payload?: { subscription?: { entity?: Record<string, unknown> }; payment?: { entity?: Record<string, unknown> } };
    };
    const type = RAZORPAY_EVENTS[body.event];
    const sub = body.payload?.subscription?.entity;
    if (!type || !sub?.id) return [];
    const notes = (sub.notes && !Array.isArray(sub.notes) ? sub.notes : {}) as Record<string, string>;
    const pay = body.payload?.payment?.entity;
    return [
      {
        // Unique per event; falls back to event+subscription+time for replays without the header.
        eventId: headers['x-razorpay-event-id'] ?? `${body.event}:${String(sub.id)}:${body.created_at ?? ''}`,
        type,
        providerSubscriptionId: String(sub.id),
        workspaceId: notes.workspace_id ?? null,
        periodStart: fromUnix(sub.current_start),
        periodEnd: fromUnix(sub.current_end),
        customerId: typeof sub.customer_id === 'string' ? sub.customer_id : null,
        payment: pay?.id
          ? {
              id: String(pay.id),
              amount: Number(pay.amount ?? 0),
              currency: String(pay.currency ?? 'INR'),
              invoiceId: typeof pay.invoice_id === 'string' ? pay.invoice_id : null,
              failureReason: typeof pay.error_description === 'string' ? pay.error_description : null,
            }
          : null,
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// Sandbox: fake checkout for development and demos (no money moves)
// ---------------------------------------------------------------------------

export class SandboxBillingProvider implements BillingProvider {
  readonly name = 'sandbox' as const;
  cancelled: { id: string; atPeriodEnd: boolean }[] = [];

  async createCheckout({ workspaceId }: { workspaceId: string }): Promise<CheckoutSession> {
    const id = `sandbox_sub_${randomBytes(8).toString('hex')}`;
    return { providerSubscriptionId: id, checkoutUrl: `${env.APP_URL}/w/${workspaceId}/billing?checkout=${id}` };
  }

  async cancel(id: string, atPeriodEnd: boolean): Promise<void> {
    this.cancelled.push({ id, atPeriodEnd });
  }

  parseWebhook(): BillingProviderEvent[] {
    throw new AppError(404, 'NOT_FOUND', 'The sandbox provider has no webhooks.');
  }
}

let override: BillingProvider | undefined;
let razorpay: RazorpayProvider | undefined;
const sandbox = new SandboxBillingProvider();

export function billingProvider(): BillingProvider {
  if (override) return override;
  if (env.BILLING_PROVIDER === 'sandbox') return sandbox;
  return (razorpay ??= new RazorpayProvider());
}

export function setBillingProvider(provider: BillingProvider | undefined) {
  override = provider;
}

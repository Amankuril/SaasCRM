import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { safeRequest } from '../../lib/safeFetch.js';
import { enqueue, type JobContext } from '../../jobs/queue.js';
import { API_VERSION, type WebhookEventType } from './catalog.js';
import { WebhookDelivery, WebhookEndpoint, type WebhookDeliveryDoc, type WebhookEndpointDoc } from './developer.model.js';

/** Delay before attempt n+1 (8 attempts over roughly 11 hours). */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** An endpoint failing this many attempts in a row is switched off. */
export const DISABLE_AFTER_FAILURES = 25;
export const SECRET_GRACE_MS = 24 * 60 * 60 * 1000;
export const MAX_ENDPOINTS = 10;
const TIMEOUT_MS = 10_000;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/**
 * `Zeta-Signature: t=<unix seconds>,v1=<hex>` where v1 = HMAC-SHA256(secret, "<t>.<raw body>").
 * During a secret rotation a second v1 (old secret) is included.
 */
export function signatureHeader(body: string, secrets: string[], timestamp = Math.floor(Date.now() / 1000)): string {
  const sigs = secrets.map((s) => `v1=${createHmac('sha256', s).update(`${timestamp}.${body}`).digest('hex')}`);
  return [`t=${timestamp}`, ...sigs].join(',');
}

type EventData = Record<string, unknown>;

/**
 * Records an event for every active endpoint subscribed to it and queues delivery.
 * `data` may be a function so payloads are only built when someone is subscribed.
 * Never throws: integrations must not break messaging.
 */
export async function emitEvent(workspaceId: Types.ObjectId, type: WebhookEventType, data: EventData | (() => Promise<EventData>)): Promise<void> {
  try {
    const endpoints = await WebhookEndpoint.find({ workspaceId, status: 'active', events: type }).select('_id').lean();
    if (!endpoints.length) return;
    if (typeof data === 'function') data = await data();
    const payload = {
      event_id: `evt_${randomUUID().replace(/-/g, '')}`,
      event_type: type,
      api_version: API_VERSION,
      workspace_id: workspaceId.toString(),
      occurred_at: new Date().toISOString(),
      data,
    };
    for (const endpoint of endpoints) {
      const token = randomUUID();
      const delivery = await WebhookDelivery.create({ workspaceId, endpointId: endpoint._id, eventId: payload.event_id, eventType: type, payload, token });
      await enqueue('integration.webhook', { workspaceId: workspaceId.toString(), deliveryId: delivery.id as string, token }, { jobId: `whd-${delivery.id}-${token}` });
    }
  } catch (err) {
    logger.error({ err, type }, 'Failed to emit webhook event');
  }
}

/** Worker: one delivery attempt; schedules its own retry so every attempt is logged. */
export async function processWebhookDelivery(data: { workspaceId: string; deliveryId: string; token: string }, _ctx: JobContext): Promise<void> {
  const delivery = await WebhookDelivery.findOne({ _id: data.deliveryId, workspaceId: data.workspaceId });
  if (!delivery || delivery.token !== data.token || !['pending', 'retrying'].includes(delivery.status)) return;
  const endpoint = await loadEndpoint(delivery);
  if (!endpoint) {
    delivery.set({ status: 'dead', nextAttemptAt: null, token: null });
    await delivery.save();
    return;
  }
  // Paused/disabled: hold; resuming the endpoint re-queues held deliveries.
  if (endpoint.status !== 'active') return;
  await attempt(endpoint, delivery, { retry: true });
}

/** Sends the delivery once and records the result. */
async function attempt(endpoint: WebhookEndpointDoc, delivery: WebhookDeliveryDoc, opts: { retry: boolean }) {
  const body = JSON.stringify(delivery.payload);
  const secrets = [decryptSecret(endpoint.secretEncrypted)];
  if (endpoint.previousSecretEncrypted && endpoint.previousSecretExpiresAt && endpoint.previousSecretExpiresAt > new Date()) {
    secrets.push(decryptSecret(endpoint.previousSecretEncrypted));
  }

  const at = new Date();
  let statusCode: number | null = null;
  let error: string | null = null;
  let snippet: string | null = null;
  let durationMs = 0;
  try {
    const res = await safeRequest(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Zeta-Signature': signatureHeader(body, secrets),
        'Zeta-Event-Id': String(delivery.eventId),
        'Zeta-Event-Type': delivery.eventType,
        'Zeta-Delivery-Attempt': String(delivery.attempts.length + 1),
      },
      body,
      timeoutMs: TIMEOUT_MS,
      maxBytes: 1_000,
      allowPrivate: env.ALLOW_PRIVATE_OUTBOUND_URLS,
    });
    statusCode = res.status;
    durationMs = res.durationMs;
    snippet = res.body.slice(0, 500) || null;
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof AppError ? err.message : 'Request failed.';
    durationMs = Date.now() - at.getTime();
  }

  delivery.attempts.push({ at, statusCode, durationMs, error, responseSnippet: snippet });
  const ok = !error;
  const isTest = delivery.eventType === 'webhook.test';

  if (ok) {
    delivery.set({ status: 'succeeded', nextAttemptAt: null, token: null });
  } else if (opts.retry && delivery.attempts.length < MAX_ATTEMPTS) {
    const delay = RETRY_DELAYS_MS[delivery.attempts.length - 1]!;
    delivery.set({ status: 'retrying', nextAttemptAt: new Date(Date.now() + delay), token: randomUUID() });
  } else {
    delivery.set({ status: 'dead', nextAttemptAt: null, token: null });
  }
  await delivery.save();
  if (delivery.status === 'retrying') {
    await enqueue(
      'integration.webhook',
      { workspaceId: delivery.workspaceId.toString(), deliveryId: delivery.id as string, token: delivery.token! },
      { jobId: `whd-${delivery.id}-${delivery.token}`, delayMs: delivery.nextAttemptAt!.getTime() - Date.now() },
    );
  }

  // Test pings don't affect the endpoint's health.
  if (isTest) return delivery;
  const update = ok
    ? { $set: { consecutiveFailures: 0, lastDeliveryAt: at, lastDeliveryStatus: 'succeeded' } }
    : { $inc: { consecutiveFailures: 1 }, $set: { lastDeliveryAt: at, lastDeliveryStatus: 'failed' } };
  const updated = await WebhookEndpoint.findOneAndUpdate({ _id: endpoint._id, workspaceId: endpoint.workspaceId }, update, { new: true });
  if (updated && updated.status === 'active' && updated.consecutiveFailures >= DISABLE_AFTER_FAILURES) {
    await WebhookEndpoint.updateOne(
      { _id: endpoint._id, workspaceId: endpoint.workspaceId },
      { status: 'disabled', disabledReason: `Turned off after ${DISABLE_AFTER_FAILURES} failed deliveries in a row.` },
    );
    logger.warn({ endpointId: endpoint.id }, 'Webhook endpoint disabled after repeated failures');
  }
  return delivery;
}

function loadEndpoint(delivery: Pick<WebhookDeliveryDoc, 'endpointId' | 'workspaceId'>) {
  return WebhookEndpoint.findOne({ _id: delivery.endpointId, workspaceId: delivery.workspaceId }).select('+secretEncrypted +previousSecretEncrypted');
}

/** Sends a `webhook.test` event right now and returns the logged delivery. */
export async function sendTestEvent(endpoint: WebhookEndpointDoc): Promise<WebhookDeliveryDoc> {
  const payload = {
    event_id: `evt_${randomUUID().replace(/-/g, '')}`,
    event_type: 'webhook.test',
    api_version: API_VERSION,
    workspace_id: endpoint.workspaceId.toString(),
    occurred_at: new Date().toISOString(),
    data: { message: 'This is a test event from Zeta Connect.' },
  };
  const delivery = await WebhookDelivery.create({ workspaceId: endpoint.workspaceId, endpointId: endpoint._id, eventId: payload.event_id, eventType: 'webhook.test', payload });
  const full = (await loadEndpoint(delivery))!;
  return attempt(full, delivery, { retry: false });
}

/** Manual resend of any logged delivery: one immediate attempt, same event id. */
export async function redeliver(delivery: WebhookDeliveryDoc): Promise<WebhookDeliveryDoc> {
  const endpoint = await loadEndpoint(delivery);
  if (!endpoint) throw new AppError(404, 'NOT_FOUND', 'Endpoint not found.');
  delivery.set({ token: null, nextAttemptAt: null });
  return attempt(endpoint, delivery, { retry: false });
}

/** Re-queues deliveries held while the endpoint was paused or disabled. */
export async function requeueHeld(endpoint: WebhookEndpointDoc): Promise<number> {
  const held = await WebhookDelivery.find({ workspaceId: endpoint.workspaceId, endpointId: endpoint._id, status: { $in: ['pending', 'retrying'] } })
    .select('_id')
    .limit(1_000)
    .lean();
  for (const d of held) {
    const token = randomUUID();
    await WebhookDelivery.updateOne({ _id: d._id, workspaceId: endpoint.workspaceId }, { token, nextAttemptAt: new Date() });
    await enqueue('integration.webhook', { workspaceId: endpoint.workspaceId.toString(), deliveryId: d._id.toString(), token }, { jobId: `whd-${d._id}-${token}` });
  }
  return held.length;
}

export function encryptNewSecret() {
  const secret = generateWebhookSecret();
  return { secret, secretEncrypted: encryptSecret(secret) };
}

export function toPublicEndpoint(e: WebhookEndpointDoc) {
  return {
    id: e.id as string,
    url: e.url,
    description: e.description,
    events: e.events,
    status: e.status,
    disabledReason: e.disabledReason,
    consecutiveFailures: e.consecutiveFailures,
    lastDeliveryAt: e.lastDeliveryAt,
    lastDeliveryStatus: e.lastDeliveryStatus,
    secretRotating: !!(e.previousSecretExpiresAt && e.previousSecretExpiresAt > new Date()),
    createdAt: e.createdAt,
  };
}

const SAFE_KEY = /(^|_)(id|ids|type|status|direction|outcome|version|count|at|valid|event)$|^(occurred_at|api_version|event_type|event_id)$/i;

/** Delivery logs hide personal data: phones keep their last 4 digits, other free text is masked. */
export function redactPayload(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => redactPayload(v, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactPayload(v, k)]));
  }
  if (typeof value !== 'string' || SAFE_KEY.test(key)) return value;
  if (/^\+?\d{8,15}$/.test(value)) return `${value.startsWith('+') ? '+' : ''}••••••${value.slice(-4)}`;
  return value ? `[redacted, ${value.length} chars]` : value;
}

export function toPublicDelivery(d: WebhookDeliveryDoc) {
  return {
    id: d.id as string,
    eventId: d.eventId,
    eventType: d.eventType,
    status: d.status,
    attempts: d.attempts.map((a) => ({ at: a.at, statusCode: a.statusCode, durationMs: a.durationMs, error: a.error, responseSnippet: a.responseSnippet })),
    nextAttemptAt: d.nextAttemptAt,
    createdAt: d.createdAt,
    payload: redactPayload(d.payload),
  };
}

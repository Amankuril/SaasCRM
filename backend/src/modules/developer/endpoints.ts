import type { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { encryptSecret } from '../../lib/crypto.js';
import { AppError, notFound } from '../../lib/errors.js';
import { assertSafeOutboundUrl } from '../../lib/safeFetch.js';
import { objectId } from '../../lib/validate.js';
import { WEBHOOK_EVENTS } from './catalog.js';
import { WebhookEndpoint, type WebhookEndpointDoc } from './developer.model.js';
import { MAX_ENDPOINTS, SECRET_GRACE_MS, encryptNewSecret, generateWebhookSecret, requeueHeld } from './webhook.service.js';

/** Webhook endpoint management shared by the dashboard and the public API. */

const eventsSchema = z
  .array(z.enum(WEBHOOK_EVENTS, { errorMap: () => ({ message: 'Unknown event type.' }) }))
  .min(1, 'Choose at least one event.')
  .transform((e) => [...new Set(e)]);

export const createEndpointSchema = z.object({
  url: z.string().trim().max(2000),
  description: z.string().trim().max(200).default(''),
  events: eventsSchema,
});

export const updateEndpointSchema = z
  .object({
    url: z.string().trim().max(2000),
    description: z.string().trim().max(200),
    events: eventsSchema,
    status: z.enum(['active', 'paused']),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

async function checkUrl(url: string): Promise<string> {
  try {
    return (await assertSafeOutboundUrl(url, env.ALLOW_PRIVATE_OUTBOUND_URLS)).toString();
  } catch (err) {
    if (err instanceof AppError) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', { url: [err.message] });
    throw err;
  }
}

export async function findEndpoint(workspaceId: Types.ObjectId, id: unknown): Promise<WebhookEndpointDoc> {
  const endpoint = await WebhookEndpoint.findOne({ _id: objectId(id, 'Webhook'), workspaceId });
  if (!endpoint) throw notFound('Webhook endpoint not found.');
  return endpoint;
}

export async function createEndpoint(workspaceId: Types.ObjectId, input: z.infer<typeof createEndpointSchema>, createdBy: Types.ObjectId | null) {
  if ((await WebhookEndpoint.countDocuments({ workspaceId })) >= MAX_ENDPOINTS) {
    throw new AppError(409, 'TOO_MANY_WEBHOOKS', `A workspace can have at most ${MAX_ENDPOINTS} webhook endpoints.`);
  }
  const url = await checkUrl(input.url);
  const { secret, secretEncrypted } = encryptNewSecret();
  const endpoint = await WebhookEndpoint.create({ workspaceId, url, description: input.description, events: input.events, secretEncrypted, createdBy });
  return { endpoint, secret };
}

export async function updateEndpoint(endpoint: WebhookEndpointDoc, input: z.infer<typeof updateEndpointSchema>) {
  if (input.url !== undefined) endpoint.url = await checkUrl(input.url);
  if (input.description !== undefined) endpoint.description = input.description;
  if (input.events) endpoint.events = input.events;
  const resuming = input.status === 'active' && endpoint.status !== 'active';
  if (input.status) {
    endpoint.status = input.status;
    if (resuming) endpoint.set({ disabledReason: null, consecutiveFailures: 0 });
  }
  await endpoint.save();
  if (resuming) await requeueHeld(endpoint);
  return endpoint;
}

/** New signing secret; the old one keeps signing (as a second v1) for 24 hours. */
export async function rotateSecret(workspaceId: Types.ObjectId, endpointId: Types.ObjectId) {
  const current = await WebhookEndpoint.findOne({ _id: endpointId, workspaceId }).select('+secretEncrypted');
  if (!current) throw notFound('Webhook endpoint not found.');
  const secret = generateWebhookSecret();
  current.set({
    previousSecretEncrypted: current.secretEncrypted,
    previousSecretExpiresAt: new Date(Date.now() + SECRET_GRACE_MS),
    secretEncrypted: encryptSecret(secret),
  });
  await current.save();
  return { endpoint: current, secret };
}

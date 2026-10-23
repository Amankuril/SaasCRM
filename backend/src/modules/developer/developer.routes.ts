import { Router } from 'express';
import { z } from 'zod';
import { AppError, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { audit } from '../audit/audit.service.js';
import { ROLL_GRACE_MS, createApiKey, keyState, toPublicApiKey } from './apiKey.service.js';
import { API_SCOPES, API_VERSION, EVENT_DESCRIPTIONS, SCOPE_DESCRIPTIONS, type ApiScope } from './catalog.js';
import { ApiKey, DELIVERY_STATUSES, WebhookDelivery, WebhookEndpoint } from './developer.model.js';
import { createEndpoint, createEndpointSchema, findEndpoint, rotateSecret, updateEndpoint, updateEndpointSchema } from './endpoints.js';
import { redeliver, sendTestEvent, toPublicDelivery, toPublicEndpoint } from './webhook.service.js';

const createKeySchema = z.object({
  name: z.string().trim().min(1, 'Name the key.').max(60),
  scopes: z.array(z.enum(API_SCOPES)).max(API_SCOPES.length).transform((s) => [...new Set(s)]),
  // null = never expires
  expiresInDays: z.number().int().min(1).max(730).nullable().default(null),
});

const deliveriesSchema = z.object({
  status: z.enum(DELIVERY_STATUSES).optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** Mounted at /api/workspaces/:workspaceId/developer (workspace already loaded). */
export const developerRouter = Router({ mergeParams: true });
developerRouter.use(requirePermission('developer:manage'));

developerRouter.get('/catalog', (_req, res) => {
  res.json({
    apiVersion: API_VERSION,
    scopes: API_SCOPES.map((id) => ({ id, description: SCOPE_DESCRIPTIONS[id] })),
    events: Object.entries(EVENT_DESCRIPTIONS).map(([id, description]) => ({ id, description })),
  });
});

// ---- API keys ----

developerRouter.get('/api-keys', async (req, res) => {
  const keys = await ApiKey.find({ workspaceId: req.workspace!._id }).sort({ createdAt: -1 });
  res.json({ apiKeys: keys.map(toPublicApiKey) });
});

developerRouter.post('/api-keys', async (req, res) => {
  const input = parse(createKeySchema, req.body);
  const { apiKey, key } = await createApiKey({
    workspaceId: req.workspace!._id,
    name: input.name,
    scopes: input.scopes,
    expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
    createdBy: req.user!._id,
  });
  await audit(req, { workspaceId: req.workspace!._id, action: 'api_key.created', targetType: 'api_key', targetId: apiKey.id, metadata: { name: apiKey.name, scopes: apiKey.scopes } });
  // The full key is returned exactly once.
  res.status(201).json({ apiKey: toPublicApiKey(apiKey), key });
});

/** Rotation: a new key with the same name/scopes; the old one keeps working for 24 hours. */
developerRouter.post('/api-keys/:keyId/roll', async (req, res) => {
  const workspaceId = req.workspace!._id;
  const old = await ApiKey.findOne({ _id: objectId(req.params.keyId, 'API key'), workspaceId });
  if (!old) throw notFound('API key not found.');
  if (keyState(old) !== 'active' || old.rolledToId) throw new AppError(409, 'API_KEY_NOT_ACTIVE', 'Only active keys that were not already rolled can be rolled.');

  const graceEnd = new Date(Date.now() + ROLL_GRACE_MS);
  const { apiKey, key } = await createApiKey({ workspaceId, name: old.name, scopes: old.scopes as ApiScope[], expiresAt: old.expiresAt ?? null, createdBy: req.user!._id });
  old.set({ rolledToId: apiKey._id, expiresAt: old.expiresAt && old.expiresAt < graceEnd ? old.expiresAt : graceEnd });
  await old.save();
  await audit(req, { workspaceId, action: 'api_key.rolled', targetType: 'api_key', targetId: old.id, metadata: { newKeyId: apiKey.id } });
  res.status(201).json({ apiKey: toPublicApiKey(apiKey), key, previous: toPublicApiKey(old) });
});

developerRouter.delete('/api-keys/:keyId', async (req, res) => {
  const workspaceId = req.workspace!._id;
  const key = await ApiKey.findOne({ _id: objectId(req.params.keyId, 'API key'), workspaceId });
  if (!key) throw notFound('API key not found.');
  if (!key.revokedAt) {
    key.revokedAt = new Date();
    await key.save();
    await audit(req, { workspaceId, action: 'api_key.revoked', targetType: 'api_key', targetId: key.id, metadata: { name: key.name } });
  }
  res.json({ apiKey: toPublicApiKey(key) });
});

// ---- Webhook endpoints ----

developerRouter.get('/webhooks', async (req, res) => {
  const endpoints = await WebhookEndpoint.find({ workspaceId: req.workspace!._id }).sort({ createdAt: -1 });
  res.json({ webhooks: endpoints.map(toPublicEndpoint) });
});

developerRouter.post('/webhooks', async (req, res) => {
  const input = parse(createEndpointSchema, req.body);
  const { endpoint, secret } = await createEndpoint(req.workspace!._id, input, req.user!._id);
  await audit(req, { workspaceId: req.workspace!._id, action: 'webhook.created', targetType: 'webhook', targetId: endpoint.id, metadata: { url: endpoint.url, events: endpoint.events } });
  res.status(201).json({ webhook: toPublicEndpoint(endpoint), secret });
});

developerRouter.patch('/webhooks/:webhookId', async (req, res) => {
  const input = parse(updateEndpointSchema, req.body);
  const endpoint = await updateEndpoint(await findEndpoint(req.workspace!._id, req.params.webhookId), input);
  await audit(req, { workspaceId: req.workspace!._id, action: 'webhook.updated', targetType: 'webhook', targetId: endpoint.id, metadata: { fields: Object.keys(input) } });
  res.json({ webhook: toPublicEndpoint(endpoint) });
});

developerRouter.delete('/webhooks/:webhookId', async (req, res) => {
  const workspaceId = req.workspace!._id;
  const endpoint = await findEndpoint(workspaceId, req.params.webhookId);
  await Promise.all([WebhookDelivery.deleteMany({ workspaceId, endpointId: endpoint._id }), WebhookEndpoint.deleteOne({ _id: endpoint._id, workspaceId })]);
  await audit(req, { workspaceId, action: 'webhook.deleted', targetType: 'webhook', targetId: endpoint.id, metadata: { url: endpoint.url } });
  res.status(204).end();
});

developerRouter.post('/webhooks/:webhookId/rotate-secret', async (req, res) => {
  const workspaceId = req.workspace!._id;
  const { endpoint, secret } = await rotateSecret(workspaceId, (await findEndpoint(workspaceId, req.params.webhookId))._id);
  await audit(req, { workspaceId, action: 'webhook.secret_rotated', targetType: 'webhook', targetId: endpoint.id });
  res.json({ webhook: toPublicEndpoint(endpoint), secret });
});

developerRouter.post('/webhooks/:webhookId/test', async (req, res) => {
  const delivery = await sendTestEvent(await findEndpoint(req.workspace!._id, req.params.webhookId));
  res.json({ delivery: toPublicDelivery(delivery) });
});

developerRouter.get('/webhooks/:webhookId/deliveries', async (req, res) => {
  const workspaceId = req.workspace!._id;
  const endpoint = await findEndpoint(workspaceId, req.params.webhookId);
  const { status, before, limit } = parse(deliveriesSchema, req.query);
  const filter: Record<string, unknown> = { workspaceId, endpointId: endpoint._id };
  if (status) filter.status = status;
  if (before) filter._id = { $lt: objectId(before, 'Cursor') };
  const rows = await WebhookDelivery.find(filter).sort({ _id: -1 }).limit(limit + 1);
  const page = rows.slice(0, limit);
  res.json({ deliveries: page.map(toPublicDelivery), nextCursor: rows.length > limit ? page.at(-1)!.id : null });
});

developerRouter.post('/webhooks/:webhookId/deliveries/:deliveryId/redeliver', async (req, res) => {
  const workspaceId = req.workspace!._id;
  const endpoint = await findEndpoint(workspaceId, req.params.webhookId);
  const delivery = await WebhookDelivery.findOne({ _id: objectId(req.params.deliveryId, 'Delivery'), workspaceId, endpointId: endpoint._id });
  if (!delivery) throw notFound('Delivery not found.');
  res.json({ delivery: toPublicDelivery(await redeliver(delivery)) });
});

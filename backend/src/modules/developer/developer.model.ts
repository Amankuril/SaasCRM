import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';
import { API_SCOPES, WEBHOOK_EVENTS } from './catalog.js';

/**
 * Workspace API key. Only a SHA-256 hash of the secret is stored; the full key
 * (`zc_live_<prefix>_<secret>`) is shown once at creation.
 */
const apiKeySchema = new Schema(
  {
    workspaceId: workspaceIdField,
    name: { type: String, required: true, trim: true, maxlength: 60 },
    prefix: { type: String, required: true },
    hash: { type: String, required: true, select: false },
    last4: { type: String, required: true },
    scopes: { type: [{ type: String, enum: API_SCOPES }], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    lastUsedIp: { type: String, default: null },
    // Set on the old key when it was rolled; it keeps working until expiresAt.
    rolledToId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);
apiKeySchema.plugin(tenantScoped);
apiKeySchema.index({ hash: 1 }, { unique: true });
apiKeySchema.index({ workspaceId: 1, createdAt: -1 });

export type ApiKeyDoc = HydratedDocument<InferSchemaType<typeof apiKeySchema>>;
export const ApiKey = model('ApiKey', apiKeySchema);

/** Replays the first response for a repeated `Idempotency-Key` on API writes (kept 24h). */
const idempotencySchema = new Schema(
  {
    workspaceId: workspaceIdField,
    apiKeyId: { type: Schema.Types.ObjectId, required: true },
    key: { type: String, required: true },
    requestHash: { type: String, required: true },
    state: { type: String, enum: ['in_progress', 'done'], default: 'in_progress' },
    statusCode: { type: Number, default: null },
    body: { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now, expires: 24 * 60 * 60 },
  },
  { minimize: false },
);
idempotencySchema.plugin(tenantScoped);
idempotencySchema.index({ workspaceId: 1, apiKeyId: 1, key: 1 }, { unique: true });

export const IdempotencyRecord = model('IdempotencyRecord', idempotencySchema);

export const ENDPOINT_STATUSES = ['active', 'paused', 'disabled'] as const;

/** A customer URL that receives signed event POSTs. */
const webhookEndpointSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    url: { type: String, required: true, maxlength: 2000 },
    description: { type: String, trim: true, maxlength: 200, default: '' },
    events: { type: [{ type: String, enum: WEBHOOK_EVENTS }], default: [] },
    secretEncrypted: { type: String, required: true, select: false },
    // During a secret rotation both secrets sign deliveries until this expires.
    previousSecretEncrypted: { type: String, default: null, select: false },
    previousSecretExpiresAt: { type: Date, default: null },
    status: { type: String, enum: ENDPOINT_STATUSES, default: 'active' },
    disabledReason: { type: String, default: null },
    consecutiveFailures: { type: Number, default: 0 },
    lastDeliveryAt: { type: Date, default: null },
    lastDeliveryStatus: { type: String, enum: ['succeeded', 'failed', null], default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
webhookEndpointSchema.plugin(tenantScoped);
webhookEndpointSchema.index({ workspaceId: 1, status: 1, events: 1 });

export type WebhookEndpointDoc = HydratedDocument<InferSchemaType<typeof webhookEndpointSchema>>;
export const WebhookEndpoint = model('WebhookEndpoint', webhookEndpointSchema);

export const DELIVERY_STATUSES = ['pending', 'retrying', 'succeeded', 'dead'] as const;

/** One event for one endpoint, with every attempt. Kept 30 days. */
const webhookDeliverySchema = new Schema(
  {
    workspaceId: workspaceIdField,
    endpointId: { type: Schema.Types.ObjectId, ref: 'WebhookEndpoint', required: true },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: DELIVERY_STATUSES, default: 'pending' },
    attempts: {
      type: [
        {
          _id: false,
          at: Date,
          statusCode: { type: Number, default: null },
          durationMs: Number,
          error: { type: String, default: null },
          responseSnippet: { type: String, default: null },
        },
      ],
      default: [],
    },
    nextAttemptAt: { type: Date, default: null },
    // Bumped on every (re)schedule; a queued job with an older token is stale.
    token: { type: String, default: null },
    createdAt: { type: Date, default: Date.now, expires: 30 * 24 * 60 * 60 },
  },
  { minimize: false },
);
webhookDeliverySchema.plugin(tenantScoped);
webhookDeliverySchema.index({ workspaceId: 1, endpointId: 1, eventId: 1 }, { unique: true });
webhookDeliverySchema.index({ workspaceId: 1, endpointId: 1, createdAt: -1 });

export type WebhookDeliveryDoc = HydratedDocument<InferSchemaType<typeof webhookDeliverySchema>>;
export const WebhookDelivery = model('WebhookDelivery', webhookDeliverySchema);

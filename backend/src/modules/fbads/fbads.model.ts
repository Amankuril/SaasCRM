import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

export const FB_CONNECTION_STATUSES = ['pending', 'connected', 'error', 'disconnected'] as const;

/**
 * A workspace's Meta ad account connection (one per workspace). `pending` = the
 * person logged in with Facebook but has not picked an ad account yet. `error` =
 * the token stopped working: every write is blocked until they reconnect.
 */
const connectionSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    status: { type: String, enum: FB_CONNECTION_STATUSES, default: 'pending' },
    fbUserId: { type: String, default: null },
    fbUserName: { type: String, default: null },
    adAccountId: { type: String, default: null }, // "act_123"
    adAccountName: { type: String, default: null },
    currency: { type: String, default: null },
    timezone: { type: String, default: null },
    // Meta's account_status: 1 active, 2 disabled, 3 unsettled, 7 pending review, 9 in grace period, 101 closed…
    accountStatus: { type: Number, default: null },
    accessTokenEnc: { type: String, default: null, select: false },
    tokenExpiresAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    connectedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    connectedAt: { type: Date, default: null },
    lastVerifiedAt: { type: Date, default: null },
    sync: {
      status: { type: String, enum: ['idle', 'queued', 'running', 'failed'], default: 'idle' },
      startedAt: { type: Date, default: null },
      finishedAt: { type: Date, default: null },
      error: { type: String, default: null },
      counts: { type: Schema.Types.Mixed, default: null },
    },
    disconnectedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
connectionSchema.plugin(tenantScoped);
connectionSchema.index({ workspaceId: 1 }, { unique: true });
connectionSchema.index({ status: 1, 'sync.finishedAt': 1 });

export type FbConnectionDoc = HydratedDocument<InferSchemaType<typeof connectionSchema>>;
export const FbConnection = model('FbConnection', connectionSchema);

export const FB_KINDS = ['campaign', 'adset', 'ad', 'creative', 'audience', 'pixel'] as const;
export type FbKind = (typeof FB_KINDS)[number];

/**
 * One synced Meta object (campaign, ad set, ad, creative, custom audience or
 * pixel). Lists and counters read these local rows ("synced locally"), never
 * Meta directly. Objects missing from Meta on the next sync are marked deleted.
 */
const entitySchema = new Schema(
  {
    workspaceId: workspaceIdField,
    adAccountId: { type: String, required: true },
    kind: { type: String, enum: FB_KINDS, required: true },
    metaId: { type: String, required: true },
    name: { type: String, default: '' },
    // Configured status (ACTIVE, PAUSED, ARCHIVED, DELETED) and what Meta actually shows (effective_status).
    status: { type: String, default: null },
    effectiveStatus: { type: String, default: null },
    campaignMetaId: { type: String, default: null },
    adsetMetaId: { type: String, default: null },
    creativeMetaId: { type: String, default: null },
    objective: { type: String, default: null },
    buyingType: { type: String, default: null },
    // Minor units (paise) as Meta stores them.
    dailyBudget: { type: Number, default: null },
    lifetimeBudget: { type: Number, default: null },
    optimizationGoal: { type: String, default: null },
    billingEvent: { type: String, default: null },
    targetingSummary: { type: String, default: null },
    reviewStatus: { type: String, default: null },
    thumbnailUrl: { type: String, default: null },
    creativeType: { type: String, default: null },
    headline: { type: String, default: null },
    callToAction: { type: String, default: null },
    subtype: { type: String, default: null },
    approxCount: { type: Number, default: null },
    lastFiredAt: { type: Date, default: null },
    metaUpdatedAt: { type: Date, default: null },
    raw: { type: Schema.Types.Mixed, default: null },
    syncedAt: { type: Date, default: null },
    // Gone from Meta (or deleted here): kept for the record.
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
entitySchema.plugin(tenantScoped);
entitySchema.index({ workspaceId: 1, adAccountId: 1, kind: 1, metaId: 1 }, { unique: true });
entitySchema.index({ workspaceId: 1, adAccountId: 1, kind: 1, deletedAt: 1, updatedAt: -1 });

export type FbEntityDoc = HydratedDocument<InferSchemaType<typeof entitySchema>>;
export const FbEntity = model('FbEntity', entitySchema);

/** Every Meta call (the "Logs" button shows the last 500). Kept 30 days. */
const apiLogSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    endpoint: { type: String, required: true },
    method: { type: String, required: true },
    httpStatus: { type: Number, default: null },
    error: { type: String, default: null },
    durationMs: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
apiLogSchema.plugin(tenantScoped);
apiLogSchema.index({ workspaceId: 1, createdAt: -1 });
apiLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86_400 });

export const FbApiLog = model('FbApiLog', apiLogSchema);

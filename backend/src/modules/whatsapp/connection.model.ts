import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

export const CONNECTION_STATUSES = ['connected', 'error'] as const;

/** A workspace's WhatsApp Business number. One per workspace for now. */
const connectionSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    provider: { type: String, required: true },
    wabaId: { type: String, required: true, index: true },
    // Globally unique: incoming webhooks are routed to a workspace by this id.
    phoneNumberId: { type: String, required: true, unique: true },
    accessTokenEncrypted: { type: String, required: true, select: false },
    displayPhoneNumber: { type: String, default: null },
    verifiedName: { type: String, default: null },
    qualityRating: { type: String, default: null },
    messagingLimitTier: { type: String, default: null },
    status: { type: String, enum: CONNECTION_STATUSES, default: 'connected' },
    lastError: { type: String, default: null },
    lastSyncAt: { type: Date, default: null },
    lastWebhookAt: { type: Date, default: null },
    connectedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

connectionSchema.plugin(tenantScoped);
connectionSchema.index({ workspaceId: 1 }, { unique: true });

export type ConnectionDoc = HydratedDocument<InferSchemaType<typeof connectionSchema>>;
export const ProviderConnection = model('ProviderConnection', connectionSchema);

export function toPublicConnection(c: ConnectionDoc) {
  return {
    id: c.id as string,
    provider: c.provider,
    wabaId: c.wabaId,
    phoneNumberId: c.phoneNumberId,
    displayPhoneNumber: c.displayPhoneNumber,
    verifiedName: c.verifiedName,
    qualityRating: c.qualityRating,
    messagingLimitTier: c.messagingLimitTier,
    status: c.status,
    lastError: c.lastError,
    lastSyncAt: c.lastSyncAt,
    lastWebhookAt: c.lastWebhookAt,
    createdAt: c.createdAt,
  };
}

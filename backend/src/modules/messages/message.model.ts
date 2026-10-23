import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

/**
 * Outbound: queued -> submitted (accepted by provider API) -> sent -> delivered -> read, or failed.
 * Inbound messages are stored as `received`.
 */
export const MESSAGE_STATUSES = ['queued', 'submitted', 'sent', 'delivered', 'read', 'failed', 'received'] as const;
export type MessageStatusValue = (typeof MESSAGE_STATUSES)[number];

const messageSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    type: { type: String, required: true },
    // Text body, media reference, or the template snapshot that was sent.
    content: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: MESSAGE_STATUSES, required: true },
    providerMessageId: { type: String, default: null },
    error: {
      type: new Schema({ code: String, title: String, message: String }, { _id: false }),
      default: null,
    },
    attempts: { type: Number, default: 0 },
    idempotencyKey: { type: String, default: null },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    submittedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

messageSchema.plugin(tenantScoped);
messageSchema.index({ workspaceId: 1, contactId: 1, createdAt: -1 });
messageSchema.index({ workspaceId: 1, createdAt: -1 });
// Provider ids are unique per workspace: replayed webhooks cannot create duplicates.
messageSchema.index(
  { workspaceId: 1, providerMessageId: 1 },
  { unique: true, partialFilterExpression: { providerMessageId: { $type: 'string' } } },
);
messageSchema.index(
  { workspaceId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

export type MessageDoc = HydratedDocument<InferSchemaType<typeof messageSchema>>;
export const Message = model('Message', messageSchema);

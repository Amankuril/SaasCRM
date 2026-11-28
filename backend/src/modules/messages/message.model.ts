import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

/**
 * Outbound: queued -> submitted (accepted by provider API) -> sent -> delivered -> read, or failed.
 * Inbound messages are stored as `received`.
 */
export const MESSAGE_STATUSES = ['queued', 'submitted', 'sent', 'delivered', 'read', 'failed', 'received'] as const;
export type MessageStatusValue = (typeof MESSAGE_STATUSES)[number];

/** Which part of Zeta Connect sent an outbound message (for cost by feature). Null on inbound. */
export const MESSAGE_SOURCES = ['inbox', 'broadcast', 'sequence', 'chatbot', 'api', 'fb_lead', 'reminder'] as const;
export type MessageSource = (typeof MESSAGE_SOURCES)[number];

/** Meta's charge details for an outbound message, from the first status receipt that carried them. */
const pricingSchema = new Schema(
  {
    billable: { type: Boolean, default: null },
    model: { type: String, default: null },
    type: { type: String, default: null },
    category: { type: String, default: null },
    // Recipient's country (ISO code), which decides Meta's rate.
    market: { type: String, default: null },
    raw: { type: Schema.Types.Mixed, default: null },
    receivedAt: { type: Date, default: null },
  },
  { _id: false },
);

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
    // Set for broadcast sends so delivery receipts can update the campaign report.
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', default: null },
    // Set when an automation flow sent it.
    flowExecutionId: { type: Schema.Types.ObjectId, ref: 'FlowExecution', default: null },
    aiGenerated: { type: Boolean, default: false },
    source: { type: String, enum: [...MESSAGE_SOURCES, null], default: null },
    // The template sent (copied from content.template.id), for reporting.
    templateId: { type: Schema.Types.ObjectId, ref: 'MessageTemplate', default: null },
    pricing: { type: pricingSchema, default: null },
    submittedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

messageSchema.pre('validate', function () {
  const id = (this.content as { template?: { id?: unknown } } | null)?.template?.id;
  if (!this.templateId && typeof id === 'string' && Types.ObjectId.isValid(id)) this.templateId = new Types.ObjectId(id);
});

messageSchema.plugin(tenantScoped);
messageSchema.index({ workspaceId: 1, contactId: 1, createdAt: -1 });
messageSchema.index({ workspaceId: 1, createdAt: -1 });
// Message pricing report: range scans by direction.
messageSchema.index({ workspaceId: 1, direction: 1, createdAt: 1 });
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

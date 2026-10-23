import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

export const CONVERSATION_STATUSES = ['open', 'pending', 'resolved'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/**
 * One WhatsApp thread per contact. Resolving keeps history; a new customer
 * message reopens it.
 */
const conversationSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    status: { type: String, enum: CONVERSATION_STATUSES, default: 'open' },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    priority: { type: String, enum: ['normal', 'high'], default: 'normal' },
    // Set when a flow hands the chat to a human: automations stay quiet until it's resolved or resumed.
    botPaused: { type: Boolean, default: false },
    // Automatic AI replies since the conversation was last opened (capped per agent settings).
    aiReplyCount: { type: Number, default: 0 },
    unreadCount: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: null },
    lastMessagePreview: { type: String, default: null },
    lastMessageDirection: { type: String, enum: ['inbound', 'outbound', null], default: null },
    lastInboundAt: { type: Date, default: null },
    openedAt: { type: Date, default: () => new Date() },
    resolvedAt: { type: Date, default: null },
    // First teammate reply since the conversation (re)opened: drives first-response-time reports.
    firstReplyAt: { type: Date, default: null },
  },
  { timestamps: true },
);

conversationSchema.plugin(tenantScoped);
conversationSchema.index({ workspaceId: 1, contactId: 1 }, { unique: true });
conversationSchema.index({ workspaceId: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index({ workspaceId: 1, assigneeId: 1, status: 1, lastMessageAt: -1 });

export type ConversationDoc = HydratedDocument<InferSchemaType<typeof conversationSchema>>;
export const Conversation = model('Conversation', conversationSchema);

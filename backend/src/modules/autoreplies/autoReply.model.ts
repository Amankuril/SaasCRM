import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

export const MATCH_TYPES = ['equals', 'contains', 'event'] as const;
export const TRIGGER_EVENTS = ['first_message', 'any_message'] as const;
export const MESSAGE_SOURCES = ['ad', 'broadcast', 'direct'] as const;
export const ACTION_TYPES = [
  'text',
  'file',
  'quick_reply',
  'cta_url',
  'form',
  'chatbot',
  'ai_chatbot',
  'location',
  'address',
  'template',
  'unsubscribe',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * A keyword trigger ("auto reply"): when an incoming message matches, run one
 * action. Equals beats Contains beats event triggers; see autoReply.service.
 */
const autoReplySchema = new Schema(
  {
    workspaceId: workspaceIdField,
    name: { type: String, required: true, trim: true, maxlength: 120 },
    active: { type: Boolean, default: true },
    match: { type: String, enum: MATCH_TYPES, required: true },
    // Stored lowercased and trimmed; compared against the lowercased message.
    keywords: { type: [String], default: [] },
    event: { type: String, enum: [...TRIGGER_EVENTS, null], default: null },
    // Empty = any source.
    sources: { type: [String], enum: MESSAGE_SOURCES, default: [] },
    // Per-customer quiet period after firing (0 = reply every time).
    cooldownMinutes: { type: Number, min: 0, max: 60 * 24 * 30, default: 0 },
    action: {
      type: { type: String, enum: ACTION_TYPES, required: true },
      // Shape depends on the type; validated by actionSchema in the service.
      config: { type: Schema.Types.Mixed, default: {} },
    },
    firedCount: { type: Number, default: 0 },
    lastFiredAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, minimize: false },
);

autoReplySchema.plugin(tenantScoped);
autoReplySchema.index({ workspaceId: 1, active: 1, match: 1 });

export type AutoReplyDoc = HydratedDocument<InferSchemaType<typeof autoReplySchema>>;
export const AutoReply = model('AutoReply', autoReplySchema);

/** One firing, kept 90 days: drives per-customer cooldowns and the "fired" stats. */
const autoReplyFireSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    autoReplyId: { type: Schema.Types.ObjectId, ref: 'AutoReply', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    messageId: { type: String, default: null },
    firedAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

autoReplyFireSchema.plugin(tenantScoped);
autoReplyFireSchema.index({ workspaceId: 1, autoReplyId: 1, contactId: 1, firedAt: -1 });
autoReplyFireSchema.index({ firedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const AutoReplyFire = model('AutoReplyFire', autoReplyFireSchema);

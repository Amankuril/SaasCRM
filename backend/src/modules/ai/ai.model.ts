import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

export const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type AiModel = (typeof AI_MODELS)[number];

/** One AI agent per workspace: how it talks, what it may answer, when it hands off. */
const aiAgentSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    enabled: { type: Boolean, default: false },
    // Answer customer messages that no flow handles. Off = only flows/inbox drafts use the AI.
    autoReply: { type: Boolean, default: false },
    name: { type: String, trim: true, maxlength: 60, default: 'Assistant' },
    tone: { type: String, enum: ['friendly', 'professional', 'concise'], default: 'friendly' },
    // "auto" replies in the customer's language.
    language: { type: String, default: 'auto' },
    businessContext: { type: String, trim: true, maxlength: 2000, default: '' },
    instructions: { type: String, trim: true, maxlength: 4000, default: '' },
    fallbackMessage: { type: String, trim: true, maxlength: 500, default: "Sorry, I couldn't find that. A teammate will get back to you shortly." },
    handoffMessage: { type: String, trim: true, maxlength: 500, default: 'Let me connect you with a teammate who can help.' },
    escalationKeywords: { type: [String], default: ['human', 'agent', 'complaint', 'refund'] },
    // Cap on automatic replies per conversation before a human must step in.
    maxRepliesPerConversation: { type: Number, min: 1, max: 50, default: 5 },
    model: { type: String, enum: AI_MODELS, default: 'claude-opus-5-5' },
    // Bring-your-own Anthropic key (encrypted). Falls back to the platform key when unset.
    apiKeyEncrypted: { type: String, default: null, select: false },
    apiKeyLast4: { type: String, default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

aiAgentSchema.plugin(tenantScoped);
aiAgentSchema.index({ workspaceId: 1 }, { unique: true });

export type AiAgentDoc = HydratedDocument<InferSchemaType<typeof aiAgentSchema>>;
export const AiAgent = model('AiAgent', aiAgentSchema);

/** One row per model call, for cost/quality reporting. Never stores message text. */
const aiUsageSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null },
    purpose: { type: String, enum: ['auto_reply', 'flow', 'draft', 'test'], required: true },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    outcome: { type: String, enum: ['answered', 'handoff', 'error', 'escalated', 'capped'], required: true },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },
    sourceCount: { type: Number, default: 0 },
    error: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

aiUsageSchema.plugin(tenantScoped);
aiUsageSchema.index({ workspaceId: 1, createdAt: -1 });

export type AiUsageAttrs = InferSchemaType<typeof aiUsageSchema>;
export const AiUsage = model('AiUsage', aiUsageSchema);

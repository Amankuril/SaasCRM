import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

/** Something the AI may answer from: pasted text, a Q&A pair, or a web page. */
const sourceSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    type: { type: String, enum: ['text', 'faq', 'url'], required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    url: { type: String, default: null },
    // Raw text as entered or extracted (kept so chunks can be rebuilt).
    content: { type: String, default: '' },
    status: { type: String, enum: ['ready', 'failed'], default: 'ready' },
    error: { type: String, default: null },
    chunkCount: { type: Number, default: 0 },
    version: { type: Number, default: 1 },
    lastIngestedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

sourceSchema.plugin(tenantScoped);
sourceSchema.index({ workspaceId: 1, createdAt: -1 });

export type KnowledgeSourceDoc = HydratedDocument<InferSchemaType<typeof sourceSchema>>;
export const KnowledgeSource = model('KnowledgeSource', sourceSchema);

/** Retrieval unit. Search always filters by workspaceId first (no cross-tenant leakage). */
const chunkSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    sourceId: { type: Schema.Types.ObjectId, ref: 'KnowledgeSource', required: true },
    position: { type: Number, required: true },
    text: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

chunkSchema.plugin(tenantScoped);
chunkSchema.index({ workspaceId: 1, sourceId: 1, position: 1 });
// Full-text index; workspaceId leads so the planner narrows to one tenant.
chunkSchema.index({ workspaceId: 1, text: 'text' }, { default_language: 'english', language_override: 'none' });

export type KnowledgeChunkDoc = HydratedDocument<InferSchemaType<typeof chunkSchema>>;
export const KnowledgeChunk = model('KnowledgeChunk', chunkSchema);

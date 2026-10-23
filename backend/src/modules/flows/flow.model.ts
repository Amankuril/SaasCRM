import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

/**
 * A flow has an editable draft and immutable published versions. Draft edits
 * never affect running executions; each execution is pinned to the version it
 * started on.
 */
const flowSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    status: { type: String, enum: ['draft', 'active', 'inactive'], default: 'draft' },
    draftGraph: { type: Schema.Types.Mixed, required: true },
    draftUpdatedAt: { type: Date, default: () => new Date() },
    publishedVersionId: { type: Schema.Types.ObjectId, ref: 'FlowVersion', default: null },
    publishedVersion: { type: Number, default: 0 },
    publishedAt: { type: Date, default: null },
    settings: {
      // Start again for a contact who is already inside this flow.
      allowReentry: { type: Boolean, default: false },
      // A customer message during a "wait" step ends the run (drip-style exit rule).
      exitOnReply: { type: Boolean, default: false },
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

flowSchema.plugin(tenantScoped);
flowSchema.index({ workspaceId: 1, status: 1 });

export type FlowDoc = HydratedDocument<InferSchemaType<typeof flowSchema>>;
export const Flow = model('Flow', flowSchema);

const flowVersionSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    flowId: { type: Schema.Types.ObjectId, ref: 'Flow', required: true },
    version: { type: Number, required: true },
    graph: { type: Schema.Types.Mixed, required: true },
    // Denormalized from the trigger node for fast matching on inbound messages.
    trigger: {
      event: { type: String, required: true },
      keywords: { type: [String], default: [] },
      match: { type: String, default: 'exact' },
      tagId: { type: Schema.Types.ObjectId, default: null },
    },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: 'publishedAt', updatedAt: false } },
);

flowVersionSchema.plugin(tenantScoped);
flowVersionSchema.index({ workspaceId: 1, flowId: 1, version: 1 }, { unique: true });

export type FlowVersionDoc = HydratedDocument<InferSchemaType<typeof flowVersionSchema>>;
export const FlowVersion = model('FlowVersion', flowVersionSchema);

export const EXECUTION_STATUSES = ['running', 'waiting', 'completed', 'exited', 'failed'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** One contact's journey through one flow version. Persisted so waits survive restarts. */
const executionSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    flowId: { type: Schema.Types.ObjectId, ref: 'Flow', required: true },
    flowVersionId: { type: Schema.Types.ObjectId, ref: 'FlowVersion', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    status: { type: String, enum: EXECUTION_STATUSES, default: 'running' },
    currentNodeId: { type: String, default: null },
    waiting: {
      type: new Schema(
        {
          kind: { type: String, enum: ['delay', 'reply'], required: true },
          nodeId: { type: String, required: true },
          until: { type: Date, required: true },
          // Wake-up jobs carry this token; a stale job (token changed) does nothing.
          token: { type: String, required: true },
          attempts: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      default: null,
    },
    vars: { type: Schema.Types.Mixed, default: {} },
    trigger: { type: Schema.Types.Mixed, default: {} },
    stepCount: { type: Number, default: 0 },
    log: {
      type: [
        new Schema(
          { nodeId: String, type: String, outcome: String, detail: String, at: { type: Date, default: () => new Date() } },
          { _id: false },
        ),
      ],
      default: [],
    },
    error: { type: String, default: null },
    exitReason: { type: String, default: null },
    goal: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

executionSchema.plugin(tenantScoped);
executionSchema.index({ workspaceId: 1, contactId: 1, status: 1 });
executionSchema.index({ workspaceId: 1, flowId: 1, createdAt: -1 });

export type ExecutionDoc = HydratedDocument<InferSchemaType<typeof executionSchema>>;
export const FlowExecution = model('FlowExecution', executionSchema);

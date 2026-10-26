import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

export const STAGE_COLORS = ['green', 'orange', 'amber', 'yellow', 'blue', 'indigo', 'violet', 'pink', 'red', 'teal', 'gray'] as const;

/**
 * A workspace's own pipeline stage ("Hot Lead", "Invoice issued"...). Contacts
 * store the stable `key`; the name and colour can change freely.
 */
const stageSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    key: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    color: { type: String, enum: STAGE_COLORS, default: 'gray' },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

stageSchema.plugin(tenantScoped);
stageSchema.index({ workspaceId: 1, key: 1 }, { unique: true });

export type StageDoc = HydratedDocument<InferSchemaType<typeof stageSchema>>;
export const PipelineStage = model('PipelineStage', stageSchema);

export function toPublicStage(s: StageDoc | (InferSchemaType<typeof stageSchema> & { _id: unknown })) {
  return { id: String(s._id), key: s.key, name: s.name, color: s.color, order: s.order };
}

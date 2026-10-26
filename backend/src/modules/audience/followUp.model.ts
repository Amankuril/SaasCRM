import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

/** A reminder to get back to a customer ("Follow-up" in Audience). */
const followUpSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    dueAt: { type: Date, required: true },
    note: { type: String, trim: true, maxlength: 1000, default: '' },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['open', 'done'], default: 'open' },
    completedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

followUpSchema.plugin(tenantScoped);
followUpSchema.index({ workspaceId: 1, status: 1, dueAt: 1 });
followUpSchema.index({ workspaceId: 1, contactId: 1, status: 1 });

export type FollowUpDoc = HydratedDocument<InferSchemaType<typeof followUpSchema>>;
export const FollowUp = model('FollowUp', followUpSchema);

export function toPublicFollowUp(f: FollowUpDoc | (InferSchemaType<typeof followUpSchema> & { _id: unknown })) {
  return {
    id: String(f._id),
    contactId: String(f.contactId),
    dueAt: f.dueAt,
    note: f.note,
    assigneeId: f.assigneeId ? String(f.assigneeId) : null,
    status: f.status,
    completedAt: f.completedAt ?? null,
    createdAt: f.createdAt,
  };
}

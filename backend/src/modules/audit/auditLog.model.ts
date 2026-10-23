import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

const auditLogSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, required: true },
    targetType: { type: String, default: null },
    targetId: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.plugin(tenantScoped);
auditLogSchema.index({ workspaceId: 1, _id: -1 });

export type AuditLogAttrs = InferSchemaType<typeof auditLogSchema>;
export const AuditLog = model('AuditLog', auditLogSchema);

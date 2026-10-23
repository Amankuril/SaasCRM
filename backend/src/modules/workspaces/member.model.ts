import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';
import { ROLES } from '../roles.js';

const memberSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ROLES, required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    joinedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

memberSchema.plugin(tenantScoped);
memberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

export type MemberDoc = HydratedDocument<InferSchemaType<typeof memberSchema>>;
export const WorkspaceMember = model('WorkspaceMember', memberSchema);

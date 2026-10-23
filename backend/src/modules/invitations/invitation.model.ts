import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';
import { ROLES } from '../roles.js';

export const INVITE_TTL_DAYS = 7;

const invitationSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ROLES, required: true },
    tokenHash: { type: String, required: true, unique: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    acceptedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

invitationSchema.plugin(tenantScoped);
invitationSchema.index({ workspaceId: 1, email: 1 });

export type InvitationDoc = HydratedDocument<InferSchemaType<typeof invitationSchema>>;
export const Invitation = model('Invitation', invitationSchema);

export function invitationStatus(inv: InvitationDoc): 'pending' | 'accepted' | 'revoked' | 'expired' {
  if (inv.acceptedAt) return 'accepted';
  if (inv.revokedAt) return 'revoked';
  if (inv.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'pending';
}

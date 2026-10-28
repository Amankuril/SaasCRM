import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Everything a platform admin does from the Super Admin panel (platform-wide, not
 * tenant-scoped). Changes inside one workspace are also written to that workspace's
 * own audit log so the business can see them.
 */
const adminActionSchema = new Schema(
  {
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true, index: true },
    targetType: { type: String, default: null },
    targetId: { type: String, default: null },
    // Kept even after a workspace is deleted, so its name is stored too.
    workspaceId: { type: Schema.Types.ObjectId, default: null, index: true },
    workspaceName: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const AdminAction = model('AdminAction', adminActionSchema);

/** Platform-wide switches. A single document (`key: 'platform'`). */
const platformSettingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: 'platform' },
    // Banner shown at the top of every business workspace.
    announcement: {
      active: { type: Boolean, default: false },
      text: { type: String, default: '', maxlength: 500 },
      tone: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
    },
    // Off: /signup refuses new accounts (invites still work).
    signupsEnabled: { type: Boolean, default: true },
    // On: business logins are refused (platform admins can still sign in).
    maintenanceMode: { type: Boolean, default: false },
    maintenanceMessage: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true },
);

export type PlatformSettingsDoc = HydratedDocument<InferSchemaType<typeof platformSettingsSchema>>;
export const PlatformSettings = model('PlatformSettings', platformSettingsSchema);

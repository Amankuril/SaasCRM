import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

export const WORKSPACE_STATUSES = ['setup', 'active', 'suspended'] as const;

/** The tenant itself. Tenant-owned collections reference it through `workspaceId`. */
const workspaceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    slug: { type: String, required: true, unique: true, lowercase: true },
    timezone: { type: String, required: true, default: 'Asia/Kolkata' },
    country: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2, default: 'IN' },
    industry: { type: String, trim: true, maxlength: 60, default: null },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3, default: 'INR' },
    // `setup` until WhatsApp is connected and required settings are complete.
    status: { type: String, enum: WORKSPACE_STATUSES, default: 'setup', index: true },
    suspendedReason: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

export type WorkspaceDoc = HydratedDocument<InferSchemaType<typeof workspaceSchema>>;
export const Workspace = model('Workspace', workspaceSchema);

export function toPublicWorkspace(ws: WorkspaceDoc) {
  return {
    id: ws.id as string,
    name: ws.name,
    slug: ws.slug,
    timezone: ws.timezone,
    country: ws.country,
    industry: ws.industry,
    currency: ws.currency,
    status: ws.status,
    createdAt: ws.createdAt,
  };
}

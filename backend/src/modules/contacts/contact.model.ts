import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

export const LIFECYCLE_STAGES = ['new', 'contacted', 'qualified', 'follow_up', 'converted', 'lost'] as const;
export const CONSENT_STATUSES = ['unknown', 'opted_in', 'opted_out'] as const;

/** The audience/identity layer shared by inbox, campaigns, flows and reports. */
const contactSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    phoneE164: { type: String, required: true },
    name: { type: String, trim: true, maxlength: 200, default: null },
    // WhatsApp profile name as last reported by the customer's app.
    profileName: { type: String, default: null },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: null },
    tags: { type: [{ type: Schema.Types.ObjectId, ref: 'Tag' }], default: [] },
    lifecycleStage: { type: String, enum: LIFECYCLE_STAGES, default: 'new' },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    customFields: { type: Schema.Types.Mixed, default: {} },
    consent: {
      status: { type: String, enum: CONSENT_STATUSES, default: 'unknown' },
      source: { type: String, default: null },
      updatedAt: { type: Date, default: null },
    },
    externalId: { type: String, trim: true, maxlength: 200, default: null },
    // Drives the 24-hour customer service window.
    lastInboundAt: { type: Date, default: null },
    lastOutboundAt: { type: Date, default: null },
    source: { type: String, default: null },
  },
  { timestamps: true },
);

contactSchema.plugin(tenantScoped);
contactSchema.index({ workspaceId: 1, phoneE164: 1 }, { unique: true });
contactSchema.index({ workspaceId: 1, tags: 1 });
contactSchema.index({ workspaceId: 1, lifecycleStage: 1 });
contactSchema.index({ workspaceId: 1, createdAt: -1 });

export type ContactDoc = HydratedDocument<InferSchemaType<typeof contactSchema>>;
export const Contact = model('Contact', contactSchema);

export function toPublicContact(c: ContactDoc | (InferSchemaType<typeof contactSchema> & { _id: unknown })) {
  return {
    id: String(c._id),
    phone: c.phoneE164,
    name: c.name ?? null,
    profileName: c.profileName ?? null,
    displayName: c.name || c.profileName || c.phoneE164,
    email: c.email ?? null,
    tags: (c.tags ?? []).map(String),
    lifecycleStage: c.lifecycleStage,
    ownerId: c.ownerId ? String(c.ownerId) : null,
    customFields: (c.customFields ?? {}) as Record<string, string>,
    consent: { status: c.consent?.status ?? 'unknown', source: c.consent?.source ?? null, updatedAt: c.consent?.updatedAt ?? null },
    externalId: c.externalId ?? null,
    source: c.source ?? null,
    lastInboundAt: c.lastInboundAt ?? null,
    createdAt: c.createdAt,
  };
}

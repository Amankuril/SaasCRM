import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

/**
 * The audience/identity layer. Phase 2 keeps only what messaging needs; tags,
 * custom fields, consent and lifecycle stage arrive with the CRM (Phase 3).
 */
const contactSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    phoneE164: { type: String, required: true },
    name: { type: String, trim: true, maxlength: 200, default: null },
    // WhatsApp profile name as last reported by the customer's app.
    profileName: { type: String, default: null },
    // Drives the 24-hour customer service window.
    lastInboundAt: { type: Date, default: null },
    lastOutboundAt: { type: Date, default: null },
    source: { type: String, default: null },
  },
  { timestamps: true },
);

contactSchema.plugin(tenantScoped);
contactSchema.index({ workspaceId: 1, phoneE164: 1 }, { unique: true });

export type ContactDoc = HydratedDocument<InferSchemaType<typeof contactSchema>>;
export const Contact = model('Contact', contactSchema);

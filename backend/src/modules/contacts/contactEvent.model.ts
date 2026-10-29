import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

export const CONTACT_EVENT_TYPES = ['stage_changed', 'blocked', 'unblocked'] as const;

/** Changes to a contact worth showing later: stage history and the chat journey. */
const contactEventSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    type: { type: String, enum: CONTACT_EVENT_TYPES, required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
    // Null when an automation or an import made the change.
    byUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
contactEventSchema.plugin(tenantScoped);
contactEventSchema.index({ workspaceId: 1, contactId: 1, createdAt: -1 });

export type ContactEventAttrs = InferSchemaType<typeof contactEventSchema>;
export const ContactEvent = model('ContactEvent', contactEventSchema);

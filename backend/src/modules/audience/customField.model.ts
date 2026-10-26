import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date'] as const;

/** A named custom column in Audience; values live in Contact.customFields[key]. */
const customFieldSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    key: { type: String, required: true },
    label: { type: String, required: true, trim: true, maxlength: 40 },
    type: { type: String, enum: CUSTOM_FIELD_TYPES, default: 'text' },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

customFieldSchema.plugin(tenantScoped);
customFieldSchema.index({ workspaceId: 1, key: 1 }, { unique: true });

export type CustomFieldDoc = HydratedDocument<InferSchemaType<typeof customFieldSchema>>;
export const CustomField = model('CustomField', customFieldSchema);

export function toPublicCustomField(f: CustomFieldDoc) {
  return { id: f.id as string, key: f.key, label: f.label, type: f.type, order: f.order };
}

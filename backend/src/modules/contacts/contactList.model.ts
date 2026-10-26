import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

/**
 * A named contact book for broadcasts ("Diwali leads"). Membership lives on the
 * contact (`Contact.lists`), so one person can be in several lists and is never
 * duplicated; deleting a list keeps its contacts.
 */
const contactListSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    name: { type: String, required: true, trim: true, maxlength: 255 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

contactListSchema.plugin(tenantScoped);
contactListSchema.index({ workspaceId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export type ContactListDoc = HydratedDocument<InferSchemaType<typeof contactListSchema>>;
export const ContactList = model('ContactList', contactListSchema);

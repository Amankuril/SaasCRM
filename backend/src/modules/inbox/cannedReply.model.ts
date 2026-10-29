import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

/** Team-wide saved reply, inserted in the inbox by typing "/" plus its shortcut. */
const cannedReplySchema = new Schema(
  {
    workspaceId: workspaceIdField,
    // Lowercase letters, numbers, - and _: typed after "/".
    shortcut: { type: String, required: true, trim: true, lowercase: true, maxlength: 30 },
    body: { type: String, required: true, trim: true, maxlength: 4096 },
    useCount: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
cannedReplySchema.plugin(tenantScoped);
cannedReplySchema.index({ workspaceId: 1, shortcut: 1 }, { unique: true });

export type CannedReplyDoc = HydratedDocument<InferSchemaType<typeof cannedReplySchema>>;
export const CannedReply = model('CannedReply', cannedReplySchema);

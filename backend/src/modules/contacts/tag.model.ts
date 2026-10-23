import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

export const TAG_COLORS = ['gray', 'red', 'amber', 'green', 'blue', 'violet', 'pink'] as const;

const tagSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    name: { type: String, required: true, trim: true, maxlength: 40 },
    color: { type: String, enum: TAG_COLORS, default: 'gray' },
  },
  { timestamps: true },
);

tagSchema.plugin(tenantScoped);
// Case-insensitive uniqueness per workspace ("VIP" == "vip").
tagSchema.index({ workspaceId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export type TagDoc = HydratedDocument<InferSchemaType<typeof tagSchema>>;
export const Tag = model('Tag', tagSchema);

export function toPublicTag(t: TagDoc) {
  return { id: t.id as string, name: t.name, color: t.color };
}

import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';
import type { TemplateComponent } from '../whatsapp/provider/types.js';

/** Local mirror of a provider message template (synced; never "approved" locally). */
const templateSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    providerTemplateId: { type: String, default: null },
    name: { type: String, required: true },
    language: { type: String, required: true },
    category: { type: String, required: true },
    // Provider status as-is: APPROVED, PENDING, REJECTED, PAUSED, DISABLED...
    status: { type: String, required: true },
    rejectedReason: { type: String, default: null },
    components: { type: [Schema.Types.Mixed], default: [] },
    syncedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

templateSchema.plugin(tenantScoped);
templateSchema.index({ workspaceId: 1, name: 1, language: 1 }, { unique: true });
templateSchema.index({ workspaceId: 1, providerTemplateId: 1 });

export type TemplateDoc = HydratedDocument<InferSchemaType<typeof templateSchema>>;
export const MessageTemplate = model('MessageTemplate', templateSchema);

/** Counts {{1}}..{{n}} placeholders in a component's text. */
export function countVariables(text: string | undefined): number {
  const nums = [...(text ?? '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

export function templateVariables(components: TemplateComponent[]) {
  const header = components.find((c) => c.type === 'HEADER');
  const body = components.find((c) => c.type === 'BODY');
  return {
    header: header?.format === 'TEXT' ? countVariables(header.text) : 0,
    body: countVariables(body?.text),
  };
}

export function toPublicTemplate(t: TemplateDoc) {
  const components = t.components as TemplateComponent[];
  return {
    id: t.id as string,
    providerTemplateId: t.providerTemplateId,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    rejectedReason: t.rejectedReason,
    components,
    variables: templateVariables(components),
    syncedAt: t.syncedAt,
    updatedAt: t.updatedAt,
  };
}

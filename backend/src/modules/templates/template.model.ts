import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';
import type { TemplateComponent } from '../whatsapp/provider/types.js';
import { sendRequirements } from './templateSend.js';

/** Local mirror of a provider message template (synced; never "approved" locally). */
const templateSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    providerTemplateId: { type: String, default: null },
    name: { type: String, required: true },
    language: { type: String, required: true },
    category: { type: String, required: true },
    // Provider status as-is: APPROVED, PENDING, REJECTED, PAUSED, DISABLED...
    // plus DRAFT for templates saved locally and not submitted yet.
    status: { type: String, required: true },
    rejectedReason: { type: String, default: null },
    components: { type: [Schema.Types.Mixed], default: [] },
    syncedAt: { type: Date, default: null },
    // What the builder was used for (custom, carousel, otp...). Inferred from components when null.
    templateType: { type: String, default: null },
    // The raw builder input of a DRAFT, so it can be reopened as-is.
    draft: { type: Schema.Types.Mixed, default: null },
    isFavorite: { type: Boolean, default: false },
    libraryTemplateName: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
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

export const TEMPLATE_TYPES = ['CUSTOM', 'FLOW', 'AUTHENTICATION', 'LIMITED_TIME_OFFER', 'CAROUSEL', 'CATALOG', 'MULTI_PRODUCT', 'CALL_PERMISSION'] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

/** Works out the builder type from Meta components (synced templates carry no type). */
export function inferTemplateType(category: string, components: TemplateComponent[]): TemplateType {
  const types = new Set(components.map((c) => c.type.toUpperCase()));
  const buttons = components.find((c) => c.type.toUpperCase() === 'BUTTONS')?.buttons ?? [];
  const buttonTypes = new Set(buttons.map((b) => b.type.toUpperCase()));
  if (category === 'AUTHENTICATION' || buttonTypes.has('OTP')) return 'AUTHENTICATION';
  if (types.has('CAROUSEL')) return 'CAROUSEL';
  if (types.has('LIMITED_TIME_OFFER')) return 'LIMITED_TIME_OFFER';
  if (types.has('CALL_PERMISSION_REQUEST')) return 'CALL_PERMISSION';
  if (buttonTypes.has('CATALOG')) return 'CATALOG';
  if (buttonTypes.has('MPM')) return 'MULTI_PRODUCT';
  if (buttonTypes.has('FLOW')) return 'FLOW';
  return 'CUSTOM';
}

/** createdBy/updatedBy are only populated on reads that ask for it. */
const userName = (u: unknown) => (u && typeof u === 'object' && 'name' in u ? ((u as { name?: string }).name ?? null) : null);

export function toPublicTemplate(t: TemplateDoc, usage?: { campaigns: number; flows: number }) {
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
    requirements: sendRequirements(components),
    type: (t.templateType as TemplateType | null) ?? inferTemplateType(t.category, components),
    draft: t.draft ?? null,
    isFavorite: t.isFavorite,
    libraryTemplateName: t.libraryTemplateName,
    createdBy: userName(t.createdBy),
    updatedBy: userName(t.updatedBy),
    usage: usage ?? null,
    syncedAt: t.syncedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import type { TemplateComponent } from '../whatsapp/provider/types.js';

/**
 * Community Library: approved templates businesses chose to share with every
 * workspace. Deliberately not tenant-scoped (it is a shared, platform-wide list);
 * only content is copied, never the contributor's ids or media handles.
 */
const communityTemplateSchema = new Schema(
  {
    contributorWorkspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    contributorName: { type: String, required: true },
    name: { type: String, required: true },
    language: { type: String, required: true },
    category: { type: String, required: true },
    templateType: { type: String, required: true },
    components: { type: [Schema.Types.Mixed], default: [] },
    uses: { type: Number, default: 0 },
  },
  { timestamps: true },
);

communityTemplateSchema.index({ contributorWorkspaceId: 1, name: 1, language: 1 }, { unique: true });
communityTemplateSchema.index({ uses: -1, createdAt: -1 });

export type CommunityTemplateDoc = HydratedDocument<InferSchemaType<typeof communityTemplateSchema>>;
export const CommunityTemplate = model('CommunityTemplate', communityTemplateSchema);

/** Media samples belong to the contributor's account; the reuser uploads their own. */
export function stripMedia(components: TemplateComponent[]): TemplateComponent[] {
  return components.map((c) => {
    if (c.type === 'HEADER' && c.format && c.format !== 'TEXT') return { type: 'HEADER', format: c.format };
    if (c.type === 'CAROUSEL') return { ...c, cards: (c.cards ?? []).map((card) => ({ components: stripMedia(card.components) })) };
    return c;
  });
}

export function toPublicCommunityTemplate(t: CommunityTemplateDoc, workspaceId: string) {
  return {
    id: t.id as string,
    name: t.name,
    language: t.language,
    category: t.category,
    type: t.templateType,
    components: t.components as TemplateComponent[],
    contributorName: t.contributorName,
    mine: t.contributorWorkspaceId.toString() === workspaceId,
    uses: t.uses,
    createdAt: t.createdAt,
  };
}

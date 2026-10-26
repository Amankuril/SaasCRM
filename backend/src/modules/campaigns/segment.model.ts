import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

/** Audience rule. Evaluated when a campaign launches; the resulting recipients are snapshotted. */
export const audienceFilterSchema = new Schema(
  {
    tagsAny: { type: [Schema.Types.ObjectId], default: [] },
    // Member of any of these contact lists.
    listsAny: { type: [Schema.Types.ObjectId], default: [] },
    excludeTags: { type: [Schema.Types.ObjectId], default: [] },
    stages: { type: [String], default: [] },
    // How their chat started (Contact.attribution.source) and from which broadcast.
    sources: { type: [String], default: [] },
    campaignIds: { type: [Schema.Types.ObjectId], default: [] },
    ownerIds: { type: [Schema.Types.ObjectId], default: [] },
    unassigned: { type: Boolean, default: false },
    // Only contacts added in the last N days (null = any time).
    addedWithinDays: { type: Number, default: null },
    // Only contacts who explicitly opted in (opted-out contacts are always excluded).
    requireOptIn: { type: Boolean, default: false },
  },
  { _id: false },
);

/** A saved filter, not a copied list: membership is re-evaluated each time it is used. */
const segmentSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    name: { type: String, required: true, trim: true, maxlength: 80 },
    filter: { type: audienceFilterSchema, default: () => ({}) },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

segmentSchema.plugin(tenantScoped);
segmentSchema.index({ workspaceId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export type SegmentDoc = HydratedDocument<InferSchemaType<typeof segmentSchema>>;
export const Segment = model('Segment', segmentSchema);

import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';
import { audienceFilterSchema } from './segment.model.js';

/**
 * draft -> scheduled -> running -> completed, with paused in between and
 * cancelled / failed as terminal alternatives.
 */
export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Where a template variable's value comes from for each recipient. */
const variableSchema = new Schema(
  {
    source: { type: String, enum: ['static', 'field'], required: true },
    // Static text, or a field key: name, first_name, phone, email, custom.<key>
    value: { type: String, required: true, maxlength: 500 },
    fallback: { type: String, default: '', maxlength: 500 },
  },
  { _id: false },
);

const campaignSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    name: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: CAMPAIGN_STATUSES, default: 'draft' },
    templateId: { type: Schema.Types.ObjectId, ref: 'MessageTemplate', default: null },
    // Exact template content used at launch, for traceability.
    templateSnapshot: { type: Schema.Types.Mixed, default: null },
    headerVariables: { type: [variableSchema], default: [] },
    bodyVariables: { type: [variableSchema], default: [] },
    // URL suffixes / coupon codes, in the order of the template's buttons that take one.
    buttonVariables: { type: [variableSchema], default: [] },
    // Same-for-everyone send values: header media/location, offer expiry, products, carousel cards.
    templateExtras: { type: Schema.Types.Mixed, default: null },
    audience: {
      type: { type: String, enum: ['all', 'segment', 'filter'], default: 'all' },
      segmentId: { type: Schema.Types.ObjectId, ref: 'Segment', default: null },
      filter: { type: audienceFilterSchema, default: () => ({}) },
    },
    // The exact filter that produced the recipient list, captured at launch.
    audienceSnapshot: { type: Schema.Types.Mixed, default: null },
    sendRatePerMinute: { type: Number, min: 1, max: 1000, default: 60 },
    // Don't send between these local times (workspace timezone), e.g. 21:00-09:00.
    quietHours: {
      enabled: { type: Boolean, default: false },
      start: { type: String, default: '21:00' },
      end: { type: String, default: '09:00' },
    },
    scheduledAt: { type: Date, default: null },
    launchedAt: { type: Date, default: null },
    launchedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    completedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

campaignSchema.plugin(tenantScoped);
campaignSchema.index({ workspaceId: 1, createdAt: -1 });

export type CampaignDoc = HydratedDocument<InferSchemaType<typeof campaignSchema>>;
export const Campaign = model('Campaign', campaignSchema);

export const RECIPIENT_STATUSES = ['pending', 'queued', 'submitted', 'sent', 'delivered', 'read', 'failed', 'skipped'] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

/** One row per contact per campaign: the source of truth for campaign reports. */
const recipientSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    phone: { type: String, required: true },
    status: { type: String, enum: RECIPIENT_STATUSES, default: 'pending' },
    skipReason: { type: String, default: null },
    headerParams: { type: [String], default: [] },
    bodyParams: { type: [String], default: [] },
    buttonParams: { type: [String], default: [] },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    error: { type: new Schema({ code: String, title: String, message: String }, { _id: false }), default: null },
    queuedAt: { type: Date, default: null },
    repliedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

recipientSchema.plugin(tenantScoped);
// A contact can be in a campaign only once: re-running launch/dispatch never duplicates.
recipientSchema.index({ workspaceId: 1, campaignId: 1, contactId: 1 }, { unique: true });
recipientSchema.index({ workspaceId: 1, campaignId: 1, status: 1 });
recipientSchema.index({ workspaceId: 1, messageId: 1 }, { partialFilterExpression: { messageId: { $type: 'objectId' } } });
recipientSchema.index({ workspaceId: 1, contactId: 1, createdAt: -1 });

export type RecipientDoc = HydratedDocument<InferSchemaType<typeof recipientSchema>>;
export const CampaignRecipient = model('CampaignRecipient', recipientSchema);

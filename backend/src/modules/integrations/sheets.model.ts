import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

/** A Google account connected for reading private sheets (read-only scope). */
const googleAccountSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    email: { type: String, required: true, trim: true, lowercase: true },
    refreshTokenEnc: { type: String, required: true },
    connectedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
googleAccountSchema.plugin(tenantScoped);
googleAccountSchema.index({ workspaceId: 1, email: 1 }, { unique: true });
export type GoogleAccountDoc = HydratedDocument<InferSchemaType<typeof googleAccountSchema>>;
export const GoogleAccount = model('GoogleAccount', googleAccountSchema);

export const SHEET_CAMPAIGN_STATUSES = ['draft', 'active', 'paused'] as const;
export const SHEET_STEPS = ['start', 'link', 'connect', 'select', 'map', 'settings'] as const;

/** A template value: a sheet column, or fixed text. */
const columnVariableSchema = new Schema(
  {
    source: { type: String, enum: ['column', 'static'], required: true },
    value: { type: String, default: '', maxlength: 1000 },
    fallback: { type: String, default: null, maxlength: 1000 },
  },
  { _id: false },
);

/**
 * "Google Sheets campaign": every new row of one sheet tab triggers a WhatsApp
 * template to the row's phone number. Rows are checked on a schedule (and on
 * "Sync Data"), so live edits to the sheet are picked up.
 */
const sheetCampaignSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    name: { type: String, required: true, trim: true, maxlength: 80 },
    status: { type: String, enum: SHEET_CAMPAIGN_STATUSES, default: 'draft' },
    // Furthest wizard step reached, so "continue setup" resumes there.
    step: { type: String, enum: SHEET_STEPS, default: 'link' },
    sheetUrl: { type: String, required: true, maxlength: 2000 },
    spreadsheetId: { type: String, required: true },
    spreadsheetTitle: { type: String, default: '' },
    access: { type: String, enum: ['link', 'google'], default: 'link' },
    googleAccountId: { type: Schema.Types.ObjectId, ref: 'GoogleAccount', default: null },
    tabGid: { type: String, default: null },
    tabTitle: { type: String, default: null },
    headers: { type: [String], default: [] },
    phoneColumn: { type: String, default: null },
    nameColumn: { type: String, default: null },
    templateId: { type: Schema.Types.ObjectId, ref: 'MessageTemplate', default: null },
    headerVariables: { type: [columnVariableSchema], default: [] },
    bodyVariables: { type: [columnVariableSchema], default: [] },
    buttonVariables: { type: [columnVariableSchema], default: [] },
    templateExtras: { type: Schema.Types.Mixed, default: null },
    sendDelayMinutes: { type: Number, min: 0, max: 7 * 24 * 60, default: 0 },
    // `new`: rows already in the sheet when it goes live are skipped. `all`: they are sent too.
    startFrom: { type: String, enum: ['new', 'all'], default: 'new' },
    // Set once the rows present at go-live have been recorded.
    baselineAt: { type: Date, default: null },
    lastSyncAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    // Last sync: rows with a phone, rows whose phone could not be read, rows waiting for empty cells.
    rowCount: { type: Number, default: 0 },
    invalidRows: { type: Number, default: 0 },
    waitingRows: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
sheetCampaignSchema.plugin(tenantScoped);
sheetCampaignSchema.index({ workspaceId: 1, createdAt: -1 });
sheetCampaignSchema.index({ status: 1, lastSyncAt: 1 });
export type SheetCampaignDoc = HydratedDocument<InferSchemaType<typeof sheetCampaignSchema>>;
export const SheetCampaign = model('SheetCampaign', sheetCampaignSchema);

export const SHEET_ROW_STATUSES = ['skipped', 'scheduled', 'sent', 'failed'] as const;

/** One phone number seen in a campaign's sheet; each number gets the message once. */
const sheetRowSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    campaignId: { type: Schema.Types.ObjectId, ref: 'SheetCampaign', required: true },
    rowNumber: { type: Number, required: true },
    phoneE164: { type: String, required: true },
    values: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: SHEET_ROW_STATUSES, required: true },
    dueAt: { type: Date, default: null },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', default: null },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    error: { type: String, default: null },
  },
  { timestamps: true },
);
sheetRowSchema.plugin(tenantScoped);
sheetRowSchema.index({ workspaceId: 1, campaignId: 1, phoneE164: 1 }, { unique: true });
sheetRowSchema.index({ workspaceId: 1, campaignId: 1, status: 1, dueAt: 1 });
sheetRowSchema.index({ workspaceId: 1, messageId: 1 });
export type SheetRowDoc = HydratedDocument<InferSchemaType<typeof sheetRowSchema>>;
export const SheetRow = model('SheetRow', sheetRowSchema);

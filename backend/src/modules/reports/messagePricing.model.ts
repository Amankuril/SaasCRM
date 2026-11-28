import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

/**
 * Meta's price per billable message, set by Super Admin (platform-wide). A rate
 * applies from `validFrom` to `validTo` (inclusive, YYYY-MM-DD), so old reports
 * keep the price that was true on their dates. `market` is the recipient's country
 * (ISO code) or "*" for every other country.
 */
const rateCardSchema = new Schema(
  {
    market: { type: String, required: true, uppercase: true, trim: true },
    category: { type: String, required: true, lowercase: true, trim: true },
    priceInr: { type: Number, required: true, min: 0 },
    validFrom: { type: String, required: true },
    validTo: { type: String, default: null },
    note: { type: String, default: null, maxlength: 200 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // Soft delete: removed rates stay for the record.
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
rateCardSchema.index({ deletedAt: 1, market: 1, category: 1, validFrom: -1 });

export type RateCardDoc = HydratedDocument<InferSchemaType<typeof rateCardSchema>>;
export const RateCard = model('RateCard', rateCardSchema);

/**
 * One workspace day (in the workspace timezone) of message counts, so a year of
 * reports reads 365 small documents instead of every message. `rows` is null when
 * the day must be counted again (pricing arrived after it was summed); `version`
 * goes up on every such change so a slow recount cannot overwrite a newer one.
 */
const rollupRowSchema = new Schema(
  {
    direction: { type: String, required: true },
    source: { type: String, default: null },
    type: { type: String, default: null },
    category: { type: String, default: null },
    market: { type: String, default: null },
    count: { type: Number, required: true },
    billable: { type: Number, required: true },
  },
  { _id: false },
);

const rollupSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    day: { type: String, required: true },
    timezone: { type: String, default: null },
    version: { type: Number, default: 0 },
    rows: { type: [rollupRowSchema], default: null },
    computedAt: { type: Date, default: null },
  },
  { timestamps: false },
);
rollupSchema.plugin(tenantScoped);
rollupSchema.index({ workspaceId: 1, day: 1 }, { unique: true });

export type RollupRow = InferSchemaType<typeof rollupRowSchema>;
export const MessageDailyRollup = model('MessageDailyRollup', rollupSchema);

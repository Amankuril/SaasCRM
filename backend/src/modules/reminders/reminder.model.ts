import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';
import { CATEGORY_KEYS, RECURRENCES, RULE_UNITS } from './categories.js';

const ruleSchema = new Schema(
  {
    when: { type: String, enum: ['before', 'on', 'after'], required: true },
    value: { type: Number, min: 0, max: 365, default: 0 },
    unit: { type: String, enum: RULE_UNITS, default: 'day' },
  },
  { _id: false },
);

/** A template value: one of the record's values, or fixed text. */
const variableSchema = new Schema(
  {
    source: { type: String, enum: ['field', 'static'], required: true },
    value: { type: String, default: '', maxlength: 1000 },
    fallback: { type: String, default: null, maxlength: 1000 },
  },
  { _id: false },
);

export const SETUP_STATUSES = ['draft', 'active', 'paused'] as const;

/** One reminder automation. It belongs to exactly one category and owns its fields, timing and message. */
const setupSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    category: { type: String, enum: CATEGORY_KEYS, required: true, immutable: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    status: { type: String, enum: SETUP_STATUSES, default: 'draft' },
    // "And More": what the event is called and which extra details it has.
    eventLabel: { type: String, trim: true, maxlength: 60, default: null },
    extraFields: { type: [new Schema({ key: { type: String, required: true }, label: { type: String, required: true, maxlength: 60 } }, { _id: false })], default: [] },
    recurrence: { type: String, enum: RECURRENCES, required: true },
    everyDays: { type: Number, min: 1, max: 730, default: 30 },
    rules: { type: [ruleSchema], default: [] },
    sendTime: { type: String, default: '10:00' },
    // A reminder whose time already passed today is sent right away instead of being skipped.
    sendMissedToday: { type: Boolean, default: false },
    templateId: { type: Schema.Types.ObjectId, ref: 'MessageTemplate', default: null },
    headerVariables: { type: [variableSchema], default: [] },
    bodyVariables: { type: [variableSchema], default: [] },
    buttonVariables: { type: [variableSchema], default: [] },
    templateExtras: { type: Schema.Types.Mixed, default: null },
    activatedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
setupSchema.plugin(tenantScoped);
setupSchema.index({ workspaceId: 1, category: 1, createdAt: -1 });
setupSchema.index({ workspaceId: 1, templateId: 1 });
export type ReminderSetupDoc = HydratedDocument<InferSchemaType<typeof setupSchema>>;
export const ReminderSetup = model('ReminderSetup', setupSchema);

export const RECORD_STATUSES = ['active', 'paused', 'completed'] as const;

/** One person's date inside a setup. */
const recordSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    setupId: { type: Schema.Types.ObjectId, ref: 'ReminderSetup', required: true },
    phoneE164: { type: String, required: true },
    name: { type: String, trim: true, maxlength: 120, default: '' },
    // Calendar date and time in the workspace timezone.
    eventDate: { type: String, required: true },
    eventTime: { type: String, default: null },
    fields: { type: Schema.Types.Mixed, default: () => ({}) },
    // Null: use the setup's repeat.
    recurrence: { type: String, enum: [...RECURRENCES, null], default: null },
    endDate: { type: String, default: null },
    maxCycles: { type: Number, min: 1, max: 1000, default: null },
    doneThrough: { type: String, default: null },
    status: { type: String, enum: RECORD_STATUSES, default: 'active' },
    // Phone + the category's identifying values: the same event cannot be added twice.
    identity: { type: String, required: true },
    nextRunAt: { type: Date, default: null },
    nextOccurrence: { type: String, default: null },
    nextRuleId: { type: String, default: null },
    source: { type: String, enum: ['manual', 'import'], default: 'manual' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, minimize: false },
);
recordSchema.plugin(tenantScoped);
recordSchema.index({ workspaceId: 1, setupId: 1, identity: 1 }, { unique: true });
recordSchema.index({ workspaceId: 1, setupId: 1, status: 1, nextRunAt: 1 });
recordSchema.index({ status: 1, nextRunAt: 1 });
export type ReminderRecordDoc = HydratedDocument<InferSchemaType<typeof recordSchema>>;
export const ReminderRecord = model('ReminderRecord', recordSchema);

export const SEND_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;

/**
 * Log of every reminder. `dedupeKey` is unique per workspace: one event, one person and
 * one rule can only ever produce one row (and so one message), even after a record is
 * deleted and imported again.
 */
const sendSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    setupId: { type: Schema.Types.ObjectId, ref: 'ReminderSetup', required: true },
    recordId: { type: Schema.Types.ObjectId, ref: 'ReminderRecord', required: true },
    dedupeKey: { type: String, required: true },
    phoneE164: { type: String, required: true },
    name: { type: String, default: '' },
    ruleId: { type: String, required: true },
    occurrence: { type: String, required: true },
    cycle: { type: Number, default: 0 },
    scheduledFor: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: SEND_STATUSES, default: 'pending' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    sentAt: { type: Date, default: null },
    errorCode: { type: String, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true },
);
sendSchema.plugin(tenantScoped);
sendSchema.index({ workspaceId: 1, dedupeKey: 1 }, { unique: true });
sendSchema.index({ workspaceId: 1, setupId: 1, scheduledFor: -1 });
sendSchema.index({ status: 1, nextAttemptAt: 1 });
export type ReminderSendDoc = HydratedDocument<InferSchemaType<typeof sendSchema>>;
export const ReminderSend = model('ReminderSend', sendSchema);

/** A one-time paid (or granted) feature. */
const unlockSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    feature: { type: String, enum: ['date_reminders'], required: true },
    status: { type: String, enum: ['pending', 'unlocked', 'revoked'], required: true },
    source: { type: String, enum: ['purchase', 'granted'], default: 'purchase' },
    // Set for "all businesses" unlocks: covers every workspace this person created.
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    provider: { type: String, default: null },
    providerOrderId: { type: String, default: null },
    providerPaymentId: { type: String, default: null },
    unlockedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
unlockSchema.plugin(tenantScoped);
unlockSchema.index({ workspaceId: 1, feature: 1 }, { unique: true });
unlockSchema.index({ ownerUserId: 1, feature: 1 });
unlockSchema.index({ providerOrderId: 1 }, { sparse: true });
export type FeatureUnlockDoc = HydratedDocument<InferSchemaType<typeof unlockSchema>>;
export const FeatureUnlock = model('FeatureUnlock', unlockSchema);

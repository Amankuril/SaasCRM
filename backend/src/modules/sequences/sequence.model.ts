import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

export const SEQUENCE_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export const TRIGGER_TYPES = ['manual', 'tag_added', 'lifecycle_changed', 'list_added', 'new_contact', 'field_changed', 'date_field', 'inactive'] as const;
export const NEW_CONTACT_SOURCES = ['whatsapp_inbound', 'api', 'broadcast', 'google_sheets', 'import', 'manual'] as const;
export const DATE_MODES = ['none', 'fixed', 'per_contact'] as const;
export const GOAL_TYPES = ['none', 'replied', 'tag_added', 'lifecycle'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

const triggerSchema = new Schema(
  {
    type: { type: String, enum: [...TRIGGER_TYPES, null], default: null },
    tagIds: { type: [Schema.Types.ObjectId], default: [] },
    stages: { type: [String], default: [] },
    listIds: { type: [Schema.Types.ObjectId], default: [] },
    sources: { type: [String], default: [] },
    // field_changed / date_field: the custom field key.
    fieldKey: { type: String, default: null },
    // field_changed: any value, or one specific value.
    fieldOp: { type: String, enum: ['any', 'equals'], default: 'any' },
    fieldValue: { type: String, default: null },
    // date_field: N days before / on / after the date, at a time (workspace timezone).
    offsetDays: { type: Number, default: 0 },
    direction: { type: String, enum: ['before', 'on', 'after'], default: 'on' },
    time: { type: String, default: '09:00' },
    repeatYearly: { type: Boolean, default: false },
    // inactive: chatted before, then nothing for N days.
    days: { type: Number, default: 30 },
  },
  { _id: false },
);

const outcomeRuleSchema = new Schema(
  {
    type: { type: String, enum: GOAL_TYPES, default: 'none' },
    tagIds: { type: [Schema.Types.ObjectId], default: [] },
    stages: { type: [String], default: [] },
  },
  { _id: false },
);

/** Sending rules are read live (they apply to everyone already inside). */
const rulesSchema = new Schema(
  {
    joinOnce: { type: Boolean, default: true },
    reentryDays: { type: Number, default: 30, min: 0 },
    maxEnrollments: { type: Number, default: null, min: 1 },
    stopOnReply: { type: Boolean, default: true },
    quietHours: {
      enabled: { type: Boolean, default: true },
      start: { type: String, default: '21:00' },
      end: { type: String, default: '09:00' },
    },
    // ISO weekdays allowed for sending: 1 = Monday … 7 = Sunday.
    days: { type: [Number], default: [1, 2, 3, 4, 5, 6, 7] },
    timezone: { type: String, enum: ['workspace', 'contact'], default: 'workspace' },
    sendAfterDelivered: { type: Boolean, default: false },
    retryEcosystemLimit: { type: Boolean, default: true },
    maxPerContactPerDay: { type: Number, default: 3, min: 1, max: 20 },
  },
  { _id: false },
);

const sequenceSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    name: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: SEQUENCE_STATUSES, default: 'draft' },
    // Ready-made starting point it was created from (key), if any.
    startingPoint: { type: String, default: null },
    trigger: { type: triggerSchema, default: () => ({}) },
    // "Only these contacts": all conditions must match when the contact joins.
    entryFilter: { type: Schema.Types.Mixed, default: [] },
    dateMode: { type: String, enum: DATE_MODES, default: 'none' },
    fixedDate: { type: Date, default: null },
    // per_contact: the enrollment data key that holds the date (e.g. trial_ends_at).
    dateKey: { type: String, default: null },
    goal: { type: outcomeRuleSchema, default: () => ({}) },
    stopConditions: { type: [outcomeRuleSchema], default: [] },
    rules: { type: rulesSchema, default: () => ({}) },
    draftGraph: { type: Schema.Types.Mixed, default: () => ({ steps: [] }) },
    liveVersionId: { type: Schema.Types.ObjectId, ref: 'SequenceVersion', default: null },
    // First publish: the trigger is locked from then on.
    publishedAt: { type: Date, default: null },
    // Date / inactivity triggers: the last local day the daily scan ran.
    dailyRunDay: { type: String, default: null },
    archivedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
sequenceSchema.plugin(tenantScoped);
sequenceSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });
sequenceSchema.index({ status: 1 });

export type SequenceDoc = HydratedDocument<InferSchemaType<typeof sequenceSchema>>;
export const Sequence = model('Sequence', sequenceSchema);

/** An immutable snapshot of the steps, taken at publish. Enrollments pin one. */
const versionSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    sequenceId: { type: Schema.Types.ObjectId, ref: 'Sequence', required: true },
    versionNo: { type: Number, required: true },
    graph: { type: Schema.Types.Mixed, required: true },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    publishedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);
versionSchema.plugin(tenantScoped);
versionSchema.index({ workspaceId: 1, sequenceId: 1, versionNo: -1 }, { unique: true });

export type SequenceVersionDoc = HydratedDocument<InferSchemaType<typeof versionSchema>>;
export const SequenceVersion = model('SequenceVersion', versionSchema);

export const ENROLLMENT_STATUSES = ['in_progress', 'needs_attention', 'completed', 'dropped', 'error'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];
export const EXIT_OUTCOMES = ['completed', 'completed_goal', 'stopped', 'dropped_replied', 'opted_out', 'removed', 'archived', 'delivery_failed', 'error'] as const;
export type ExitOutcome = (typeof EXIT_OUTCOMES)[number];

/**
 * One contact's trip through one sequence. The scheduler picks rows whose
 * `nextRunAt` has come (status in_progress / needs_attention), leases them with
 * `lockedUntil`, runs the next step and writes the next `nextRunAt`.
 */
const enrollmentSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    sequenceId: { type: Schema.Types.ObjectId, ref: 'Sequence', required: true },
    versionId: { type: Schema.Types.ObjectId, ref: 'SequenceVersion', default: null },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    status: { type: String, enum: ENROLLMENT_STATUSES, default: 'in_progress' },
    outcome: { type: String, enum: [...EXIT_OUTCOMES, null], default: null },
    // true while in_progress / needs_attention: one live (non-test) enrollment per contact per sequence.
    active: { type: Boolean, default: true },
    // Test runs (own number, 20 s waits) are not counted anywhere.
    test: { type: Boolean, default: false },
    // Test runs use the draft steps, stored here instead of a version.
    testGraph: { type: Schema.Types.Mixed, default: null },
    joinedVia: { type: String, default: 'trigger' },
    // Date / inactivity triggers: which date (or quiet spell) this run is for, so each joins once.
    occurrence: { type: String, default: null },
    currentStepId: { type: String, default: null },
    // The wait / dated step it is sleeping on (a new date moves a dated wait).
    waitingStepId: { type: String, default: null },
    nextRunAt: { type: Date, default: null },
    data: { type: Schema.Types.Mixed, default: {} },
    enrolledAt: { type: Date, default: () => new Date() },
    exitedAt: { type: Date, default: null },
    exitReason: { type: String, default: null },
    attention: {
      type: new Schema({ code: String, message: String, since: Date }, { _id: false }),
      default: null,
    },
    attempts: { type: Number, default: 0 },
    // First reply received while in the sequence (server time).
    repliedAt: { type: Date, default: null },
    // This sequence's last message (for "send next only after delivered" and branches).
    lastSequenceMessageId: { type: Schema.Types.ObjectId, ref: 'SequenceMessage', default: null },
    lockedUntil: { type: Date, default: null },
    lockToken: { type: String, default: null },
  },
  { timestamps: true },
);
enrollmentSchema.plugin(tenantScoped);
// The scheduler's scan (across workspaces).
enrollmentSchema.index({ status: 1, nextRunAt: 1 });
enrollmentSchema.index({ sequenceId: 1, contactId: 1 }, { unique: true, partialFilterExpression: { active: true, test: false } });
enrollmentSchema.index({ workspaceId: 1, sequenceId: 1, status: 1, enrolledAt: -1 });
enrollmentSchema.index({ workspaceId: 1, contactId: 1, active: 1 });
enrollmentSchema.index({ workspaceId: 1, test: 1, createdAt: -1 });

export type EnrollmentDoc = HydratedDocument<InferSchemaType<typeof enrollmentSchema>>;
export const SequenceEnrollment = model('SequenceEnrollment', enrollmentSchema);

/** Contact history: every step with its time, result and the reason for any skip. */
const eventSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    sequenceId: { type: Schema.Types.ObjectId, ref: 'Sequence', required: true },
    enrollmentId: { type: Schema.Types.ObjectId, ref: 'SequenceEnrollment', required: true },
    stepId: { type: String, default: null },
    type: { type: String, required: true },
    result: { type: String, required: true },
    reason: { type: String, default: null },
    meta: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
eventSchema.plugin(tenantScoped);
eventSchema.index({ workspaceId: 1, enrollmentId: 1, createdAt: 1 });

export const SequenceEvent = model('SequenceEvent', eventSchema);

/** Per message sent by a sequence: the funnel (sent, delivered, read, replied). */
const sequenceMessageSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    sequenceId: { type: Schema.Types.ObjectId, ref: 'Sequence', required: true },
    enrollmentId: { type: Schema.Types.ObjectId, ref: 'SequenceEnrollment', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    stepId: { type: String, required: true },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', required: true },
    templateId: { type: Schema.Types.ObjectId, ref: 'MessageTemplate', default: null },
    status: { type: String, default: 'queued' },
    test: { type: Boolean, default: false },
    attempt: { type: Number, default: 1 },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    repliedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    errorCode: { type: String, default: null },
  },
  { timestamps: true },
);
sequenceMessageSchema.plugin(tenantScoped);
sequenceMessageSchema.index({ workspaceId: 1, messageId: 1 }, { unique: true });
sequenceMessageSchema.index({ workspaceId: 1, sequenceId: 1, stepId: 1 });
sequenceMessageSchema.index({ workspaceId: 1, contactId: 1, createdAt: -1 });

export type SequenceMessageDoc = HydratedDocument<InferSchemaType<typeof sequenceMessageSchema>>;
export const SequenceMessage = model('SequenceMessage', sequenceMessageSchema);

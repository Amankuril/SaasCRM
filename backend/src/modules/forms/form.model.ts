import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantScoped, workspaceIdField } from '../../db/tenantPlugin.js';

export const FIELD_TYPES = ['short_text', 'long_text', 'email', 'phone', 'number', 'dropdown', 'radio', 'checkbox', 'date', 'opt_in'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const fieldSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, enum: FIELD_TYPES, required: true },
    required: { type: Boolean, default: false },
    options: { type: [{ id: String, title: String }], default: [] },
    // Copy the answer onto the contact: name, email or custom.<key>.
    saveTo: { type: String, default: null },
  },
  { _id: false },
);

/**
 * A WhatsApp Form (Meta "Flow", navigate-only). Editing changes the draft;
 * publishing creates a new provider flow + version, so old submissions keep
 * their meaning.
 */
const formSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    name: { type: String, required: true, trim: true, maxlength: 80 },
    status: { type: String, enum: ['draft', 'published', 'failed'], default: 'draft' },
    // Chat message shown with the "open form" button.
    intro: { type: String, trim: true, maxlength: 1024, default: '' },
    ctaText: { type: String, trim: true, maxlength: 20, default: 'Open form' },
    screenTitle: { type: String, trim: true, maxlength: 30, default: 'Details' },
    submitLabel: { type: String, trim: true, maxlength: 35, default: 'Submit' },
    successMessage: { type: String, trim: true, maxlength: 1024, default: 'Thanks! We received your details.' },
    fields: { type: [fieldSchema], default: [] },
    version: { type: Number, default: 0 },
    publishedFields: { type: [fieldSchema], default: [] },
    providerFlowId: { type: String, default: null },
    publishError: { type: String, default: null },
    publishedAt: { type: Date, default: null },
    draftUpdatedAt: { type: Date, default: () => new Date() },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

formSchema.plugin(tenantScoped);
formSchema.index({ workspaceId: 1, createdAt: -1 });

export type FormDoc = HydratedDocument<InferSchemaType<typeof formSchema>>;
export const Form = model('Form', formSchema);

/** One submission, normalized and linked to the contact and form version. */
const submissionSchema = new Schema(
  {
    workspaceId: workspaceIdField,
    formId: { type: Schema.Types.ObjectId, ref: 'Form', required: true },
    formVersion: { type: Number, required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    // Opaque token we sent with the form; a token is accepted once.
    flowToken: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
    valid: { type: Boolean, required: true },
    issues: { type: [String], default: [] },
    submittedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

submissionSchema.plugin(tenantScoped);
submissionSchema.index({ workspaceId: 1, flowToken: 1 }, { unique: true });
submissionSchema.index({ workspaceId: 1, formId: 1, submittedAt: -1 });

export type SubmissionDoc = HydratedDocument<InferSchemaType<typeof submissionSchema>>;
export const FormSubmission = model('FormSubmission', submissionSchema);

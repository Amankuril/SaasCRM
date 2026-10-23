import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { assertFeature, assertWithinLimit } from '../billing/billing.service.js';
import { requirePermission } from '../../middleware/workspace.js';
import { audit } from '../audit/audit.service.js';
import { Contact } from '../contacts/contact.model.js';
import { normalizePhone } from '../contacts/contact.service.js';
import { credentialsOf, getConnection, providerToAppError } from '../whatsapp/connection.service.js';
import { whatsappProvider } from '../whatsapp/provider/index.js';
import { buildFlowJson, displayValue, fieldInput, validateFields, type FormField } from './flowJson.js';
import { Form, FormSubmission, type FormDoc } from './form.model.js';
import { sendForm } from './form.service.js';

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    intro: z.string().trim().max(1024),
    ctaText: z.string().trim().min(1).max(20, 'Button text is at most 20 characters.'),
    screenTitle: z.string().trim().min(1).max(30, 'Form title is at most 30 characters.'),
    submitLabel: z.string().trim().min(1).max(35, 'Submit button is at most 35 characters.'),
    successMessage: z.string().trim().max(1024),
    // Shape-checked here; WhatsApp limits are checked on publish so drafts can be saved half-done.
    fields: z.array(z.object({}).passthrough()).max(50),
  })
  .partial();

const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) });

function serialize(f: FormDoc, submissions?: number) {
  return {
    id: f.id as string,
    name: f.name,
    status: f.status,
    intro: f.intro,
    ctaText: f.ctaText,
    screenTitle: f.screenTitle,
    submitLabel: f.submitLabel,
    successMessage: f.successMessage,
    fields: f.fields,
    version: f.version,
    publishError: f.publishError,
    publishedAt: f.publishedAt,
    hasUnpublishedChanges: !f.publishedAt || f.draftUpdatedAt > f.publishedAt,
    submissions: submissions ?? undefined,
    updatedAt: f.updatedAt,
  };
}

/** Mounted at /api/workspaces/:workspaceId/forms (workspace already loaded). */
export const formRouter = Router({ mergeParams: true });

formRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const forms = await Form.find({ workspaceId }).sort({ createdAt: -1 });
  const counts = await FormSubmission.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { workspaceId, valid: true } },
    { $group: { _id: '$formId', n: { $sum: 1 } } },
  ]);
  const countOf = new Map(counts.map((c) => [c._id.toString(), c.n]));
  res.json({ forms: forms.map((f) => serialize(f, countOf.get(f.id as string) ?? 0)) });
});

formRouter.post('/', requirePermission('forms:manage'), async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(80).default('Untitled form') }), req.body);
  await assertFeature(req.workspace!._id, 'forms');
  await assertWithinLimit(req.workspace!._id, 'forms', await Form.countDocuments({ workspaceId: req.workspace!._id }));
  const form = await Form.create({
    workspaceId: req.workspace!._id,
    name,
    createdBy: req.user!._id,
    fields: [
      { key: 'name', label: 'Full name', type: 'short_text', required: true, options: [], saveTo: 'name' },
      { key: 'email', label: 'Email', type: 'email', required: false, options: [], saveTo: 'email' },
    ],
  });
  res.status(201).json({ form: serialize(form) });
});

formRouter.get('/:formId', requirePermission('workspace:read'), async (req, res) => {
  res.json({ form: serialize(await findForm(req.workspace!._id, req.params.formId)) });
});

formRouter.patch('/:formId', requirePermission('forms:manage'), async (req, res) => {
  const input = parse(updateSchema, req.body);
  const form = await findForm(req.workspace!._id, req.params.formId);
  form.set(input);
  form.draftUpdatedAt = new Date();
  await form.save();
  res.json({ form: serialize(form) });
});

formRouter.delete('/:formId', requirePermission('forms:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const form = await findForm(workspaceId, req.params.formId);
  await Form.deleteOne({ _id: form._id, workspaceId });
  await audit(req, { workspaceId, action: 'form.deleted', targetType: 'form', targetId: form.id, metadata: { name: form.name } });
  res.status(204).end();
});

/** Validates against WhatsApp limits, then creates + publishes a new Meta flow. */
formRouter.post('/:formId/publish', requirePermission('forms:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const form = await findForm(workspaceId, req.params.formId);
  await assertFeature(workspaceId, 'forms');
  const fields = form.fields as FormField[];
  const issues = validateFields(fields);
  if (issues.length) throw new AppError(422, 'FORM_INVALID', 'Fix the form before publishing.', { issues });

  const conn = await getConnection(workspaceId, true);
  if (!conn || conn.status !== 'connected') throw conflict('WHATSAPP_NOT_CONNECTED', 'Connect a working WhatsApp number first.');
  const normalized = fields.map((f) => fieldInput.parse(f));
  const flowJson = buildFlowJson({ screenTitle: form.screenTitle, submitLabel: form.submitLabel, intro: form.intro, fields: normalized });

  let result;
  try {
    result = await whatsappProvider().publishFlow(credentialsOf(conn), { name: `${form.name} v${form.version + 1} (${form.id.slice(-6)})`, flowJson });
  } catch (err) {
    form.set({ status: form.providerFlowId ? form.status : 'failed', publishError: (err as Error).message });
    await form.save();
    throw providerToAppError(err, 'WhatsApp rejected the form');
  }
  if (result.validationErrors.length) {
    form.set({ publishError: result.validationErrors.join(' ') });
    await form.save();
    throw new AppError(422, 'FORM_INVALID', 'WhatsApp reported problems with this form.', { issues: result.validationErrors });
  }

  form.set({
    status: 'published',
    providerFlowId: result.providerFlowId,
    version: form.version + 1,
    publishedFields: normalized,
    publishError: null,
    publishedAt: new Date(),
  });
  await form.save();
  await audit(req, { workspaceId, action: 'form.published', targetType: 'form', targetId: form.id, metadata: { name: form.name, version: form.version } });
  res.json({ form: serialize(form) });
});

/** Sends the published form to one contact (they must have messaged within 24 hours). */
formRouter.post('/:formId/send', requirePermission('messages:send'), async (req, res) => {
  const { phone, text } = parse(z.object({ phone: z.string().trim().min(5).max(30), text: z.string().trim().max(1024).optional() }), req.body);
  const workspaceId = req.workspace!._id;
  const form = await findForm(workspaceId, req.params.formId);
  const phoneE164 = normalizePhone(phone, req.workspace!.country);
  if (!phoneE164) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { phone: ['Enter a valid phone number.'] });
  const contact = await Contact.findOne({ workspaceId, phoneE164 });
  if (!contact) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { phone: ['No contact with this number yet.'] });
  const { message } = await sendForm(req.workspace!, contact, form, { text });
  res.status(202).json({ message: { id: message.id, status: message.status } });
});

formRouter.get('/:formId/submissions', requirePermission('workspace:read'), async (req, res) => {
  const { page, limit } = parse(pageSchema, req.query);
  const workspaceId = req.workspace!._id;
  const form = await findForm(workspaceId, req.params.formId);
  const filter = { workspaceId, formId: form._id };
  const [rows, total] = await Promise.all([
    FormSubmission.find(filter).sort({ submittedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    FormSubmission.countDocuments(filter),
  ]);
  const contacts = await Contact.find({ workspaceId, _id: { $in: rows.map((r) => r.contactId) } }).select('name profileName phoneE164').lean();
  const contactOf = new Map(contacts.map((c) => [c._id.toString(), c]));
  const fields = (form.publishedFields.length ? form.publishedFields : form.fields) as FormField[];

  res.json({
    columns: fields.map((f) => ({ key: f.key, label: f.label })),
    submissions: rows.map((r) => {
      const c = contactOf.get(r.contactId.toString());
      const data = (r.data ?? {}) as Record<string, unknown>;
      return {
        id: r._id.toString(),
        contact: c ? { id: c._id.toString(), name: c.name || c.profileName || c.phoneE164, phone: c.phoneE164 } : null,
        values: Object.fromEntries(fields.map((f) => [f.key, displayValue(f, data[f.key])])),
        valid: r.valid,
        issues: r.issues,
        formVersion: r.formVersion,
        submittedAt: r.submittedAt,
      };
    }),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
});

async function findForm(workspaceId: Types.ObjectId, id: unknown) {
  const form = await Form.findOne({ _id: objectId(id, 'Form'), workspaceId });
  if (!form) throw notFound('Form not found.');
  return form;
}

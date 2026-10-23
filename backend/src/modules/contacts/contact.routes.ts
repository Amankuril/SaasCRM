import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { emailSchema, objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { publish } from '../../realtime/bus.js';
import { audit } from '../audit/audit.service.js';
import { assertWithinLimit } from '../billing/billing.service.js';
import { contactPayload } from '../developer/serializers.js';
import { emitEvent } from '../developer/webhook.service.js';
import { onTagsAdded } from '../flows/triggers.js';
import { Conversation } from '../inbox/conversation.model.js';
import { ConversationNote } from '../inbox/note.model.js';
import { Message } from '../messages/message.model.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { importContacts, importSchema } from './contact.import.js';
import { CONSENT_STATUSES, Contact, LIFECYCLE_STAGES, toPublicContact } from './contact.model.js';
import { normalizePhone } from './contact.service.js';
import { Tag } from './tag.model.js';

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  tag: z.string().optional(),
  stage: z.enum(LIFECYCLE_STAGES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const customFieldsSchema = z
  .record(z.string().regex(/^[a-z0-9_]{1,40}$/, 'Custom field keys use lowercase letters, numbers and underscores.'), z.string().max(500))
  .refine((v) => Object.keys(v).length <= 50, 'At most 50 custom fields.');

const fields = {
  name: z.string().trim().max(200).nullable(),
  email: emailSchema.nullable().or(z.literal('').transform(() => null)),
  tags: z.array(z.string()).max(50),
  lifecycleStage: z.enum(LIFECYCLE_STAGES),
  ownerId: z.string().nullable(),
  customFields: customFieldsSchema,
  consentStatus: z.enum(CONSENT_STATUSES),
};

const createSchema = z.object({ phone: z.string().trim().min(5).max(30), ...fields }).partial().required({ phone: true });
const updateSchema = z.object(fields).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

/** Mounted at /api/workspaces/:workspaceId/contacts (workspace already loaded). */
export const contactRouter = Router({ mergeParams: true });

contactRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const { q, tag, stage, page, limit } = parse(listSchema, req.query);
  const workspaceId = req.workspace!._id;
  const filter: Record<string, unknown> = { workspaceId };
  if (stage) filter.lifecycleStage = stage;
  if (tag) filter.tags = objectId(tag, 'Tag');
  if (q) {
    const rx = { $regex: escapeRegex(q), $options: 'i' };
    const digits = q.replace(/\D/g, '');
    filter.$or = [{ name: rx }, { profileName: rx }, { email: rx }, ...(digits.length >= 3 ? [{ phoneE164: { $regex: digits } }] : [])];
  }

  const [contacts, total] = await Promise.all([
    Contact.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Contact.countDocuments(filter),
  ]);
  res.json({ contacts: contacts.map(toPublicContact), total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});

contactRouter.get('/export', requirePermission('contacts:export'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const [contacts, tags] = await Promise.all([Contact.find({ workspaceId }).sort({ createdAt: 1 }).lean(), Tag.find({ workspaceId }).lean()]);
  const tagName = new Map(tags.map((t) => [t._id.toString(), t.name]));
  const customKeys = [...new Set(contacts.flatMap((c) => Object.keys((c.customFields ?? {}) as object)))].sort();

  const header = ['phone', 'name', 'profile_name', 'email', 'lifecycle_stage', 'tags', 'consent', 'source', 'created_at', ...customKeys];
  const lines = [header.join(',')];
  for (const c of contacts) {
    const custom = (c.customFields ?? {}) as Record<string, unknown>;
    lines.push(
      [
        c.phoneE164,
        c.name,
        c.profileName,
        c.email,
        c.lifecycleStage,
        (c.tags ?? []).map((t) => tagName.get(t.toString())).filter(Boolean).join(';'),
        c.consent?.status,
        c.source,
        c.createdAt?.toISOString(),
        ...customKeys.map((k) => custom[k]),
      ]
        .map(csvCell)
        .join(','),
    );
  }

  await audit(req, { workspaceId, action: 'contacts.exported', metadata: { count: contacts.length } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

contactRouter.post('/import', requirePermission('contacts:import'), async (req, res) => {
  const input = parse(importSchema, req.body);
  const report = await importContacts(req.workspace!._id, req.workspace!.country, input);
  await audit(req, {
    workspaceId: req.workspace!._id,
    action: 'contacts.imported',
    metadata: { total: report.total, created: report.created, updated: report.updated, skipped: report.skipped, invalid: report.invalid.length, duplicate: input.duplicate },
  });
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.json({ report });
});

contactRouter.post('/', requirePermission('contacts:manage'), async (req, res) => {
  const input = parse(createSchema, req.body);
  const workspaceId = req.workspace!._id;
  const phoneE164 = normalizePhone(input.phone, req.workspace!.country);
  if (!phoneE164) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { phone: ['Enter a valid phone number.'] });
  if (await Contact.exists({ workspaceId, phoneE164 })) throw conflict('CONTACT_EXISTS', 'A contact with this phone number already exists.');
  await assertWithinLimit(workspaceId, 'contacts', await Contact.countDocuments({ workspaceId }));

  const contact = await Contact.create({
    workspaceId,
    phoneE164,
    name: input.name ?? null,
    email: input.email ?? null,
    lifecycleStage: input.lifecycleStage ?? 'new',
    tags: await validTags(workspaceId, input.tags ?? []),
    ownerId: await validOwner(workspaceId, input.ownerId ?? null),
    customFields: input.customFields ?? {},
    ...(input.consentStatus ? { consent: { status: input.consentStatus, source: 'manual', updatedAt: new Date() } } : {}),
    source: 'manual',
  });
  await onTagsAdded(workspaceId, contact._id, contact.tags);
  await emitEvent(workspaceId, 'contact.created', async () => ({ contact: await contactPayload(workspaceId, contact._id) }));
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.status(201).json({ contact: toPublicContact(contact) });
});

contactRouter.get('/:contactId', requirePermission('workspace:read'), async (req, res) => {
  const contact = await findContact(req.workspace!._id, req.params.contactId);
  const conversation = await Conversation.findOne({ workspaceId: req.workspace!._id, contactId: contact._id }).select('_id status').lean();
  res.json({
    contact: toPublicContact(contact),
    conversation: conversation ? { id: conversation._id.toString(), status: conversation.status } : null,
  });
});

contactRouter.patch('/:contactId', requirePermission('contacts:manage'), async (req, res) => {
  const input = parse(updateSchema, req.body);
  const workspaceId = req.workspace!._id;
  const contact = await findContact(workspaceId, req.params.contactId);

  if (input.name !== undefined) contact.name = input.name || null;
  if (input.email !== undefined) contact.email = input.email;
  if (input.lifecycleStage) contact.lifecycleStage = input.lifecycleStage;
  let addedTags: Types.ObjectId[] = [];
  if (input.tags) {
    const next = await validTags(workspaceId, input.tags);
    addedTags = next.filter((t) => !contact.tags.some((c) => c.equals(t)));
    contact.tags = next;
  }
  if (input.ownerId !== undefined) contact.ownerId = await validOwner(workspaceId, input.ownerId);
  if (input.customFields) contact.customFields = input.customFields;
  const optedOut = input.consentStatus === 'opted_out' && contact.consent?.status !== 'opted_out';
  if (input.consentStatus && input.consentStatus !== contact.consent?.status) {
    contact.consent = { status: input.consentStatus, source: 'manual', updatedAt: new Date() };
  }
  await contact.save();
  await onTagsAdded(workspaceId, contact._id, addedTags);
  if (optedOut) await emitEvent(workspaceId, 'contact.opted_out', async () => ({ contact: await contactPayload(workspaceId, contact._id), source: 'manual' }));
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.json({ contact: toPublicContact(contact) });
});

contactRouter.delete('/:contactId', requirePermission('contacts:delete'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const contact = await findContact(workspaceId, req.params.contactId);

  // Removes the person and their conversation history from this workspace.
  await Promise.all([
    Message.deleteMany({ workspaceId, contactId: contact._id }),
    ConversationNote.deleteMany({ workspaceId, contactId: contact._id }),
    Conversation.deleteMany({ workspaceId, contactId: contact._id }),
  ]);
  await Contact.deleteOne({ _id: contact._id, workspaceId });
  await audit(req, { workspaceId, action: 'contact.deleted', targetType: 'contact', targetId: contact.id, metadata: { phone: contact.phoneE164 } });
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.status(204).end();
});

async function findContact(workspaceId: Types.ObjectId, id: unknown) {
  const contact = await Contact.findOne({ _id: objectId(id, 'Contact'), workspaceId });
  if (!contact) throw notFound('Contact not found.');
  return contact;
}

async function validTags(workspaceId: Types.ObjectId, ids: string[]): Promise<Types.ObjectId[]> {
  const valid = ids.filter((id) => Types.ObjectId.isValid(id));
  const tags = await Tag.find({ workspaceId, _id: { $in: valid } }).select('_id').lean();
  if (tags.length !== new Set(ids).size) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { tags: ['Unknown tag.'] });
  return tags.map((t) => t._id);
}

async function validOwner(workspaceId: Types.ObjectId, ownerId: string | null): Promise<Types.ObjectId | null> {
  if (!ownerId) return null;
  const member = Types.ObjectId.isValid(ownerId) ? await WorkspaceMember.findOne({ workspaceId, userId: ownerId }).lean() : null;
  if (!member) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { ownerId: ['Owner must be a workspace member.'] });
  return member.userId;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** RFC 4180 quoting, plus a guard against spreadsheet formula injection. */
function csvCell(value: unknown): string {
  if (value == null) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

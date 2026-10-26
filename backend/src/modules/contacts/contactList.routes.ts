import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { publish } from '../../realtime/bus.js';
import { audit } from '../audit/audit.service.js';
import { Contact, toPublicContact } from './contact.model.js';
import { normalizeImportPhone } from './contact.service.js';
import { ContactList, type ContactListDoc } from './contactList.model.js';
import { addOneSchema, addToList, importIntoList, listImportSchema, type ListImportReport } from './contactList.service.js';
import { Tag } from './tag.model.js';

const nameSchema = z.object({ name: z.string().trim().min(1, 'Name the list.').max(255) });
const idList = z.array(z.string().regex(/^[a-f0-9]{24}$/)).min(1).max(1000);
const membersSchema = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['name', 'phone', 'createdAt']).default('createdAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

const SORT_FIELD = { name: 'name', phone: 'phoneE164', createdAt: 'createdAt' } as const;

/** Mounted at /api/workspaces/:workspaceId/contact-lists (workspace already loaded). */
export const contactListRouter = Router({ mergeParams: true });

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function load(req: Request) {
  const list = await ContactList.findOne({ _id: objectId(req.params.listId, 'List'), workspaceId: req.workspace!._id });
  if (!list) throw notFound('List not found.');
  return list;
}

/** Member counts and the most common member tags, per list. */
async function listStats(workspaceId: Types.ObjectId, lists: ContactListDoc[]) {
  const ids = lists.map((l) => l._id);
  const counts = await Contact.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { workspaceId, lists: { $in: ids } } },
    { $unwind: '$lists' },
    { $match: { lists: { $in: ids } } },
    { $group: { _id: '$lists', count: { $sum: 1 } } },
  ]);
  const topTags = await Contact.aggregate<{ _id: { list: Types.ObjectId; tag: Types.ObjectId }; n: number }>([
    { $match: { workspaceId, lists: { $in: ids }, 'tags.0': { $exists: true } } },
    { $unwind: '$lists' },
    { $match: { lists: { $in: ids } } },
    { $unwind: '$tags' },
    { $group: { _id: { list: '$lists', tag: '$tags' }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  const tagNames = new Map((await Tag.find({ workspaceId, _id: { $in: topTags.map((t) => t._id.tag) } }).lean()).map((t) => [t._id.toString(), { id: t._id.toString(), name: t.name, color: t.color }]));
  return (l: ContactListDoc) => ({
    id: l.id as string,
    name: l.name,
    count: counts.find((c) => c._id.equals(l._id))?.count ?? 0,
    tags: topTags
      .filter((t) => t._id.list.equals(l._id))
      .slice(0, 3)
      .flatMap((t) => tagNames.get(t._id.tag.toString()) ?? []),
    createdAt: l.createdAt,
  });
}

contactListRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const { q } = parse(z.object({ q: z.string().trim().max(100).optional() }), req.query);
  const workspaceId = req.workspace!._id;
  const lists = await ContactList.find({ workspaceId, ...(q ? { name: { $regex: escapeRegex(q), $options: 'i' } } : {}) }).sort({ createdAt: -1 });
  const serialize = await listStats(workspaceId, lists);
  res.json({ lists: lists.map(serialize) });
});

contactListRouter.post('/', requirePermission('contacts:manage'), async (req, res) => {
  const { name } = parse(nameSchema, req.body);
  try {
    const list = await ContactList.create({ workspaceId: req.workspace!._id, name, createdBy: req.user!._id });
    await audit(req, { workspaceId: req.workspace!._id, action: 'contact_list.created', targetType: 'contact_list', targetId: list.id, metadata: { name } });
    res.status(201).json({ list: (await listStats(req.workspace!._id, [list]))(list) });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('LIST_EXISTS', `A list named "${name}" already exists.`);
    throw err;
  }
});

/** Adds existing contacts to one or more lists ("Assign Lists"). */
contactListRouter.post('/assign', requirePermission('contacts:manage'), async (req, res) => {
  const { contactIds, listIds } = parse(z.object({ contactIds: idList, listIds: idList.max(50) }), req.body);
  const workspaceId = req.workspace!._id;
  const lists = await ContactList.find({ workspaceId, _id: { $in: listIds } }).select('_id').lean();
  if (lists.length !== new Set(listIds).size) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { listIds: ['Unknown list.'] });
  const result = await Contact.updateMany({ workspaceId, _id: { $in: contactIds } }, { $addToSet: { lists: { $each: lists.map((l) => l._id) } } });
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.json({ updated: result.modifiedCount });
});

contactListRouter.patch('/:listId', requirePermission('contacts:manage'), async (req, res) => {
  const list = await load(req);
  const { name } = parse(nameSchema, req.body);
  list.name = name;
  try {
    await list.save();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('LIST_EXISTS', `A list named "${name}" already exists.`);
    throw err;
  }
  res.json({ list: (await listStats(req.workspace!._id, [list]))(list) });
});

/** Deletes the list only; its contacts stay in Contacts. */
contactListRouter.delete('/:listId', requirePermission('contacts:manage'), async (req, res) => {
  const list = await load(req);
  const workspaceId = req.workspace!._id;
  await Contact.updateMany({ workspaceId, lists: list._id }, { $pull: { lists: list._id } });
  await ContactList.deleteOne({ _id: list._id, workspaceId });
  await audit(req, { workspaceId, action: 'contact_list.deleted', targetType: 'contact_list', targetId: list.id, metadata: { name: list.name } });
  res.status(204).end();
});

contactListRouter.get('/:listId/contacts', requirePermission('workspace:read'), async (req, res) => {
  const list = await load(req);
  const { q, page, limit, sort, dir } = parse(membersSchema, req.query);
  const filter: Record<string, unknown> = { workspaceId: req.workspace!._id, lists: list._id };
  if (q) {
    const rx = { $regex: escapeRegex(q), $options: 'i' };
    const digits = q.replace(/\D/g, '');
    filter.$or = [{ name: rx }, { profileName: rx }, ...(digits.length >= 3 ? [{ phoneE164: { $regex: digits } }] : [])];
  }
  const [contacts, total] = await Promise.all([Contact.find(filter)
      .sort({ [SORT_FIELD[sort]]: dir === 'asc' ? 1 : -1, _id: 1 })
      .collation({ locale: 'en', strength: 2 })
      .skip((page - 1) * limit)
      .limit(limit), Contact.countDocuments(filter)]);
  res.json({ contacts: contacts.map(toPublicContact), total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});

/** "One by one": adds a single number (creating the contact if it's new). */
contactListRouter.post('/:listId/contacts', requirePermission('contacts:manage'), async (req, res) => {
  const list = await load(req);
  const input = parse(addOneSchema, req.body);
  // A number typed with its own "+code" wins over the selected country.
  const phone = normalizeImportPhone(input.phone, { international: input.phone.trim().startsWith('+'), country: input.country });
  if (!phone) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { phone: ['Enter a valid WhatsApp number for this country.'] });
  const report: ListImportReport = { total: 1, created: 0, added: 0, alreadyInList: 0, invalid: [] };
  await addToList(req.workspace!._id, list, [{ row: 1, phone, name: input.name || undefined, tags: [] }], report, 'manual');
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  const contact = await Contact.findOne({ workspaceId: req.workspace!._id, phoneE164: phone });
  res.status(report.created ? 201 : 200).json({ contact: toPublicContact(contact!), created: report.created === 1, alreadyInList: report.alreadyInList === 1 });
});

contactListRouter.post('/:listId/import', requirePermission('contacts:import'), async (req, res) => {
  const list = await load(req);
  const input = parse(listImportSchema, req.body);
  const report = await importIntoList(req.workspace!._id, list, input);
  await audit(req, {
    workspaceId: req.workspace!._id,
    action: 'contact_list.imported',
    targetType: 'contact_list',
    targetId: list.id,
    metadata: { total: report.total, created: report.created, added: report.added, invalid: report.invalid.length },
  });
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.json({ report });
});

contactListRouter.post('/:listId/remove', requirePermission('contacts:manage'), async (req, res) => {
  const list = await load(req);
  const { contactIds } = parse(z.object({ contactIds: idList }), req.body);
  const result = await Contact.updateMany({ workspaceId: req.workspace!._id, _id: { $in: contactIds } }, { $pull: { lists: list._id } });
  res.json({ removed: result.modifiedCount });
});

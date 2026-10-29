import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { csvCell } from '../../lib/csv.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { publish } from '../../realtime/bus.js';
import { audit } from '../audit/audit.service.js';
import { User } from '../auth/user.model.js';
import { audienceFilterInput } from '../campaigns/campaign.routes.js';
import { targetingQuery, type AudienceFilter } from '../campaigns/campaign.service.js';
import { CONSENT_STATUSES, Contact, toPublicContact } from '../contacts/contact.model.js';
import { ContactList } from '../contacts/contactList.model.js';
import { Tag } from '../contacts/tag.model.js';
import { onTagsAdded } from '../flows/triggers.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { can } from '../roles.js';
import { syncCampaignAttribution } from './attribution.service.js';
import { deleteContactsData } from './audience.service.js';
import { CUSTOM_FIELD_TYPES, CustomField, toPublicCustomField } from './customField.model.js';
import { FollowUp, toPublicFollowUp } from './followUp.model.js';
import { PipelineStage, STAGE_COLORS, toPublicStage } from './stage.model.js';
import { ENTRY_STAGE, assertStage, listStages, slugifyStage, stageKeySchema } from './stage.service.js';
import { ContactEvent } from '../contacts/contactEvent.model.js';

const objectIdString = z.string().regex(/^[a-f0-9]{24}$/);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DAY_MS = 24 * 60 * 60 * 1000;

const SORTS = { createdAt: 'createdAt', name: 'name', phone: 'phoneE164', stage: 'lifecycleStage', lastInboundAt: 'lastInboundAt' } as const;

/** Everything the Audience table can be narrowed by; sent as ?query=<json>. */
const audienceQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  filter: audienceFilterInput.default({}),
  addedFrom: z.string().datetime({ offset: true }).optional(),
  addedTo: z.string().datetime({ offset: true }).optional(),
  consent: z.enum(CONSENT_STATUSES).optional(),
  followUp: z.enum(['overdue', 'today', 'upcoming', 'any', 'none']).optional(),
  sort: z.enum(Object.keys(SORTS) as [keyof typeof SORTS]).default('createdAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(25),
});
type AudienceQuery = z.infer<typeof audienceQuerySchema>;

function readQuery(raw: unknown): AudienceQuery {
  let json: unknown = {};
  if (typeof raw === 'string' && raw) {
    try {
      json = JSON.parse(raw);
    } catch {
      throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { query: ['Malformed query.'] });
    }
  }
  return parse(audienceQuerySchema, json);
}

/** Mongo filter for an Audience query (same targeting rules as campaigns and segments). */
async function buildFilter(workspaceId: Types.ObjectId, input: AudienceQuery): Promise<Record<string, unknown>> {
  const query = targetingQuery(workspaceId, input.filter as AudienceFilter) as Record<string, unknown>;
  const and = [...((query.$and as Record<string, unknown>[] | undefined) ?? [])];
  if (input.q) {
    const rx = { $regex: escapeRegex(input.q), $options: 'i' };
    const digits = input.q.replace(/\D/g, '');
    and.push({ $or: [{ name: rx }, { profileName: rx }, { email: rx }, ...(digits.length >= 3 ? [{ phoneE164: { $regex: digits } }] : [])] });
  }
  if (input.addedFrom || input.addedTo) {
    and.push({ createdAt: { ...(input.addedFrom ? { $gte: new Date(input.addedFrom) } : {}), ...(input.addedTo ? { $lte: new Date(input.addedTo) } : {}) } });
  }
  if (input.consent) query['consent.status'] = input.consent;
  if (input.followUp) {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const due =
      input.followUp === 'overdue'
        ? { $lt: now }
        : input.followUp === 'today'
          ? { $gte: startOfDay, $lt: new Date(startOfDay.getTime() + DAY_MS) }
          : input.followUp === 'upcoming'
            ? { $gte: now }
            : undefined;
    const ids = await FollowUp.distinct('contactId', { workspaceId, status: 'open', ...(due ? { dueAt: due } : {}) });
    and.push({ _id: input.followUp === 'none' ? { $nin: ids } : { $in: ids } });
  }
  if (and.length) query.$and = and;
  return query;
}

export const audienceRouter = Router({ mergeParams: true });

/** The Audience table: contacts with owner, next follow-up and lead source. */
audienceRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const input = readQuery(req.query.query);
  const workspaceId = req.workspace!._id;
  const filter = await buildFilter(workspaceId, input);
  const [contacts, total] = await Promise.all([
    Contact.find(filter)
      .sort({ [SORTS[input.sort]]: input.dir === 'asc' ? 1 : -1, _id: -1 })
      .collation({ locale: 'en', strength: 2 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit),
    Contact.countDocuments(filter),
  ]);
  const ids = contacts.map((c) => c._id);
  const [owners, followUps] = await Promise.all([
    User.find({ _id: { $in: contacts.map((c) => c.ownerId).filter(Boolean) } }).select('name').lean(),
    FollowUp.find({ workspaceId, contactId: { $in: ids }, status: 'open' }).sort({ dueAt: 1 }).lean(),
  ]);
  const ownerName = new Map(owners.map((u) => [u._id.toString(), u.name]));
  res.json({
    contacts: contacts.map((c) => {
      const open = followUps.filter((f) => f.contactId.equals(c._id));
      return {
        ...toPublicContact(c),
        owner: c.ownerId ? { id: c.ownerId.toString(), name: ownerName.get(c.ownerId.toString()) ?? 'Former member' } : null,
        nextFollowUp: open[0] ? toPublicFollowUp(open[0]) : null,
        openFollowUps: open.length,
      };
    }),
    total,
    page: input.page,
    pages: Math.max(1, Math.ceil(total / input.limit)),
  });
});

audienceRouter.get('/export', requirePermission('contacts:export'), async (req, res) => {
  const input = readQuery(req.query.query);
  const workspaceId = req.workspace!._id;
  const filter = await buildFilter(workspaceId, input);
  const [contacts, stages, tags, fields] = await Promise.all([
    Contact.find(filter).sort({ [SORTS[input.sort]]: input.dir === 'asc' ? 1 : -1 }).limit(50_000).lean(),
    listStages(workspaceId),
    Tag.find({ workspaceId }).lean(),
    CustomField.find({ workspaceId }).sort({ order: 1 }).lean(),
  ]);
  const [owners, followUps] = await Promise.all([
    User.find({ _id: { $in: contacts.map((c) => c.ownerId).filter(Boolean) } }).select('name').lean(),
    FollowUp.find({ workspaceId, contactId: { $in: contacts.map((c) => c._id) }, status: 'open' }).sort({ dueAt: 1 }).lean(),
  ]);
  const stageName = new Map(stages.map((s) => [s.key, s.name]));
  const tagName = new Map(tags.map((t) => [t._id.toString(), t.name]));
  const ownerName = new Map(owners.map((u) => [u._id.toString(), u.name]));
  const nextFollowUp = new Map<string, Date>();
  for (const f of followUps) if (!nextFollowUp.has(f.contactId.toString())) nextFollowUp.set(f.contactId.toString(), f.dueAt);

  const header = ['name', 'phone', 'email', 'stage', 'tags', 'chat_source', 'campaign', 'assigned_to', 'next_follow_up', 'subscription', 'added_on', ...fields.map((f) => f.key)];
  const lines = [header.join(',')];
  for (const c of contacts) {
    const custom = (c.customFields ?? {}) as Record<string, unknown>;
    lines.push(
      [
        c.name || c.profileName,
        c.phoneE164,
        c.email,
        stageName.get(c.lifecycleStage) ?? c.lifecycleStage,
        (c.tags ?? []).map((t) => tagName.get(t.toString())).filter(Boolean).join(';'),
        c.attribution?.source,
        c.attribution?.campaignName,
        c.ownerId ? ownerName.get(c.ownerId.toString()) : '',
        nextFollowUp.get(c._id.toString())?.toISOString(),
        c.consent?.status === 'opted_out' ? 'unsubscribed' : 'subscribed',
        c.createdAt?.toISOString(),
        ...fields.map((f) => custom[f.key]),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  await audit(req, { workspaceId, action: 'contacts.exported', metadata: { count: contacts.length, from: 'audience' } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audience-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

const bulkSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set_stage'), contactIds: z.array(objectIdString).min(1).max(1000), stage: stageKeySchema }),
  z.object({ action: z.literal('add_tags'), contactIds: z.array(objectIdString).min(1).max(1000), tagIds: z.array(objectIdString).min(1).max(20) }),
  z.object({ action: z.literal('remove_tags'), contactIds: z.array(objectIdString).min(1).max(1000), tagIds: z.array(objectIdString).min(1).max(20) }),
  z.object({ action: z.literal('set_owner'), contactIds: z.array(objectIdString).min(1).max(1000), ownerId: objectIdString.nullable() }),
  z.object({ action: z.literal('add_to_list'), contactIds: z.array(objectIdString).min(1).max(1000), listId: objectIdString }),
  z.object({ action: z.literal('delete'), contactIds: z.array(objectIdString).min(1).max(1000) }),
]);

audienceRouter.post('/bulk', requirePermission('contacts:manage'), async (req, res) => {
  const input = parse(bulkSchema, req.body);
  const workspaceId = req.workspace!._id;
  const filter = { workspaceId, _id: { $in: input.contactIds.map((id) => new Types.ObjectId(id)) } };
  let updated = 0;
  switch (input.action) {
    case 'set_stage': {
      await assertStage(workspaceId, input.stage, 'stage');
      // Record the stage history of the contacts that actually move.
      const moving = await Contact.find({ ...filter, lifecycleStage: { $ne: input.stage } }).select('_id lifecycleStage').lean();
      updated = (await Contact.updateMany(filter, { lifecycleStage: input.stage })).modifiedCount;
      if (moving.length) {
        await ContactEvent.insertMany(moving.map((c) => ({ workspaceId: req.workspace!._id, contactId: c._id, type: 'stage_changed', from: c.lifecycleStage, to: input.stage, byUserId: req.user!._id })));
      }
      break;
    }
    case 'add_tags':
    case 'remove_tags': {
      const tags = await Tag.find({ workspaceId, _id: { $in: input.tagIds } }).select('_id').lean();
      if (tags.length !== new Set(input.tagIds).size) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { tagIds: ['Unknown tag.'] });
      const tagIds = tags.map((t) => t._id);
      if (input.action === 'add_tags') {
        const before = await Contact.find({ ...filter, tags: { $not: { $all: tagIds } } }).select('_id tags').lean();
        updated = (await Contact.updateMany(filter, { $addToSet: { tags: { $each: tagIds } } })).modifiedCount;
        // "Tag added" flows run for each contact that actually gained a tag.
        for (const c of before) await onTagsAdded(workspaceId, c._id, tagIds.filter((t) => !(c.tags ?? []).some((x) => x.equals(t))));
      } else {
        updated = (await Contact.updateMany(filter, { $pull: { tags: { $in: tagIds } } })).modifiedCount;
      }
      break;
    }
    case 'set_owner': {
      if (input.ownerId && !(await WorkspaceMember.exists({ workspaceId, userId: input.ownerId }))) {
        throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { ownerId: ['Choose a teammate.'] });
      }
      updated = (await Contact.updateMany(filter, { ownerId: input.ownerId })).modifiedCount;
      break;
    }
    case 'add_to_list': {
      if (!(await ContactList.exists({ workspaceId, _id: input.listId }))) throw notFound('List not found.');
      updated = (await Contact.updateMany(filter, { $addToSet: { lists: new Types.ObjectId(input.listId) } })).modifiedCount;
      break;
    }
    case 'delete': {
      if (!can(req.membership!.role, 'contacts:delete')) throw forbidden();
      updated = await deleteContactsData(workspaceId, filter._id.$in);
      await audit(req, { workspaceId, action: 'contacts.deleted', metadata: { count: updated } });
      break;
    }
  }
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.json({ updated });
});

audienceRouter.post('/sync-campaigns', requirePermission('contacts:manage'), async (req, res) => {
  const result = await syncCampaignAttribution(req.workspace!._id);
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.json(result);
});

// ---- Pipeline stages ----

export const stageRouter = Router({ mergeParams: true });
const stageInput = z.object({ name: z.string().trim().min(1, 'Name the stage.').max(40), color: z.enum(STAGE_COLORS).default('gray') });

stageRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const stages = await listStages(req.workspace!._id);
  const counts = await Contact.aggregate<{ _id: string; n: number }>([{ $match: { workspaceId: req.workspace!._id } }, { $group: { _id: '$lifecycleStage', n: { $sum: 1 } } }]);
  res.json({ stages: stages.map((s) => ({ ...toPublicStage(s), count: counts.find((c) => c._id === s.key)?.n ?? 0 })) });
});

stageRouter.post('/', requirePermission('contacts:manage'), async (req, res) => {
  const input = parse(stageInput, req.body);
  const workspaceId = req.workspace!._id;
  const stages = await listStages(workspaceId);
  if (stages.length >= 30) throw conflict('TOO_MANY_STAGES', 'A pipeline can have at most 30 stages.');
  if (stages.some((s) => s.name.toLowerCase() === input.name.toLowerCase())) throw conflict('STAGE_EXISTS', `A stage named "${input.name}" already exists.`);
  const base = slugifyStage(input.name);
  let key = base;
  for (let i = 2; stages.some((s) => s.key === key); i++) key = `${base}_${i}`;
  const stage = await PipelineStage.create({ workspaceId, key, ...input, order: (stages.at(-1)?.order ?? 0) + 1 });
  res.status(201).json({ stage: toPublicStage(stage) });
});

stageRouter.post('/reorder', requirePermission('contacts:manage'), async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(objectIdString).min(1).max(30) }), req.body);
  const workspaceId = req.workspace!._id;
  await PipelineStage.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: { _id: new Types.ObjectId(id), workspaceId }, update: { order } } })));
  res.json({ stages: (await listStages(workspaceId)).map(toPublicStage) });
});

stageRouter.patch('/:stageId', requirePermission('contacts:manage'), async (req, res) => {
  const input = parse(stageInput.partial(), req.body);
  const workspaceId = req.workspace!._id;
  const stage = await PipelineStage.findOne({ _id: objectId(req.params.stageId, 'Stage'), workspaceId });
  if (!stage) throw notFound('Stage not found.');
  if (input.name && (await PipelineStage.exists({ workspaceId, _id: { $ne: stage._id }, name: input.name }).collation({ locale: 'en', strength: 2 }))) {
    throw conflict('STAGE_EXISTS', `A stage named "${input.name}" already exists.`);
  }
  stage.set(input);
  await stage.save();
  res.json({ stage: toPublicStage(stage) });
});

/** Deleting a stage moves its contacts to another one (`moveTo`, default: the entry stage). */
stageRouter.delete('/:stageId', requirePermission('contacts:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const stage = await PipelineStage.findOne({ _id: objectId(req.params.stageId, 'Stage'), workspaceId });
  if (!stage) throw notFound('Stage not found.');
  if (stage.key === ENTRY_STAGE) throw conflict('ENTRY_STAGE', 'New contacts start in this stage, so it can be renamed but not deleted.');
  const moveTo = typeof req.query.moveTo === 'string' ? req.query.moveTo : ENTRY_STAGE;
  if (moveTo === stage.key) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { moveTo: ['Choose another stage.'] });
  await assertStage(workspaceId, moveTo, 'moveTo');
  const moved = await Contact.updateMany({ workspaceId, lifecycleStage: stage.key }, { lifecycleStage: moveTo });
  await PipelineStage.deleteOne({ _id: stage._id, workspaceId });
  res.json({ moved: moved.modifiedCount });
});

// ---- Custom fields (Audience columns) ----

export const customFieldRouter = Router({ mergeParams: true });
const fieldInput = z.object({ label: z.string().trim().min(1, 'Name the field.').max(40), type: z.enum(CUSTOM_FIELD_TYPES).default('text') });

customFieldRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const fields = await CustomField.find({ workspaceId: req.workspace!._id }).sort({ order: 1, createdAt: 1 });
  res.json({ fields: fields.map(toPublicCustomField) });
});

customFieldRouter.post('/', requirePermission('contacts:manage'), async (req, res) => {
  const input = parse(fieldInput, req.body);
  const workspaceId = req.workspace!._id;
  const existing = await CustomField.find({ workspaceId }).lean();
  if (existing.length >= 50) throw conflict('TOO_MANY_FIELDS', 'At most 50 custom fields.');
  if (existing.some((f) => f.label.toLowerCase() === input.label.toLowerCase())) throw conflict('FIELD_EXISTS', `A field named "${input.label}" already exists.`);
  const base = slugifyStage(input.label);
  let key = base;
  for (let i = 2; existing.some((f) => f.key === key); i++) key = `${base}_${i}`;
  const field = await CustomField.create({ workspaceId, key, ...input, order: existing.length });
  res.status(201).json({ field: toPublicCustomField(field) });
});

customFieldRouter.patch('/:fieldId', requirePermission('contacts:manage'), async (req, res) => {
  const input = parse(fieldInput.partial(), req.body);
  const field = await CustomField.findOne({ _id: objectId(req.params.fieldId, 'Field'), workspaceId: req.workspace!._id });
  if (!field) throw notFound('Field not found.');
  field.set(input);
  await field.save();
  res.json({ field: toPublicCustomField(field) });
});

/** Removes the column; values stay on contacts (and come back if the field is re-created). */
customFieldRouter.delete('/:fieldId', requirePermission('contacts:manage'), async (req, res) => {
  const result = await CustomField.deleteOne({ _id: objectId(req.params.fieldId, 'Field'), workspaceId: req.workspace!._id });
  if (!result.deletedCount) throw notFound('Field not found.');
  res.status(204).end();
});

// ---- Follow-ups ----

export const followUpRouter = Router({ mergeParams: true });
const followUpInput = z.object({
  contactId: objectIdString,
  dueAt: z.string().datetime({ offset: true }),
  note: z.string().trim().max(1000).default(''),
  assigneeId: objectIdString.nullable().default(null),
});

async function checkAssignee(workspaceId: Types.ObjectId, assigneeId: string | null | undefined) {
  if (assigneeId && !(await WorkspaceMember.exists({ workspaceId, userId: assigneeId }))) {
    throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { assigneeId: ['Choose a teammate.'] });
  }
}

followUpRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const { contactId, status, range, mine } = parse(
    z.object({
      contactId: objectIdString.optional(),
      status: z.enum(['open', 'done']).optional(),
      range: z.enum(['overdue', 'today', 'upcoming']).optional(),
      mine: z.enum(['true', 'false']).optional(),
    }),
    req.query,
  );
  const workspaceId = req.workspace!._id;
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const dueAt =
    range === 'overdue' ? { $lt: now } : range === 'today' ? { $gte: start, $lt: new Date(start.getTime() + DAY_MS) } : range === 'upcoming' ? { $gte: now } : undefined;
  const items = await FollowUp.find({
    workspaceId,
    ...(contactId ? { contactId } : {}),
    ...(status ? { status } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(mine === 'true' ? { assigneeId: req.user!._id } : {}),
  })
    .sort({ status: -1, dueAt: 1 })
    .limit(500)
    .lean();
  const contacts = await Contact.find({ workspaceId, _id: { $in: items.map((f) => f.contactId) } }).select('name profileName phoneE164').lean();
  const byId = new Map(contacts.map((c) => [c._id.toString(), c]));
  res.json({
    followUps: items.map((f) => {
      const c = byId.get(f.contactId.toString());
      return { ...toPublicFollowUp(f), contact: c ? { id: c._id.toString(), name: c.name || c.profileName || c.phoneE164, phone: c.phoneE164 } : null };
    }),
  });
});

followUpRouter.post('/', requirePermission('contacts:manage'), async (req, res) => {
  const input = parse(followUpInput, req.body);
  const workspaceId = req.workspace!._id;
  if (!(await Contact.exists({ workspaceId, _id: input.contactId }))) throw notFound('Contact not found.');
  await checkAssignee(workspaceId, input.assigneeId);
  const followUp = await FollowUp.create({ workspaceId, ...input, dueAt: new Date(input.dueAt), createdBy: req.user!._id });
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.status(201).json({ followUp: toPublicFollowUp(followUp) });
});

followUpRouter.patch('/:followUpId', requirePermission('contacts:manage'), async (req, res) => {
  const input = parse(followUpInput.omit({ contactId: true }).partial().extend({ done: z.boolean().optional() }), req.body);
  const workspaceId = req.workspace!._id;
  const followUp = await FollowUp.findOne({ _id: objectId(req.params.followUpId, 'Follow-up'), workspaceId });
  if (!followUp) throw notFound('Follow-up not found.');
  await checkAssignee(workspaceId, input.assigneeId);
  const { done, dueAt, ...rest } = input;
  followUp.set({ ...rest, ...(dueAt ? { dueAt: new Date(dueAt) } : {}) });
  if (done !== undefined) followUp.set({ status: done ? 'done' : 'open', completedAt: done ? new Date() : null });
  await followUp.save();
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.json({ followUp: toPublicFollowUp(followUp) });
});

followUpRouter.delete('/:followUpId', requirePermission('contacts:manage'), async (req, res) => {
  const result = await FollowUp.deleteOne({ _id: objectId(req.params.followUpId, 'Follow-up'), workspaceId: req.workspace!._id });
  if (!result.deletedCount) throw notFound('Follow-up not found.');
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.status(204).end();
});

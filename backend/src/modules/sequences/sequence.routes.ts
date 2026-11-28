import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { audit } from '../audit/audit.service.js';
import { getEntitlements, usageFor } from '../billing/billing.service.js';
import { CustomField } from '../audience/customField.model.js';
import { Contact } from '../contacts/contact.model.js';
import { ensureTags } from '../contacts/contact.import.js';
import { findOrCreateContact, normalizePhone } from '../contacts/contact.service.js';
import { resetDomainInterest } from '../events/domainEvents.js';
import { checklist } from './sequence.checklist.js';
import { enroll, exitEnrollment, exitWhere, type EnrollResult } from './sequence.engine.js';
import { allSteps, compile, conditionSchema, graphSchema, type Graph } from './sequence.graph.js';
import {
  DATE_MODES,
  ENROLLMENT_STATUSES,
  GOAL_TYPES,
  NEW_CONTACT_SOURCES,
  Sequence,
  SequenceEnrollment,
  SequenceEvent,
  SequenceMessage,
  SequenceVersion,
  TRIGGER_TYPES,
  type SequenceDoc,
} from './sequence.model.js';
import { STARTING_POINTS, freshGraph } from './sequence.templates.js';

const MAX_TESTS_PER_DAY = 20;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.');
const idString = z.string().regex(/^[a-f0-9]{24}$/i, 'Unknown item.');
const fieldKey = z.string().trim().regex(/^[a-z0-9_]{1,40}$/i, 'Use letters, numbers and _.');

const triggerSchema = z.object({
  type: z.enum(TRIGGER_TYPES).nullable(),
  tagIds: z.array(idString).max(20).default([]),
  stages: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  listIds: z.array(idString).max(20).default([]),
  sources: z.array(z.enum(NEW_CONTACT_SOURCES)).max(10).default([]),
  fieldKey: fieldKey.nullable().default(null),
  fieldOp: z.enum(['any', 'equals']).default('any'),
  fieldValue: z.string().trim().max(200).nullable().default(null),
  offsetDays: z.number().int().min(0).max(365).default(0),
  direction: z.enum(['before', 'on', 'after']).default('on'),
  time: time.default('09:00'),
  repeatYearly: z.boolean().default(false),
  days: z.number().int().min(1).max(365).default(30),
});

const outcomeSchema = z.object({
  type: z.enum(GOAL_TYPES),
  tagIds: z.array(idString).max(20).default([]),
  stages: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
});

const rulesSchema = z.object({
  joinOnce: z.boolean(),
  reentryDays: z.number().int().min(0).max(3650),
  maxEnrollments: z.number().int().min(1).max(10_000_000).nullable(),
  stopOnReply: z.boolean(),
  quietHours: z.object({ enabled: z.boolean(), start: time, end: time }),
  days: z.array(z.number().int().min(1).max(7)).min(1, 'Pick at least one day.').max(7),
  timezone: z.enum(['workspace', 'contact']),
  sendAfterDelivered: z.boolean(),
  retryEcosystemLimit: z.boolean(),
  maxPerContactPerDay: z.number().int().min(1).max(20),
});

const entryCondition = conditionSchema.refine((c) => ['tag', 'stage', 'field'].includes(c.kind), 'Only tag, stage and field conditions can filter who joins.');

const updateSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the sequence.').max(120),
    trigger: triggerSchema,
    entryFilter: z.array(entryCondition).max(10),
    dateMode: z.enum(DATE_MODES),
    fixedDate: z.string().datetime({ offset: true }).nullable(),
    dateKey: fieldKey.nullable(),
    goal: outcomeSchema,
    stopConditions: z.array(outcomeSchema).max(5),
    rules: rulesSchema.partial(),
    draftGraph: graphSchema,
  })
  .partial();

/** Mounted at /api/workspaces/:workspaceId/sequences. */
export const sequenceRouter = Router({ mergeParams: true });

async function findSequence(req: Request): Promise<SequenceDoc> {
  const seq = await Sequence.findOne({ _id: objectId((req.params as { sequenceId?: string }).sequenceId, 'Sequence'), workspaceId: req.workspace!._id });
  if (!seq) throw notFound('Sequence not found.');
  return seq;
}

function summary(s: SequenceDoc) {
  return {
    id: s.id as string,
    name: s.name,
    status: s.status,
    trigger: s.trigger,
    startingPoint: s.startingPoint ?? null,
    published: !!s.publishedAt,
    publishedAt: s.publishedAt ?? null,
    archivedAt: s.archivedAt ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

async function detail(s: SequenceDoc) {
  const live = s.liveVersionId ? await SequenceVersion.findOne({ _id: s.liveVersionId, workspaceId: s.workspaceId }).select('versionNo publishedAt graph').lean() : null;
  return {
    ...summary(s),
    entryFilter: s.entryFilter ?? [],
    dateMode: s.dateMode,
    fixedDate: s.fixedDate ?? null,
    dateKey: s.dateKey ?? null,
    goal: s.goal,
    stopConditions: s.stopConditions ?? [],
    rules: s.rules,
    draftGraph: s.draftGraph as Graph,
    live: live ? { versionNo: live.versionNo, publishedAt: live.publishedAt, changedSincePublish: JSON.stringify(live.graph) !== JSON.stringify(s.draftGraph) } : null,
    checklist: await checklist(s, s.workspaceId),
  };
}

async function monthlyUsage(workspaceId: Types.ObjectId) {
  const e = await getEntitlements(workspaceId);
  const used = (await usageFor(workspaceId, e.subscription.currentPeriodStart)).sequence_contacts ?? 0;
  return { used, limit: e.limits.sequenceContactsPerMonth ?? null, periodStart: e.subscription.currentPeriodStart, periodEnd: e.subscription.currentPeriodEnd };
}

sequenceRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const view = req.query.view === 'archived' ? 'archived' : 'active';
  const sequences = await Sequence.find({ workspaceId, status: view === 'archived' ? 'archived' : { $ne: 'archived' } }).sort({ updatedAt: -1 });
  const ids = sequences.map((s) => s._id);
  const [byStatus, replied] = await Promise.all([
    SequenceEnrollment.aggregate<{ _id: { s: Types.ObjectId; st: string }; n: number }>([
      { $match: { workspaceId, sequenceId: { $in: ids }, test: false } },
      { $group: { _id: { s: '$sequenceId', st: '$status' }, n: { $sum: 1 } } },
    ]),
    SequenceMessage.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { workspaceId, sequenceId: { $in: ids }, test: false, repliedAt: { $ne: null } } },
      { $group: { _id: { s: '$sequenceId', e: '$enrollmentId' } } },
      { $group: { _id: '$_id.s', n: { $sum: 1 } } },
    ]),
  ]);
  const count = (id: Types.ObjectId, ...statuses: string[]) => byStatus.filter((r) => r._id.s.equals(id) && statuses.includes(r._id.st)).reduce((a, r) => a + r.n, 0);
  const lastChange = await Sequence.findOne({ workspaceId }).sort({ updatedAt: -1 }).select('updatedAt').lean();
  res.json({
    sequences: sequences.map((s) => ({
      ...summary(s),
      counts: {
        inProgress: count(s._id, 'in_progress'),
        needsAttention: count(s._id, 'needs_attention'),
        replied: replied.find((r) => r._id.equals(s._id))?.n ?? 0,
        completed: count(s._id, 'completed'),
        stopped: count(s._id, 'dropped', 'error'),
      },
    })),
    usage: await monthlyUsage(workspaceId),
    lastChangeAt: lastChange?.updatedAt ?? null,
  });
});

sequenceRouter.get('/starting-points', requirePermission('workspace:read'), (_req, res) => {
  res.json({
    startingPoints: STARTING_POINTS.map((p) => ({ key: p.key, name: p.name, description: p.description, icon: p.icon, summary: p.summary, triggerType: p.trigger.type })),
  });
});

sequenceRouter.post('/', requirePermission('sequences:manage'), async (req, res) => {
  const { name, startingPoint } = parse(z.object({ name: z.string().trim().min(1, 'Name the sequence.').max(120), startingPoint: z.string().max(40).nullable().default(null) }), req.body);
  const workspaceId = req.workspace!._id;
  const point = startingPoint ? STARTING_POINTS.find((p) => p.key === startingPoint) : null;
  if (startingPoint && !point) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { startingPoint: ['Unknown starting point.'] });
  const tagsNamed = async (names: string[] | undefined) => {
    if (!names?.length) return [];
    const map = await ensureTags(workspaceId, names);
    return names.map((n) => map.get(n.toLowerCase())!);
  };
  const tagIds = await tagsNamed(point?.triggerTagNames);
  const goalTags = await tagsNamed(point?.goal?.tagNames);
  // Date starting points (birthday, appointment) need their custom field to exist.
  const fieldKey = point?.trigger.type === 'date_field' ? String(point.trigger.fieldKey) : null;
  if (fieldKey && !(await CustomField.exists({ workspaceId, key: fieldKey }))) {
    const order = await CustomField.countDocuments({ workspaceId });
    await CustomField.create({ workspaceId, key: fieldKey, label: fieldKey.charAt(0).toUpperCase() + fieldKey.slice(1), type: 'date', order }).catch((err: { code?: number }) => {
      if (err.code !== 11000) throw err;
    });
  }
  const seq = await Sequence.create({
    workspaceId,
    name,
    startingPoint: point?.key ?? null,
    trigger: point ? { ...point.trigger, tagIds } : {},
    dateMode: point?.dateMode ?? 'none',
    dateKey: point?.dateKey ?? null,
    goal: point?.goal ? { type: point.goal.type, tagIds: goalTags } : { type: 'none' },
    rules: point?.rules ?? {},
    draftGraph: point ? freshGraph(point.graph) : { steps: [] },
    createdBy: req.user!._id,
    updatedBy: req.user!._id,
  });
  await audit(req, { workspaceId, action: 'sequence.created', targetType: 'sequence', targetId: seq.id, metadata: { name, startingPoint } });
  res.status(201).json({ sequence: await detail(seq) });
});

sequenceRouter.get('/:sequenceId', requirePermission('workspace:read'), async (req, res) => {
  res.json({ sequence: await detail(await findSequence(req)) });
});

sequenceRouter.patch('/:sequenceId', requirePermission('sequences:manage'), async (req, res) => {
  const input = parse(updateSchema, req.body);
  const seq = await findSequence(req);
  if (seq.status === 'archived') throw conflict('SEQUENCE_ARCHIVED', 'Restore the sequence before editing it.');
  if (input.trigger && seq.publishedAt && JSON.stringify(input.trigger) !== JSON.stringify(triggerSchema.parse(JSON.parse(JSON.stringify(seq.toObject().trigger ?? {}))))) {
    throw conflict('TRIGGER_LOCKED', 'Who joins cannot change after a sequence is published. Create a new sequence instead.');
  }
  if (input.draftGraph) {
    try {
      compile(input.draftGraph as Graph);
    } catch {
      throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { draftGraph: ['Two steps have the same id.'] });
    }
  }
  const { rules, fixedDate, ...rest } = input;
  seq.set(rest);
  if (fixedDate !== undefined) seq.fixedDate = fixedDate ? new Date(fixedDate) : null;
  if (rules) seq.set('rules', { ...(seq.toObject().rules ?? {}), ...rules });
  seq.updatedBy = req.user!._id;
  await seq.save();
  res.json({ sequence: await detail(seq) });
});

sequenceRouter.post('/:sequenceId/publish', requirePermission('sequences:manage'), async (req, res) => {
  const seq = await findSequence(req);
  if (seq.status === 'archived') throw conflict('SEQUENCE_ARCHIVED', 'Restore the sequence before publishing it.');
  const items = await checklist(seq, seq.workspaceId);
  if (items.length) throw new AppError(422, 'SEQUENCE_NOT_READY', 'Finish the things left before publishing.', { checklist: items });
  const graph = graphSchema.parse(seq.draftGraph) as Graph;
  const last = await SequenceVersion.findOne({ workspaceId: seq.workspaceId, sequenceId: seq._id }).sort({ versionNo: -1 }).select('versionNo').lean();
  const version = await SequenceVersion.create({ workspaceId: seq.workspaceId, sequenceId: seq._id, versionNo: (last?.versionNo ?? 0) + 1, graph, publishedBy: req.user!._id });
  const firstPublish = !seq.publishedAt;
  seq.set({ liveVersionId: version._id, draftGraph: graph, publishedAt: seq.publishedAt ?? new Date(), status: seq.status === 'paused' ? 'paused' : 'active', updatedBy: req.user!._id });
  await seq.save();
  resetDomainInterest(seq.workspaceId);
  await audit(req, { workspaceId: seq.workspaceId, action: firstPublish ? 'sequence.published' : 'sequence.republished', targetType: 'sequence', targetId: seq.id, metadata: { name: seq.name, versionNo: version.versionNo } });
  res.json({ sequence: await detail(seq) });
});

sequenceRouter.post('/:sequenceId/pause', requirePermission('sequences:manage'), async (req, res) => {
  const seq = await findSequence(req);
  if (seq.status !== 'active') throw conflict('NOT_ACTIVE', 'Only a live sequence can be paused.');
  seq.status = 'paused';
  await seq.save();
  await audit(req, { workspaceId: seq.workspaceId, action: 'sequence.paused', targetType: 'sequence', targetId: seq.id, metadata: { name: seq.name } });
  res.json({ sequence: await detail(seq) });
});

sequenceRouter.post('/:sequenceId/resume', requirePermission('sequences:manage'), async (req, res) => {
  const seq = await findSequence(req);
  if (seq.status !== 'paused') throw conflict('NOT_PAUSED', 'Only a paused sequence can be resumed.');
  seq.status = 'active';
  await seq.save();
  resetDomainInterest(seq.workspaceId);
  await audit(req, { workspaceId: seq.workspaceId, action: 'sequence.resumed', targetType: 'sequence', targetId: seq.id, metadata: { name: seq.name } });
  res.json({ sequence: await detail(seq) });
});

/** Soft delete: everyone inside exits (reason "archived"); it can be restored later. */
sequenceRouter.post('/:sequenceId/archive', requirePermission('sequences:manage'), async (req, res) => {
  const seq = await findSequence(req);
  if (seq.status === 'archived') return void res.json({ sequence: await detail(seq) });
  seq.set({ status: 'archived', archivedAt: new Date() });
  await seq.save();
  const exited = await exitWhere({ workspaceId: seq.workspaceId, sequenceId: seq._id }, 'archived', 'Sequence archived');
  await audit(req, { workspaceId: seq.workspaceId, action: 'sequence.archived', targetType: 'sequence', targetId: seq.id, metadata: { name: seq.name, exited } });
  res.json({ sequence: await detail(seq), exited });
});

/** A once-live sequence comes back paused; a never-published one as a draft. */
sequenceRouter.post('/:sequenceId/restore', requirePermission('sequences:manage'), async (req, res) => {
  const seq = await findSequence(req);
  if (seq.status !== 'archived') throw conflict('NOT_ARCHIVED', 'This sequence is not archived.');
  seq.set({ status: seq.publishedAt ? 'paused' : 'draft', archivedAt: null });
  await seq.save();
  await audit(req, { workspaceId: seq.workspaceId, action: 'sequence.restored', targetType: 'sequence', targetId: seq.id, metadata: { name: seq.name } });
  res.json({ sequence: await detail(seq) });
});

sequenceRouter.post('/:sequenceId/duplicate', requirePermission('sequences:manage'), async (req, res) => {
  const src = await findSequence(req);
  const o = src.toObject();
  const copy = await Sequence.create({
    workspaceId: src.workspaceId,
    name: `${src.name} (copy)`.slice(0, 120),
    startingPoint: o.startingPoint,
    trigger: o.trigger,
    entryFilter: o.entryFilter,
    dateMode: o.dateMode,
    fixedDate: o.fixedDate,
    dateKey: o.dateKey,
    goal: o.goal,
    stopConditions: o.stopConditions,
    rules: o.rules,
    draftGraph: o.draftGraph,
    createdBy: req.user!._id,
    updatedBy: req.user!._id,
  });
  await audit(req, { workspaceId: src.workspaceId, action: 'sequence.duplicated', targetType: 'sequence', targetId: copy.id, metadata: { name: copy.name, from: src.id } });
  res.status(201).json({ sequence: await detail(copy) });
});

/** Runs the draft to the user's own number: every wait is 20 s, the send window is ignored. */
sequenceRouter.post('/:sequenceId/test', requirePermission('sequences:manage'), async (req, res) => {
  const { phone, data } = parse(z.object({ phone: z.string().trim().min(5).max(30), data: z.record(z.string(), z.unknown()).default({}) }), req.body);
  const seq = await findSequence(req);
  const workspaceId = seq.workspaceId;
  const phoneE164 = normalizePhone(phone, req.workspace!.country);
  if (!phoneE164) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { phone: ['Enter a valid phone number.'] });
  const items = (await checklist(seq, workspaceId)).filter((i) => !i.publishOnly);
  if (items.length) throw new AppError(422, 'SEQUENCE_NOT_READY', 'Finish the things left before testing.', { checklist: items });
  const since = new Date(Date.now() - 24 * 3_600_000);
  const today = await SequenceEnrollment.countDocuments({ workspaceId, test: true, createdAt: { $gte: since }, joinedVia: `test:${req.user!.id}` });
  if (today >= MAX_TESTS_PER_DAY) throw new AppError(429, 'TEST_LIMIT', `You can run ${MAX_TESTS_PER_DAY} tests a day. Try again tomorrow.`);
  const contact = await findOrCreateContact(workspaceId, phoneE164, 'sequence_test');
  const { result, enrollment } = await enroll(seq, contact, { via: `test:${req.user!.id}`, data, test: { graph: graphSchema.parse(seq.draftGraph) as Graph } });
  if (result !== 'enrolled') throw new AppError(422, 'TEST_NOT_STARTED', result === 'opted_out' ? 'This number has opted out of messages.' : 'This number is blocked.');
  res.status(201).json({ enrollmentId: enrollment!.id, testsLeftToday: MAX_TESTS_PER_DAY - today - 1 });
});

/** Manual trigger: add contacts (ids or pasted numbers). Per-contact results. */
sequenceRouter.post('/:sequenceId/enroll', requirePermission('sequences:manage'), async (req, res) => {
  const input = parse(
    z.object({ contactIds: z.array(idString).max(1000).default([]), phones: z.array(z.string().trim().min(5).max(30)).max(1000).default([]), listId: idString.nullable().default(null), data: z.record(z.string(), z.unknown()).default({}) }),
    req.body,
  );
  const seq = await findSequence(req);
  const workspaceId = seq.workspaceId;
  if (seq.trigger?.type !== 'manual') throw conflict('NOT_MANUAL', 'This sequence adds contacts automatically. Only "Added manually or by API" sequences take contacts here.');
  if (seq.status !== 'active') throw conflict('NOT_ACTIVE', 'Publish (or resume) the sequence before adding contacts.');
  const ids = new Set(input.contactIds);
  if (input.listId) for (const c of await Contact.find({ workspaceId, lists: new Types.ObjectId(input.listId) }).select('_id').limit(5000).lean()) ids.add(String(c._id));
  const results: Record<EnrollResult | 'invalid', number> = { enrolled: 0, already_in: 0, opted_out: 0, blocked: 0, filtered: 0, not_again_yet: 0, capped: 0, limit_reached: 0, not_live: 0, invalid: 0 };
  for (const phone of input.phones) {
    const e164 = normalizePhone(phone, req.workspace!.country);
    if (!e164) {
      results.invalid++;
      continue;
    }
    ids.add(String((await findOrCreateContact(workspaceId, e164, 'manual'))._id));
  }
  const contacts = await Contact.find({ workspaceId, _id: { $in: [...ids].map((id) => new Types.ObjectId(id)) } });
  results.invalid += ids.size - contacts.length;
  for (const contact of contacts) results[(await enroll(seq, contact, { via: 'manual', data: input.data })).result]++;
  res.json({ results });
});

const contactsQuery = z.object({
  status: z.enum([...ENROLLMENT_STATUSES, 'all']).default('all'),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

sequenceRouter.get('/:sequenceId/contacts', requirePermission('workspace:read'), async (req, res) => {
  const { status, q, page, limit } = parse(contactsQuery, req.query);
  const seq = await findSequence(req);
  const workspaceId = seq.workspaceId;
  const filter: Record<string, unknown> = { workspaceId, sequenceId: seq._id, test: false };
  if (status !== 'all') filter.status = status;
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const matches = await Contact.find({ workspaceId, $or: [{ name: rx }, { profileName: rx }, { phoneE164: rx }] }).select('_id').limit(1000).lean();
    filter.contactId = { $in: matches.map((m) => m._id) };
  }
  const [rows, total] = await Promise.all([SequenceEnrollment.find(filter).sort({ enrolledAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), SequenceEnrollment.countDocuments(filter)]);
  const contacts = await Contact.find({ workspaceId, _id: { $in: rows.map((r) => r.contactId) } }).select('name profileName phoneE164').lean();
  const graphs = new Map<string, Map<string, { label: string }>>();
  for (const vId of new Set(rows.map((r) => String(r.versionId)))) {
    const v = await SequenceVersion.findOne({ _id: vId, workspaceId }).select('graph').lean();
    if (v) graphs.set(vId, stepLabels(v.graph as Graph));
  }
  res.json({
    contacts: rows.map((r) => {
      const c = contacts.find((x) => x._id.equals(r.contactId));
      return {
        enrollmentId: String(r._id),
        contact: c ? { id: String(c._id), name: c.name || c.profileName || null, phone: c.phoneE164 } : null,
        status: r.status,
        outcome: r.outcome ?? null,
        currentStep: r.active && r.currentStepId ? (graphs.get(String(r.versionId))?.get(r.currentStepId)?.label ?? null) : null,
        nextRunAt: r.active ? (r.nextRunAt ?? null) : null,
        attention: r.attention ?? null,
        enrolledAt: r.enrolledAt,
        exitedAt: r.exitedAt ?? null,
        exitReason: r.exitReason ?? null,
        joinedVia: r.joinedVia,
      };
    }),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    paused: seq.status === 'paused',
  });
});

/** "Message 2 · Offer", "Wait 3 days"… for showing where someone is. */
export function stepLabels(graph: Graph): Map<string, { label: string }> {
  const out = new Map<string, { label: string }>();
  let m = 0;
  for (const s of allSteps(graph)) {
    if (s.type === 'message') out.set(s.id, { label: `Message ${++m}${s.note ? ` · ${s.note}` : ''}` });
    else if (s.type === 'wait') out.set(s.id, { label: `Wait ${s.amount} ${s.amount === 1 ? s.unit.slice(0, -1) : s.unit}` });
    else if (s.type === 'wait_until_date') out.set(s.id, { label: `Dated step (${s.offsetDays === 0 ? 'on the day' : `${Math.abs(s.offsetDays)} day${Math.abs(s.offsetDays) === 1 ? '' : 's'} ${s.offsetDays < 0 ? 'before' : 'after'}`} ${s.time})` });
    else if (s.type === 'branch') out.set(s.id, { label: 'Branch' });
    else out.set(s.id, { label: `Action: ${s.action.replace(/_/g, ' ')}` });
  }
  return out;
}

sequenceRouter.get('/:sequenceId/contacts/:enrollmentId', requirePermission('workspace:read'), async (req, res) => {
  const seq = await findSequence(req);
  const workspaceId = seq.workspaceId;
  const e = await SequenceEnrollment.findOne({ _id: objectId(req.params.enrollmentId, 'Contact'), workspaceId, sequenceId: seq._id }).lean();
  if (!e) throw notFound('This contact is not in the sequence.');
  const [events, messages, contact, version] = await Promise.all([
    SequenceEvent.find({ workspaceId, enrollmentId: e._id }).sort({ createdAt: 1, _id: 1 }).limit(500).lean(),
    SequenceMessage.find({ workspaceId, enrollmentId: e._id }).sort({ createdAt: 1 }).lean(),
    Contact.findOne({ workspaceId, _id: e.contactId }).select('name profileName phoneE164').lean(),
    e.versionId ? SequenceVersion.findOne({ _id: e.versionId, workspaceId }).select('graph versionNo').lean() : null,
  ]);
  const labels = stepLabels(((version?.graph ?? e.testGraph) as Graph) ?? { steps: [] });
  res.json({
    enrollment: {
      id: String(e._id),
      status: e.status,
      outcome: e.outcome ?? null,
      enrolledAt: e.enrolledAt,
      exitedAt: e.exitedAt ?? null,
      exitReason: e.exitReason ?? null,
      nextRunAt: e.active ? (e.nextRunAt ?? null) : null,
      currentStep: e.active && e.currentStepId ? (labels.get(e.currentStepId)?.label ?? null) : null,
      data: e.data ?? {},
      versionNo: version?.versionNo ?? null,
      attention: e.attention ?? null,
    },
    contact: contact ? { id: String(contact._id), name: contact.name || contact.profileName || null, phone: contact.phoneE164 } : null,
    history: events.map((ev) => ({ at: ev.createdAt, step: ev.stepId ? (labels.get(ev.stepId)?.label ?? ev.stepId) : null, type: ev.type, result: ev.result, reason: ev.reason ?? null })),
    messages: messages.map((m) => ({ step: labels.get(m.stepId)?.label ?? m.stepId, status: m.status, sentAt: m.sentAt ?? m.createdAt, deliveredAt: m.deliveredAt ?? null, readAt: m.readAt ?? null, repliedAt: m.repliedAt ?? null, errorCode: m.errorCode ?? null })),
  });
});

sequenceRouter.post('/:sequenceId/contacts/:enrollmentId/remove', requirePermission('sequences:manage'), async (req, res) => {
  const seq = await findSequence(req);
  const e = await SequenceEnrollment.findOne({ _id: objectId(req.params.enrollmentId, 'Contact'), workspaceId: seq.workspaceId, sequenceId: seq._id, active: true });
  if (!e) throw notFound('This contact is not in the sequence any more.');
  await exitEnrollment(e, 'removed', `Removed by ${req.user!.name ?? 'a teammate'}`);
  await audit(req, { workspaceId: seq.workspaceId, action: 'sequence.contact_removed', targetType: 'sequence', targetId: seq.id, metadata: { enrollmentId: e.id, contactId: String(e.contactId) } });
  res.json({ ok: true });
});

/** Per message step of the live version: sent → delivered → read → replied. */
sequenceRouter.get('/:sequenceId/funnel', requirePermission('workspace:read'), async (req, res) => {
  const seq = await findSequence(req);
  const workspaceId = seq.workspaceId;
  const graph = (seq.liveVersionId ? (await SequenceVersion.findOne({ _id: seq.liveVersionId, workspaceId }).lean())?.graph : seq.draftGraph) as Graph;
  const rows = await SequenceMessage.aggregate<{ _id: string; sent: number; delivered: number; read: number; replied: number; failed: number }>([
    { $match: { workspaceId, sequenceId: seq._id, test: false } },
    {
      $group: {
        _id: '$stepId',
        sent: { $sum: 1 },
        delivered: { $sum: { $cond: [{ $or: [{ $ne: ['$deliveredAt', null] }, { $ne: ['$readAt', null] }] }, 1, 0] } },
        read: { $sum: { $cond: [{ $ne: ['$readAt', null] }, 1, 0] } },
        replied: { $sum: { $cond: [{ $ne: ['$repliedAt', null] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
      },
    },
  ]);
  const labels = stepLabels(graph ?? { steps: [] });
  const steps = allSteps(graph ?? { steps: [] }).filter((s) => s.type === 'message');
  res.json({
    steps: steps.map((s) => {
      const r = rows.find((x) => x._id === s.id);
      return { stepId: s.id, label: labels.get(s.id)!.label, sent: r?.sent ?? 0, delivered: r?.delivered ?? 0, read: r?.read ?? 0, replied: r?.replied ?? 0, failed: r?.failed ?? 0 };
    }),
  });
});

/** For "Preview & publish": messages per contact and what is left of the plan. */
sequenceRouter.get('/:sequenceId/estimate', requirePermission('workspace:read'), async (req, res) => {
  const seq = await findSequence(req);
  const parsed = graphSchema.safeParse(seq.draftGraph);
  const steps = parsed.success ? allSteps(parsed.data as Graph) : [];
  const longest = (list: Graph['steps']): number =>
    list.reduce((n, s) => n + (s.type === 'message' ? 1 : s.type === 'branch' ? Math.max(...s.ways.map((w) => longest(w.steps))) : 0), 0);
  const e = await getEntitlements(seq.workspaceId);
  const usage = await usageFor(seq.workspaceId, e.subscription.currentPeriodStart);
  res.json({
    messagesPerContact: parsed.success ? longest((parsed.data as Graph).steps) : 0,
    messageSteps: steps.filter((s) => s.type === 'message').length,
    messages: { used: usage.messages ?? 0, limit: e.limits.monthlyMessages ?? null },
    sequenceContacts: { used: usage.sequence_contacts ?? 0, limit: e.limits.sequenceContactsPerMonth ?? null },
    periodEnd: e.subscription.currentPeriodEnd,
  });
});

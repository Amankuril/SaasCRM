import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { publish } from '../../realtime/bus.js';
import { slugifyStage } from '../audience/stage.service.js';
import { STAGE_COLORS } from '../audience/stage.model.js';
import { User } from '../auth/user.model.js';
import { Contact } from '../contacts/contact.model.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { Counter, TASK_PRIORITIES, TASK_TYPES, Task, TaskColumn, type TaskColumnDoc, type TaskDoc } from './task.model.js';

const objectIdString = z.string().regex(/^[a-f0-9]{24}$/);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const DEFAULT_COLUMNS = [
  { key: 'open', name: 'Open', color: 'orange', isDone: false },
  { key: 'in_progress', name: 'In Progress', color: 'blue', isDone: false },
  { key: 'unit_testing', name: 'Unit Testing', color: 'violet', isDone: false },
  { key: 'done', name: 'Done', color: 'green', isDone: true },
] as const;

/** The board's columns in order, creating the defaults the first time. */
export async function listColumns(workspaceId: Types.ObjectId): Promise<TaskColumnDoc[]> {
  let columns = await TaskColumn.find({ workspaceId }).sort({ order: 1, createdAt: 1 });
  if (columns.length) return columns;
  try {
    await TaskColumn.insertMany(
      DEFAULT_COLUMNS.map((c, order) => ({ workspaceId, ...c, order })),
      { ordered: false },
    );
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }
  columns = await TaskColumn.find({ workspaceId }).sort({ order: 1, createdAt: 1 });
  return columns;
}

const toColumn = (c: TaskColumnDoc) => ({ id: c.id as string, key: c.key, name: c.name, color: c.color, order: c.order, isDone: c.isDone });

async function checkMember(workspaceId: Types.ObjectId, userId: string | null | undefined, field = 'assigneeId') {
  if (userId && !(await WorkspaceMember.exists({ workspaceId, userId }))) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { [field]: ['Choose a teammate.'] });
}

async function serializeTasks(workspaceId: Types.ObjectId, tasks: TaskDoc[]) {
  const [users, contacts] = await Promise.all([
    User.find({ _id: { $in: tasks.flatMap((t) => [t.assigneeId, t.createdBy]).filter(Boolean) } }).select('name').lean(),
    Contact.find({ workspaceId, _id: { $in: tasks.map((t) => t.contactId).filter(Boolean) } }).select('name profileName phoneE164').lean(),
  ]);
  const userName = new Map(users.map((u) => [u._id.toString(), u.name]));
  const contactById = new Map(contacts.map((c) => [c._id.toString(), c]));
  return tasks.map((t) => {
    const c = t.contactId ? contactById.get(t.contactId.toString()) : null;
    return {
      id: t.id as string,
      number: t.number,
      type: t.type,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      assignee: t.assigneeId ? { id: t.assigneeId.toString(), name: userName.get(t.assigneeId.toString()) ?? 'Former member' } : null,
      contact: c ? { id: c._id.toString(), name: c.name || c.profileName || c.phoneE164, phone: c.phoneE164 } : null,
      dueAt: t.dueAt,
      position: t.position,
      completedAt: t.completedAt,
      createdBy: t.createdBy ? (userName.get(t.createdBy.toString()) ?? null) : null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  });
}

// ---- Columns ----

export const taskColumnRouter = Router({ mergeParams: true });
const columnInput = z.object({ name: z.string().trim().min(1, 'Name the column.').max(40), color: z.enum(STAGE_COLORS).default('gray'), isDone: z.boolean().default(false) });

taskColumnRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const columns = await listColumns(req.workspace!._id);
  res.json({ columns: columns.map(toColumn) });
});

taskColumnRouter.post('/', requirePermission('contacts:manage'), async (req, res) => {
  const input = parse(columnInput, req.body);
  const workspaceId = req.workspace!._id;
  const columns = await listColumns(workspaceId);
  if (columns.length >= 20) throw conflict('TOO_MANY_COLUMNS', 'A board can have at most 20 columns.');
  if (columns.some((c) => c.name.toLowerCase() === input.name.toLowerCase())) throw conflict('COLUMN_EXISTS', `A column named "${input.name}" already exists.`);
  const base = slugifyStage(input.name);
  let key = base;
  for (let i = 2; columns.some((c) => c.key === key); i++) key = `${base}_${i}`;
  const column = await TaskColumn.create({ workspaceId, key, ...input, order: (columns.at(-1)?.order ?? 0) + 1 });
  res.status(201).json({ column: toColumn(column) });
});

taskColumnRouter.post('/reorder', requirePermission('contacts:manage'), async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(objectIdString).min(1).max(20) }), req.body);
  const workspaceId = req.workspace!._id;
  await TaskColumn.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: { _id: new Types.ObjectId(id), workspaceId }, update: { order } } })));
  res.json({ columns: (await listColumns(workspaceId)).map(toColumn) });
});

taskColumnRouter.patch('/:columnId', requirePermission('contacts:manage'), async (req, res) => {
  const input = parse(columnInput.partial(), req.body);
  const column = await TaskColumn.findOne({ _id: objectId(req.params.columnId, 'Column'), workspaceId: req.workspace!._id });
  if (!column) throw notFound('Column not found.');
  column.set(input);
  await column.save();
  res.json({ column: toColumn(column) });
});

/** Deleting a column moves its tasks to `moveTo` (default: the first other column). */
taskColumnRouter.delete('/:columnId', requirePermission('contacts:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const columns = await listColumns(workspaceId);
  const column = columns.find((c) => c.id === req.params.columnId);
  if (!column) throw notFound('Column not found.');
  if (columns.length === 1) throw conflict('LAST_COLUMN', 'A board needs at least one column.');
  const moveTo = typeof req.query.moveTo === 'string' ? req.query.moveTo : columns.find((c) => c.key !== column.key)!.key;
  const target = columns.find((c) => c.key === moveTo && c.key !== column.key);
  if (!target) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { moveTo: ['Choose another column.'] });
  const moved = await Task.updateMany({ workspaceId, status: column.key }, { status: target.key, completedAt: target.isDone ? new Date() : null });
  await TaskColumn.deleteOne({ _id: column._id, workspaceId });
  res.json({ moved: moved.modifiedCount });
});

// ---- Tasks ----

export const taskRouter = Router({ mergeParams: true });

const taskInput = z.object({
  title: z.string().trim().min(1, 'Give the task a title.').max(200),
  description: z.string().trim().max(5000).default(''),
  type: z.enum(TASK_TYPES).default('task'),
  status: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
  priority: z.enum(TASK_PRIORITIES).default('medium'),
  assigneeId: objectIdString.nullable().default(null),
  contactId: objectIdString.nullable().default(null),
  dueAt: z.string().datetime({ offset: true }).nullable().default(null),
});

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  assignee: z.union([objectIdString, z.literal('unassigned'), z.literal('me')]).optional(),
  type: z.enum(TASK_TYPES).optional(),
  contactId: objectIdString.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

async function loadTask(req: Request) {
  const task = await Task.findOne({ _id: objectId(req.params.taskId, 'Task'), workspaceId: req.workspace!._id });
  if (!task) throw notFound('Task not found.');
  return task;
}

async function columnFor(workspaceId: Types.ObjectId, key: string | undefined) {
  const columns = await listColumns(workspaceId);
  const column = key ? columns.find((c) => c.key === key) : columns[0];
  if (!column) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { status: ['Unknown column.'] });
  return column;
}

taskRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const input = parse(listSchema, req.query);
  const workspaceId = req.workspace!._id;
  const filter: Record<string, unknown> = { workspaceId };
  if (input.assignee === 'unassigned') filter.assigneeId = null;
  else if (input.assignee === 'me') filter.assigneeId = req.user!._id;
  else if (input.assignee) filter.assigneeId = new Types.ObjectId(input.assignee);
  if (input.type) filter.type = input.type;
  if (input.contactId) filter.contactId = new Types.ObjectId(input.contactId);
  if (input.from || input.to) filter.createdAt = { ...(input.from ? { $gte: new Date(input.from) } : {}), ...(input.to ? { $lte: new Date(input.to) } : {}) };
  if (input.q) {
    const asNumber = Number(input.q.replace(/^#/, ''));
    filter.$or = [{ title: { $regex: escapeRegex(input.q), $options: 'i' } }, { description: { $regex: escapeRegex(input.q), $options: 'i' } }, ...(Number.isInteger(asNumber) && asNumber > 0 ? [{ number: asNumber }] : [])];
  }
  const tasks = await Task.find(filter).sort({ position: 1, number: -1 }).limit(2000);
  res.json({ tasks: await serializeTasks(workspaceId, tasks) });
});

taskRouter.post('/', requirePermission('contacts:manage'), async (req, res) => {
  const input = parse(taskInput, req.body);
  const workspaceId = req.workspace!._id;
  await checkMember(workspaceId, input.assigneeId);
  if (input.contactId && !(await Contact.exists({ workspaceId, _id: input.contactId }))) throw notFound('Contact not found.');
  const column = await columnFor(workspaceId, input.status);
  const counter = await Counter.findOneAndUpdate({ workspaceId, name: 'task' }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  const last = await Task.findOne({ workspaceId, status: column.key }).sort({ position: -1 }).select('position').lean();
  const task = await Task.create({
    workspaceId,
    ...input,
    number: counter.seq,
    status: column.key,
    dueAt: input.dueAt ? new Date(input.dueAt) : null,
    position: (last?.position ?? 0) + 1,
    completedAt: column.isDone ? new Date() : null,
    createdBy: req.user!._id,
  });
  publish(req.workspace!.id as string, { type: 'tasks.changed' });
  res.status(201).json({ task: (await serializeTasks(workspaceId, [task]))[0] });
});

taskRouter.patch('/:taskId', requirePermission('contacts:manage'), async (req, res) => {
  const task = await loadTask(req);
  const input = parse(taskInput.partial(), req.body);
  const workspaceId = req.workspace!._id;
  await checkMember(workspaceId, input.assigneeId);
  if (input.contactId && !(await Contact.exists({ workspaceId, _id: input.contactId }))) throw notFound('Contact not found.');
  const { status, dueAt, ...rest } = input;
  task.set(rest);
  if (dueAt !== undefined) task.dueAt = dueAt ? new Date(dueAt) : null;
  if (status && status !== task.status) {
    const column = await columnFor(workspaceId, status);
    task.set({ status: column.key, completedAt: column.isDone ? new Date() : null });
  }
  await task.save();
  publish(req.workspace!.id as string, { type: 'tasks.changed' });
  res.json({ task: (await serializeTasks(workspaceId, [task]))[0] });
});

/** Drag & drop: puts the task in `status` and renumbers that column in the given order. */
taskRouter.post('/:taskId/move', requirePermission('contacts:manage'), async (req, res) => {
  const { status, orderedIds } = parse(z.object({ status: z.string().regex(/^[a-z0-9_]{1,40}$/), orderedIds: z.array(objectIdString).max(2000) }), req.body);
  const task = await loadTask(req);
  const workspaceId = req.workspace!._id;
  const column = await columnFor(workspaceId, status);
  if (!orderedIds.includes(task.id as string)) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { orderedIds: ['The moved task must be in the new order.'] });
  if (column.key !== task.status) task.set({ status: column.key, completedAt: column.isDone ? new Date() : null });
  await task.save();
  await Task.bulkWrite(orderedIds.map((id, position) => ({ updateOne: { filter: { _id: new Types.ObjectId(id), workspaceId, status: column.key }, update: { position } } })));
  publish(req.workspace!.id as string, { type: 'tasks.changed' });
  res.json({ task: (await serializeTasks(workspaceId, [task]))[0] });
});

taskRouter.delete('/:taskId', requirePermission('contacts:manage'), async (req, res) => {
  const task = await loadTask(req);
  await Task.deleteOne({ _id: task._id, workspaceId: req.workspace!._id });
  publish(req.workspace!.id as string, { type: 'tasks.changed' });
  res.status(204).end();
});

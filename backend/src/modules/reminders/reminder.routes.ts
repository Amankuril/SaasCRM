import { Router, type Request } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { env, isProd } from '../../config/env.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { publish } from '../../realtime/bus.js';
import { audit } from '../audit/audit.service.js';
import { billingProvider } from '../billing/provider.js';
import { Message } from '../messages/message.model.js';
import { MessageTemplate } from '../templates/template.model.js';
import { sendRequirements, templateExtrasSchema } from '../templates/templateSend.js';
import type { TemplateComponent } from '../whatsapp/provider/types.js';
import { CATEGORIES, CATEGORY_KEYS, RECURRENCES, RULE_UNITS, categoryOf, ruleId, type ReminderRule } from './categories.js';
import { importRecords, importSchema, parseRecord } from './reminder.import.js';
import { ReminderRecord, ReminderSend, ReminderSetup, SEND_STATUSES, type ReminderRecordDoc, type ReminderSetupDoc } from './reminder.model.js';
import { applySchedule, exampleValues, fieldsOf, identityOf, readiness, rescheduleSetup, resolveVariables, setupCounts, upcomingRun, valuesFor, variablesOf, type ReminderVariable } from './reminder.service.js';
import { formatDate, formatTime, isRealDate } from './schedule.js';
import { assertReminderAccess, completeUnlock, pendingOrder, reminderAccess, startUnlock } from './unlock.service.js';

/** Mounted at /api/workspaces/:workspaceId/reminders (workspace already loaded). */
export const reminderRouter = Router({ mergeParams: true });

const changed = (req: Request) => publish(req.workspace!.id as string, { type: 'reminders.changed' });

async function loadSetup(req: Request): Promise<ReminderSetupDoc> {
  const setup = await ReminderSetup.findOne({ _id: objectId(req.params.setupId, 'Reminder'), workspaceId: req.workspace!._id });
  if (!setup) throw notFound('Reminder not found.');
  return setup;
}

async function loadRecord(req: Request, setup: ReminderSetupDoc): Promise<ReminderRecordDoc> {
  const record = await ReminderRecord.findOne({ _id: objectId(req.params.recordId, 'Contact'), workspaceId: setup.workspaceId, setupId: setup._id });
  if (!record) throw notFound('This contact is no longer in the reminder.');
  return record;
}

const EMPTY = { contacts: 0, active: 0, paused: 0, completed: 0, nextRunAt: null as Date | null, sent: 0, pending: 0, failed: 0, skipped: 0 };

async function serialize(setup: ReminderSetupDoc, counts = EMPTY) {
  const template = setup.templateId ? await MessageTemplate.findOne({ _id: setup.templateId, workspaceId: setup.workspaceId }) : null;
  return {
    id: setup.id as string,
    category: setup.category,
    name: setup.name,
    status: setup.status,
    eventLabel: setup.eventLabel ?? null,
    extraFields: setup.extraFields.map((f) => ({ key: f.key, label: f.label })),
    fields: fieldsOf(setup),
    variables: variablesOf(setup),
    recurrence: setup.recurrence,
    everyDays: setup.everyDays,
    rules: setup.rules.map((r) => ({ when: r.when, value: r.value, unit: r.unit })),
    sendTime: setup.sendTime,
    sendMissedToday: setup.sendMissedToday,
    templateId: setup.templateId?.toString() ?? null,
    template: template ? { id: template.id as string, name: template.name, language: template.language, category: template.category, status: template.status, components: template.components } : null,
    headerVariables: setup.headerVariables,
    bodyVariables: setup.bodyVariables,
    buttonVariables: setup.buttonVariables,
    templateExtras: setup.templateExtras ?? null,
    lastError: setup.lastError,
    activatedAt: setup.activatedAt,
    counts,
    missing: await readiness(setup),
    createdAt: setup.createdAt,
    updatedAt: setup.updatedAt,
  };
}
const full = async (setup: ReminderSetupDoc) => serialize(setup, (await setupCounts(setup.workspaceId, [setup._id])).get(setup.id as string));

// ---- Overview ----

reminderRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const setups = await ReminderSetup.find({ workspaceId }).sort({ createdAt: -1 });
  const counts = await setupCounts(workspaceId, setups.map((s) => s._id));
  const totals = { ...EMPTY, setups: setups.length, live: setups.filter((s) => s.status === 'active').length };
  for (const c of counts.values()) {
    for (const k of ['contacts', 'active', 'paused', 'completed', 'sent', 'pending', 'failed', 'skipped'] as const) totals[k] += c[k];
    if (c.nextRunAt && (!totals.nextRunAt || c.nextRunAt < totals.nextRunAt)) totals.nextRunAt = c.nextRunAt;
  }
  res.json({
    categories: CATEGORIES.map((c) => {
      const own = setups.filter((s) => s.category === c.key);
      return { ...c, setups: own.length, live: own.filter((s) => s.status === 'active').length, contacts: own.reduce((n, s) => n + (counts.get(s.id as string)?.contacts ?? 0), 0) };
    }),
    setups: await Promise.all(setups.map((s) => serialize(s, counts.get(s.id as string)))),
    totals,
    access: await reminderAccess(req.workspace!),
    timezone: req.workspace!.timezone,
  });
});

// ---- One-time unlock ----

reminderRouter.post('/unlock', requirePermission('billing:manage'), async (req, res) => {
  const order = await startUnlock(req.workspace!);
  await audit(req, { workspaceId: req.workspace!._id, action: 'reminders.unlock_started', metadata: { amount: order.amount, provider: order.provider } });
  res.json({ order, razorpayKeyId: order.provider === 'razorpay' ? (env.RAZORPAY_KEY_ID ?? null) : null });
});

const confirmSchema = z.object({ razorpay_order_id: z.string().min(1).max(64), razorpay_payment_id: z.string().min(1).max(64), razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/i) });

reminderRouter.post('/unlock/confirm', requirePermission('billing:manage'), async (req, res) => {
  const input = parse(confirmSchema, req.body);
  const provider = billingProvider();
  if (!provider.confirmOrder) throw notFound();
  const pending = await pendingOrder(req.workspace!._id);
  // The webhook may have finished this order already.
  if (pending) {
    if (pending.providerOrderId !== input.razorpay_order_id) throw conflict('CHECKOUT_NOT_FOUND', 'This checkout is no longer open.');
    await completeUnlock(await provider.confirmOrder({ orderId: input.razorpay_order_id, paymentId: input.razorpay_payment_id, signature: input.razorpay_signature }));
    await audit(req, { workspaceId: req.workspace!._id, action: 'reminders.unlocked', metadata: { paymentId: input.razorpay_payment_id } });
  }
  res.json({ access: await reminderAccess(req.workspace!) });
});

/** Sandbox only: completes the fake payment. */
reminderRouter.post('/unlock/sandbox', requirePermission('billing:manage'), async (req, res) => {
  if (isProd || billingProvider().name !== 'sandbox') throw notFound();
  const pending = await pendingOrder(req.workspace!._id);
  if (!pending?.providerOrderId) throw conflict('CHECKOUT_NOT_FOUND', 'This checkout is no longer open.');
  await completeUnlock({ orderId: pending.providerOrderId, paymentId: `sandbox_pay_${pending.providerOrderId}`, amount: pending.amount, currency: pending.currency });
  res.json({ access: await reminderAccess(req.workspace!) });
});

// ---- Setups ----

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Choose a time.');
const variable = z.object({ source: z.enum(['field', 'static']), value: z.string().max(1000), fallback: z.string().max(1000).nullable().optional() });
const rule = z
  .object({ when: z.enum(['before', 'on', 'after']), value: z.number().int().min(0).max(365), unit: z.enum(RULE_UNITS) })
  .transform((r): ReminderRule => (r.when === 'on' ? { when: 'on', value: 0, unit: 'day' } : r));

const updateSchema = z
  .object({
    name: z.string().trim().min(1, 'Name this reminder.').max(80),
    eventLabel: z.string().trim().max(60).nullable(),
    extraFields: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: z.string().trim().min(1, 'Name every field.').max(60) })).max(10),
    recurrence: z.enum(RECURRENCES),
    everyDays: z.number().int().min(1).max(730),
    rules: z.array(rule).max(8),
    sendTime: time,
    sendMissedToday: z.boolean(),
    templateId: z.string().nullable(),
    headerVariables: z.array(variable).max(10),
    bodyVariables: z.array(variable).max(30),
    buttonVariables: z.array(variable).max(10),
    templateExtras: templateExtrasSchema.nullable(),
  })
  .partial();

/** Timing that does not belong to this category is refused, so categories stay separate. */
function checkTiming(setup: ReminderSetupDoc) {
  const c = categoryOf(setup.category);
  const invalid = (field: string, message: string) => badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { [field]: [message] });
  if (!(c.recurrences as readonly string[]).includes(setup.recurrence)) throw invalid('recurrence', `${c.name} reminders cannot repeat this way.`);
  const seen = new Set<string>();
  for (const r of setup.rules) {
    if (r.when !== 'on' && r.value < 1) throw invalid('rules', 'Use a number of at least 1.');
    if (c.dateKind === 'date' && r.when !== 'on' && (r.unit === 'hour' || r.unit === 'minute')) throw invalid('rules', `${c.name} have no time of day, so use days or weeks.`);
    if (r.when === 'after' && !c.followUps) throw invalid('rules', `${c.name} reminders have no follow-ups after the date.`);
    const id = ruleId(r as ReminderRule);
    if (seen.has(id)) throw invalid('rules', 'Two reminders have the same timing.');
    seen.add(id);
  }
  if (setup.category !== 'custom' && (setup.extraFields.length || setup.eventLabel)) throw invalid('extraFields', 'Only your own event types can have extra fields.');
}

reminderRouter.post('/setups', requirePermission('campaigns:manage'), async (req, res) => {
  await assertReminderAccess(req.workspace!);
  const input = parse(z.object({ category: z.enum(CATEGORY_KEYS), name: z.string().trim().max(80).optional(), eventLabel: z.string().trim().min(1).max(60).optional() }), req.body);
  const c = categoryOf(input.category);
  const count = await ReminderSetup.countDocuments({ workspaceId: req.workspace!._id, category: c.key });
  const setup = await ReminderSetup.create({
    workspaceId: req.workspace!._id,
    category: c.key,
    name: input.name || (c.key === 'custom' ? (input.eventLabel ?? 'Custom event') : `${c.name}${count ? ` ${count + 1}` : ''}`),
    eventLabel: c.key === 'custom' ? (input.eventLabel ?? null) : null,
    recurrence: c.defaultRecurrence,
    rules: c.defaultRules,
    createdBy: req.user!._id,
  });
  await audit(req, { workspaceId: setup.workspaceId, action: 'reminder.created', targetType: 'reminder', targetId: setup.id as string, metadata: { category: c.key } });
  res.status(201).json({ setup: await full(setup) });
});

reminderRouter.get('/setups/:setupId', requirePermission('workspace:read'), async (req, res) => {
  const setup = await loadSetup(req);
  res.json({ setup: await full(setup), category: categoryOf(setup.category), access: await reminderAccess(req.workspace!), timezone: req.workspace!.timezone });
});

reminderRouter.patch('/setups/:setupId', requirePermission('campaigns:manage'), async (req, res) => {
  await assertReminderAccess(req.workspace!);
  const { templateId, ...rest } = parse(updateSchema, req.body);
  const setup = await loadSetup(req);
  if (templateId !== undefined) {
    const template = templateId ? await MessageTemplate.findOne({ _id: objectId(templateId, 'Template'), workspaceId: setup.workspaceId }) : null;
    if (templateId && !template) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { templateId: ['Template not found.'] });
    setup.templateId = template?._id ?? null;
  }
  setup.set(rest);
  checkTiming(setup);
  if (setup.status === 'active') {
    const details = await readiness(setup);
    if (Object.keys(details).length) throw badRequest('VALIDATION_ERROR', 'This reminder is live, so it must stay complete. Pause it first to make bigger changes.', details);
  }
  const timingChanged = ['recurrence', 'everyDays', 'rules', 'sendTime', 'sendMissedToday'].some((p) => setup.isModified(p));
  await setup.save();
  if (timingChanged) await rescheduleSetup(setup, req.workspace!.timezone);
  changed(req);
  res.json({ setup: await full(setup) });
});

reminderRouter.post('/setups/:setupId/activate', requirePermission('campaigns:manage'), async (req, res) => {
  await assertReminderAccess(req.workspace!);
  const setup = await loadSetup(req);
  checkTiming(setup);
  const details = await readiness(setup);
  if (!(await ReminderRecord.exists({ workspaceId: setup.workspaceId, setupId: setup._id }))) details.contacts = ['Add at least one contact.'];
  if (Object.keys(details).length) throw badRequest('VALIDATION_ERROR', 'Finish setting up this reminder first.', details);
  setup.set({ status: 'active', activatedAt: new Date(), lastError: null });
  await setup.save();
  await rescheduleSetup(setup, req.workspace!.timezone);
  await audit(req, { workspaceId: setup.workspaceId, action: 'reminder.activated', targetType: 'reminder', targetId: setup.id as string, metadata: { category: setup.category, name: setup.name } });
  res.json({ setup: await full(setup) });
});

reminderRouter.post('/setups/:setupId/pause', requirePermission('campaigns:manage'), async (req, res) => {
  const setup = await loadSetup(req);
  if (setup.status === 'active') {
    setup.status = 'paused';
    await setup.save();
    await ReminderRecord.updateMany({ workspaceId: setup.workspaceId, setupId: setup._id }, { nextRunAt: null });
    await audit(req, { workspaceId: setup.workspaceId, action: 'reminder.paused', targetType: 'reminder', targetId: setup.id as string, metadata: { name: setup.name } });
    changed(req);
  }
  res.json({ setup: await full(setup) });
});

reminderRouter.delete('/setups/:setupId', requirePermission('campaigns:manage'), async (req, res) => {
  const setup = await loadSetup(req);
  await ReminderRecord.deleteMany({ workspaceId: setup.workspaceId, setupId: setup._id });
  await ReminderSend.deleteMany({ workspaceId: setup.workspaceId, setupId: setup._id });
  await ReminderSetup.deleteOne({ _id: setup._id, workspaceId: setup.workspaceId });
  await audit(req, { workspaceId: setup.workspaceId, action: 'reminder.deleted', targetType: 'reminder', targetId: setup.id as string, metadata: { category: setup.category, name: setup.name } });
  changed(req);
  res.status(204).end();
});

/** The message as a chosen (or the next) contact would get it, and the facts shown before activation. */
reminderRouter.get('/setups/:setupId/preview', requirePermission('workspace:read'), async (req, res) => {
  const setup = await loadSetup(req);
  const workspace = req.workspace!;
  const scope = { workspaceId: setup.workspaceId, setupId: setup._id };
  const records = req.query.recordId ? [await ReminderRecord.findOne({ _id: objectId(req.query.recordId, 'Contact'), ...scope })] : await ReminderRecord.find({ ...scope, status: { $ne: 'paused' } }).limit(500);
  const now = new Date();
  // The earliest reminder across contacts, as it would be if the setup were live.
  let best: { record: ReminderRecordDoc; run: NonNullable<ReturnType<typeof upcomingRun>> } | null = null;
  for (const record of records) {
    if (!record) continue;
    const run = upcomingRun(setup, record, workspace.timezone, now);
    if (run && (!best || run.runAt < best.run.runAt)) best = { record, run };
  }
  const record = best?.record ?? records[0] ?? null;
  const values = record ? valuesFor(setup, record, workspace, { date: best?.run.occurrence ?? record.eventDate, cycle: best?.run.cycle ?? 0 }, best?.run.runAt ?? now) : exampleValues(setup, workspace);
  const specs = { header: setup.headerVariables, body: setup.bodyVariables, buttons: setup.buttonVariables } as unknown as Record<'header' | 'body' | 'buttons', ReminderVariable[]>;
  const template = setup.templateId ? await MessageTemplate.findOne({ _id: setup.templateId, workspaceId: setup.workspaceId }) : null;
  const header = resolveVariables(specs.header, values);
  const body = resolveVariables(specs.body, values);
  const buttons = resolveVariables(specs.buttons, values);
  res.json({
    values,
    headerParams: header.values,
    bodyParams: body.values,
    buttonParams: buttons.values,
    missing: [...new Set([...header.missing, ...body.missing, ...buttons.missing])],
    record: record ? { id: record.id as string, name: record.name, phone: record.phoneE164 } : null,
    requirements: template ? sendRequirements(template.components as TemplateComponent[]) : null,
    nextRunAt: best?.run.runAt ?? null,
    contacts: await ReminderRecord.countDocuments(scope),
  });
});

// ---- Contacts (records) ----

function publicRecord(setup: ReminderSetupDoc, r: ReminderRecordDoc) {
  return {
    id: r.id as string,
    phone: r.phoneE164,
    name: r.name ?? '',
    eventDate: r.eventDate,
    eventDateLabel: formatDate(r.eventDate),
    eventTime: r.eventTime ?? null,
    eventTimeLabel: formatTime(r.eventTime ?? null) || null,
    fields: (r.fields ?? {}) as Record<string, string>,
    endDate: r.endDate ?? null,
    maxCycles: r.maxCycles ?? null,
    recurrence: r.recurrence ?? null,
    doneThrough: r.doneThrough ?? null,
    // A record cannot be due while its setup is a draft or paused.
    status: r.status === 'active' && setup.status !== 'active' ? 'waiting' : r.status,
    nextRunAt: r.nextRunAt,
    nextOccurrence: r.nextOccurrence,
    nextRuleId: r.nextRuleId,
    source: r.source,
    createdAt: r.createdAt,
  };
}

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'paused', 'completed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
});
const PAGE = 25;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

reminderRouter.get('/setups/:setupId/records', requirePermission('workspace:read'), async (req, res) => {
  const { q, status, page } = parse(listSchema, req.query);
  const setup = await loadSetup(req);
  const digits = (q ?? '').replace(/\D/g, '');
  const filter = {
    workspaceId: setup.workspaceId,
    setupId: setup._id,
    ...(status ? { status } : {}),
    ...(q ? { $or: [{ name: { $regex: escape(q), $options: 'i' } }, ...(digits.length >= 3 ? [{ phoneE164: { $regex: digits } }] : [])] } : {}),
  };
  const [items, total] = await Promise.all([
    ReminderRecord.find(filter)
      .sort({ nextOccurrence: 1, _id: 1 })
      .skip((page - 1) * PAGE)
      .limit(PAGE),
    ReminderRecord.countDocuments(filter),
  ]);
  res.json({ records: items.map((r) => publicRecord(setup, r)), total, page, pages: Math.max(1, Math.ceil(total / PAGE)) });
});

const recordSchema = z.object({
  phone: z.string().trim().max(40).default(''),
  name: z.string().max(120).default(''),
  date: z.string().trim().max(40).default(''),
  time: z.string().trim().max(20).default(''),
  fields: z.record(z.string(), z.string().max(500)).default({}),
  endDate: z.string().trim().max(40).nullable().optional(),
  maxCycles: z.number().int().min(1).max(1000).nullable().optional(),
  recurrence: z.enum(RECURRENCES).nullable().optional(),
});

async function fill(req: Request, setup: ReminderSetupDoc, record: ReminderRecordDoc) {
  const input = parse(recordSchema, req.body);
  const parsed = parseRecord(setup, req.workspace!, input);
  if ('errors' in parsed) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', parsed.errors);
  if (input.recurrence && !(categoryOf(setup.category).recurrences as readonly string[]).includes(input.recurrence)) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { recurrence: ['This repeat is not available here.'] });
  record.set({ ...parsed.value, maxCycles: input.maxCycles ?? null, recurrence: input.recurrence ?? null, identity: identityOf(setup, parsed.value) });
  record.markModified('fields');
  applySchedule(setup, record, req.workspace!.timezone);
  try {
    await record.save();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('RECORD_EXISTS', 'This event is already in the list for this contact.');
    throw err;
  }
  changed(req);
}

reminderRouter.post('/setups/:setupId/records', requirePermission('campaigns:manage'), async (req, res) => {
  await assertReminderAccess(req.workspace!);
  const setup = await loadSetup(req);
  const record = new ReminderRecord({ workspaceId: setup.workspaceId, setupId: setup._id, createdBy: req.user!._id, phoneE164: '-', eventDate: '-', identity: '-' });
  await fill(req, setup, record);
  res.status(201).json({ record: publicRecord(setup, record) });
});

reminderRouter.put('/setups/:setupId/records/:recordId', requirePermission('campaigns:manage'), async (req, res) => {
  const setup = await loadSetup(req);
  const record = await loadRecord(req, setup);
  await fill(req, setup, record);
  res.json({ record: publicRecord(setup, record) });
});

reminderRouter.post('/setups/:setupId/records/:recordId/:action', requirePermission('campaigns:manage'), async (req, res, next) => {
  const action = req.params.action;
  if (action !== 'pause' && action !== 'resume' && action !== 'done') return next();
  const setup = await loadSetup(req);
  const record = await loadRecord(req, setup);
  if (action === 'pause') record.status = 'paused';
  if (action === 'resume') record.status = 'active';
  if (action === 'done') {
    // Paid/renewed/completed: stop reminders of the current cycle; repeating records move to the next one.
    const { date } = parse(z.object({ date: z.string().optional() }), req.body ?? {});
    const last = await ReminderSend.findOne({ workspaceId: setup.workspaceId, recordId: record._id }).sort({ occurrence: -1 }).lean();
    const run = upcomingRun(setup, record, req.workspace!.timezone);
    const sentOccurrence = last?.occurrence.slice(0, 10) ?? null;
    // Already reminded about a date: that one is done. Otherwise the upcoming one is.
    const target = date && isRealDate(date) ? date : sentOccurrence && (!record.doneThrough || sentOccurrence > record.doneThrough) ? sentOccurrence : (run?.occurrence.slice(0, 10) ?? record.eventDate);
    record.doneThrough = target;
    record.status = 'active';
  }
  applySchedule(setup, record, req.workspace!.timezone);
  await record.save();
  changed(req);
  res.json({ record: publicRecord(setup, record) });
});

reminderRouter.post('/setups/:setupId/records-bulk', requirePermission('campaigns:manage'), async (req, res) => {
  const { ids, action } = parse(z.object({ ids: z.array(z.string()).min(1).max(500), action: z.enum(['pause', 'resume', 'delete']) }), req.body);
  const setup = await loadSetup(req);
  const filter = { workspaceId: setup.workspaceId, setupId: setup._id, _id: { $in: ids.map((id) => objectId(id, 'Contact')) } };
  if (action === 'delete') await ReminderRecord.deleteMany(filter);
  else
    for (const record of await ReminderRecord.find(filter)) {
      record.status = action === 'pause' ? 'paused' : 'active';
      applySchedule(setup, record, req.workspace!.timezone);
      await record.save();
    }
  changed(req);
  res.json({ ok: true });
});

reminderRouter.delete('/setups/:setupId/records/:recordId', requirePermission('campaigns:manage'), async (req, res) => {
  const setup = await loadSetup(req);
  const record = await loadRecord(req, setup);
  await ReminderRecord.deleteOne({ _id: record._id, workspaceId: setup.workspaceId });
  changed(req);
  res.status(204).end();
});

reminderRouter.post('/setups/:setupId/import', requirePermission('contacts:import'), async (req, res) => {
  await assertReminderAccess(req.workspace!);
  const input = parse(importSchema, req.body);
  const setup = await loadSetup(req);
  const report = await importRecords(setup, req.workspace!, req.user!._id as Types.ObjectId, input);
  if (!input.dryRun) {
    await audit(req, { workspaceId: setup.workspaceId, action: 'reminder.contacts_imported', targetType: 'reminder', targetId: setup.id as string, metadata: { created: report.created, updated: report.updated, invalid: report.invalid.length } });
    changed(req);
  }
  res.json({ report });
});

// ---- Log ----

const logSchema = z.object({ status: z.enum(['upcoming', ...SEND_STATUSES]).optional(), page: z.coerce.number().int().min(1).default(1) });

reminderRouter.get('/setups/:setupId/logs', requirePermission('workspace:read'), async (req, res) => {
  const { status, page } = parse(logSchema, req.query);
  const setup = await loadSetup(req);
  const scope = { workspaceId: setup.workspaceId, setupId: setup._id };
  const counts = (await setupCounts(setup.workspaceId, [setup._id])).get(setup.id as string) ?? EMPTY;
  const upcomingFilter = { ...scope, status: 'active', nextRunAt: { $ne: null } };
  const upcoming = await ReminderRecord.countDocuments(upcomingFilter);
  if (status === 'upcoming') {
    const items = await ReminderRecord.find(upcomingFilter)
      .sort({ nextRunAt: 1 })
      .skip((page - 1) * PAGE)
      .limit(PAGE);
    return void res.json({
      logs: items.map((r) => ({ id: r.id as string, name: r.name, phone: r.phoneE164, status: 'upcoming', ruleId: r.nextRuleId, occurrence: r.nextOccurrence, scheduledFor: r.nextRunAt, sentAt: null, delivery: null, error: null, attempts: 0, nextAttemptAt: null, retryable: false })),
      total: upcoming,
      page,
      pages: Math.max(1, Math.ceil(upcoming / PAGE)),
      counts: { ...counts, upcoming },
    });
  }
  const filter = { ...scope, ...(status ? { status } : {}) };
  const [rows, total] = await Promise.all([
    ReminderSend.find(filter)
      .sort({ scheduledFor: -1, _id: -1 })
      .skip((page - 1) * PAGE)
      .limit(PAGE)
      .lean(),
    ReminderSend.countDocuments(filter),
  ]);
  const messages = new Map((await Message.find({ workspaceId: setup.workspaceId, _id: { $in: rows.flatMap((r) => (r.messageId ? [r.messageId] : [])) } }).select('status error').lean()).map((m) => [m._id.toString(), m]));
  res.json({
    logs: rows.map((r) => {
      const m = r.messageId ? messages.get(r.messageId.toString()) : undefined;
      const deliveryFailed = r.status === 'sent' && m?.status === 'failed';
      const err = deliveryFailed ? ((m?.error as { message?: string; title?: string } | null)?.message || (m?.error as { title?: string } | null)?.title || 'WhatsApp could not deliver this message.') : r.error;
      return {
        id: r._id.toString(),
        name: r.name,
        phone: r.phoneE164,
        status: deliveryFailed ? 'failed' : r.status,
        ruleId: r.ruleId,
        occurrence: r.occurrence,
        scheduledFor: r.scheduledFor,
        sentAt: r.sentAt,
        delivery: r.status === 'sent' ? (m?.status ?? null) : null,
        error: err ?? null,
        attempts: r.attempts,
        nextAttemptAt: r.status === 'pending' ? r.nextAttemptAt : null,
        retryable: deliveryFailed || r.status === 'failed',
      };
    }),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE)),
    counts: { ...counts, upcoming },
  });
});

/** Sends a failed reminder again, on request. */
reminderRouter.post('/setups/:setupId/logs/:logId/retry', requirePermission('campaigns:manage'), async (req, res) => {
  const setup = await loadSetup(req);
  const row = await ReminderSend.findOne({ _id: objectId(req.params.logId, 'Reminder'), workspaceId: setup.workspaceId, setupId: setup._id });
  if (!row) throw notFound('Reminder not found.');
  const message = row.messageId ? await Message.findOne({ _id: row.messageId, workspaceId: setup.workspaceId }).select('status').lean() : null;
  if (row.status !== 'failed' && !(row.status === 'sent' && message?.status === 'failed')) throw new AppError(409, 'NOT_RETRYABLE', 'Only failed reminders can be sent again.');
  if (setup.status !== 'active') throw conflict('REMINDER_PAUSED', 'Resume this reminder first.');
  const now = new Date();
  row.set({ status: 'pending', errorCode: null, error: null, nextAttemptAt: now, expiresAt: new Date(now.getTime() + 60 * 60_000) });
  await row.save();
  changed(req);
  res.json({ ok: true });
});

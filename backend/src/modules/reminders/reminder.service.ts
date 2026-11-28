import { Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { enqueue } from '../../jobs/queue.js';
import { publish } from '../../realtime/bus.js';
import { consume, hasAccess, refund } from '../billing/billing.service.js';
import { Contact } from '../contacts/contact.model.js';
import { findOrCreateContact } from '../contacts/contact.service.js';
import { messagePreview, recordOutboundOnConversation } from '../inbox/conversation.service.js';
import { Message } from '../messages/message.model.js';
import { buildTemplateContent } from '../messages/message.service.js';
import { MessageTemplate, type TemplateDoc } from '../templates/template.model.js';
import { checkSendValues, sendRequirements, type TemplateExtras } from '../templates/templateSend.js';
import { getConnection } from '../whatsapp/connection.service.js';
import type { TemplateComponent } from '../whatsapp/provider/types.js';
import { Workspace, type WorkspaceDoc } from '../workspaces/workspace.model.js';
import { COMMON_VARIABLES, categoryOf, type CategoryField, type Recurrence, type ReminderRule } from './categories.js';
import { ReminderRecord, ReminderSend, ReminderSetup, type ReminderRecordDoc, type ReminderSendDoc, type ReminderSetupDoc } from './reminder.model.js';
import { NO_YEAR, daysBetween, formatDate, formatTime, localDate, nextRun, runsBetween, zonedToUtc, type Run, type ScheduleInput } from './schedule.js';

export interface ReminderVariable {
  source: 'field' | 'static';
  value: string;
  fallback?: string | null;
}

const RETRY_MS = 5 * 60_000;
const TICK_LIMIT = 500;

/** A setup's own fields: the category's, plus the ones a custom event defines. */
export function fieldsOf(setup: Pick<ReminderSetupDoc, 'category' | 'extraFields'>): CategoryField[] {
  return [...categoryOf(setup.category).fields, ...setup.extraFields.map((f) => ({ key: f.key, label: f.label, type: 'text' as const, example: f.label }))];
}

/** Every value that can be placed in this setup's message. */
export function variablesOf(setup: Pick<ReminderSetupDoc, 'category' | 'extraFields' | 'eventLabel'>) {
  const c = categoryOf(setup.category);
  const own = fieldsOf(setup).map((f) => ({ key: f.key, label: f.label, example: f.example }));
  const common = COMMON_VARIABLES.filter((v) => (v.key !== 'time' || c.dateKind === 'datetime') && (v.key !== 'cycle_number' || c.recurrences.length > 1 || c.defaultRecurrence !== 'none')).map((v) => ({ ...v, label: v.key === 'date' ? (setup.eventLabel ?? c.dateLabel) : v.key === 'name' ? `${c.person} name` : v.label }));
  return [...common.slice(0, 3), ...own, ...common.slice(3)];
}

export function scheduleOf(setup: ReminderSetupDoc, record: Pick<ReminderRecordDoc, 'eventDate' | 'eventTime' | 'recurrence' | 'endDate' | 'maxCycles' | 'doneThrough'>, timeZone: string): ScheduleInput {
  return {
    eventDate: record.eventDate,
    eventTime: record.eventTime ?? null,
    recurrence: (record.recurrence ?? setup.recurrence) as Recurrence,
    everyDays: setup.everyDays,
    sendTime: setup.sendTime,
    rules: setup.rules.map((r) => ({ when: r.when, value: r.value, unit: r.unit })) as ReminderRule[],
    endDate: record.endDate ?? null,
    maxCycles: record.maxCycles ?? null,
    doneThrough: record.doneThrough ?? null,
    timeZone,
  };
}

/** Where scheduling starts from: never the past, except (opt-in) earlier today. */
function scheduleFrom(setup: ReminderSetupDoc, timeZone: string, now: Date): { from: Date; inclusive: boolean } {
  return setup.sendMissedToday ? { from: zonedToUtc(localDate(now, timeZone), '00:00', timeZone), inclusive: true } : { from: now, inclusive: false };
}

/** The next reminder of a record as if its setup were live (also used for previews before activation). */
export function upcomingRun(setup: ReminderSetupDoc, record: ReminderRecordDoc, timeZone: string, now = new Date()): Run | null {
  if (record.status === 'paused') return null;
  return nextRun(scheduleOf(setup, record, timeZone), now);
}

function nextFields(run: Run | null, live: boolean) {
  return { nextRunAt: live ? (run?.runAt ?? null) : null, nextOccurrence: run?.occurrence ?? null, nextRuleId: run?.ruleId ?? null };
}

/** Recalculates one record's next reminder after it, or its setup, changed. */
export function applySchedule(setup: ReminderSetupDoc, record: ReminderRecordDoc, timeZone: string, now = new Date()): void {
  if (record.status === 'paused') {
    record.set(nextFields(null, false));
    return;
  }
  const { from, inclusive } = scheduleFrom(setup, timeZone, now);
  const run = nextRun(scheduleOf(setup, record, timeZone), from, inclusive);
  record.status = run ? 'active' : 'completed';
  record.set(nextFields(run, setup.status === 'active'));
}

export async function rescheduleSetup(setup: ReminderSetupDoc, timeZone: string, now = new Date()): Promise<void> {
  const cursor = ReminderRecord.find({ workspaceId: setup.workspaceId, setupId: setup._id }).cursor();
  let ops: Parameters<typeof ReminderRecord.bulkWrite>[0] = [];
  const flush = async () => {
    if (ops.length) await ReminderRecord.bulkWrite(ops);
    ops = [];
  };
  for await (const record of cursor) {
    applySchedule(setup, record, timeZone, now);
    ops.push({
      updateOne: {
        filter: { _id: record._id, workspaceId: setup.workspaceId },
        update: { $set: { status: record.status, nextRunAt: record.nextRunAt, nextOccurrence: record.nextOccurrence, nextRuleId: record.nextRuleId } },
      },
    });
    if (ops.length >= 500) await flush();
  }
  await flush();
  publish(setup.workspaceId.toString(), { type: 'reminders.changed' });
}

/** The workspace timezone changed: every reminder moves to the same wall-clock time in the new zone. */
export async function rescheduleWorkspace(workspace: WorkspaceDoc): Promise<void> {
  for (const setup of await ReminderSetup.find({ workspaceId: workspace._id })) await rescheduleSetup(setup, workspace.timezone);
}

/** Phone + identifying values: the same event of the same person is one record. */
export function identityOf(setup: Pick<ReminderSetupDoc, 'category'>, r: { phoneE164: string; name: string; eventDate: string; eventTime: string | null; fields: Record<string, string> }): string {
  const value = (key: string) => (key === 'name' ? r.name : key === 'date' ? r.eventDate : key === 'time' ? (r.eventTime ?? '') : (r.fields[key] ?? '')).trim().toLowerCase();
  const parts = categoryOf(setup.category).identity.map(value);
  // Nothing identifying was given: fall back to the date.
  if (parts.every((p) => !p)) parts.push(r.eventDate);
  return [r.phoneE164, ...parts].join('|').slice(0, 400);
}

// ---- Message values ----

export function valuesFor(setup: ReminderSetupDoc, record: Pick<ReminderRecordDoc, 'name' | 'phoneE164' | 'eventDate' | 'eventTime' | 'fields'>, workspace: Pick<WorkspaceDoc, 'name' | 'timezone'>, occurrence: { date: string; cycle: number }, now = new Date()): Record<string, string> {
  const eventYear = Number(record.eventDate.slice(0, 4));
  const date = occurrence.date.slice(0, 10);
  return {
    ...(record.fields as Record<string, string>),
    name: record.name ?? '',
    first_name: (record.name ?? '').split(/\s+/)[0] ?? '',
    date: formatDate(date),
    time: formatTime(record.eventTime ?? null),
    days_left: String(Math.max(0, daysBetween(localDate(now, workspace.timezone), date))),
    business_name: workspace.name,
    phone: record.phoneE164,
    cycle_number: String(occurrence.cycle + 1),
    years: eventYear === NO_YEAR ? '' : String(Math.max(0, Number(date.slice(0, 4)) - eventYear)),
  };
}

/** Example values for previews before any contact was added. */
export function exampleValues(setup: ReminderSetupDoc, workspace: Pick<WorkspaceDoc, 'name'>): Record<string, string> {
  return { ...Object.fromEntries(variablesOf(setup).map((v) => [v.key, v.example])), business_name: workspace.name };
}

export function resolveVariables(specs: ReminderVariable[], values: Record<string, string>): { values: string[]; missing: string[] } {
  const missing: string[] = [];
  const out = specs.map((s) => {
    const raw = s.source === 'static' ? s.value : (values[s.value] ?? '');
    const v = raw.trim() || (s.fallback ?? '').trim();
    if (!v) missing.push(s.source === 'field' ? s.value : 'text');
    return v;
  });
  return { values: out, missing };
}

const specsOf = (s: ReminderSetupDoc) => ({
  header: s.headerVariables as unknown as ReminderVariable[],
  body: s.bodyVariables as unknown as ReminderVariable[],
  buttons: s.buttonVariables as unknown as ReminderVariable[],
});

/** What is still missing before a setup can go live; empty when it is ready. */
export async function readiness(setup: ReminderSetupDoc): Promise<Record<string, string[]>> {
  const details: Record<string, string[]> = {};
  if (!setup.rules.length) details.rules = ['Choose when the reminder is sent.'];
  if (setup.category === 'custom' && !setup.eventLabel?.trim()) details.eventLabel = ['Name this event.'];
  const template = setup.templateId ? await MessageTemplate.findOne({ _id: setup.templateId, workspaceId: setup.workspaceId }) : null;
  if (!template) details.templateId = ['Choose a template.'];
  else if (template.status !== 'APPROVED') details.templateId = [`Template "${template.name}" is ${template.status.toLowerCase().replace(/_/g, ' ')}, not approved.`];
  else {
    const req = sendRequirements(template.components as TemplateComponent[]);
    const known = new Set(variablesOf(setup).map((v) => v.key));
    const check = (key: 'headerVariables' | 'bodyVariables' | 'buttonVariables', n: number) => {
      const specs = setup[key];
      if (specs.length !== n) {
        details[key] = [`Fill in ${n} value${n === 1 ? '' : 's'}.`];
        return;
      }
      specs.forEach((s, i) => {
        if (s.source === 'field' && !known.has(s.value)) details[key] = [`Value ${i + 1}: choose what to insert.`];
        if (s.source === 'static' && !s.value.trim()) details[key] = [`Value ${i + 1}: type the text to send.`];
      });
    };
    check('headerVariables', req.header);
    check('bodyVariables', req.body);
    check('buttonVariables', req.buttons.length);
    const fill = (n: number) => Array<string>(n).fill('x');
    Object.assign(details, checkSendValues(req, { headerParams: fill(req.header), bodyParams: fill(req.body), buttonParams: fill(req.buttons.length), extras: (setup.templateExtras ?? {}) as TemplateExtras }));
  }
  return details;
}

// ---- Sending ----

/**
 * Repeating job. 1) turns due records into log rows (one per event + person + rule, ever),
 * 2) sends rows that are ready, including ones waiting for a retry.
 */
export async function tickReminders(now = new Date()): Promise<{ due: number; sent: number }> {
  const due = await ReminderRecord.find({ status: 'active', nextRunAt: { $ne: null, $lte: now } })
    .setOptions({ skipTenantScope: true })
    .sort({ nextRunAt: 1 })
    .limit(TICK_LIMIT);
  const setups = new Map<string, ReminderSetupDoc | null>();
  const workspaces = new Map<string, WorkspaceDoc | null>();
  const changed = new Set<string>();

  for (const record of due) {
    try {
      const key = record.setupId.toString();
      if (!setups.has(key)) setups.set(key, await ReminderSetup.findOne({ _id: record.setupId, workspaceId: record.workspaceId }));
      const wsKey = record.workspaceId.toString();
      if (!workspaces.has(wsKey)) workspaces.set(wsKey, await Workspace.findById(record.workspaceId));
      const setup = setups.get(key);
      const workspace = workspaces.get(wsKey);
      if (!setup || setup.status !== 'active' || !workspace) {
        await ReminderRecord.updateOne({ _id: record._id, workspaceId: record.workspaceId }, { nextRunAt: null });
        continue;
      }
      await collect(setup, record, workspace.timezone, now);
      changed.add(wsKey);
    } catch (err) {
      logger.error({ err, recordId: record.id as string }, 'Could not schedule a reminder');
    }
  }

  let sent = 0;
  for (;;) {
    const row = await ReminderSend.findOneAndUpdate(
      { status: 'pending', nextAttemptAt: { $lte: now } },
      // Claimed: if this process dies, the row becomes due again later (the message itself is idempotent).
      { $set: { nextAttemptAt: new Date(now.getTime() + 2 * RETRY_MS) }, $inc: { attempts: 1 } },
      { new: true, sort: { scheduledFor: 1 } },
    ).setOptions({ skipTenantScope: true });
    if (!row) break;
    changed.add(row.workspaceId.toString());
    try {
      if (await sendReminder(row, now)) sent++;
    } catch (err) {
      logger.error({ err, sendId: row.id as string }, 'Reminder send failed');
      await settle(row, { status: 'pending', errorCode: 'UNEXPECTED', error: 'Something went wrong while sending. Trying again shortly.', nextAttemptAt: new Date(now.getTime() + RETRY_MS) });
    }
  }
  for (const id of changed) publish(id, { type: 'reminders.changed' });
  return { due: due.length, sent };
}

/** Logs every reminder of this record that became due and moves it to its next one. */
async function collect(setup: ReminderSetupDoc, record: ReminderRecordDoc, timeZone: string, now: Date) {
  const schedule = scheduleOf(setup, record, timeZone);
  for (const run of runsBetween(schedule, record.nextRunAt!, now)) {
    const missed = run.expiresAt <= now;
    try {
      await ReminderSend.create({
        workspaceId: record.workspaceId,
        setupId: setup._id,
        recordId: record._id,
        dedupeKey: `${setup.id as string}:${record.identity}:${run.ruleId}:${run.occurrence}`,
        phoneE164: record.phoneE164,
        name: record.name,
        ruleId: run.ruleId,
        occurrence: run.occurrence,
        cycle: run.cycle,
        scheduledFor: run.runAt,
        expiresAt: run.expiresAt,
        status: missed ? 'skipped' : 'pending',
        nextAttemptAt: missed ? null : now,
        ...(missed ? { errorCode: 'MISSED', error: 'The send time had already passed, so this reminder was not sent late.' } : {}),
      });
    } catch (err) {
      // Already logged: this reminder was handled before.
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  const next = nextRun(schedule, now);
  await ReminderRecord.updateOne(
    { _id: record._id, workspaceId: record.workspaceId, nextRunAt: record.nextRunAt },
    { $set: { ...nextFields(next, true), ...(next ? {} : { status: 'completed' }) } },
  );
}

async function settle(row: ReminderSendDoc, set: Record<string, unknown>) {
  await ReminderSend.updateOne({ _id: row._id, workspaceId: row.workspaceId }, { $set: set });
}

async function sendReminder(row: ReminderSendDoc, now: Date): Promise<boolean> {
  const workspaceId = row.workspaceId;
  const done = (status: 'failed' | 'skipped', errorCode: string, error: string) => settle(row, { status, errorCode, error, nextAttemptAt: null });
  /** A problem the business can fix: keep trying until the reminder would be too late. */
  const later = (errorCode: string, error: string) => {
    const at = new Date(now.getTime() + RETRY_MS);
    return at >= row.expiresAt ? done('failed', errorCode, error) : settle(row, { status: 'pending', errorCode, error, nextAttemptAt: at });
  };

  if (row.expiresAt <= now) {
    await done(row.errorCode ? 'failed' : 'skipped', row.errorCode ?? 'MISSED', row.error ?? 'The send time had already passed, so this reminder was not sent late.');
    return false;
  }
  const [setup, record, workspace] = await Promise.all([
    ReminderSetup.findOne({ _id: row.setupId, workspaceId }),
    ReminderRecord.findOne({ _id: row.recordId, workspaceId }),
    Workspace.findById(workspaceId),
  ]);
  if (!setup || !workspace || !record) return (await done('skipped', 'REMOVED', 'This contact or reminder was deleted before sending.'), false);
  if (setup.status !== 'active') return (await done('skipped', 'PAUSED', 'The reminder was paused at the send time.'), false);
  if (record.status === 'paused') return (await done('skipped', 'PAUSED', 'This contact was paused at the send time.'), false);
  if (record.doneThrough && row.occurrence.slice(0, 10) <= record.doneThrough) return (await done('skipped', 'DONE', `Already marked ${(categoryOf(setup.category).doneLabel ?? 'done').toLowerCase()}.`), false);
  if (workspace.status === 'suspended') return (await later('WORKSPACE_SUSPENDED', 'This workspace is suspended.'), false);
  if (!(await hasAccess(workspaceId))) return (await later('SUBSCRIPTION_INACTIVE', 'Sending is paused because the subscription is not active.'), false);
  const conn = await getConnection(workspaceId);
  if (!conn || conn.status !== 'connected') return (await later('WHATSAPP_NOT_CONNECTED', conn ? 'The WhatsApp connection needs attention. Reconnect it and the reminder will be sent.' : 'No WhatsApp number is connected.'), false);
  const template: TemplateDoc | null = setup.templateId ? await MessageTemplate.findOne({ _id: setup.templateId, workspaceId }) : null;
  if (!template) return (await later('TEMPLATE_MISSING', 'The template was deleted. Choose another one.'), false);
  if (template.status !== 'APPROVED') return (await later('TEMPLATE_NOT_APPROVED', `Template "${template.name}" is ${template.status.toLowerCase().replace(/_/g, ' ')} on WhatsApp.`), false);

  const values = valuesFor(setup, record, workspace, { date: row.occurrence, cycle: row.cycle }, now);
  const specs = specsOf(setup);
  const resolved = { header: resolveVariables(specs.header, values), body: resolveVariables(specs.body, values), buttons: resolveVariables(specs.buttons, values) };
  const missing = [...resolved.header.missing, ...resolved.body.missing, ...resolved.buttons.missing];
  if (missing.length) {
    const labels = new Map(variablesOf(setup).map((v) => [v.key, v.label]));
    return (await done('failed', 'MISSING_VALUE', `Missing ${[...new Set(missing)].map((k) => labels.get(k) ?? k).join(', ')} for this contact. Add it, or set a fallback.`), false);
  }
  let content: Record<string, unknown>;
  try {
    content = buildTemplateContent(template, resolved.header.values, resolved.body.values, resolved.buttons.values, (setup.templateExtras ?? {}) as TemplateExtras);
  } catch (err) {
    const e = err as AppError;
    const detail = e.details ? Object.values(e.details as Record<string, string[]>)[0]?.[0] : null;
    return (await done('failed', e.code ?? 'INVALID', detail ?? e.message), false);
  }

  const contact = await findOrCreateContact(workspaceId, record.phoneE164, 'date_reminder');
  if (record.name && !contact.name) await Contact.updateOne({ _id: contact._id, workspaceId }, { name: record.name.slice(0, 120) });
  if (contact.consent?.status === 'opted_out') return (await done('skipped', 'CONTACT_OPTED_OUT', 'This contact has opted out of WhatsApp messages.'), false);
  if (contact.blocked) return (await done('skipped', 'CONTACT_BLOCKED', 'This contact is blocked.'), false);

  const idempotencyKey = row.messageId ? `reminder:${row.id as string}:${row.messageId.toString()}` : `reminder:${row.id as string}`;
  const existing = await Message.findOne({ workspaceId, idempotencyKey });
  let message = existing;
  if (!message) {
    try {
      await consume(workspaceId, 'messages');
    } catch (err) {
      const e = err as AppError;
      return (await later(e.code ?? 'PLAN_LIMIT_REACHED', e.message), false);
    }
    try {
      message = await Message.create({ workspaceId, contactId: contact._id, direction: 'outbound', type: 'template', content, status: 'queued', idempotencyKey, source: 'reminder' });
    } catch (err) {
      await refund(workspaceId, 'messages');
      if ((err as { code?: number }).code !== 11000) throw err;
      message = (await Message.findOne({ workspaceId, idempotencyKey }))!;
    }
  }
  await settle(row, { status: 'sent', messageId: message._id, sentAt: now, errorCode: null, error: null, nextAttemptAt: null });
  if (existing) return false;
  await recordOutboundOnConversation(workspaceId, contact._id, messagePreview('template', content), now);
  await enqueue('whatsapp.send', { workspaceId: workspaceId.toString(), messageId: message.id as string }, { jobId: `send-${message.id as string}` });
  return true;
}

// ---- Counts ----

export async function setupCounts(workspaceId: Types.ObjectId, setupIds: Types.ObjectId[]) {
  const [records, sends] = await Promise.all([
    ReminderRecord.aggregate<{ _id: { s: Types.ObjectId; status: string }; n: number; next: Date | null }>([
      { $match: { workspaceId, setupId: { $in: setupIds } } },
      { $group: { _id: { s: '$setupId', status: '$status' }, n: { $sum: 1 }, next: { $min: { $cond: [{ $eq: ['$nextRunAt', null] }, '$$REMOVE', '$nextRunAt'] } } } },
    ]),
    ReminderSend.aggregate<{ _id: { s: Types.ObjectId; status: string }; n: number }>([
      { $match: { workspaceId, setupId: { $in: setupIds } } },
      { $group: { _id: { s: '$setupId', status: '$status' }, n: { $sum: 1 } } },
    ]),
  ]);
  const out = new Map<string, { contacts: number; active: number; paused: number; completed: number; nextRunAt: Date | null; sent: number; pending: number; failed: number; skipped: number }>();
  const at = (id: Types.ObjectId) => {
    const key = id.toString();
    if (!out.has(key)) out.set(key, { contacts: 0, active: 0, paused: 0, completed: 0, nextRunAt: null, sent: 0, pending: 0, failed: 0, skipped: 0 });
    return out.get(key)!;
  };
  for (const r of records) {
    const c = at(r._id.s);
    c.contacts += r.n;
    c[r._id.status as 'active' | 'paused' | 'completed'] += r.n;
    if (r.next && (!c.nextRunAt || r.next < c.nextRunAt)) c.nextRunAt = r.next;
  }
  for (const r of sends) at(r._id.s)[r._id.status as 'sent' | 'pending' | 'failed' | 'skipped'] += r.n;
  return out;
}

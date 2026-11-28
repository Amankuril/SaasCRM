import { createHmac, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { enqueue } from '../../jobs/queue.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { safeRequest } from '../../lib/safeFetch.js';
import { consume, refund } from '../billing/billing.service.js';
import { Contact, type ContactDoc } from '../contacts/contact.model.js';
import { ContactList } from '../contacts/contactList.model.js';
import { isInServiceWindow } from '../contacts/contact.service.js';
import { Tag } from '../contacts/tag.model.js';
import { onDomainEvents, resetDomainInterest, type DomainEvent } from '../events/domainEvents.js';
import { Conversation } from '../inbox/conversation.model.js';
import { Message, type MessageDoc } from '../messages/message.model.js';
import { buildTemplateContent, queueOutboundMessage, type SendInput } from '../messages/message.service.js';
import { MessageTemplate } from '../templates/template.model.js';
import { sendRequirements } from '../templates/templateSend.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { Workspace, type WorkspaceDoc } from '../workspaces/workspace.model.js';
import { can, type Role } from '../roles.js';
import { compile, waitMs, type ActionStep, type Compiled, type Graph, type MessageStep, type Step } from './sequence.graph.js';
import {
  Sequence,
  SequenceEnrollment,
  SequenceEvent,
  SequenceMessage,
  SequenceVersion,
  type EnrollmentDoc,
  type ExitOutcome,
  type SequenceDoc,
} from './sequence.model.js';
import { allMatch, datedRunAt, dayOf, nextDaySendTime, nextSendTime, resolveVariable, validTimeZone, variableLabel, type ContactValues } from './sequence.rules.js';

/** Test runs: every wait is 20 seconds and the send window is ignored. */
export const TEST_WAIT_MS = 20_000;
const LEASE_MS = 5 * 60_000;
const ATTENTION_RETRY_MS = 15 * 60_000;
const DELIVERY_CHECK_MS = 10 * 60_000;
const DELIVERY_TIMEOUT_MS = 48 * 3_600_000;
const ECOSYSTEM_RETRY_MS = 4 * 3_600_000;
const MAX_STEPS_PER_RUN = 50;
/** Runs due within this window get a delayed job for the exact time; the tick is the safety net. */
const EXACT_SCHEDULE_MS = 5 * 60_000;

export type EnrollResult = 'enrolled' | 'already_in' | 'opted_out' | 'blocked' | 'filtered' | 'not_again_yet' | 'capped' | 'limit_reached' | 'not_live';

const DROPPED: ExitOutcome[] = ['stopped', 'dropped_replied', 'opted_out', 'removed', 'archived', 'delivery_failed'];

function statusFor(outcome: ExitOutcome) {
  if (outcome === 'completed' || outcome === 'completed_goal') return 'completed' as const;
  if (DROPPED.includes(outcome)) return 'dropped' as const;
  return 'error' as const;
}

function values(contact: ContactDoc | (Record<string, unknown> & { _id: Types.ObjectId })): ContactValues {
  const c = contact as ContactDoc;
  return {
    id: String(c._id),
    name: c.name ?? null,
    profileName: c.profileName ?? null,
    phoneE164: c.phoneE164,
    email: c.email ?? null,
    tags: (c.tags ?? []).map(String),
    lifecycleStage: c.lifecycleStage ?? 'new',
    customFields: (c.customFields ?? {}) as Record<string, unknown>,
  };
}

async function log(e: EnrollmentDoc, stepId: string | null, type: string, result: string, reason: string | null = null, meta: Record<string, unknown> | null = null) {
  await SequenceEvent.create({ workspaceId: e.workspaceId, sequenceId: e.sequenceId, enrollmentId: e._id, stepId, type, result, reason, meta });
}

// ---- goal & stop ----

type OutcomeRule = { type: string; tagIds?: Types.ObjectId[] | null; stages?: string[] | null };

function ruleHit(rule: OutcomeRule | null | undefined, contact: ContactValues, replied: boolean): boolean {
  if (!rule || rule.type === 'none') return false;
  if (rule.type === 'replied') return replied;
  if (rule.type === 'tag_added') return (rule.tagIds ?? []).some((t) => contact.tags.includes(String(t)));
  if (rule.type === 'lifecycle') return (rule.stages ?? []).includes(contact.lifecycleStage);
  return false;
}

/** Goal first (success), then stop conditions, then "stop when the contact replies". */
function exitFor(seq: SequenceDoc, e: EnrollmentDoc, contact: ContactDoc): { outcome: ExitOutcome; reason: string } | null {
  const v = values(contact);
  const replied = hasReplied(e, contact);
  if (ruleHit(seq.goal, v, replied)) return { outcome: 'completed_goal', reason: `Goal reached (${seq.goal!.type.replace('_', ' ')})` };
  for (const stop of seq.stopConditions ?? []) if (ruleHit(stop, v, replied)) return { outcome: 'stopped', reason: `Stop condition (${stop.type.replace('_', ' ')})` };
  if (replied && seq.rules?.stopOnReply) return { outcome: 'dropped_replied', reason: 'Contact replied' };
  return null;
}

/** Replied since joining: recorded on the reply event, or seen on the contact (seconds precision). */
function hasReplied(e: EnrollmentDoc, contact: ContactDoc): boolean {
  return !!e.repliedAt || (!!contact.lastInboundAt && contact.lastInboundAt.getTime() > e.enrolledAt.getTime() + 1000);
}

// ---- exits ----

export async function exitEnrollment(e: EnrollmentDoc, outcome: ExitOutcome, reason: string): Promise<void> {
  const done = await SequenceEnrollment.updateOne(
    { _id: e._id, workspaceId: e.workspaceId, active: true },
    { status: statusFor(outcome), outcome, active: false, exitedAt: new Date(), exitReason: reason, nextRunAt: null, lockedUntil: null, lockToken: null, attention: null },
  );
  if (done.modifiedCount) {
    e.set({ status: statusFor(outcome), outcome, active: false, exitReason: reason });
    await log(e, e.currentStepId ?? null, 'exited', outcome, reason);
  }
}

/** Ends a filter's worth of live enrollments (STOP, archive, manual remove). */
export async function exitWhere(filter: Record<string, unknown>, outcome: ExitOutcome, reason: string): Promise<number> {
  const rows = await SequenceEnrollment.find({ ...filter, active: true });
  for (const e of rows) await exitEnrollment(e, outcome, reason);
  return rows.length;
}

// ---- enroll ----

export interface EnrollOptions {
  via: string;
  data?: Record<string, unknown>;
  /** Date / inactivity triggers: one run per occurrence instead of "join only once". */
  occurrence?: string;
  /** Test run: draft steps, own number, 20 s waits, never counted. */
  test?: { graph: Graph };
}

export async function enroll(seq: SequenceDoc, contact: ContactDoc, opts: EnrollOptions): Promise<{ result: EnrollResult; enrollment?: EnrollmentDoc }> {
  const workspaceId = seq.workspaceId;
  if (!opts.test && (seq.status !== 'active' || !seq.liveVersionId)) return { result: 'not_live' };
  if (contact.consent?.status === 'opted_out') return { result: 'opted_out' };
  if (contact.blocked) return { result: 'blocked' };
  const data = { ...(opts.data ?? {}) };

  if (!opts.test) {
    const ctx = { contact: values(contact), data, stepId: 'entry', lastMessage: null, replied: false, lastReplyText: '' };
    if (!allMatch((seq.entryFilter ?? []) as never, ctx)) return { result: 'filtered' };
    if (await SequenceEnrollment.exists({ workspaceId, sequenceId: seq._id, contactId: contact._id, active: true, test: false })) return { result: 'already_in' };
    if (opts.occurrence && (await SequenceEnrollment.exists({ workspaceId, sequenceId: seq._id, contactId: contact._id, occurrence: opts.occurrence, test: false }))) return { result: 'already_in' };
    const last = await SequenceEnrollment.findOne({ workspaceId, sequenceId: seq._id, contactId: contact._id, test: false }).sort({ enrolledAt: -1 }).lean();
    if (last) {
      if (seq.rules?.joinOnce !== false && !opts.occurrence) return { result: 'not_again_yet' };
      const coolDown = (seq.rules?.reentryDays ?? 0) * 86_400_000;
      if (last.exitedAt && Date.now() - last.exitedAt.getTime() < coolDown) return { result: 'not_again_yet' };
    }
    if (seq.rules?.maxEnrollments) {
      const total = await SequenceEnrollment.countDocuments({ workspaceId, sequenceId: seq._id, test: false });
      if (total >= seq.rules.maxEnrollments) return { result: 'capped' };
    }
    try {
      await consume(workspaceId, 'sequence_contacts');
    } catch (err) {
      if ((err as AppError).code === 'PLAN_LIMIT_REACHED' || (err as AppError).code === 'SUBSCRIPTION_INACTIVE') return { result: 'limit_reached' };
      throw err;
    }
  }

  const graph = opts.test ? opts.test.graph : ((await SequenceVersion.findOne({ _id: seq.liveVersionId, workspaceId }).lean())?.graph as Graph | undefined);
  const first = graph ? compile(graph).first : null;
  let enrollment: EnrollmentDoc;
  try {
    enrollment = await SequenceEnrollment.create({
      workspaceId,
      sequenceId: seq._id,
      versionId: opts.test ? null : seq.liveVersionId,
      contactId: contact._id,
      test: !!opts.test,
      active: true,
      testGraph: opts.test ? opts.test.graph : null,
      joinedVia: opts.via,
      occurrence: opts.occurrence ?? null,
      currentStepId: first,
      nextRunAt: new Date(),
      data,
    });
  } catch (err) {
    if (!opts.test) await refund(workspaceId, 'sequence_contacts');
    if ((err as { code?: number }).code === 11000) return { result: 'already_in' };
    throw err;
  }
  await log(enrollment, null, 'enrolled', 'joined', `Joined via ${opts.via}`, Object.keys(data).length ? { data } : null);
  await kick(enrollment);
  return { result: 'enrolled', enrollment };
}

/** Runs it now (or schedules the exact time if soon). */
async function kick(e: { _id: Types.ObjectId; workspaceId: Types.ObjectId; nextRunAt?: Date | null }) {
  if (!e.nextRunAt) return;
  const delay = e.nextRunAt.getTime() - Date.now();
  if (delay > EXACT_SCHEDULE_MS) return;
  await enqueue('sequence.run', { workspaceId: String(e.workspaceId), enrollmentId: String(e._id) }, { delayMs: Math.max(0, delay), jobId: `seqrun-${e._id}-${e.nextRunAt.getTime()}` }).catch((err) =>
    logger.warn({ err, enrollmentId: String(e._id) }, 'Could not schedule sequence run'),
  );
}

// ---- scheduler ----

/**
 * Every 30 s: leases due enrollments of live sequences (and test runs) in batches
 * and hands each to a worker job. A lease that is never released (crash) expires
 * after 5 minutes and the row is picked up again; sends are idempotent per step.
 */
export async function tickSequences(now = new Date(), budgetMs = 20_000): Promise<number> {
  const started = Date.now();
  const live = await Sequence.find({ status: 'active' }).select('_id').setOptions({ skipTenantScope: true }).lean();
  const liveIds = live.map((s) => s._id);
  let total = 0;
  while (Date.now() - started < budgetMs) {
    const due = await SequenceEnrollment.find({
      status: { $in: ['in_progress', 'needs_attention'] },
      nextRunAt: { $lte: now },
      $and: [{ $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] }, { $or: [{ test: true }, { sequenceId: { $in: liveIds } }] }],
    })
      .select('_id workspaceId')
      .sort({ nextRunAt: 1 })
      .limit(500)
      .setOptions({ skipTenantScope: true })
      .lean();
    if (!due.length) break;
    const token = randomBytes(8).toString('hex');
    await SequenceEnrollment.updateMany(
      { _id: { $in: due.map((d) => d._id) }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
      { lockedUntil: new Date(Date.now() + LEASE_MS), lockToken: token },
    ).setOptions({ skipTenantScope: true });
    const mine = await SequenceEnrollment.find({ _id: { $in: due.map((d) => d._id) }, lockToken: token }).select('_id workspaceId').setOptions({ skipTenantScope: true }).lean();
    for (const e of mine) await enqueue('sequence.run', { workspaceId: String(e.workspaceId), enrollmentId: String(e._id), token });
    total += mine.length;
    if (due.length < 500) break;
  }
  return total;
}

/** Claims one enrollment if it is due and free (delayed jobs and kicks). */
async function claim(workspaceId: Types.ObjectId, enrollmentId: string): Promise<string | null> {
  const now = new Date();
  const token = randomBytes(8).toString('hex');
  const res = await SequenceEnrollment.updateOne(
    { _id: enrollmentId, workspaceId, status: { $in: ['in_progress', 'needs_attention'] }, nextRunAt: { $lte: now }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
    { lockedUntil: new Date(now.getTime() + LEASE_MS), lockToken: token },
  );
  return res.modifiedCount ? token : null;
}

export async function processSequenceRun(data: { workspaceId: string; enrollmentId: string; token?: string }): Promise<void> {
  const workspaceId = new Types.ObjectId(data.workspaceId);
  const token = data.token ?? (await claim(workspaceId, data.enrollmentId));
  if (!token) return;
  const e = await SequenceEnrollment.findOne({ _id: data.enrollmentId, workspaceId, lockToken: token });
  if (!e) return;
  try {
    await run(e);
  } catch (err) {
    logger.error({ err, enrollmentId: data.enrollmentId }, 'Sequence step failed');
    e.attempts = (e.attempts ?? 0) + 1;
    if (e.attempts >= 5) {
      await release(e);
      await exitEnrollment(e, 'error', `Unexpected error: ${(err as Error).message}`.slice(0, 300));
      return;
    }
    e.nextRunAt = new Date(Date.now() + 5 * 60_000 * e.attempts);
    await release(e);
  }
}

async function release(e: EnrollmentDoc) {
  e.lockedUntil = null;
  e.lockToken = null;
  await e.save();
  await kick(e);
}

// ---- running steps ----

interface RunCtx {
  e: EnrollmentDoc;
  seq: SequenceDoc;
  workspace: WorkspaceDoc;
  contact: ContactDoc;
  compiled: Compiled;
  tz: string;
  now: Date;
}

const graphCache = new Map<string, Compiled>();
async function compiledFor(e: EnrollmentDoc): Promise<Compiled | null> {
  if (e.test) return e.testGraph ? compile(e.testGraph as Graph) : null;
  const key = String(e.versionId);
  const hit = graphCache.get(key);
  if (hit) return hit;
  const version = await SequenceVersion.findOne({ _id: e.versionId, workspaceId: e.workspaceId }).lean();
  if (!version) return null;
  const compiled = compile(version.graph as Graph);
  if (graphCache.size > 500) graphCache.clear();
  graphCache.set(key, compiled);
  return compiled;
}

function dateDay(ctx: RunCtx): string | null {
  const { seq, e, contact, tz } = ctx;
  if (seq.dateMode === 'fixed') return seq.fixedDate ? dayOf(seq.fixedDate, tz) : null;
  if (seq.dateMode === 'per_contact' && seq.dateKey) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    return dayOf(data[seq.dateKey] ?? ((contact.customFields ?? {}) as Record<string, unknown>)[seq.dateKey], tz);
  }
  return null;
}

/** Skips from a passed dated step to the next wait, logging each message skipped. */
async function skipPassedDated(ctx: RunCtx, fromId: string): Promise<string | null> {
  let id = ctx.compiled.next.get(fromId) ?? null;
  while (id) {
    const step = ctx.compiled.steps.get(id)!;
    if (step.type === 'wait' || step.type === 'wait_until_date') return id;
    await log(ctx.e, id, step.type, 'skipped', 'Dated reminder already passed');
    id = ctx.compiled.next.get(id) ?? null;
  }
  return null;
}

async function run(e: EnrollmentDoc): Promise<void> {
  const seq = await Sequence.findOne({ _id: e.sequenceId, workspaceId: e.workspaceId });
  if (!seq) return exitAndRelease(e, 'error', 'Sequence was deleted');
  if (!e.test && seq.status !== 'active') {
    // Paused: keep the place; the scheduler skips paused sequences.
    return release(e);
  }
  const [workspace, contact, compiled] = await Promise.all([Workspace.findById(e.workspaceId), Contact.findOne({ _id: e.contactId, workspaceId: e.workspaceId }), compiledFor(e)]);
  if (!workspace) return exitAndRelease(e, 'error', 'Workspace not found');
  if (!contact) return exitAndRelease(e, 'removed', 'Contact was deleted');
  if (!compiled) return exitAndRelease(e, 'error', 'Sequence steps not found');
  const customTz = ((contact.customFields ?? {}) as Record<string, unknown>).timezone;
  const tz = seq.rules?.timezone === 'contact' && validTimeZone(customTz) ? customTz : workspace.timezone;
  const ctx: RunCtx = { e, seq, workspace, contact, compiled, tz, now: new Date() };

  for (let i = 0; i < MAX_STEPS_PER_RUN; i++) {
    if (contact.consent?.status === 'opted_out') return exitAndRelease(e, 'opted_out', 'Contact opted out');
    if (contact.blocked) return exitAndRelease(e, 'removed', 'Contact is blocked');
    const exit = exitFor(seq, e, contact);
    if (exit) return exitAndRelease(e, exit.outcome, exit.reason);

    const stepId = e.currentStepId;
    if (!stepId) return exitAndRelease(e, 'completed', 'Had every message');
    const step = compiled.steps.get(stepId);
    if (!step) return exitAndRelease(e, 'error', `Step ${stepId} no longer exists`);
    const next = compiled.next.get(stepId) ?? null;

    e.waitingStepId = null;
    if (step.type === 'wait') {
      const ms = e.test ? TEST_WAIT_MS : waitMs(step);
      e.waitingStepId = stepId;
      e.currentStepId = next;
      e.nextRunAt = new Date(ctx.now.getTime() + ms);
      await log(e, stepId, 'wait', 'waiting', null, { until: e.nextRunAt });
      return settle(e);
    }

    if (step.type === 'wait_until_date') {
      const day = dateDay(ctx);
      if (!day) {
        await log(e, stepId, 'wait_until_date', 'skipped', 'No date for this contact');
        e.currentStepId = next;
        continue;
      }
      const at = e.test ? new Date(ctx.now.getTime() + TEST_WAIT_MS) : datedRunAt(day, step.offsetDays, step.time, tz);
      if (at <= ctx.now) {
        await log(e, stepId, 'wait_until_date', 'skipped', 'Dated reminder already passed');
        e.currentStepId = await skipPassedDated(ctx, stepId);
        continue;
      }
      e.waitingStepId = stepId;
      e.currentStepId = next;
      e.nextRunAt = at;
      await log(e, stepId, 'wait_until_date', 'waiting', null, { until: at, date: day });
      return settle(e);
    }

    if (step.type === 'branch') {
      const cctx = await conditionContext(ctx, stepId);
      const way = step.ways.find((w) => allMatch(w.conditions, cctx)) ?? step.ways[step.ways.length - 1]!;
      await log(e, stepId, 'branch', 'took', way.label || `Way ${step.ways.indexOf(way) + 1}`);
      e.currentStepId = way.steps[0]?.id ?? next;
      continue;
    }

    if (step.type === 'action') {
      await runAction(ctx, step);
      e.currentStepId = next;
      continue;
    }

    // message
    const outcome = await sendStep(ctx, step);
    if (outcome === 'stop') return; // settled or exited inside
    if (outcome === 'skipped') {
      e.currentStepId = next;
      continue;
    }
    // Sent: the next step runs in a fresh job, so long chains of sends spread out.
    e.currentStepId = next;
    e.nextRunAt = new Date();
    return settle(e);
  }
  // Safety: very long chains of actions continue in the next job.
  e.nextRunAt = new Date();
  return settle(e);
}

async function settle(e: EnrollmentDoc) {
  if (e.status === 'needs_attention' && !e.attention) e.status = 'in_progress';
  e.attempts = 0;
  await release(e);
}

async function exitAndRelease(e: EnrollmentDoc, outcome: ExitOutcome, reason: string) {
  e.lockedUntil = null;
  e.lockToken = null;
  await e.save();
  await exitEnrollment(e, outcome, reason);
}

async function needsAttention(e: EnrollmentDoc, code: string, message: string, retryMs = ATTENTION_RETRY_MS) {
  const first = e.status !== 'needs_attention' || e.attention?.code !== code;
  e.status = 'needs_attention';
  e.attention = { code, message, since: e.attention?.code === code ? e.attention.since : new Date() };
  e.nextRunAt = new Date(Date.now() + retryMs);
  if (first) await log(e, e.currentStepId ?? null, 'attention', code, message);
  await release(e);
}

async function conditionContext(ctx: RunCtx, stepId: string) {
  const last = ctx.e.lastSequenceMessageId ? await SequenceMessage.findOne({ _id: ctx.e.lastSequenceMessageId, workspaceId: ctx.e.workspaceId }).lean() : null;
  const replied = hasReplied(ctx.e, ctx.contact);
  const lastReply = replied
    ? await Message.findOne({ workspaceId: ctx.e.workspaceId, contactId: ctx.contact._id, direction: 'inbound' }).sort({ createdAt: -1 }).select('content').lean()
    : null;
  const content = (lastReply?.content ?? {}) as { text?: string; title?: string };
  return {
    contact: values(ctx.contact),
    data: (ctx.e.data ?? {}) as Record<string, unknown>,
    stepId,
    lastMessage: last ? { status: last.status, deliveredAt: last.deliveredAt ?? null, readAt: last.readAt ?? null } : null,
    replied,
    lastReplyText: String(content.text ?? content.title ?? ''),
  };
}

async function runAction(ctx: RunCtx, step: ActionStep) {
  const { e, contact, workspace } = ctx;
  const ok = (result: string, reason: string | null = null) => log(e, step.id, 'action', result, reason, { action: step.action });
  try {
    switch (step.action) {
      case 'add_tag':
      case 'remove_tag': {
        if (!Types.ObjectId.isValid(step.tagId) || !(await Tag.exists({ _id: step.tagId, workspaceId: workspace._id }))) return ok('skipped', 'Tag was deleted');
        const id = new Types.ObjectId(step.tagId);
        if (step.action === 'add_tag' && !contact.tags.some((t) => t.equals(id))) contact.tags.push(id);
        if (step.action === 'remove_tag') contact.tags = contact.tags.filter((t) => !t.equals(id)) as typeof contact.tags;
        await contact.save();
        return ok('done');
      }
      case 'set_lifecycle':
        contact.lifecycleStage = step.stage;
        await contact.save();
        return ok('done');
      case 'add_to_list': {
        if (!Types.ObjectId.isValid(step.listId) || !(await ContactList.exists({ _id: step.listId, workspaceId: workspace._id }))) return ok('skipped', 'List was deleted');
        const id = new Types.ObjectId(step.listId);
        if (!contact.lists.some((l) => l.equals(id))) contact.lists.push(id);
        await contact.save();
        return ok('done');
      }
      case 'start_sequence': {
        const other = Types.ObjectId.isValid(step.sequenceId) ? await Sequence.findOne({ _id: step.sequenceId, workspaceId: workspace._id }) : null;
        if (!other || other._id.equals(ctx.seq._id)) return ok('skipped', 'Sequence not found');
        if (e.test) return ok('skipped', 'Not started in a test run');
        const { result } = await enroll(other, contact, { via: `sequence:${ctx.seq.name}`.slice(0, 80), data: (e.data ?? {}) as Record<string, unknown> });
        return ok(result === 'enrolled' ? 'done' : 'skipped', result === 'enrolled' ? `Started "${other.name}"` : `Not started: ${result.replace(/_/g, ' ')}`);
      }
      case 'assign_chat': {
        const userId = step.userId && Types.ObjectId.isValid(step.userId) ? new Types.ObjectId(step.userId) : await leastBusy(workspace._id);
        if (!userId) return ok('skipped', 'No teammate to assign');
        await Conversation.updateOne({ workspaceId: workspace._id, contactId: contact._id }, { assigneeId: userId });
        return ok('done');
      }
      case 'webhook': {
        const body = JSON.stringify({
          event: 'sequence.step',
          sequence: { id: String(ctx.seq._id), name: ctx.seq.name },
          step_id: step.id,
          contact: { id: String(contact._id), phone: contact.phoneE164, name: contact.name ?? contact.profileName ?? null },
          data: e.data ?? {},
          test: !!e.test,
          sent_at: new Date().toISOString(),
        });
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (step.secret) headers['X-Zeta-Signature'] = `sha256=${createHmac('sha256', step.secret).update(body).digest('hex')}`;
        const res = await safeRequest(step.url, { method: 'POST', headers, body, timeoutMs: 10_000, maxBytes: 2_000 });
        return ok(res.status < 300 ? 'done' : 'failed', `HTTP ${res.status}`);
      }
    }
  } catch (err) {
    return ok('failed', (err as Error).message.slice(0, 200));
  }
}

async function leastBusy(workspaceId: Types.ObjectId): Promise<Types.ObjectId | null> {
  const members = await WorkspaceMember.find({ workspaceId }).select('userId role').lean();
  const agents = members.filter((m) => can(m.role as Role, 'messages:send')).map((m) => m.userId);
  if (!agents.length) return null;
  const load = await Conversation.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { workspaceId, status: { $in: ['open', 'pending'] }, assigneeId: { $in: agents } } },
    { $group: { _id: '$assigneeId', n: { $sum: 1 } } },
  ]);
  const byUser = new Map(load.map((l) => [String(l._id), l.n]));
  return [...agents].sort((a, b) => (byUser.get(String(a)) ?? 0) - (byUser.get(String(b)) ?? 0))[0] ?? null;
}

/** 'sent' | 'skipped' (filter) | 'stop' (waiting, needs attention or exited: already saved). */
async function sendStep(ctx: RunCtx, step: MessageStep, attempt = 1, ignoreRules = false): Promise<'sent' | 'skipped' | 'stop'> {
  const { e, seq, workspace, contact, tz } = ctx;
  const now = new Date();

  if (step.filter.length && !allMatch(step.filter, await conditionContext(ctx, step.id))) {
    await log(e, step.id, 'message', 'skipped', 'Did not match the filter');
    return 'skipped';
  }

  if (!e.test && !ignoreRules) {
    const rules = seq.rules!;
    const window = { quietHours: rules.quietHours as { enabled: boolean; start: string; end: string }, days: rules.days as number[] };
    const allowed = nextSendTime(now, window, tz);
    if (allowed > now) {
      e.nextRunAt = allowed;
      await release(e);
      return 'stop';
    }
    const dayStart = datedRunAt(dayOf(now, tz)!, 0, '00:00', tz);
    const sentToday = await SequenceMessage.countDocuments({ workspaceId: e.workspaceId, contactId: contact._id, test: false, createdAt: { $gte: dayStart } });
    if (sentToday >= (rules.maxPerContactPerDay ?? 3)) {
      e.nextRunAt = nextDaySendTime(now, window, tz);
      await log(e, step.id, 'message', 'postponed', 'Daily message limit for this contact reached');
      await release(e);
      return 'stop';
    }
    if (rules.sendAfterDelivered && e.lastSequenceMessageId) {
      const prev = await SequenceMessage.findOne({ _id: e.lastSequenceMessageId, workspaceId: e.workspaceId }).lean();
      if (prev && !prev.deliveredAt && !prev.readAt) {
        if (prev.status === 'failed' || now.getTime() - prev.createdAt.getTime() > DELIVERY_TIMEOUT_MS) {
          await exitAndRelease(e, 'delivery_failed', prev.status === 'failed' ? 'Previous message failed' : 'Previous message not delivered in 48 hours');
          return 'stop';
        }
        e.nextRunAt = new Date(now.getTime() + DELIVERY_CHECK_MS);
        await release(e);
        return 'stop';
      }
    }
  }

  const template = step.templateId && Types.ObjectId.isValid(step.templateId) ? await MessageTemplate.findOne({ _id: step.templateId, workspaceId: e.workspaceId }) : null;
  if (!template) {
    await needsAttention(e, 'TEMPLATE_MISSING', 'The template for this message was deleted. Choose another one and publish again.');
    return 'stop';
  }
  if (template.status !== 'APPROVED') {
    await needsAttention(e, 'TEMPLATE_NOT_APPROVED', `Template "${template.name}" is ${String(template.status).toLowerCase()}. Sending continues when it is approved again.`);
    return 'stop';
  }

  const data = (e.data ?? {}) as Record<string, unknown>;
  const v = values(contact);
  const resolve = (vars: MessageStep['bodyVariables']) => {
    const out: string[] = [];
    for (const variable of vars) {
      const value = resolveVariable(variable, v, data, tz, now);
      if (value === null) return { missing: variableLabel(variable) };
      out.push(value);
    }
    return { values: out };
  };
  const header = resolve(step.headerVariables);
  const body = resolve(step.bodyVariables);
  const missing = header.missing ?? body.missing;
  if (missing) {
    await log(e, step.id, 'message', 'error', `Variable ${missing} is empty and has no fallback`);
    await exitAndRelease(e, 'error', `Variable ${missing} is empty and has no fallback`);
    return 'stop';
  }

  const needsMedia = sendRequirements(template.components as never).headerMedia;
  const extras = needsMedia && step.mediaUrl ? { headerMedia: { link: step.mediaUrl } } : {};
  const key = `seq:${e._id}:${step.id}:${attempt}`;
  let input: SendInput = { type: 'template', to: contact.phoneE164, templateId: String(template._id), headerParams: header.values, bodyParams: body.values, extras };
  let free = false;
  if (step.freeIfWindowOpen && isInServiceWindow(contact)) {
    const preview = String(buildTemplateContent(template, header.values!, body.values!, [], extras).preview ?? '').trim();
    if (preview) {
      input = { type: 'text', to: contact.phoneE164, text: preview };
      free = true;
    }
  }

  let message: MessageDoc;
  try {
    ({ message } = await queueOutboundMessage(workspace, null, input, key, { source: 'sequence' }));
  } catch (err) {
    const code = (err as AppError).code;
    if (code === 'CONTACT_OPTED_OUT') {
      await exitAndRelease(e, 'opted_out', 'Contact opted out');
      return 'stop';
    }
    if (code === 'CONTACT_BLOCKED') {
      await exitAndRelease(e, 'removed', 'Contact is blocked');
      return 'stop';
    }
    if (code === 'PLAN_LIMIT_REACHED' || code === 'SUBSCRIPTION_INACTIVE') {
      await needsAttention(e, 'QUOTA', `${(err as AppError).message} Sending continues when the plan allows more.`, 30 * 60_000);
      return 'stop';
    }
    if (code === 'WHATSAPP_CONNECTION_ERROR' || code === 'WHATSAPP_NOT_CONNECTED') {
      await needsAttention(e, 'NUMBER_DISCONNECTED', 'The WhatsApp number needs attention. Sending continues when it is reconnected.');
      return 'stop';
    }
    if (err instanceof AppError && err.status < 500) {
      const detail = err.details ? Object.values(err.details).flat().join(' ') : '';
      await log(e, step.id, 'message', 'error', `${err.message} ${detail}`.trim());
      await exitAndRelease(e, 'error', `Could not send: ${err.message} ${detail}`.trim().slice(0, 300));
      return 'stop';
    }
    throw err;
  }

  const sm = await SequenceMessage.findOneAndUpdate(
    { workspaceId: e.workspaceId, messageId: message._id },
    {
      $setOnInsert: {
        workspaceId: e.workspaceId,
        sequenceId: seq._id,
        enrollmentId: e._id,
        contactId: contact._id,
        stepId: step.id,
        messageId: message._id,
        templateId: template._id,
        test: !!e.test,
        attempt,
        status: message.status,
      },
    },
    { upsert: true, new: true },
  );
  e.lastSequenceMessageId = sm._id;
  e.status = 'in_progress';
  e.attention = null;
  await log(e, step.id, 'message', 'sent', free ? 'Sent as a free message (24h window open)' : null, { templateName: template.name, messageId: String(message._id) });
  return 'sent';
}

/** WhatsApp's "ecosystem limit" (131049): try once more about 4 hours later. */
export async function retrySequenceMessage(data: { workspaceId: string; sequenceMessageId: string }): Promise<void> {
  const workspaceId = new Types.ObjectId(data.workspaceId);
  const sm = await SequenceMessage.findOne({ _id: data.sequenceMessageId, workspaceId });
  if (!sm || sm.attempt > 1) return;
  const e = await SequenceEnrollment.findOne({ _id: sm.enrollmentId, workspaceId, active: true });
  if (!e) return;
  const [seq, workspace, contact, compiled] = await Promise.all([
    Sequence.findOne({ _id: e.sequenceId, workspaceId }),
    Workspace.findById(workspaceId),
    Contact.findOne({ _id: e.contactId, workspaceId }),
    compiledFor(e),
  ]);
  const step = compiled?.steps.get(sm.stepId);
  if (!seq || seq.status !== 'active' || !workspace || !contact || step?.type !== 'message') return;
  const ctx: RunCtx = { e, seq, workspace, contact, compiled: compiled!, tz: workspace.timezone, now: new Date() };
  // Sent outside the normal flow: the enrollment keeps its place and schedule (only the last-message link changes).
  const out = await sendStep(ctx, step, 2, true).catch((err) => {
    logger.warn({ err, sequenceMessageId: data.sequenceMessageId }, 'Sequence retry failed');
    return 'stop' as const;
  });
  if (out === 'sent') await SequenceEnrollment.updateOne({ _id: e._id, workspaceId }, { lastSequenceMessageId: e.lastSequenceMessageId });
}

// ---- status receipts and replies ----

/** Keeps the sequence funnel in step with WhatsApp receipts (called for source=sequence). */
export async function syncSequenceMessage(message: MessageDoc): Promise<void> {
  const sm = await SequenceMessage.findOne({ workspaceId: message.workspaceId, messageId: message._id });
  if (!sm) return;
  const wasFailed = sm.status === 'failed';
  sm.set({
    status: message.status,
    sentAt: message.sentAt ?? sm.sentAt,
    deliveredAt: message.deliveredAt ?? sm.deliveredAt,
    readAt: message.readAt ?? sm.readAt,
    failedAt: message.failedAt ?? sm.failedAt,
    errorCode: message.error?.code ?? sm.errorCode,
  });
  await sm.save();
  if (message.status === 'failed' && !wasFailed && message.error?.code === '131049' && sm.attempt === 1 && !sm.test) {
    const seq = await Sequence.findOne({ _id: sm.sequenceId, workspaceId: sm.workspaceId }).select('rules').lean();
    if (seq?.rules?.retryEcosystemLimit !== false) {
      await SequenceEvent.create({ workspaceId: sm.workspaceId, sequenceId: sm.sequenceId, enrollmentId: sm.enrollmentId, stepId: sm.stepId, type: 'message', result: 'retry_scheduled', reason: 'WhatsApp held the message back (131049); trying again in about 4 hours' });
      await enqueue('sequence.retry', { workspaceId: String(sm.workspaceId), sequenceMessageId: String(sm._id) }, { delayMs: ECOSYSTEM_RETRY_MS, jobId: `seqretry-${sm._id}` });
    }
  }
}

async function onReply(workspaceId: Types.ObjectId, contactId: Types.ObjectId) {
  const live = await SequenceEnrollment.find({ workspaceId, contactId, active: true });
  if (!live.length) return;
  const now = new Date();
  // The latest message of each sequence counts the reply (funnel "replied").
  for (const e of live) {
    if (e.lastSequenceMessageId) await SequenceMessage.updateOne({ _id: e.lastSequenceMessageId, workspaceId, repliedAt: null }, { repliedAt: now });
    if (!e.repliedAt) {
      e.repliedAt = now;
      await SequenceEnrollment.updateOne({ _id: e._id, workspaceId, repliedAt: null }, { repliedAt: now });
    }
  }
  await checkExits(workspaceId, contactId, live);
}

/** Event-driven goal / stop check for one contact's live enrollments. */
async function checkExits(workspaceId: Types.ObjectId, contactId: Types.ObjectId, live?: EnrollmentDoc[]) {
  const rows = live ?? (await SequenceEnrollment.find({ workspaceId, contactId, active: true }));
  if (!rows.length) return;
  const contact = await Contact.findOne({ _id: contactId, workspaceId });
  if (!contact) return;
  const seqs = await Sequence.find({ workspaceId, _id: { $in: rows.map((r) => r.sequenceId) } });
  for (const e of rows) {
    const seq = seqs.find((s) => s._id.equals(e.sequenceId));
    if (!seq) continue;
    const exit = exitFor(seq, e, contact);
    if (exit) await exitEnrollment(e, exit.outcome, exit.reason);
  }
}

// ---- data updates (API events) ----

/**
 * Merges new data into a contact's live enrollments. When the date key changes and
 * the contact is sleeping on a dated step, that step is planned again from the new
 * date (a passed date is skipped, as for a late joiner).
 */
export async function updateEnrollmentData(workspaceId: Types.ObjectId, contactId: Types.ObjectId, data: Record<string, unknown>): Promise<number> {
  if (!Object.keys(data).length) return 0;
  const rows = await SequenceEnrollment.find({ workspaceId, contactId, active: true });
  const seqs = await Sequence.find({ workspaceId, _id: { $in: rows.map((r) => r.sequenceId) } }).select('dateKey dateMode').lean();
  for (const e of rows) {
    e.data = { ...((e.data ?? {}) as Record<string, unknown>), ...data };
    e.markModified('data');
    const seq = seqs.find((s) => s._id.equals(e.sequenceId));
    const dateMoved = seq?.dateMode === 'per_contact' && !!seq.dateKey && seq.dateKey in data;
    if (dateMoved && e.waitingStepId && e.status === 'in_progress') {
      const compiled = await compiledFor(e);
      if (compiled?.steps.get(e.waitingStepId)?.type === 'wait_until_date') {
        e.currentStepId = e.waitingStepId;
        e.waitingStepId = null;
        e.nextRunAt = new Date();
        await log(e, e.currentStepId, 'wait_until_date', 'replanned', 'The date changed');
      }
    }
    await SequenceEnrollment.updateOne(
      { _id: e._id, workspaceId, active: true, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: new Date() } }] },
      { data: e.data, currentStepId: e.currentStepId, waitingStepId: e.waitingStepId, nextRunAt: e.nextRunAt },
    );
    await kick(e);
  }
  return rows.length;
}

// ---- triggers ----

function triggerMatches(seq: SequenceDoc, ev: DomainEvent): boolean {
  const t = seq.trigger;
  if (!t?.type) return false;
  const has = (list: unknown[] | null | undefined, ids: string[]) => (list ?? []).some((x) => ids.includes(String(x)));
  switch (ev.type) {
    case 'tag.added':
      return t.type === 'tag_added' && has(t.tagIds, ev.tagIds);
    case 'lifecycle.changed':
      return t.type === 'lifecycle_changed' && (t.stages ?? []).includes(ev.to);
    case 'list.member_added':
      return t.type === 'list_added' && has(t.listIds, ev.listIds);
    case 'contact.created':
      return t.type === 'new_contact' && (!(t.sources ?? []).length || (t.sources ?? []).includes(ev.source ?? ''));
    case 'field.changed':
      return t.type === 'field_changed' && t.fieldKey === ev.key && (t.fieldOp !== 'equals' || String(ev.value ?? '').trim().toLowerCase() === String(t.fieldValue ?? '').trim().toLowerCase());
    default:
      return false;
  }
}

export async function handleDomainEvents(workspaceId: Types.ObjectId, events: DomainEvent[]): Promise<void> {
  const live = await Sequence.find({ workspaceId, status: 'active', 'trigger.type': { $nin: [null, 'manual', 'date_field', 'inactive'] } });
  for (const ev of events) {
    const contactId = new Types.ObjectId(ev.contactId);
    if (ev.type === 'contact.opted_out') {
      await exitWhere({ workspaceId, contactId }, 'opted_out', 'Contact opted out (STOP)');
      continue;
    }
    if (ev.type === 'message.inbound') {
      await onReply(workspaceId, contactId);
      continue;
    }
    if (ev.type === 'tag.added' || ev.type === 'lifecycle.changed') await checkExits(workspaceId, contactId);
    const matching = live.filter((s) => triggerMatches(s, ev));
    if (!matching.length) continue;
    const contact = await Contact.findOne({ _id: contactId, workspaceId });
    if (!contact) continue;
    for (const seq of matching) {
      const data = ev.type === 'field.changed' ? { [ev.key]: ev.value } : {};
      await enroll(seq, contact, { via: `trigger:${seq.trigger!.type}`, data }).catch((err) => logger.error({ err, sequenceId: String(seq._id) }, 'Sequence enroll failed'));
    }
  }
}

onDomainEvents(handleDomainEvents, async (workspaceId) => !!(await Sequence.exists({ workspaceId, status: { $in: ['active', 'paused'] } })) || !!(await SequenceEnrollment.exists({ workspaceId, active: true })));

export { resetDomainInterest };
export type { Step };

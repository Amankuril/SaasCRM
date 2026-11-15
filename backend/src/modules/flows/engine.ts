import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { safeRequest } from '../../lib/safeFetch.js';
import { logger } from '../../lib/logger.js';
import { enqueue, type JobContext } from '../../jobs/queue.js';
import { getAgent, runAgent } from '../ai/ai.service.js';
import { hasAccess } from '../billing/billing.service.js';
import { emitEvent } from '../developer/webhook.service.js';
import { resolveVariables, type VariableSpec } from '../campaigns/campaign.service.js';
import { Contact, type ContactDoc } from '../contacts/contact.model.js';
import { Conversation } from '../inbox/conversation.model.js';
import { notify } from '../inbox/conversation.service.js';
import { ConversationNote } from '../inbox/note.model.js';
import { Message } from '../messages/message.model.js';
import { Form } from '../forms/form.model.js';
import { sendForm } from '../forms/form.service.js';
import { queueOutboundMessage, type SendInput } from '../messages/message.service.js';
import { Workspace, type WorkspaceDoc } from '../workspaces/workspace.model.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { Flow, FlowExecution, FlowVersion, type ExecutionDoc, type FlowVersionDoc } from './flow.model.js';
import { Appointment } from '../appointments/appointment.model.js';
import { SheetAccessError, appendRow, parseSheetUrl } from '../integrations/googleSheets.js';
import { authFor } from '../integrations/sheets.service.js';
import { Counter, Task } from '../tasks/task.model.js';
import { listColumns } from '../tasks/task.routes.js';
import { publish } from '../../realtime/bus.js';
import { LOOP_MAX_ITEMS, nextNodeId, type Graph, type GraphNode, type NodeConfig } from './graph.js';

/** Loop guards: a single wake-up runs at most this many steps, a whole run at most MAX_TOTAL. */
const MAX_STEPS_PER_RUN = 150;
const MAX_STEPS_TOTAL = 500;
const LOCK_MS = 60_000;
const LOG_LIMIT = 100;

type StepResult =
  | { kind: 'next'; handle: string; detail?: string }
  | { kind: 'wait'; wait: 'delay' | 'reply'; ms: number; detail?: string }
  | { kind: 'end'; status: 'completed' | 'exited'; reason?: string; goal?: string; detail?: string };

interface RunContext {
  workspace: WorkspaceDoc;
  version: FlowVersionDoc;
  graph: Graph;
  contact: ContactDoc;
  exec: ExecutionDoc;
  /** How deep we are in trigger-from-flow chains (tag added by a flow starting another flow). */
  depth: number;
}

// ---------------------------------------------------------------------------
// Starting and resuming
// ---------------------------------------------------------------------------

export interface TriggerInfo {
  type: string;
  messageId?: string;
  text?: string;
  /** Initial {{vars.*}} (API runs). */
  vars?: Record<string, string>;
}

/** Starts a contact on a published flow version, unless they're already in it. */
export async function startExecution(version: FlowVersionDoc, contactId: Types.ObjectId, trigger: TriggerInfo, depth = 0): Promise<ExecutionDoc | null> {
  const workspaceId = version.workspaceId as unknown as Types.ObjectId;
  const flow = await Flow.findOne({ _id: version.flowId, workspaceId }).lean();
  if (!flow || flow.status !== 'active') return null;
  if (!flow.settings?.allowReentry) {
    const busy = await FlowExecution.exists({ workspaceId, flowId: flow._id, contactId, status: { $in: ['running', 'waiting'] } });
    if (busy) return null;
  }
  const graph = version.graph as Graph;
  const triggerNode = graph.nodes.find((n) => n.type === 'trigger');
  if (!triggerNode) return null;

  const exec = await FlowExecution.create({
    workspaceId,
    flowId: flow._id,
    flowVersionId: version._id,
    contactId,
    status: 'running',
    currentNodeId: triggerNode.id,
    trigger: { type: trigger.type, messageId: trigger.messageId, text: trigger.text },
    vars: trigger.vars ?? {},
    lockedUntil: new Date(Date.now() + LOCK_MS),
  });
  await runLocked(exec, version, nextNodeId(graph, triggerNode.id, 'next'), depth, { nodeId: triggerNode.id, type: 'trigger', outcome: 'started', detail: trigger.type });
  return exec;
}

/** Worker: a delay finished or a reply wait timed out. */
export async function processFlowResume(data: { workspaceId: string; executionId: string; token: string }, _ctx: JobContext): Promise<void> {
  const workspaceId = new Types.ObjectId(data.workspaceId);
  const exec = await claim(workspaceId, data.executionId, { status: 'waiting', 'waiting.token': data.token });
  if (!exec) return; // stale wake-up (already resumed, exited or replied)

  const waiting = exec.waiting!;
  const remaining = waiting.until.getTime() - Date.now();
  if (remaining > 1_000) {
    // Woken early (e.g. clock skew): sleep again for the rest.
    await release(exec);
    await scheduleWake(exec, remaining);
    return;
  }
  const version = await FlowVersion.findOne({ _id: exec.flowVersionId, workspaceId });
  if (!version) return fail(exec, 'Flow version missing.');

  const handle = waiting.kind === 'delay' ? 'next' : 'no_reply';
  const from = waiting.nodeId;
  exec.waiting = null;
  exec.status = 'running';
  await runLocked(exec, version, nextNodeId(version.graph as Graph, from, handle), 0, {
    nodeId: from,
    type: waiting.kind,
    outcome: waiting.kind === 'delay' ? 'resumed' : 'timed_out',
  });
}

/**
 * Feeds a customer reply to the execution waiting on it. Returns true when an
 * execution consumed the message (so no other flow should start from it).
 */
export async function deliverReply(
  exec: ExecutionDoc,
  message: { type: string; content: Record<string, unknown>; form?: { formId: string; valid: boolean; data: Record<string, unknown> } },
): Promise<boolean> {
  const workspaceId = exec.workspaceId as unknown as Types.ObjectId;
  const locked = await claim(workspaceId, exec.id as string, { status: 'waiting', 'waiting.kind': 'reply' });
  if (!locked) return true;
  const version = await FlowVersion.findOne({ _id: locked.flowVersionId, workspaceId });
  if (!version) {
    await fail(locked, 'Flow version missing.');
    return true;
  }
  const graph = version.graph as Graph;
  const node = graph.nodes.find((n) => n.id === locked.waiting!.nodeId);
  if (!node) {
    await fail(locked, 'Waiting step no longer exists.');
    return true;
  }
  const text = replyText(message);

  if (node.type === 'send_form') {
    const cfg = node.data as NodeConfig<'send_form'>;
    if (!message.form || message.form.formId !== cfg.formId || !message.form.valid) {
      // Chat text or another form: keep waiting for this form.
      await release(locked);
      return !message.form;
    }
    for (const [key, value] of Object.entries(message.form.data)) setVar(locked, `form_${key}`, Array.isArray(value) ? value.join(', ') : String(value ?? ''));
    return continueAfterReply(locked, version, node.id, 'submitted', 'form submitted');
  }

  if (node.type === 'send_buttons') {
    const cfg = node.data as NodeConfig<'send_buttons'>;
    const replyId = message.content.replyId as string | undefined;
    const button = cfg.buttons.find((b) => b.id === replyId) ?? cfg.buttons.find((b) => b.title.toLowerCase() === text.toLowerCase());
    if (!button) {
      // Not a button tap: keep waiting, a human can pick it up in the inbox.
      await release(locked);
      return true;
    }
    setVar(locked, 'last_reply', button.title);
    return continueAfterReply(locked, version, node.id, `btn:${button.id}`, `tapped "${button.title}"`);
  }

  if (node.type === 'ask') {
    const cfg = node.data as NodeConfig<'ask'>;
    if (!isValidAnswer(text, cfg.validation)) {
      const attempts = (locked.waiting!.attempts ?? 0) + 1;
      if (attempts >= 3) return continueAfterReply(locked, version, node.id, 'no_reply', 'gave up after 3 invalid answers');
      locked.waiting!.attempts = attempts;
      await locked.save();
      const workspace = await Workspace.findById(workspaceId);
      const contact = await Contact.findOne({ _id: locked.contactId, workspaceId });
      if (workspace && contact && cfg.retryMessage) {
        await send(workspace, contact, locked, { type: 'text', text: cfg.retryMessage }, `${node.id}:retry${attempts}`).catch(() => undefined);
      }
      await release(locked);
      return true;
    }
    setVar(locked, 'last_reply', text);
    await saveAnswer(locked, cfg.saveTo, text.trim());
    // Answers saved on the contact are also kept on the run, so they show under Collected Data.
    if (!cfg.saveTo.startsWith('var.')) setVar(locked, cfg.saveTo.split('.').pop()!, text.trim());
    return continueAfterReply(locked, version, node.id, 'answered', 'answer saved');
  }

  if (node.type === 'send_list') {
    const cfg = node.data as NodeConfig<'send_list'>;
    const replyId = message.content.replyId as string | undefined;
    const row = cfg.rows.find((r) => r.id === replyId) ?? cfg.rows.find((r) => r.title.toLowerCase() === text.toLowerCase());
    if (!row) {
      await release(locked);
      return true;
    }
    setVar(locked, 'last_reply', row.title);
    return continueAfterReply(locked, version, node.id, `row:${row.id}`, `chose "${row.title}"`);
  }

  if (node.type === 'rating') {
    const cfg = node.data as NodeConfig<'rating'>;
    const score = /^[1-5]$/.test(String(message.content.replyId ?? '')) ? String(message.content.replyId) : (/^\s*([1-5])\b/.exec(text)?.[1] ?? null);
    if (!score) {
      await release(locked);
      return true;
    }
    setVar(locked, 'last_reply', score);
    setVar(locked, cfg.saveAs || 'rating', score);
    return continueAfterReply(locked, version, node.id, 'answered', `rated ${score}/5`);
  }

  if (node.type === 'ask_address') {
    const address = addressFromReply(message, text);
    if (!address) {
      await release(locked);
      return true;
    }
    for (const [key, value] of Object.entries(address.parts)) setVar(locked, `address_${key}`, value);
    setVar(locked, 'address', address.full);
    setVar(locked, 'last_reply', address.full);
    return continueAfterReply(locked, version, node.id, 'answered', 'address saved');
  }

  if (node.type === 'wait_reply') {
    setVar(locked, 'last_reply', text);
    return continueAfterReply(locked, version, node.id, 'replied', 'customer replied');
  }

  if (node.type === 'book_appointment') return bookingReply(locked, version, node, String(message.content.replyId ?? ''), text);

  await release(locked);
  return false;
}

/** The address form answer (India / Singapore), or a typed address as a fallback. */
function addressFromReply(message: { type: string; content: Record<string, unknown> }, text: string): { full: string; parts: Record<string, string> } | null {
  if (message.type === 'interactive' && message.content.interactiveType === 'nfm_reply') {
    try {
      const parsed = JSON.parse(String(message.content.response ?? '{}')) as { values?: Record<string, unknown> } & Record<string, unknown>;
      const values = (parsed.values ?? parsed) as Record<string, unknown>;
      const parts: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) if (/^[a-z0-9_]{1,40}$/.test(k) && k !== 'flow_token' && v != null && v !== '') parts[k] = String(v).slice(0, 500);
      const order = ['name', 'phone_number', 'house_number', 'floor_number', 'tower_number', 'building_name', 'address', 'landmark_area', 'city', 'state', 'in_pin_code', 'sg_post_code'];
      const full = order.map((k) => parts[k]).filter(Boolean).join(', ') || Object.values(parts).join(', ');
      return full ? { full, parts } : null;
    } catch {
      return null;
    }
  }
  return text ? { full: text.slice(0, 1000), parts: {} } : null;
}

// ---- Book Appt. ----

/** Wall-clock time in a timezone. */
function localParts(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(at).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!),
  };
}

/** "2026-11-20" + "15:30" in a timezone -> the UTC instant. */
function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const local = localParts(new Date(guess), timeZone);
  const [ly, lm, ld] = local.date.split('-').map(Number) as [number, number, number];
  const offset = Date.UTC(ly, lm - 1, ld, Math.floor(local.minutes / 60), local.minutes % 60) - guess;
  return new Date(guess - offset);
}

const clock12 = (time: string) => {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** The next working days (from tomorrow) a customer can pick, as list rows. */
function appointmentDays(cfg: NodeConfig<'book_appointment'>, timeZone: string) {
  const rows: { id: string; title: string }[] = [];
  const working = cfg.workingDays?.length ? cfg.workingDays : [1, 2, 3, 4, 5, 6];
  for (let i = 1; rows.length < (cfg.daysAhead ?? 7) && i <= 60; i++) {
    const at = new Date(Date.now() + i * 86_400_000);
    const local = localParts(at, timeZone);
    if (!working.includes(local.weekday)) continue;
    rows.push({ id: `d:${local.date}`, title: new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(at) });
  }
  return rows;
}

async function bookingReply(exec: ExecutionDoc, version: FlowVersionDoc, node: GraphNode, replyId: string, text: string): Promise<boolean> {
  const cfg = node.data as NodeConfig<'book_appointment'>;
  const workspaceId = exec.workspaceId as unknown as Types.ObjectId;
  const workspace = await Workspace.findById(workspaceId);
  const contact = await Contact.findOne({ _id: exec.contactId, workspaceId });
  if (!workspace || !contact) {
    await release(exec);
    return true;
  }
  const timeZone = workspace.timezone || 'UTC';
  const ctx = { contact, exec };
  const vars = (exec.vars ?? {}) as Record<string, string>;
  const days = appointmentDays(cfg, timeZone);
  const dateKey = `_appt_date_${node.id}`;

  const day = days.find((d) => d.id === replyId) ?? days.find((d) => d.title.toLowerCase() === text.toLowerCase());
  if (day) {
    const date = day.id.slice(2);
    const taken = new Set(
      (
        await Appointment.find({ workspaceId, status: { $in: ['scheduled', 'confirmed'] }, startAt: { $gte: zonedToUtc(date, '00:00', timeZone), $lte: zonedToUtc(date, '23:59', timeZone) } })
          .select('startAt')
          .lean()
      ).map((a) => a.startAt.getTime()),
    );
    const free = cfg.slots.filter((slot) => !taken.has(zonedToUtc(date, slot, timeZone).getTime()));
    if (!free.length) {
      await send(workspace, contact, exec, { type: 'list', text: `Sorry, ${day.title} is fully booked. Please pick another date.`, buttonText: 'Choose date', rows: days.filter((d) => d.id !== day.id) }, `${node.id}:dates:${Date.now()}`).catch(() => undefined);
      await release(exec);
      return true;
    }
    setVar(exec, dateKey, date);
    await send(workspace, contact, exec, { type: 'list', text: render(cfg.timePrompt, ctx), footer: day.title, buttonText: 'Choose time', rows: free.map((slot) => ({ id: `t:${slot}`, title: clock12(slot) })) }, `${node.id}:times:${Date.now()}`).catch(() => undefined);
    await release(exec);
    return true;
  }

  const date = vars[dateKey];
  const slot = cfg.slots.find((s) => `t:${s}` === replyId) ?? cfg.slots.find((s) => clock12(s).toLowerCase() === text.toLowerCase());
  if (!date || !slot) {
    // Something else: keep waiting, a human can pick it up in the inbox.
    await release(exec);
    return true;
  }
  const startAt = zonedToUtc(date, slot, timeZone);
  const service = render(cfg.service, ctx).slice(0, 120) || 'Appointment';
  await Appointment.create({ workspaceId, contactId: contact._id, service, startAt, durationMinutes: cfg.durationMinutes ?? 30, status: 'scheduled', source: 'flow', notes: 'Booked in a flow.' });
  const dayLabel = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(startAt);
  setVar(exec, 'appointment_date', dayLabel);
  setVar(exec, 'appointment_time', clock12(slot));
  setVar(exec, 'appointment_service', service);
  exec.vars = Object.fromEntries(Object.entries((exec.vars ?? {}) as Record<string, string>).filter(([k]) => k !== dateKey));
  publish(workspace.id as string, { type: 'appointments.changed' });
  if (cfg.confirmation) await send(workspace, contact, exec, { type: 'text', text: render(cfg.confirmation, ctx) }, `${node.id}:confirmed`).catch(() => undefined);
  return continueAfterReply(exec, version, node.id, 'booked', `${dayLabel}, ${clock12(slot)}`);
}

async function continueAfterReply(exec: ExecutionDoc, version: FlowVersionDoc, nodeId: string, handle: string, detail: string) {
  exec.waiting = null;
  exec.status = 'running';
  await runLocked(exec, version, nextNodeId(version.graph as Graph, nodeId, handle), 0, { nodeId, type: 'reply', outcome: handle, detail });
  return true;
}

/** Ends active runs of a flow (deactivated) or of a contact (exit rules). */
export async function exitExecutions(filter: Record<string, unknown>, reason: string) {
  await FlowExecution.updateMany(
    { ...filter, status: { $in: ['running', 'waiting'] } },
    { status: 'exited', exitReason: reason, waiting: null, endedAt: new Date(), lockedUntil: null },
  );
}

// ---------------------------------------------------------------------------
// The run loop
// ---------------------------------------------------------------------------

async function runLocked(
  exec: ExecutionDoc,
  version: FlowVersionDoc,
  startNodeId: string | null,
  depth: number,
  entry?: { nodeId: string; type: string; outcome: string; detail?: string },
) {
  const workspaceId = exec.workspaceId as unknown as Types.ObjectId;
  try {
    if (entry) pushLog(exec, entry);
    const workspace = await Workspace.findById(workspaceId);
    const contact = await Contact.findOne({ _id: exec.contactId, workspaceId });
    if (!workspace || workspace.status === 'suspended') return await end(exec, 'exited', 'workspace_unavailable');
    if (!contact) return await end(exec, 'exited', 'contact_deleted');
    if (contact.consent?.status === 'opted_out') return await end(exec, 'exited', 'contact_opted_out');
    if (!(await hasAccess(workspaceId))) return await end(exec, 'exited', 'subscription_inactive');

    const ctx: RunContext = { workspace, version, graph: version.graph as Graph, contact, exec, depth };
    let current = startNodeId;
    let steps = 0;

    while (current) {
      if (++steps > MAX_STEPS_PER_RUN || exec.stepCount >= MAX_STEPS_TOTAL) {
        return await fail(exec, 'Stopped: too many steps without waiting (possible loop).');
      }
      const node = ctx.graph.nodes.find((n) => n.id === current);
      if (!node) return await fail(exec, `Step ${current} not found.`);
      exec.currentNodeId = node.id;
      exec.stepCount += 1;

      let result: StepResult;
      try {
        result = await executeNode(node, ctx);
      } catch (err) {
        const msg = err instanceof AppError ? err.message : 'Unexpected error in this step.';
        if (!(err instanceof AppError)) logger.error({ err, executionId: exec.id, nodeId: node.id }, 'Flow step crashed');
        pushLog(exec, { nodeId: node.id, type: node.type, outcome: 'error', detail: msg });
        return await fail(exec, msg);
      }

      if (result.kind === 'next') {
        pushLog(exec, { nodeId: node.id, type: node.type, outcome: result.handle, detail: result.detail });
        current = nextNodeId(ctx.graph, node.id, result.handle);
        continue;
      }
      if (result.kind === 'wait') {
        pushLog(exec, { nodeId: node.id, type: node.type, outcome: 'waiting', detail: result.detail });
        exec.status = 'waiting';
        exec.waiting = { kind: result.wait, nodeId: node.id, until: new Date(Date.now() + result.ms), token: randomUUID(), attempts: 0 };
        exec.lockedUntil = null;
        await exec.save();
        await scheduleWake(exec, result.ms);
        return;
      }
      pushLog(exec, { nodeId: node.id, type: node.type, outcome: result.status, detail: result.detail });
      return await end(exec, result.status, result.reason, result.goal);
    }
    await end(exec, 'completed');
  } catch (err) {
    logger.error({ err, executionId: exec.id }, 'Flow run failed');
    await fail(exec, 'Unexpected error.').catch(() => undefined);
  }
}

async function executeNode(rawNode: GraphNode, ctx: RunContext): Promise<StepResult> {
  const { contact, exec } = ctx;
  // Older saves may have dropped empty configs; treat a missing config as {}.
  const node = { ...rawNode, data: rawNode.data ?? {} };
  switch (node.type) {
    case 'trigger':
      return { kind: 'next', handle: 'next' };

    case 'send_text': {
      const cfg = node.data as NodeConfig<'send_text'>;
      await send(ctx.workspace, contact, exec, { type: 'text', text: render(cfg.text, ctx) }, node.id);
      return { kind: 'next', handle: 'next' };
    }

    case 'send_template': {
      const cfg = node.data as NodeConfig<'send_template'>;
      const header = resolveVariables(contact, cfg.headerVariables as VariableSpec[]);
      const body = resolveVariables(contact, cfg.bodyVariables as VariableSpec[]);
      const buttons = resolveVariables(contact, (cfg.buttonVariables ?? []) as VariableSpec[]);
      if (!header || !body || !buttons) throw new AppError(422, 'MISSING_VARIABLE', 'A template variable has no value for this contact.');
      await send(
        ctx.workspace,
        contact,
        exec,
        { type: 'template', templateId: cfg.templateId, headerParams: header, bodyParams: body, buttonParams: buttons, extras: cfg.templateExtras ?? {} },
        node.id,
      );
      return { kind: 'next', handle: 'next' };
    }

    case 'send_buttons': {
      const cfg = node.data as NodeConfig<'send_buttons'>;
      await send(
        ctx.workspace,
        contact,
        exec,
        { type: 'buttons', text: render(cfg.text, ctx), header: cfg.header ? render(cfg.header, ctx) : undefined, footer: cfg.footer, buttons: cfg.buttons },
        node.id,
      );
      return { kind: 'wait', wait: 'reply', ms: cfg.timeoutMinutes * 60_000, detail: 'waiting for a button tap' };
    }

    case 'send_cta': {
      const cfg = node.data as NodeConfig<'send_cta'>;
      await send(
        ctx.workspace,
        contact,
        exec,
        { type: 'cta_url', text: render(cfg.text, ctx), header: cfg.header ? render(cfg.header, ctx) : undefined, footer: cfg.footer, buttonText: cfg.buttonText, url: cfg.url },
        node.id,
      );
      return { kind: 'next', handle: 'next' };
    }

    case 'ask': {
      const cfg = node.data as NodeConfig<'ask'>;
      await send(ctx.workspace, contact, exec, { type: 'text', text: render(cfg.question, ctx) }, node.id);
      return { kind: 'wait', wait: 'reply', ms: cfg.timeoutMinutes * 60_000, detail: 'waiting for an answer' };
    }

    case 'send_form': {
      const cfg = node.data as NodeConfig<'send_form'>;
      const form = await Form.findOne({ _id: cfg.formId, workspaceId: ctx.workspace._id });
      if (!form) throw new AppError(404, 'FORM_MISSING', 'The form in this step no longer exists.');
      await sendForm(ctx.workspace, contact, form, { text: cfg.text ? render(cfg.text, ctx) : undefined, idempotencyKey: `flow:${exec.id}:${node.id}:${exec.stepCount}`, flowExecutionId: exec._id });
      return { kind: 'wait', wait: 'reply', ms: cfg.timeoutMinutes * 60_000, detail: `waiting for "${form.name}"` };
    }

    case 'condition': {
      const cfg = node.data as NodeConfig<'condition'>;
      const results = cfg.rules.map((r) => evaluateRule(r, ctx));
      const ok = cfg.match === 'any' ? results.some(Boolean) : results.every(Boolean);
      return { kind: 'next', handle: ok ? 'true' : 'false' };
    }

    case 'delay': {
      const cfg = node.data as NodeConfig<'delay'>;
      const unitMs = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[cfg.unit];
      return { kind: 'wait', wait: 'delay', ms: cfg.amount * unitMs, detail: `${cfg.amount} ${cfg.unit}` };
    }

    case 'update_contact': {
      const cfg = node.data as NodeConfig<'update_contact'>;
      const addedTags: Types.ObjectId[] = [];
      for (const action of cfg.actions) {
        if (action.type === 'add_tag') addedTags.push(...addTags(contact, [action.tagId]));
        if (action.type === 'remove_tag') contact.tags = contact.tags.filter((t) => !t.equals(action.tagId)) as typeof contact.tags;
        if (action.type === 'set_stage') contact.lifecycleStage = action.stage;
        if (action.type === 'set_field') applyField(contact, action.field, render(action.value, ctx));
      }
      await contact.save();
      await tagsAdded(ctx, addedTags);
      return { kind: 'next', handle: 'next', detail: `${cfg.actions.length} change(s)` };
    }

    case 'ai_answer': {
      const cfg = node.data as NodeConfig<'ai_answer'>;
      const agent = await getAgent(ctx.workspace._id, true);
      if (!agent?.enabled) throw new AppError(409, 'AI_DISABLED', 'The AI agent is turned off in AI settings.');
      const last = await Message.findOne({ workspaceId: ctx.workspace._id, contactId: contact._id, direction: 'inbound' }).sort({ createdAt: -1 }).lean();
      const question = String((last?.content as { text?: string; title?: string } | undefined)?.text ?? (last?.content as { title?: string } | undefined)?.title ?? '');
      if (!question) return { kind: 'next', handle: 'handoff', detail: 'no customer question to answer' };
      const decision = await runAgent({ workspace: ctx.workspace, agent, question, contactId: contact._id, excludeMessageId: last?._id.toString(), purpose: 'flow' });
      setVar(exec, 'ai_reason', decision.reason);
      if (decision.outcome !== 'answered') return { kind: 'next', handle: 'handoff', detail: decision.reason };
      setVar(exec, 'ai_answer', decision.answer);
      if (cfg.sendAnswer) await send(ctx.workspace, contact, exec, { type: 'text', text: decision.answer }, node.id, { aiGenerated: true });
      return { kind: 'next', handle: 'answered', detail: `${decision.sources.length} source(s)` };
    }

    case 'http_request': {
      const cfg = node.data as NodeConfig<'http_request'>;
      const result = await callHttp(cfg, ctx);
      setVar(exec, 'http_status', String(result.status ?? 0));
      for (const [key, value] of Object.entries(result.saved)) setVar(exec, key, value);
      return { kind: 'next', handle: result.ok ? 'success' : 'failed', detail: result.detail };
    }

    case 'handoff': {
      const cfg = node.data as NodeConfig<'handoff'>;
      if (cfg.message) await send(ctx.workspace, contact, exec, { type: 'text', text: render(cfg.message, ctx) }, node.id).catch(() => undefined);
      const assignee =
        cfg.assigneeId && Types.ObjectId.isValid(cfg.assigneeId) && (await WorkspaceMember.exists({ workspaceId: ctx.workspace._id, userId: cfg.assigneeId }))
          ? new Types.ObjectId(cfg.assigneeId)
          : null;
      const conv = await Conversation.findOneAndUpdate(
        { workspaceId: ctx.workspace._id, contactId: contact._id },
        {
          $set: { botPaused: true, status: 'open', resolvedAt: null, snoozedUntil: null, handoffSource: 'flow', handoffAt: new Date(), awaitingHuman: true, ...(assignee ? { assigneeId: assignee, assignedAt: new Date() } : {}) },
          $setOnInsert: { workspaceId: ctx.workspace._id, contactId: contact._id, openedAt: new Date() },
        },
        { upsert: true, new: true },
      );
      if (cfg.note) {
        await ConversationNote.create({ workspaceId: ctx.workspace._id, conversationId: conv!._id, contactId: contact._id, authorLabel: 'Flow bot', body: `[Bot handoff] ${render(cfg.note, ctx)}` });
      }
      notify(ctx.workspace._id, conv!._id, true);
      return { kind: 'end', status: 'completed', reason: 'handoff', detail: assignee ? 'assigned to a teammate' : 'sent to the team queue' };
    }

    case 'exit': {
      const cfg = node.data as NodeConfig<'exit'>;
      return { kind: 'end', status: 'completed', reason: 'exit', goal: cfg.goal || undefined, detail: cfg.goal ? `goal: ${cfg.goal}` : undefined };
    }

    case 'send_list': {
      const cfg = node.data as NodeConfig<'send_list'>;
      await send(
        ctx.workspace,
        contact,
        exec,
        { type: 'list', text: render(cfg.text, ctx), header: cfg.header ? render(cfg.header, ctx) : undefined, footer: cfg.footer, buttonText: cfg.buttonText, rows: cfg.rows },
        node.id,
      );
      return { kind: 'wait', wait: 'reply', ms: cfg.timeoutMinutes * 60_000, detail: 'waiting for a choice' };
    }

    case 'send_media': {
      const cfg = node.data as NodeConfig<'send_media'>;
      for (const [i, item] of cfg.items.entries()) {
        await send(ctx.workspace, contact, exec, { type: 'media', mediaType: item.mediaType, link: item.link, ...(item.caption ? { caption: render(item.caption, ctx) } : {}) }, `${node.id}:m${i}`);
      }
      return { kind: 'next', handle: 'next', detail: `${cfg.items.length} item(s)` };
    }

    case 'send_location': {
      const cfg = node.data as NodeConfig<'send_location'>;
      await send(ctx.workspace, contact, exec, { type: 'location', latitude: cfg.latitude, longitude: cfg.longitude, name: cfg.name || undefined, address: cfg.address || undefined }, node.id);
      return { kind: 'next', handle: 'next' };
    }

    case 'send_contacts': {
      const cfg = node.data as NodeConfig<'send_contacts'>;
      await send(ctx.workspace, contact, exec, { type: 'contacts', contacts: cfg.contacts.map((c) => ({ name: c.name, phone: c.phone.replace(/[^\d+]/g, ''), organization: c.organization || undefined })) }, node.id);
      return { kind: 'next', handle: 'next', detail: `${cfg.contacts.length} contact(s)` };
    }

    case 'send_catalog': {
      const cfg = node.data as NodeConfig<'send_catalog'>;
      await send(ctx.workspace, contact, exec, { type: 'catalog', text: render(cfg.text, ctx), footer: cfg.footer || undefined, thumbnailProductId: cfg.thumbnailProductId || undefined }, node.id);
      return { kind: 'next', handle: 'next' };
    }

    case 'rating': {
      const cfg = node.data as NodeConfig<'rating'>;
      const rows = [
        { id: '5', title: '⭐⭐⭐⭐⭐', description: 'Excellent' },
        { id: '4', title: '⭐⭐⭐⭐', description: 'Good' },
        { id: '3', title: '⭐⭐⭐', description: 'Okay' },
        { id: '2', title: '⭐⭐', description: 'Poor' },
        { id: '1', title: '⭐', description: 'Very poor' },
      ];
      await send(ctx.workspace, contact, exec, { type: 'list', text: render(cfg.question, ctx), buttonText: 'Rate us', rows }, node.id);
      return { kind: 'wait', wait: 'reply', ms: cfg.timeoutMinutes * 60_000, detail: 'waiting for a rating' };
    }

    case 'ask_address': {
      const cfg = node.data as NodeConfig<'ask_address'>;
      await send(ctx.workspace, contact, exec, { type: 'address_request', text: render(cfg.text, ctx), country: cfg.country ?? 'IN' }, node.id);
      return { kind: 'wait', wait: 'reply', ms: cfg.timeoutMinutes * 60_000, detail: 'waiting for an address' };
    }

    case 'wait_reply': {
      const cfg = node.data as NodeConfig<'wait_reply'>;
      const unitMs = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[cfg.unit];
      return { kind: 'wait', wait: 'reply', ms: cfg.amount * unitMs, detail: `waiting ${cfg.amount} ${cfg.unit} for a reply` };
    }

    case 'time_check': {
      const cfg = node.data as NodeConfig<'time_check'>;
      const now = localParts(new Date(), ctx.workspace.timezone || 'UTC');
      const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
      const [from, to] = [toMinutes(cfg.from), toMinutes(cfg.to)];
      // An overnight window (e.g. 21:00–06:00) wraps past midnight.
      const inWindow = from < to ? now.minutes >= from && now.minutes < to : now.minutes >= from || now.minutes < to;
      const open = cfg.days.includes(now.weekday) && inWindow;
      return { kind: 'next', handle: open ? 'true' : 'false', detail: open ? 'within hours' : 'outside hours' };
    }

    case 'add_tags': {
      const cfg = node.data as NodeConfig<'add_tags'>;
      const added = addTags(contact, cfg.tagIds);
      await contact.save();
      await tagsAdded(ctx, added);
      return { kind: 'next', handle: 'next', detail: `${added.length} tag(s) added` };
    }

    case 'set_stage': {
      const cfg = node.data as NodeConfig<'set_stage'>;
      contact.lifecycleStage = cfg.stage;
      await contact.save();
      return { kind: 'next', handle: 'next', detail: cfg.stage };
    }

    case 'set_field': {
      const cfg = node.data as NodeConfig<'set_field'>;
      const value = render(cfg.value, ctx);
      applyField(contact, cfg.field, value);
      await contact.save();
      // Kept on the run too, so it shows under Collected Data.
      setVar(exec, cfg.field.split('.').pop()!, value);
      return { kind: 'next', handle: 'next', detail: cfg.field };
    }

    case 'loop': {
      const cfg = node.data as NodeConfig<'loop'>;
      const items = render(cfg.items, ctx)
        .split(/[\n,]/)
        .map((v) => v.trim())
        .filter(Boolean)
        .slice(0, LOOP_MAX_ITEMS);
      const key = `_loop_${node.id}`;
      const index = Number(((exec.vars ?? {}) as Record<string, string>)[key] ?? 0);
      if (index >= items.length) {
        setVar(exec, key, '0');
        return { kind: 'next', handle: 'done', detail: `${items.length} item(s)` };
      }
      setVar(exec, key, String(index + 1));
      setVar(exec, 'item', items[index]!);
      setVar(exec, 'item_index', String(index + 1));
      return { kind: 'next', handle: 'item', detail: `${index + 1}/${items.length}: ${items[index]}` };
    }

    case 'book_appointment': {
      const cfg = node.data as NodeConfig<'book_appointment'>;
      const days = appointmentDays(cfg, ctx.workspace.timezone || 'UTC');
      await send(ctx.workspace, contact, exec, { type: 'list', text: render(cfg.datePrompt, ctx), buttonText: 'Choose date', rows: days }, node.id);
      return { kind: 'wait', wait: 'reply', ms: cfg.timeoutMinutes * 60_000, detail: 'waiting for a date and time' };
    }

    case 'create_ticket': {
      const cfg = node.data as NodeConfig<'create_ticket'>;
      const workspaceId = ctx.workspace._id;
      const column = (await listColumns(workspaceId))[0];
      if (!column) throw new AppError(409, 'NO_TASK_COLUMN', 'The ticket board has no columns.');
      const counter = await Counter.findOneAndUpdate({ workspaceId, name: 'task' }, { $inc: { seq: 1 } }, { upsert: true, new: true });
      const last = await Task.findOne({ workspaceId, status: column.key }).sort({ position: -1 }).select('position').lean();
      await Task.create({
        workspaceId,
        type: 'ticket',
        number: counter.seq,
        title: render(cfg.title, ctx).slice(0, 200) || 'Ticket from flow',
        description: render(cfg.description ?? '', ctx).slice(0, 5000),
        priority: cfg.priority ?? 'medium',
        status: column.key,
        contactId: contact._id,
        position: (last?.position ?? 0) + 1,
      });
      setVar(exec, 'ticket_number', String(counter.seq));
      publish(ctx.workspace.id as string, { type: 'tasks.changed' });
      return { kind: 'next', handle: 'next', detail: `ticket #${counter.seq}` };
    }

    case 'resolve_chat': {
      const cfg = node.data as NodeConfig<'resolve_chat'>;
      if (cfg.message) await send(ctx.workspace, contact, exec, { type: 'text', text: render(cfg.message, ctx) }, node.id).catch(() => undefined);
      const conv = await Conversation.findOneAndUpdate(
        { workspaceId: ctx.workspace._id, contactId: contact._id },
        { $set: { status: 'resolved', resolvedAt: new Date(), snoozedUntil: null, awaitingHuman: false, unreadCount: 0 } },
        { new: true },
      );
      if (conv) notify(ctx.workspace._id, conv._id, true);
      return { kind: 'end', status: 'completed', reason: 'resolved', detail: 'chat resolved' };
    }

    case 'google_sheets': {
      const cfg = node.data as NodeConfig<'google_sheets'>;
      const sheet = parseSheetUrl(cfg.sheetUrl);
      if (!sheet) return { kind: 'next', handle: 'failed', detail: 'Invalid sheet link.' };
      try {
        const auth = await authFor({ workspaceId: ctx.workspace._id, access: 'google', googleAccountId: new Types.ObjectId(cfg.googleAccountId) } as Parameters<typeof authFor>[0]);
        if (auth.mode !== 'google') return { kind: 'next', handle: 'failed', detail: 'No Google account.' };
        await appendRow(sheet.spreadsheetId, cfg.tab || 'Sheet1', cfg.values.map((v) => render(v, ctx)), auth.accessToken);
        return { kind: 'next', handle: 'success', detail: 'row added' };
      } catch (err) {
        if (!(err instanceof SheetAccessError)) logger.warn({ err, executionId: exec.id }, 'Flow Google Sheets step failed');
        return { kind: 'next', handle: 'failed', detail: err instanceof SheetAccessError ? err.message : 'Could not add the row.' };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Adds tags the contact doesn't have yet (caller saves) and returns the new ones. */
function addTags(contact: ContactDoc, tagIds: string[]): Types.ObjectId[] {
  const added: Types.ObjectId[] = [];
  for (const tagId of tagIds) {
    if (!Types.ObjectId.isValid(tagId) || contact.tags.some((t) => t.equals(tagId))) continue;
    contact.tags.push(new Types.ObjectId(tagId));
    added.push(new Types.ObjectId(tagId));
  }
  return added;
}

/** A tag added by a flow may start "tag added" flows (bounded chain). */
async function tagsAdded(ctx: RunContext, added: Types.ObjectId[]) {
  if (!added.length || ctx.depth >= 3) return;
  const { onTagsAdded } = await import('./triggers.js');
  await onTagsAdded(ctx.workspace._id, ctx.contact._id, added, ctx.depth + 1);
}

async function send(
  workspace: WorkspaceDoc,
  contact: ContactDoc,
  exec: ExecutionDoc,
  input: DistributiveOmit<SendInput, 'to'>,
  stepKey: string,
  options: { aiGenerated?: boolean } = {},
) {
  // The key ties a send to this exact step of this run, so a retried step never double-sends.
  const key = `flow:${exec.id}:${stepKey}:${exec.stepCount}`;
  await queueOutboundMessage(workspace, null, { ...input, to: contact.phoneE164 } as SendInput, key, { flowExecutionId: exec._id, ...options });
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** {{contact.first_name}}, {{contact.custom.city}}, {{vars.x}}, {{last_reply}} */
export function render(text: string, ctx: Pick<RunContext, 'contact' | 'exec'>, escape: (value: string) => string = (v) => v): string {
  return text.replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi, (_m, key: string) => escape(lookup(key.toLowerCase(), ctx)));
}

const jsonEscape = (v: string) => JSON.stringify(v).slice(1, -1);

/** Flow "HTTP request" step: calls the customer's API with the SSRF guard; never throws. */
async function callHttp(cfg: NodeConfig<'http_request'>, ctx: RunContext): Promise<{ ok: boolean; status: number | null; saved: Record<string, string>; detail: string }> {
  const url = render(cfg.url, ctx, encodeURIComponent);
  const isJson = /^\s*[[{]/.test(cfg.body);
  const body = cfg.body.trim() ? render(cfg.body, ctx, isJson ? jsonEscape : (v) => v) : undefined;
  const headers: Record<string, string> = { 'Zeta-Execution-Id': ctx.exec.id as string };
  if (body) headers['Content-Type'] = isJson ? 'application/json' : 'text/plain; charset=utf-8';
  for (const h of cfg.headers) headers[h.key] = render(h.value, ctx);

  let res;
  try {
    res = await safeRequest(url, { method: cfg.method, headers, body, timeoutMs: cfg.timeoutSeconds * 1000, maxBytes: 100_000, allowPrivate: env.ALLOW_PRIVATE_OUTBOUND_URLS });
  } catch (err) {
    return { ok: false, status: null, saved: {}, detail: err instanceof AppError ? err.message : 'Request failed.' };
  }
  const ok = res.status >= 200 && res.status < 300;
  const saved: Record<string, string> = {};
  if (ok && cfg.saveResponse.length) {
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      json = undefined;
    }
    for (const m of cfg.saveResponse) {
      const value = readPath(json, m.path);
      if (value !== undefined && value !== null) saved[m.var] = (typeof value === 'object' ? JSON.stringify(value) : String(value)).slice(0, 1000);
    }
  }
  return { ok, status: res.status, saved, detail: `HTTP ${res.status} in ${res.durationMs}ms${Object.keys(saved).length ? `, saved ${Object.keys(saved).join(', ')}` : ''}` };
}

/** "data.items[0].name" -> value, or undefined. */
export function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.match(/[^.[\]]+/g) ?? []) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function lookup(key: string, { contact, exec }: Pick<RunContext, 'contact' | 'exec'>): string {
  const vars = (exec.vars ?? {}) as Record<string, string>;
  const name = contact.name || contact.profileName || '';
  if (key === 'last_reply') return vars.last_reply ?? '';
  if (key.startsWith('vars.')) return vars[key.slice(5)] ?? '';
  const field = key.replace(/^contact\./, '');
  if (field === 'name') return name;
  if (field === 'first_name') return name.split(/\s+/)[0] ?? '';
  if (field === 'phone') return contact.phoneE164;
  if (field === 'email') return contact.email ?? '';
  if (field.startsWith('custom.')) return String(((contact.customFields ?? {}) as Record<string, unknown>)[field.slice(7)] ?? '');
  return '';
}

function fieldText(field: string, ctx: RunContext): string {
  if (field === 'stage') return ctx.contact.lifecycleStage;
  if (field === 'consent') return ctx.contact.consent?.status ?? 'unknown';
  if (field === 'last_reply') return lookup('last_reply', ctx);
  if (field.startsWith('var.')) return lookup(`vars.${field.slice(4)}`, ctx);
  return lookup(field, ctx);
}

function evaluateRule(rule: NodeConfig<'condition'>['rules'][number], ctx: RunContext): boolean {
  if (rule.field === 'tag') {
    const has = ctx.contact.tags.some((t) => t.toString() === rule.value);
    return rule.op === 'not_has' ? !has : has;
  }
  const actual = fieldText(rule.field, ctx).trim().toLowerCase();
  const expected = rule.value.trim().toLowerCase();
  switch (rule.op) {
    case 'equals':
      return actual === expected;
    case 'not_equals':
      return actual !== expected;
    case 'contains':
      return actual.includes(expected);
    case 'is_empty':
      return actual === '';
    case 'not_empty':
      return actual !== '';
    default:
      return false;
  }
}

function replyText(message: { type: string; content: Record<string, unknown> }): string {
  const c = message.content as { text?: string; title?: string };
  return String(c.text ?? c.title ?? '').trim();
}

function isValidAnswer(text: string, validation: NodeConfig<'ask'>['validation']): boolean {
  if (!text) return false;
  if (validation === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
  if (validation === 'number') return /^-?\d+([.,]\d+)?$/.test(text);
  if (validation === 'phone') return text.replace(/\D/g, '').length >= 8;
  return true;
}

function applyField(contact: ContactDoc, field: string, value: string) {
  if (field === 'name') contact.name = value || null;
  else if (field === 'email') contact.email = value.toLowerCase() || null;
  else if (field.startsWith('custom.')) contact.customFields = { ...((contact.customFields ?? {}) as object), [field.slice(7)]: value };
}

async function saveAnswer(exec: ExecutionDoc, saveTo: string, value: string) {
  if (saveTo.startsWith('var.')) return setVar(exec, saveTo.slice(4), value);
  const contact = await Contact.findOne({ _id: exec.contactId, workspaceId: exec.workspaceId });
  if (!contact) return;
  applyField(contact, saveTo, value);
  await contact.save();
}

function setVar(exec: ExecutionDoc, key: string, value: string) {
  exec.vars = { ...((exec.vars ?? {}) as object), [key]: value };
}

function pushLog(exec: ExecutionDoc, entry: { nodeId: string; type: string; outcome: string; detail?: string }) {
  exec.log.push({ ...entry, at: new Date() });
  if (exec.log.length > LOG_LIMIT) exec.log.splice(0, exec.log.length - LOG_LIMIT);
}

/** Atomically takes the execution so two workers never advance it at once. */
async function claim(workspaceId: Types.ObjectId, id: string, extra: Record<string, unknown>) {
  const now = new Date();
  return FlowExecution.findOneAndUpdate(
    { _id: id, workspaceId, ...extra, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
    { lockedUntil: new Date(now.getTime() + LOCK_MS) },
    { new: true },
  );
}

async function release(exec: ExecutionDoc) {
  exec.lockedUntil = null;
  await exec.save();
}

async function scheduleWake(exec: ExecutionDoc, ms: number) {
  await enqueue(
    'flow.resume',
    { workspaceId: exec.workspaceId.toString(), executionId: exec.id as string, token: exec.waiting!.token },
    { jobId: `flow-${exec.id}-${exec.waiting!.token}-${Date.now()}`, delayMs: Math.max(ms, 0) },
  );
}

async function end(exec: ExecutionDoc, status: 'completed' | 'exited', reason?: string, goal?: string) {
  exec.set({ status, exitReason: reason ?? null, goal: goal ?? null, waiting: null, endedAt: new Date(), lockedUntil: null });
  await exec.save();
  if (status === 'completed') {
    await emitEvent(exec.workspaceId as unknown as Types.ObjectId, 'flow.completed', {
      execution_id: exec.id as string,
      flow_id: exec.flowId.toString(),
      contact_id: exec.contactId.toString(),
      reason: reason ?? 'end',
      goal: goal ?? null,
      variables: (exec.vars ?? {}) as Record<string, string>,
    });
  }
}

async function fail(exec: ExecutionDoc, error: string) {
  exec.set({ status: 'failed', error, waiting: null, endedAt: new Date(), lockedUntil: null });
  await exec.save();
}

import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { enqueue, type JobContext } from '../../jobs/queue.js';
import { resolveVariables, type VariableSpec } from '../campaigns/campaign.service.js';
import { Contact, type ContactDoc } from '../contacts/contact.model.js';
import { Conversation } from '../inbox/conversation.model.js';
import { notify } from '../inbox/conversation.service.js';
import { ConversationNote } from '../inbox/note.model.js';
import { queueOutboundMessage, type SendInput } from '../messages/message.service.js';
import { Workspace, type WorkspaceDoc } from '../workspaces/workspace.model.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { Flow, FlowExecution, FlowVersion, type ExecutionDoc, type FlowVersionDoc } from './flow.model.js';
import { nextNodeId, type Graph, type GraphNode, type NodeConfig } from './graph.js';

/** Loop guards: a single wake-up runs at most this many steps, a whole run at most MAX_TOTAL. */
const MAX_STEPS_PER_RUN = 50;
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
    trigger,
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
export async function deliverReply(exec: ExecutionDoc, message: { type: string; content: Record<string, unknown> }): Promise<boolean> {
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
    return continueAfterReply(locked, version, node.id, 'answered', 'answer saved');
  }

  await release(locked);
  return false;
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

async function executeNode(node: GraphNode, ctx: RunContext): Promise<StepResult> {
  const { contact, exec } = ctx;
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
      if (!header || !body) throw new AppError(422, 'MISSING_VARIABLE', 'A template variable has no value for this contact.');
      await send(ctx.workspace, contact, exec, { type: 'template', templateId: cfg.templateId, headerParams: header, bodyParams: body }, node.id);
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
        if (action.type === 'add_tag' && !contact.tags.some((t) => t.equals(action.tagId))) {
          contact.tags.push(new Types.ObjectId(action.tagId));
          addedTags.push(new Types.ObjectId(action.tagId));
        }
        if (action.type === 'remove_tag') contact.tags = contact.tags.filter((t) => !t.equals(action.tagId)) as typeof contact.tags;
        if (action.type === 'set_stage') contact.lifecycleStage = action.stage;
        if (action.type === 'set_field') applyField(contact, action.field, render(action.value, ctx));
      }
      await contact.save();
      if (addedTags.length && ctx.depth < 3) {
        const { onTagsAdded } = await import('./triggers.js');
        await onTagsAdded(ctx.workspace._id, contact._id, addedTags, ctx.depth + 1);
      }
      return { kind: 'next', handle: 'next', detail: `${cfg.actions.length} change(s)` };
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
          $set: { botPaused: true, status: 'open', resolvedAt: null, ...(assignee ? { assigneeId: assignee, assignedAt: new Date() } : {}) },
          $setOnInsert: { workspaceId: ctx.workspace._id, contactId: contact._id, openedAt: new Date() },
        },
        { upsert: true, new: true },
      );
      if (cfg.note) {
        await ConversationNote.create({ workspaceId: ctx.workspace._id, conversationId: conv!._id, contactId: contact._id, authorId: ctx.version.publishedBy, body: `[Bot handoff] ${render(cfg.note, ctx)}` });
      }
      notify(ctx.workspace._id, conv!._id, true);
      return { kind: 'end', status: 'completed', reason: 'handoff', detail: assignee ? 'assigned to a teammate' : 'sent to the team queue' };
    }

    case 'exit': {
      const cfg = node.data as NodeConfig<'exit'>;
      return { kind: 'end', status: 'completed', reason: 'exit', goal: cfg.goal || undefined, detail: cfg.goal ? `goal: ${cfg.goal}` : undefined };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function send(workspace: WorkspaceDoc, contact: ContactDoc, exec: ExecutionDoc, input: DistributiveOmit<SendInput, 'to'>, stepKey: string) {
  // The key ties a send to this exact step of this run, so a retried step never double-sends.
  const key = `flow:${exec.id}:${stepKey}:${exec.stepCount}`;
  await queueOutboundMessage(workspace, null, { ...input, to: contact.phoneE164 } as SendInput, key, { flowExecutionId: exec._id });
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** {{contact.first_name}}, {{contact.custom.city}}, {{vars.x}}, {{last_reply}} */
export function render(text: string, ctx: Pick<RunContext, 'contact' | 'exec'>): string {
  return text.replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi, (_m, key: string) => lookup(key.toLowerCase(), ctx));
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
}

async function fail(exec: ExecutionDoc, error: string) {
  exec.set({ status: 'failed', error, waiting: null, endedAt: new Date(), lockedUntil: null });
  await exec.save();
}

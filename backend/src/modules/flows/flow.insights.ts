import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { csvCell } from '../../lib/csv.js';
import { parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { Appointment } from '../appointments/appointment.model.js';
import { Contact } from '../contacts/contact.model.js';
import { Message } from '../messages/message.model.js';
import { EXECUTION_STATUSES, Flow, FlowExecution } from './flow.model.js';

const DAY = 24 * 60 * 60 * 1000;
const objectIdString = z.string().regex(/^[a-f0-9]{24}$/);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rangeSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

const listSchema = rangeSchema.extend({
  flowId: objectIdString.optional(),
  status: z.enum(EXECUTION_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  format: z.enum(['json', 'csv']).default('json'),
});

/** Variables the engine sets for its own use; not something the customer answered. */
const INTERNAL_VARS = new Set(['last_reply', 'ai_reason', 'ai_answer', 'http_status', 'item', 'item_index']);

function rangeOf(input: z.infer<typeof rangeSchema>) {
  const to = input.to ? new Date(input.to) : new Date();
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * DAY);
  return { from, to };
}

async function contactsById(workspaceId: Types.ObjectId, ids: Types.ObjectId[]) {
  const contacts = await Contact.find({ workspaceId, _id: { $in: ids } }).select('name profileName phoneE164').lean();
  return new Map(contacts.map((c) => [c._id.toString(), { id: c._id.toString(), name: c.name || c.profileName || c.phoneE164, phone: c.phoneE164 }]));
}

/** Contacts matching a search, for filtering executions by customer. */
async function contactIdsMatching(workspaceId: Types.ObjectId, q: string) {
  const rx = { $regex: escapeRegex(q), $options: 'i' };
  const digits = q.replace(/\D/g, '');
  const found = await Contact.find({ workspaceId, $or: [{ name: rx }, { profileName: rx }, ...(digits ? [{ phoneE164: { $regex: digits } }] : [])] })
    .select('_id')
    .limit(2000)
    .lean();
  return found.map((c) => c._id);
}

/** Mounted at /api/workspaces/:workspaceId/flows/insights, before the /:flowId routes. */
export const flowInsightsRouter = Router({ mergeParams: true });

/** Flow Builder dashboard: totals, replies sent by flows per day and a per-flow table. */
flowInsightsRouter.get('/analytics', requirePermission('workspace:read'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const { from, to } = rangeOf(parse(rangeSchema, req.query));
  const timezone = req.workspace!.timezone || 'UTC';
  const inRange = { $gte: from, $lte: to };
  const day = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone } };

  const [flows, totalRuns, runsByFlow, runsByDay, repliesByDay, repliesByFlow, appointments, dataEntries] = await Promise.all([
    Flow.find({ workspaceId }).select('name status').sort({ updatedAt: -1 }).lean(),
    FlowExecution.countDocuments({ workspaceId }),
    FlowExecution.aggregate<{ _id: { f: Types.ObjectId; s: string }; n: number; last: Date }>([
      { $match: { workspaceId, createdAt: inRange } },
      { $group: { _id: { f: '$flowId', s: '$status' }, n: { $sum: 1 }, last: { $max: '$createdAt' } } },
    ]),
    FlowExecution.aggregate<{ _id: string; n: number }>([{ $match: { workspaceId, createdAt: inRange } }, { $group: { _id: day, n: { $sum: 1 } } }]),
    Message.aggregate<{ _id: string; n: number }>([
      { $match: { workspaceId, createdAt: inRange, direction: 'outbound', flowExecutionId: { $ne: null } } },
      { $group: { _id: day, n: { $sum: 1 } } },
    ]),
    Message.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { workspaceId, createdAt: inRange, direction: 'outbound', flowExecutionId: { $ne: null } } },
      { $group: { _id: '$flowExecutionId', n: { $sum: 1 } } },
      { $lookup: { from: FlowExecution.collection.name, localField: '_id', foreignField: '_id', as: 'exec' } },
      { $unwind: '$exec' },
      { $group: { _id: '$exec.flowId', n: { $sum: '$n' } } },
    ]),
    Appointment.countDocuments({ workspaceId, source: 'flow', createdAt: inRange }),
    FlowExecution.countDocuments({ workspaceId, createdAt: inRange, vars: { $nin: [null, {}] } }),
  ]);

  const perFlow = new Map<string, { runs: number; completed: number; dropped: number; lastRunAt: Date | null }>();
  for (const r of runsByFlow) {
    const k = r._id.f.toString();
    const row = perFlow.get(k) ?? { runs: 0, completed: 0, dropped: 0, lastRunAt: null };
    row.runs += r.n;
    if (r._id.s === 'completed') row.completed += r.n;
    if (r._id.s === 'exited' || r._id.s === 'failed') row.dropped += r.n;
    if (!row.lastRunAt || r.last > row.lastRunAt) row.lastRunAt = r.last;
    perFlow.set(k, row);
  }
  const replies = new Map(repliesByFlow.map((r) => [r._id.toString(), r.n]));
  const runsDay = new Map(runsByDay.map((r) => [r._id, r.n]));
  const repliesDay = new Map(repliesByDay.map((r) => [r._id, r.n]));
  const days = [...new Set([...runsDay.keys(), ...repliesDay.keys()])].sort();
  const runsInRange = [...perFlow.values()].reduce((a, r) => a + r.runs, 0);

  res.json({
    range: { from, to },
    totals: {
      flows: flows.length,
      activeFlows: flows.filter((f) => f.status === 'active').length,
      runs: totalRuns,
      runsInRange,
      replies: repliesByDay.reduce((a, r) => a + r.n, 0),
      appointments,
      dataEntries,
    },
    series: days.map((date) => ({ date, runs: runsDay.get(date) ?? 0, replies: repliesDay.get(date) ?? 0 })),
    flows: flows.map((f) => {
      const s = perFlow.get(f._id.toString()) ?? { runs: 0, completed: 0, dropped: 0, lastRunAt: null };
      return {
        id: f._id.toString(),
        name: f.name,
        status: f.status,
        runs: s.runs,
        replies: replies.get(f._id.toString()) ?? 0,
        completionRate: s.runs ? Math.round((s.completed / s.runs) * 100) : null,
        dropOffRate: s.runs ? Math.round((s.dropped / s.runs) * 100) : null,
        lastRunAt: s.lastRunAt,
      };
    }),
  });
});

/** Conversations handled by flows: which flow ran, how far the customer got and where they dropped off. */
flowInsightsRouter.get('/runs', requirePermission('workspace:read'), async (req, res) => {
  const input = parse(listSchema, req.query);
  const workspaceId = req.workspace!._id;
  const filter: Record<string, unknown> = { workspaceId };
  if (input.flowId) filter.flowId = new Types.ObjectId(input.flowId);
  if (input.status) filter.status = input.status;
  if (input.from || input.to) filter.createdAt = { ...(input.from ? { $gte: new Date(input.from) } : {}), ...(input.to ? { $lte: new Date(input.to) } : {}) };
  if (input.q) filter.contactId = { $in: await contactIdsMatching(workspaceId, input.q) };

  const [rows, total] = await Promise.all([
    FlowExecution.find(filter).sort({ createdAt: -1 }).skip((input.page - 1) * input.limit).limit(input.limit).lean(),
    FlowExecution.countDocuments(filter),
  ]);
  const [contacts, flows] = await Promise.all([
    contactsById(workspaceId, rows.map((r) => r.contactId)),
    Flow.find({ workspaceId, _id: { $in: rows.map((r) => r.flowId) } }).select('name').lean(),
  ]);
  const flowName = new Map(flows.map((f) => [f._id.toString(), f.name]));

  res.json({
    runs: rows.map((r) => {
      const last = r.log[r.log.length - 1];
      return {
        id: r._id.toString(),
        flow: { id: r.flowId.toString(), name: flowName.get(r.flowId.toString()) ?? 'Deleted flow' },
        contact: contacts.get(r.contactId.toString()) ?? null,
        status: r.status,
        steps: r.stepCount,
        lastStep: last ? { type: last.type ?? null, outcome: last.outcome ?? null, detail: last.detail ?? null } : null,
        // Ended before the flow finished: the last step reached is where the customer dropped off.
        droppedOff: r.status === 'exited' || r.status === 'failed',
        handedOff: r.exitReason === 'handoff',
        exitReason: r.exitReason,
        error: r.error,
        trigger: (r.trigger as { type?: string } | null)?.type ?? null,
        startedAt: r.createdAt,
        endedAt: r.endedAt,
      };
    }),
    total,
    pages: Math.max(1, Math.ceil(total / input.limit)),
  });
});

/** Answers customers gave inside flows (questions, forms, custom fields), one row per run. */
flowInsightsRouter.get('/collected-data', requirePermission('workspace:read'), async (req, res) => {
  const input = parse(listSchema, req.query);
  const workspaceId = req.workspace!._id;
  const filter: Record<string, unknown> = { workspaceId, vars: { $nin: [null, {}] } };
  if (input.flowId) filter.flowId = new Types.ObjectId(input.flowId);
  if (input.from || input.to) filter.createdAt = { ...(input.from ? { $gte: new Date(input.from) } : {}), ...(input.to ? { $lte: new Date(input.to) } : {}) };
  if (input.q) filter.contactId = { $in: await contactIdsMatching(workspaceId, input.q) };

  const csv = input.format === 'csv';
  const [found, total] = await Promise.all([
    FlowExecution.find(filter)
      .sort({ createdAt: -1 })
      .skip(csv ? 0 : (input.page - 1) * input.limit)
      .limit(csv ? 20_000 : input.limit)
      .select('flowId contactId vars createdAt')
      .lean(),
    FlowExecution.countDocuments(filter),
  ]);
  const [contacts, flows] = await Promise.all([
    contactsById(workspaceId, found.map((r) => r.contactId)),
    Flow.find({ workspaceId, _id: { $in: found.map((r) => r.flowId) } }).select('name').lean(),
  ]);
  const flowName = new Map(flows.map((f) => [f._id.toString(), f.name]));
  const rows = found
    .map((r) => {
      const data: Record<string, string> = {};
      for (const [k, v] of Object.entries((r.vars ?? {}) as Record<string, unknown>)) if (!INTERNAL_VARS.has(k) && !k.startsWith('_') && v != null && v !== '') data[k] = String(v);
      return { id: r._id.toString(), flow: { id: r.flowId.toString(), name: flowName.get(r.flowId.toString()) ?? 'Deleted flow' }, contact: contacts.get(r.contactId.toString()) ?? null, data, collectedAt: r.createdAt };
    })
    .filter((r) => Object.keys(r.data).length);
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r.data)))];

  if (csv) {
    const lines = [['customer', 'phone', 'flow', 'collected_at', ...columns].map(csvCell).join(',')];
    for (const r of rows) lines.push([r.contact?.name, r.contact?.phone, r.flow.name, new Date(r.collectedAt).toISOString(), ...columns.map((c) => r.data[c])].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="flow-data-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
    return;
  }
  res.json({ rows, columns, total, pages: Math.max(1, Math.ceil(total / input.limit)) });
});

/** Click-to-WhatsApp ads: leads each ad brought in, and what flows did with them. */
flowInsightsRouter.get('/ads', requirePermission('workspace:read'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const { from, to } = rangeOf(parse(rangeSchema, req.query));
  const messages = await Message.find({ workspaceId, direction: 'inbound', createdAt: { $gte: from, $lte: to }, 'content.referral': { $exists: true } })
    .sort({ createdAt: -1 })
    .limit(5000)
    .select('contactId content createdAt')
    .lean();

  const execs = messages.length
    ? await FlowExecution.find({ workspaceId, 'trigger.messageId': { $in: messages.map((m) => m._id.toString()) } }).select('flowId trigger').lean()
    : [];
  const [replyCounts, flows] = await Promise.all([
    execs.length
      ? Message.aggregate<{ _id: Types.ObjectId; n: number }>([
          { $match: { workspaceId, direction: 'outbound', flowExecutionId: { $in: execs.map((e) => e._id) } } },
          { $group: { _id: '$flowExecutionId', n: { $sum: 1 } } },
        ])
      : [],
    Flow.find({ workspaceId, _id: { $in: execs.map((e) => e.flowId) } }).select('name').lean(),
  ]);
  const repliesOf = new Map(replyCounts.map((r) => [r._id.toString(), r.n]));
  const flowName = new Map(flows.map((f) => [f._id.toString(), f.name]));
  const execOfMessage = new Map(execs.map((e) => [String((e.trigger as { messageId?: unknown }).messageId), e]));

  type Ad = { id: string; headline: string; body: string; sourceUrl: string | null; sourceType: string | null; leads: Set<string>; messages: number; flowRuns: number; replies: number; flows: Set<string>; lastLeadAt: Date };
  const ads = new Map<string, Ad>();
  for (const m of messages) {
    const ref = (m.content as { referral?: Record<string, unknown> }).referral ?? {};
    const key = String(ref.source_id ?? ref.source_url ?? ref.headline ?? 'unknown');
    const ad =
      ads.get(key) ??
      ({ id: key, headline: String(ref.headline ?? ''), body: String(ref.body ?? ''), sourceUrl: ref.source_url ? String(ref.source_url) : null, sourceType: ref.source_type ? String(ref.source_type) : null, leads: new Set(), messages: 0, flowRuns: 0, replies: 0, flows: new Set(), lastLeadAt: m.createdAt } satisfies Ad);
    ad.leads.add(m.contactId.toString());
    ad.messages += 1;
    const exec = execOfMessage.get(m._id.toString());
    if (exec) {
      ad.flowRuns += 1;
      ad.replies += repliesOf.get(exec._id.toString()) ?? 0;
      const name = flowName.get(exec.flowId.toString());
      if (name) ad.flows.add(name);
    }
    ads.set(key, ad);
  }
  const list = [...ads.values()].map((a) => ({ ...a, leads: a.leads.size, flows: [...a.flows] })).sort((a, b) => b.leads - a.leads);
  res.json({
    range: { from, to },
    totals: { ads: list.length, leads: new Set(messages.map((m) => m.contactId.toString())).size, flowRuns: list.reduce((a, r) => a + r.flowRuns, 0), replies: list.reduce((a, r) => a + r.replies, 0) },
    ads: list,
  });
});

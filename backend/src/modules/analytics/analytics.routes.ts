import { Router } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { AiUsage } from '../ai/ai.model.js';
import { User } from '../auth/user.model.js';
import { Campaign } from '../campaigns/campaign.model.js';
import { campaignStats } from '../campaigns/campaign.service.js';
import { Contact } from '../contacts/contact.model.js';
import { Flow, FlowExecution } from '../flows/flow.model.js';
import { Conversation } from '../inbox/conversation.model.js';
import { Message } from '../messages/message.model.js';
import { ConversationCycle } from './analytics.model.js';

const querySchema = z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), 'Use 7, 30 or 90.').default(30) });

function stats(values: number[]) {
  if (!values.length) return { count: 0, avgMs: null, medianMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    count: values.length,
    avgMs: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    medianMs: sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2),
  };
}

/** Every day in the range as YYYY-MM-DD in the workspace timezone, oldest first. */
function dayKeys(since: Date, days: number, timeZone: string): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return Array.from({ length: days }, (_, i) => fmt.format(new Date(since.getTime() + (i + 1) * 86_400_000)));
}

/**
 * Workspace reports, computed from stored rows (messages, cycles, executions,
 * AI usage, campaign recipients), never from client-side counters.
 */
export async function buildAnalytics(workspaceId: Types.ObjectId, timezone: string, days: number) {
  const now = new Date();
  const since = new Date(now.getTime() - days * 86_400_000);

  const [messageRows, dailyRows, contactsTotal, contactsNew, openNow, pendingNow, unassignedOpen, cycles, liveReplies, workloadRows] = await Promise.all([
    Message.aggregate<{ _id: { direction: string; status: string }; n: number }>([
      { $match: { workspaceId, createdAt: { $gte: since } } },
      { $group: { _id: { direction: '$direction', status: '$status' }, n: { $sum: 1 } } },
    ]),
    Message.aggregate<{ _id: { day: string; direction: string }; n: number }>([
      { $match: { workspaceId, createdAt: { $gte: since } } },
      { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone } }, direction: '$direction' }, n: { $sum: 1 } } },
    ]),
    Contact.countDocuments({ workspaceId }),
    Contact.countDocuments({ workspaceId, createdAt: { $gte: since } }),
    Conversation.countDocuments({ workspaceId, status: 'open' }),
    Conversation.countDocuments({ workspaceId, status: 'pending' }),
    Conversation.countDocuments({ workspaceId, status: 'open', assigneeId: null }),
    ConversationCycle.find({ workspaceId, resolvedAt: { $gte: since } }).lean(),
    // Still-open conversations that already got their first reply in the range.
    Conversation.find({ workspaceId, status: { $ne: 'resolved' }, firstReplyAt: { $gte: since } }).select('openedAt firstReplyAt assigneeId').lean(),
    Conversation.aggregate<{ _id: Types.ObjectId | null; open: number }>([
      { $match: { workspaceId, status: { $in: ['open', 'pending'] } } },
      { $group: { _id: '$assigneeId', open: { $sum: 1 } } },
    ]),
  ]);

  // ---- messages ----
  const outbound = { total: 0, queued: 0, submitted: 0, sent: 0, delivered: 0, read: 0, failed: 0 } as Record<string, number>;
  let inbound = 0;
  for (const r of messageRows) {
    if (r._id.direction === 'inbound') inbound += r.n;
    else {
      outbound.total! += r.n;
      outbound[r._id.status] = (outbound[r._id.status] ?? 0) + r.n;
    }
  }
  const reached = (outbound.delivered ?? 0) + (outbound.read ?? 0);
  const settled = reached + (outbound.sent ?? 0) + (outbound.failed ?? 0);
  const keys = dayKeys(since, days, timezone);
  const byDay = new Map(keys.map((k) => [k, { day: k, inbound: 0, outbound: 0 }]));
  for (const r of dailyRows) {
    const row = byDay.get(r._id.day);
    if (row) row[r._id.direction === 'inbound' ? 'inbound' : 'outbound'] += r.n;
  }

  // ---- inbox ----
  const firstResponses = [
    ...cycles.filter((c) => c.firstReplyAt).map((c) => ({ assignee: c.assigneeId?.toString() ?? null, ms: c.firstReplyAt!.getTime() - c.openedAt.getTime() })),
    ...liveReplies.map((c) => ({ assignee: c.assigneeId?.toString() ?? null, ms: c.firstReplyAt!.getTime() - c.openedAt!.getTime() })),
  ].filter((r) => r.ms >= 0);
  const resolutions = cycles.map((c) => ({ assignee: c.assigneeId?.toString() ?? null, ms: c.resolvedAt.getTime() - c.openedAt.getTime() })).filter((r) => r.ms >= 0);

  const agentIds = new Set<string>([...workloadRows.map((w) => w._id?.toString()), ...resolutions.map((r) => r.assignee)].filter((v): v is string => !!v));
  const users = await User.find({ _id: { $in: [...agentIds] } }).select('name').lean();
  const agents = users
    .map((u) => {
      const id = u._id.toString();
      return {
        userId: id,
        name: u.name,
        open: workloadRows.find((w) => w._id?.toString() === id)?.open ?? 0,
        resolved: resolutions.filter((r) => r.assignee === id).length,
        firstResponse: stats(firstResponses.filter((r) => r.assignee === id).map((r) => r.ms)),
      };
    })
    .sort((a, b) => b.resolved - a.resolved || b.open - a.open);

  // ---- campaigns ----
  const campaigns = await Campaign.find({ workspaceId, launchedAt: { $gte: since } }).sort({ launchedAt: -1 }).limit(10).lean();
  const cStats = await campaignStats(workspaceId, campaigns.map((c) => c._id));

  // ---- automation ----
  const [execRows, dropRows] = await Promise.all([
    FlowExecution.aggregate<{ _id: { flowId: Types.ObjectId; status: string }; n: number; goals: number }>([
      { $match: { workspaceId, createdAt: { $gte: since } } },
      { $group: { _id: { flowId: '$flowId', status: '$status' }, n: { $sum: 1 }, goals: { $sum: { $cond: [{ $ifNull: ['$goal', false] }, 1, 0] } } } },
    ]),
    // Where runs stopped without finishing: the step they were on.
    FlowExecution.aggregate<{ _id: { flowId: Types.ObjectId; nodeId: string; status: string }; n: number }>([
      { $match: { workspaceId, createdAt: { $gte: since }, status: { $in: ['failed', 'exited'] } } },
      { $group: { _id: { flowId: '$flowId', nodeId: '$currentNodeId', status: '$status' }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 50 },
    ]),
  ]);
  const flowIds = [...new Set(execRows.map((r) => r._id.flowId.toString()))];
  const flows = await Flow.find({ workspaceId, _id: { $in: flowIds } }).select('name draftGraph').lean();
  const automation = flows
    .map((f) => {
      const id = f._id.toString();
      const rows = execRows.filter((r) => r._id.flowId.toString() === id);
      const count = (s: string) => rows.filter((r) => r._id.status === s).reduce((a, r) => a + r.n, 0);
      const nodes = ((f.draftGraph as { nodes?: { id: string; type: string; data?: { text?: string; question?: string } }[] })?.nodes ?? []);
      return {
        flowId: id,
        name: f.name,
        started: rows.reduce((a, r) => a + r.n, 0),
        completed: count('completed'),
        active: count('running') + count('waiting'),
        exited: count('exited'),
        failed: count('failed'),
        goals: rows.reduce((a, r) => a + r.goals, 0),
        dropOffs: dropRows
          .filter((d) => d._id.flowId.toString() === id)
          .slice(0, 3)
          .map((d) => {
            const node = nodes.find((n) => n.id === d._id.nodeId);
            return { nodeId: d._id.nodeId, type: node?.type ?? 'unknown', label: node?.data?.question ?? node?.data?.text ?? null, status: d._id.status, count: d.n };
          }),
      };
    })
    .sort((a, b) => b.started - a.started);

  // ---- AI ----
  const aiRows = await AiUsage.aggregate<{ _id: string; n: number; latency: number; inTok: number; outTok: number }>([
    { $match: { workspaceId, createdAt: { $gte: since }, purpose: { $ne: 'test' } } },
    { $group: { _id: '$outcome', n: { $sum: 1 }, latency: { $sum: '$latencyMs' }, inTok: { $sum: '$inputTokens' }, outTok: { $sum: '$outputTokens' } } },
  ]);
  const aiTotal = aiRows.reduce((a, r) => a + r.n, 0);
  const aiBy = (o: string) => aiRows.find((r) => r._id === o)?.n ?? 0;
  const answeredLatency = aiRows.find((r) => r._id === 'answered');

  return {
    range: { days, since, until: now, timezone },
    contacts: { total: contactsTotal, new: contactsNew },
    messages: {
      inbound,
      outbound,
      deliveryRate: settled ? reached / settled : null,
      readRate: reached ? (outbound.read ?? 0) / reached : null,
      failureRate: settled ? (outbound.failed ?? 0) / settled : null,
      daily: [...byDay.values()],
    },
    inbox: {
      openNow,
      pendingNow,
      unassignedOpen,
      resolved: cycles.length,
      firstResponse: stats(firstResponses.map((r) => r.ms)),
      resolution: stats(resolutions.map((r) => r.ms)),
      agents,
    },
    campaigns: campaigns.map((c) => {
      const s = cStats.get(c._id.toString()) ?? {};
      return {
        id: c._id.toString(),
        name: c.name,
        status: c.status,
        launchedAt: c.launchedAt,
        total: s.total ?? 0,
        delivered: (s.delivered ?? 0) + (s.read ?? 0),
        read: s.read ?? 0,
        replied: s.replied ?? 0,
        failed: s.failed ?? 0,
        skipped: s.skipped ?? 0,
      };
    }),
    automation,
    ai: {
      total: aiTotal,
      answered: aiBy('answered'),
      handedOff: aiBy('handoff') + aiBy('escalated') + aiBy('capped'),
      errors: aiBy('error'),
      resolvedRate: aiTotal ? aiBy('answered') / aiTotal : null,
      avgLatencyMs: answeredLatency?.n ? Math.round(answeredLatency.latency / answeredLatency.n) : null,
      inputTokens: aiRows.reduce((a, r) => a + r.inTok, 0),
      outputTokens: aiRows.reduce((a, r) => a + r.outTok, 0),
    },
  };
}

/** Mounted at /api/workspaces/:workspaceId/analytics (workspace already loaded). */
export const analyticsRouter = Router({ mergeParams: true });

analyticsRouter.get('/', requirePermission('conversations:view_all'), async (req, res) => {
  const { days } = parse(querySchema, req.query);
  res.json(await buildAnalytics(req.workspace!._id, req.workspace!.timezone, days));
});

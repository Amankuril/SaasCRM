import { Router, type Request } from 'express';
import { z } from 'zod';
import { notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { getAgent } from '../ai/ai.service.js';
import { audit } from '../audit/audit.service.js';
import { Flow } from '../flows/flow.model.js';
import { activeVersions, eventFlow, keywordFlow } from '../flows/triggers.js';
import { ACTION_TYPES, AutoReply, MESSAGE_SOURCES, type AutoReplyDoc } from './autoReply.model.js';
import { autoReplyInputSchema, findEventAutoReply, findKeywordAutoReply, saveAutoReply, setActive } from './autoReply.service.js';

const userName = (u: unknown) => (u && typeof u === 'object' && 'name' in u ? ((u as { name?: string }).name ?? null) : null);

function serialize(r: AutoReplyDoc) {
  return {
    id: r.id as string,
    name: r.name,
    active: r.active,
    match: r.match,
    keywords: r.keywords,
    event: r.event,
    sources: r.sources,
    cooldownMinutes: r.cooldownMinutes,
    action: r.action,
    firedCount: r.firedCount,
    lastFiredAt: r.lastFiredAt,
    createdBy: userName(r.createdBy),
    updatedBy: userName(r.updatedBy),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const listSchema = z.object({
  status: z.enum(['active', 'inactive']).optional(),
  type: z.enum(ACTION_TYPES).optional(),
  q: z.string().trim().max(100).optional(),
});

const bulkSchema = z.object({
  ids: z.array(z.string().regex(/^[a-f0-9]{24}$/)).min(1).max(200),
  action: z.enum(['activate', 'deactivate', 'delete']),
});

const trySchema = z.object({
  text: z.string().trim().max(4096).default(''),
  firstMessage: z.boolean().default(false),
  source: z.enum(MESSAGE_SOURCES).default('direct'),
  outsideHours: z.boolean().default(false),
});

/** Mounted at /api/workspaces/:workspaceId/auto-replies (workspace already loaded). */
export const autoReplyRouter = Router({ mergeParams: true });

async function load(req: Request) {
  const rule = await AutoReply.findOne({ _id: objectId(req.params.autoReplyId, 'Auto reply'), workspaceId: req.workspace!._id }).populate('createdBy updatedBy', 'name');
  if (!rule) throw notFound('Auto reply not found.');
  return rule;
}

autoReplyRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const { status, type, q } = parse(listSchema, req.query);
  const escaped = q?.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = await AutoReply.find({
    workspaceId: req.workspace!._id,
    ...(status ? { active: status === 'active' } : {}),
    ...(type ? { 'action.type': type } : {}),
    ...(escaped ? { $or: [{ keywords: { $regex: escaped } }, { name: { $regex: escaped, $options: 'i' } }] } : {}),
  })
    .sort({ createdAt: -1 })
    .populate('createdBy updatedBy', 'name');
  res.json({ autoReplies: rules.map(serialize), total: await AutoReply.countDocuments({ workspaceId: req.workspace!._id }) });
});

/**
 * "Try a message": which automation would answer this message. Read-only:
 * nothing is sent and cooldowns are not considered.
 */
autoReplyRouter.post('/try', requirePermission('workspace:read'), async (req, res) => {
  const input = parse(trySchema, req.body);
  const workspaceId = req.workspace!._id;
  const notes: string[] = [];
  if (input.outsideHours) notes.push('Working-hours replies (Default Actions) are not set up yet, so outside hours behaves the same.');

  const keyword = await findKeywordAutoReply(workspaceId, input.text, input.source);
  if (keyword) {
    await keyword.rule.populate('createdBy updatedBy', 'name');
    return res.json({ outcome: 'auto_reply', matchedBy: keyword.rule.match, matchedKeyword: keyword.keyword, autoReply: serialize(keyword.rule), flow: null, notes });
  }
  const versions = await activeVersions(workspaceId);
  const flowName = async (flowId: unknown) => (await Flow.findOne({ _id: flowId, workspaceId }).select('name').lean())?.name ?? 'Flow';
  const kf = keywordFlow(versions, input.text);
  if (kf) return res.json({ outcome: 'flow', matchedBy: 'keyword', autoReply: null, flow: { id: String(kf.flowId), name: await flowName(kf.flowId) }, notes });

  const ev = await findEventAutoReply(workspaceId, input.firstMessage, input.source);
  if (ev) {
    await ev.populate('createdBy updatedBy', 'name');
    return res.json({ outcome: 'auto_reply', matchedBy: ev.event, matchedKeyword: null, autoReply: serialize(ev), flow: null, notes });
  }
  const ef = eventFlow(versions, input.firstMessage);
  if (ef) return res.json({ outcome: 'flow', matchedBy: ef.trigger?.event, autoReply: null, flow: { id: String(ef.flowId), name: await flowName(ef.flowId) }, notes });

  const agent = await getAgent(workspaceId);
  if (agent?.enabled && agent.autoReply && input.text) return res.json({ outcome: 'ai', autoReply: null, flow: null, notes });
  res.json({ outcome: 'none', autoReply: null, flow: null, notes });
});

autoReplyRouter.post('/bulk', requirePermission('flows:manage'), async (req, res) => {
  const { ids, action } = parse(bulkSchema, req.body);
  const filter = { workspaceId: req.workspace!._id, _id: { $in: ids } };
  if (action === 'delete') {
    const { deletedCount } = await AutoReply.deleteMany(filter);
    await audit(req, { workspaceId: req.workspace!._id, action: 'auto_reply.deleted', targetType: 'auto_reply', metadata: { count: deletedCount } });
    return res.json({ updated: deletedCount });
  }
  // One by one so turning triggers on still checks keyword clashes.
  let updated = 0;
  const errors: string[] = [];
  for (const rule of await AutoReply.find(filter)) {
    try {
      await setActive(rule, action === 'activate', req.user!._id);
      updated++;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  res.json({ updated, errors });
});

autoReplyRouter.post('/', requirePermission('flows:manage'), async (req, res) => {
  const input = parse(autoReplyInputSchema, req.body);
  const rule = await saveAutoReply(req.workspace!._id, req.user!._id, input);
  await audit(req, { workspaceId: req.workspace!._id, action: 'auto_reply.created', targetType: 'auto_reply', targetId: rule.id, metadata: { name: rule.name } });
  await rule.populate('createdBy updatedBy', 'name');
  res.status(201).json({ autoReply: serialize(rule) });
});

autoReplyRouter.get('/:autoReplyId', requirePermission('workspace:read'), async (req, res) => {
  res.json({ autoReply: serialize(await load(req)) });
});

autoReplyRouter.put('/:autoReplyId', requirePermission('flows:manage'), async (req, res) => {
  const rule = await load(req);
  const input = parse(autoReplyInputSchema, req.body);
  const saved = await saveAutoReply(req.workspace!._id, req.user!._id, input, rule);
  await audit(req, { workspaceId: req.workspace!._id, action: 'auto_reply.updated', targetType: 'auto_reply', targetId: saved.id, metadata: { name: saved.name } });
  await saved.populate('createdBy updatedBy', 'name');
  res.json({ autoReply: serialize(saved) });
});

autoReplyRouter.patch('/:autoReplyId/status', requirePermission('flows:manage'), async (req, res) => {
  const { active } = parse(z.object({ active: z.boolean() }), req.body);
  const rule = await setActive(await load(req), active, req.user!._id);
  await rule.populate('createdBy updatedBy', 'name');
  res.json({ autoReply: serialize(rule) });
});

autoReplyRouter.delete('/:autoReplyId', requirePermission('flows:manage'), async (req, res) => {
  const rule = await load(req);
  await AutoReply.deleteOne({ _id: rule._id, workspaceId: req.workspace!._id });
  await audit(req, { workspaceId: req.workspace!._id, action: 'auto_reply.deleted', targetType: 'auto_reply', targetId: rule.id, metadata: { name: rule.name } });
  res.status(204).end();
});

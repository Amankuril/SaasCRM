import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { audit } from '../audit/audit.service.js';
import { Contact } from '../contacts/contact.model.js';
import { normalizePhone } from '../contacts/contact.service.js';
import { exitExecutions, startExecution } from './engine.js';
import { EXECUTION_STATUSES, Flow, FlowExecution, FlowVersion, type FlowDoc } from './flow.model.js';
import { validateFlow } from './flow.validate.js';
import { DEFAULT_GRAPH, graphSchema, nodeConfigSchemas, type Graph } from './graph.js';

const updateSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the flow.').max(120),
    description: z.string().trim().max(500),
    draftGraph: graphSchema,
    settings: z.object({ allowReentry: z.boolean(), exitOnReply: z.boolean() }),
  })
  .partial();

const executionsSchema = z.object({
  status: z.enum(EXECUTION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Mounted at /api/workspaces/:workspaceId/flows (workspace already loaded). */
export const flowRouter = Router({ mergeParams: true });

flowRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const flows = await Flow.find({ workspaceId }).sort({ updatedAt: -1 });
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const counts = await FlowExecution.aggregate<{ _id: { f: Types.ObjectId; s: string }; n: number }>([
    { $match: { workspaceId, createdAt: { $gte: since } } },
    { $group: { _id: { f: '$flowId', s: '$status' }, n: { $sum: 1 } } },
  ]);
  const stats = new Map<string, Record<string, number>>();
  for (const c of counts) {
    const k = c._id.f.toString();
    stats.set(k, { ...(stats.get(k) ?? {}), [c._id.s]: c.n });
  }
  res.json({ flows: flows.map((f) => ({ ...summary(f), stats30d: stats.get(f.id as string) ?? {} })) });
});

flowRouter.post('/', requirePermission('flows:manage'), async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(120).default('Untitled flow') }), req.body);
  const flow = await Flow.create({ workspaceId: req.workspace!._id, name, draftGraph: DEFAULT_GRAPH, createdBy: req.user!._id });
  res.status(201).json({ flow: detail(flow) });
});

flowRouter.get('/:flowId', requirePermission('workspace:read'), async (req, res) => {
  res.json({ flow: detail(await findFlow(req.workspace!._id, req.params.flowId)) });
});

flowRouter.patch('/:flowId', requirePermission('flows:manage'), async (req, res) => {
  const input = parse(updateSchema, req.body);
  const flow = await findFlow(req.workspace!._id, req.params.flowId);
  if (input.name !== undefined) flow.name = input.name;
  if (input.description !== undefined) flow.description = input.description;
  if (input.settings) flow.settings = input.settings;
  if (input.draftGraph) {
    flow.draftGraph = input.draftGraph;
    flow.draftUpdatedAt = new Date();
  }
  await flow.save();
  res.json({ flow: detail(flow) });
});

flowRouter.post('/:flowId/validate', requirePermission('workspace:read'), async (req, res) => {
  const flow = await findFlow(req.workspace!._id, req.params.flowId);
  res.json({ issues: await validateFlow(req.workspace!._id, flow._id, flow.draftGraph as Graph) });
});

/** Freezes the draft as a new immutable version and makes it live. */
flowRouter.post('/:flowId/publish', requirePermission('flows:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const flow = await findFlow(workspaceId, req.params.flowId);
  const graph = graphSchema.parse(flow.draftGraph);
  const issues = await validateFlow(workspaceId, flow._id, graph);
  if (issues.length) throw new AppError(422, 'FLOW_INVALID', 'Fix the highlighted steps before publishing.', { issues });

  // Store each step's config with defaults applied, so the engine never sees half-filled data.
  graph.nodes = graph.nodes.map((node) => ({ ...node, data: nodeConfigSchemas[node.type].parse(node.data) as Record<string, unknown> }));
  const trigger = graph.nodes.find((n) => n.type === 'trigger')!.data as { event: string; keywords?: string[]; match?: string; tagId?: string };
  const version = await FlowVersion.create({
    workspaceId,
    flowId: flow._id,
    version: flow.publishedVersion + 1,
    graph,
    trigger: { event: trigger.event, keywords: trigger.keywords ?? [], match: trigger.match ?? 'exact', tagId: trigger.tagId ?? null },
    publishedBy: req.user!._id,
  });
  flow.set({ publishedVersionId: version._id, publishedVersion: version.version, publishedAt: new Date(), status: 'active' });
  await flow.save();
  await audit(req, { workspaceId, action: 'flow.published', targetType: 'flow', targetId: flow.id, metadata: { name: flow.name, version: version.version } });
  res.json({ flow: detail(flow) });
});

flowRouter.post('/:flowId/activate', requirePermission('flows:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const flow = await findFlow(workspaceId, req.params.flowId);
  if (!flow.publishedVersionId) throw conflict('NOT_PUBLISHED', 'Publish the flow first.');
  const version = await FlowVersion.findOne({ _id: flow.publishedVersionId, workspaceId });
  const issues = (await validateFlow(workspaceId, flow._id, version!.graph as Graph)).filter((i) => /already uses|already used/.test(i.message));
  if (issues.length) throw new AppError(422, 'FLOW_INVALID', issues[0]!.message, { issues });
  flow.status = 'active';
  await flow.save();
  await audit(req, { workspaceId, action: 'flow.activated', targetType: 'flow', targetId: flow.id });
  res.json({ flow: detail(flow) });
});

/** Stops new runs and ends the ones in progress. */
flowRouter.post('/:flowId/deactivate', requirePermission('flows:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const flow = await findFlow(workspaceId, req.params.flowId);
  flow.status = flow.publishedVersionId ? 'inactive' : 'draft';
  await flow.save();
  await exitExecutions({ workspaceId, flowId: flow._id }, 'flow_deactivated');
  await audit(req, { workspaceId, action: 'flow.deactivated', targetType: 'flow', targetId: flow.id });
  res.json({ flow: detail(flow) });
});

flowRouter.delete('/:flowId', requirePermission('flows:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const flow = await findFlow(workspaceId, req.params.flowId);
  if (flow.status === 'active') throw conflict('FLOW_ACTIVE', 'Deactivate the flow before deleting it.');
  await exitExecutions({ workspaceId, flowId: flow._id }, 'flow_deleted');
  await Flow.deleteOne({ _id: flow._id, workspaceId });
  await audit(req, { workspaceId, action: 'flow.deleted', targetType: 'flow', targetId: flow.id, metadata: { name: flow.name } });
  res.status(204).end();
});

/** Runs the live version for one contact right now (a "test" or manual start). */
flowRouter.post('/:flowId/test', requirePermission('flows:manage'), async (req, res) => {
  const { phone } = parse(z.object({ phone: z.string().trim().min(5).max(30) }), req.body);
  const workspaceId = req.workspace!._id;
  const flow = await findFlow(workspaceId, req.params.flowId);
  if (flow.status !== 'active' || !flow.publishedVersionId) throw conflict('NOT_ACTIVE', 'Publish the flow before testing it.');
  const phoneE164 = normalizePhone(phone, req.workspace!.country);
  if (!phoneE164) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { phone: ['Enter a valid phone number.'] });
  const contact = await Contact.findOne({ workspaceId, phoneE164 });
  if (!contact) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { phone: ['No contact with this number. Message the business number from it first.'] });

  const version = await FlowVersion.findOne({ _id: flow.publishedVersionId, workspaceId });
  const exec = await startExecution(version!, contact._id, { type: 'manual' });
  if (!exec) throw conflict('ALREADY_RUNNING', 'This contact is already in this flow.');
  const fresh = await FlowExecution.findOne({ _id: exec._id, workspaceId });
  res.status(201).json({ execution: serializeExecution(fresh!) });
});

flowRouter.get('/:flowId/executions', requirePermission('workspace:read'), async (req, res) => {
  const { status, limit } = parse(executionsSchema, req.query);
  const workspaceId = req.workspace!._id;
  const flow = await findFlow(workspaceId, req.params.flowId);
  const rows = await FlowExecution.find({ workspaceId, flowId: flow._id, ...(status ? { status } : {}) }).sort({ createdAt: -1 }).limit(limit);
  const contacts = await Contact.find({ workspaceId, _id: { $in: rows.map((r) => r.contactId) } }).select('name profileName phoneE164').lean();
  const byId = new Map(contacts.map((c) => [c._id.toString(), c]));
  res.json({
    executions: rows.map((r) => {
      const c = byId.get(r.contactId.toString());
      return { ...serializeExecution(r), contact: c ? { name: c.name || c.profileName || c.phoneE164, phone: c.phoneE164 } : null };
    }),
  });
});

async function findFlow(workspaceId: Types.ObjectId, id: unknown): Promise<FlowDoc> {
  const flow = await Flow.findOne({ _id: objectId(id, 'Flow'), workspaceId });
  if (!flow) throw notFound('Flow not found.');
  return flow;
}

function summary(f: FlowDoc) {
  const trigger = ((f.draftGraph as Graph).nodes ?? []).find((n) => n.type === 'trigger')?.data as { event?: string; keywords?: string[] } | undefined;
  return {
    id: f.id as string,
    name: f.name,
    description: f.description,
    status: f.status,
    publishedVersion: f.publishedVersion,
    trigger: trigger ? { event: trigger.event ?? null, keywords: trigger.keywords ?? [] } : null,
    hasUnpublishedChanges: !f.publishedAt || f.draftUpdatedAt.getTime() > f.publishedAt.getTime(),
    draftUpdatedAt: f.draftUpdatedAt,
    updatedAt: f.updatedAt,
  };
}

function detail(f: FlowDoc) {
  return { ...summary(f), draftGraph: f.draftGraph as Graph, settings: { allowReentry: !!f.settings?.allowReentry, exitOnReply: !!f.settings?.exitOnReply } };
}

function serializeExecution(e: InstanceType<typeof FlowExecution>) {
  return {
    id: e.id as string,
    status: e.status,
    currentNodeId: e.currentNodeId,
    waiting: e.waiting ? { kind: e.waiting.kind, nodeId: e.waiting.nodeId, until: e.waiting.until } : null,
    trigger: e.trigger,
    stepCount: e.stepCount,
    error: e.error,
    exitReason: e.exitReason,
    goal: e.goal,
    log: e.log,
    createdAt: e.createdAt,
    endedAt: e.endedAt,
  };
}

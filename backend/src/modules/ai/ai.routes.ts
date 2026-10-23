import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { encryptSecret } from '../../lib/crypto.js';
import { AppError, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { assertFeature } from '../billing/billing.service.js';
import { audit } from '../audit/audit.service.js';
import { AI_MODELS, AiAgent, AiUsage, type AiAgentDoc } from './ai.model.js';
import { runAgent } from './ai.service.js';
import { KnowledgeChunk, KnowledgeSource, type KnowledgeSourceDoc } from './knowledge.model.js';
import { indexSource, ingestUrl } from './knowledge.service.js';
import { aiProvider } from './provider.js';

const settingsSchema = z
  .object({
    enabled: z.boolean(),
    autoReply: z.boolean(),
    name: z.string().trim().min(1).max(60),
    tone: z.enum(['friendly', 'professional', 'concise']),
    language: z.string().trim().min(2).max(40),
    businessContext: z.string().trim().max(2000),
    instructions: z.string().trim().max(4000),
    fallbackMessage: z.string().trim().min(1).max(500),
    handoffMessage: z.string().trim().min(1).max(500),
    escalationKeywords: z.array(z.string().trim().min(1).max(40)).max(30),
    maxRepliesPerConversation: z.number().int().min(1).max(50),
    model: z.enum(AI_MODELS),
    // Write-only: a new key, or null to remove the workspace key.
    apiKey: z.string().trim().min(20).max(300).nullable(),
  })
  .partial();

const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), title: z.string().trim().min(1).max(200), content: z.string().trim().min(20, 'Add at least a sentence or two.').max(200_000) }),
  z.object({ type: z.literal('faq'), question: z.string().trim().min(3).max(500), answer: z.string().trim().min(2).max(5000) }),
  z.object({ type: z.literal('url'), url: z.string().trim().url().max(2000) }),
]);

function serializeAgent(agent: AiAgentDoc | null) {
  const a = agent ?? new AiAgent();
  return {
    enabled: a.enabled,
    autoReply: a.autoReply,
    name: a.name,
    tone: a.tone,
    language: a.language,
    businessContext: a.businessContext,
    instructions: a.instructions,
    fallbackMessage: a.fallbackMessage,
    handoffMessage: a.handoffMessage,
    escalationKeywords: a.escalationKeywords,
    maxRepliesPerConversation: a.maxRepliesPerConversation,
    model: a.model,
    apiKey: a.apiKeyLast4 ? { source: 'workspace', last4: a.apiKeyLast4 } : env.ANTHROPIC_API_KEY ? { source: 'platform', last4: null } : null,
  };
}

function serializeSource(s: KnowledgeSourceDoc) {
  return {
    id: s.id as string,
    type: s.type,
    title: s.title,
    url: s.url,
    status: s.status,
    error: s.error,
    chunkCount: s.chunkCount,
    preview: s.content.slice(0, 280),
    lastIngestedAt: s.lastIngestedAt,
    createdAt: s.createdAt,
  };
}

/** Mounted at /api/workspaces/:workspaceId/ai (workspace already loaded). */
export const aiRouter = Router({ mergeParams: true });

aiRouter.get('/settings', requirePermission('workspace:read'), async (req, res) => {
  const agent = await AiAgent.findOne({ workspaceId: req.workspace!._id });
  res.json({ settings: serializeAgent(agent), provider: aiProvider().name });
});

aiRouter.put('/settings', requirePermission('ai:manage'), async (req, res) => {
  const { apiKey, ...input } = parse(settingsSchema, req.body);
  const workspaceId = req.workspace!._id;
  const agent = (await AiAgent.findOne({ workspaceId }).select('+apiKeyEncrypted')) ?? new AiAgent({ workspaceId });
  agent.set(input);
  if (agent.enabled && agent.isModified('enabled')) await assertFeature(workspaceId, 'ai');
  if (apiKey !== undefined) {
    agent.apiKeyEncrypted = apiKey ? encryptSecret(apiKey) : null;
    agent.apiKeyLast4 = apiKey ? apiKey.slice(-4) : null;
  }
  // The real model needs a key from somewhere before the agent can be switched on.
  if (agent.enabled && aiProvider().name === 'anthropic' && !agent.apiKeyEncrypted && !env.ANTHROPIC_API_KEY) {
    throw new AppError(400, 'AI_KEY_REQUIRED', 'Add an Anthropic API key before turning the AI agent on.');
  }
  agent.updatedBy = req.user!._id;
  await agent.save();
  await audit(req, {
    workspaceId,
    action: 'ai.settings_updated',
    targetType: 'ai_agent',
    targetId: agent.id,
    metadata: { enabled: agent.enabled, autoReply: agent.autoReply, model: agent.model, apiKeyChanged: apiKey !== undefined },
  });
  res.json({ settings: serializeAgent(agent) });
});

/** Try the agent without sending anything to a customer. */
aiRouter.post('/test', requirePermission('ai:manage'), async (req, res) => {
  const { question } = parse(z.object({ question: z.string().trim().min(1).max(1000) }), req.body);
  const agent = await AiAgent.findOne({ workspaceId: req.workspace!._id }).select('+apiKeyEncrypted');
  const decision = await runAgent({ workspace: req.workspace!, agent: agent ?? new AiAgent({ workspaceId: req.workspace!._id }), question, purpose: 'test' });
  res.json({ decision });
});

aiRouter.get('/usage', requirePermission('ai:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await AiUsage.aggregate<{ _id: string; count: number; input: number; output: number }>([
    { $match: { workspaceId, createdAt: { $gte: since } } },
    { $group: { _id: '$outcome', count: { $sum: 1 }, input: { $sum: '$inputTokens' }, output: { $sum: '$outputTokens' } } },
  ]);
  const byOutcome = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  res.json({
    since,
    total: rows.reduce((a, r) => a + r.count, 0),
    byOutcome,
    inputTokens: rows.reduce((a, r) => a + r.input, 0),
    outputTokens: rows.reduce((a, r) => a + r.output, 0),
  });
});

aiRouter.get('/knowledge', requirePermission('workspace:read'), async (req, res) => {
  const sources = await KnowledgeSource.find({ workspaceId: req.workspace!._id }).sort({ createdAt: -1 });
  res.json({ sources: sources.map(serializeSource) });
});

aiRouter.post('/knowledge', requirePermission('ai:manage'), async (req, res) => {
  const input = parse(sourceSchema, req.body);
  const workspaceId = req.workspace!._id;
  if ((await KnowledgeSource.countDocuments({ workspaceId })) >= 200) throw new AppError(409, 'KNOWLEDGE_LIMIT', 'A workspace can have at most 200 knowledge sources.');

  const source = new KnowledgeSource({
    workspaceId,
    createdBy: req.user!._id,
    ...(input.type === 'text'
      ? { type: 'text', title: input.title, content: input.content }
      : input.type === 'faq'
        ? { type: 'faq', title: input.question, content: `Q: ${input.question}\nA: ${input.answer}` }
        : { type: 'url', title: input.url, url: input.url }),
  });
  if (source.type === 'url') await ingestUrl(source);
  else await indexSource(source);
  await audit(req, { workspaceId, action: 'ai.knowledge_added', targetType: 'knowledge', targetId: source.id, metadata: { type: source.type, title: source.title } });
  res.status(201).json({ source: serializeSource(source) });
});

aiRouter.post('/knowledge/:sourceId/refresh', requirePermission('ai:manage'), async (req, res) => {
  const source = await findSource(req.workspace!._id, req.params.sourceId);
  if (source.type === 'url') await ingestUrl(source);
  else await indexSource(source);
  res.json({ source: serializeSource(source) });
});

aiRouter.delete('/knowledge/:sourceId', requirePermission('ai:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const source = await findSource(workspaceId, req.params.sourceId);
  await KnowledgeChunk.deleteMany({ workspaceId, sourceId: source._id });
  await KnowledgeSource.deleteOne({ _id: source._id, workspaceId });
  await audit(req, { workspaceId, action: 'ai.knowledge_deleted', targetType: 'knowledge', targetId: source.id, metadata: { title: source.title } });
  res.status(204).end();
});

async function findSource(workspaceId: Types.ObjectId, id: unknown) {
  const source = await KnowledgeSource.findOne({ _id: objectId(id, 'Knowledge source'), workspaceId });
  if (!source) throw notFound('Knowledge source not found.');
  return source;
}

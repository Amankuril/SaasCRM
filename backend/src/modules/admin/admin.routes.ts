import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { queueStats } from '../../jobs/queue.js';
import { notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { adminLog } from './admin.service.js';
import { adminPlatformRouter } from './adminPlatform.routes.js';
import { adminUsersRouter, escapeRegex } from './adminUsers.routes.js';
import { adminWorkspaceRouter } from './adminWorkspace.routes.js';
import { adminPagesRouter } from './sitePages.js';
import { FEATURE_KEYS, LIMIT_KEYS, Plan, SUBSCRIPTION_STATUSES, Subscription, type FeatureKey, type LimitKey } from '../billing/billing.model.js';
import { toPublicPlan, toPublicSubscription } from '../billing/billing.routes.js';
import { adminUpdateSubscription, getSubscription } from '../billing/billing.service.js';
import { ensurePlans } from '../billing/plans.js';
import { WebhookDelivery, WebhookEndpoint } from '../developer/developer.model.js';
import { FlowExecution } from '../flows/flow.model.js';
import { Message } from '../messages/message.model.js';
import { ProviderConnection } from '../whatsapp/connection.model.js';
import { WebhookEvent } from '../whatsapp/webhookEvent.model.js';
import { User } from '../auth/user.model.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { WORKSPACE_STATUSES, Workspace, toPublicWorkspace } from '../workspaces/workspace.model.js';

const listSchema = z.object({
  status: z.enum(WORKSPACE_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
});

/** Mounted at /api/admin behind requireAuth + requirePlatformAdmin. */
export const adminRouter = Router();
adminRouter.use('/users', adminUsersRouter);
adminRouter.use('/pages', adminPagesRouter);
adminRouter.use('/workspaces/:id', adminWorkspaceRouter);
adminRouter.use(adminPlatformRouter);

adminRouter.get('/stats', async (_req, res) => {
  const [users, byStatus] = await Promise.all([
    User.countDocuments(),
    Workspace.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const workspaces = Object.fromEntries(WORKSPACE_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const row of byStatus) workspaces[row._id] = row.count;

  // Billing overview (deliberate cross-tenant aggregate for the platform owner).
  await ensurePlans();
  const [subRows, plans] = await Promise.all([
    Subscription.aggregate<{ _id: { status: string; plan: string; cycle: string }; n: number }>([{ $group: { _id: { status: '$status', plan: '$planCode', cycle: '$cycle' }, n: { $sum: 1 } } }]).option({ skipTenantScope: true }),
    Plan.find().lean(),
  ]);
  const price = new Map(plans.map((p) => [p.code, p]));
  const subscriptions: Record<string, number> = {};
  let mrr = 0;
  for (const r of subRows) {
    subscriptions[r._id.status] = (subscriptions[r._id.status] ?? 0) + r.n;
    const p = price.get(r._id.plan);
    if (p && (r._id.status === 'active' || r._id.status === 'past_due')) mrr += r.n * (r._id.cycle === 'yearly' ? p.priceYearly / 12 : p.priceMonthly);
  }
  res.json({ users, workspaces, subscriptions, mrr: Math.round(mrr), currency: 'INR' });
});

adminRouter.get('/workspaces', async (req, res) => {
  const { status, q } = parse(listSchema, req.query);
  // Search matches the business name/slug or any member's email/name.
  let byPeople: unknown[] = [];
  if (q) {
    const people = await User.find({ $or: [{ email: { $regex: escapeRegex(q), $options: 'i' } }, { name: { $regex: escapeRegex(q), $options: 'i' } }] }).select('_id').limit(200).lean();
    byPeople = await WorkspaceMember.distinct('workspaceId', { userId: { $in: people.map((u) => u._id) } }).setOptions({ skipTenantScope: true });
  }
  const filter = {
    ...(status ? { status } : {}),
    ...(q ? { $or: [{ name: { $regex: escapeRegex(q), $options: 'i' } }, { slug: { $regex: escapeRegex(q), $options: 'i' } }, { _id: { $in: byPeople } }] } : {}),
  };
  const workspaces = await Workspace.find(filter).sort({ createdAt: -1 }).limit(200);
  const ids = workspaces.map((w) => w._id);

  // Platform-admin view: deliberately reads memberships of many tenants at once ($in).
  const members = await WorkspaceMember.find({ workspaceId: { $in: ids } }).lean();
  const owners = await User.find({ _id: { $in: members.filter((m) => m.role === 'owner').map((m) => m.userId) } }).lean();
  const ownerEmail = new Map(owners.map((u) => [u._id.toString(), u.email]));

  const subs = await Subscription.find({ workspaceId: { $in: ids } }).lean();
  const subByWs = new Map(subs.map((x) => [x.workspaceId.toString(), x]));

  res.json({
    workspaces: workspaces.map((ws) => {
      const own = members.filter((m) => m.workspaceId.equals(ws._id));
      const sub = subByWs.get(ws.id as string);
      return {
        ...toPublicWorkspace(ws),
        subscription: sub
          ? { planCode: sub.planCode, status: sub.status, cycle: sub.cycle, currentPeriodEnd: sub.currentPeriodEnd, trialEndsAt: sub.trialEndsAt, provider: sub.provider }
          : null,
        suspendedReason: ws.suspendedReason,
        memberCount: own.length,
        owners: own.filter((m) => m.role === 'owner').map((m) => ownerEmail.get(m.userId.toString()) ?? null),
      };
    }),
  });
});

// ---- Subscription overrides (offline payments, extensions, comps) ----

const subscriptionOverrideSchema = z
  .object({
    planCode: z.string().trim().min(1),
    status: z.enum(SUBSCRIPTION_STATUSES),
    cycle: z.enum(['monthly', 'yearly']),
    extendDays: z.number().int().min(1).max(365),
    reason: z.string().trim().max(500),
  })
  .partial()
  .refine((v) => v.planCode || v.status || v.cycle || v.extendDays, 'Nothing to change.');

adminRouter.patch('/workspaces/:id/subscription', async (req, res) => {
  const input = parse(subscriptionOverrideSchema, req.body);
  const workspace = await Workspace.findById(objectId(req.params.id, 'Workspace'));
  if (!workspace) throw notFound('Workspace not found.');
  const before = await getSubscription(workspace._id);
  const snapshot = { planCode: before.planCode, status: before.status, currentPeriodEnd: before.currentPeriodEnd, trialEndsAt: before.trialEndsAt };
  const sub = await adminUpdateSubscription(workspace._id, input);
  await adminLog(req, {
    workspace,
    action: 'admin.subscription_changed',
    targetType: 'workspace',
    targetId: workspace.id,
    metadata: { before: snapshot, change: input, after: { planCode: sub.planCode, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, trialEndsAt: sub.trialEndsAt } },
  });
  res.json({ subscription: toPublicSubscription(sub) });
});

// ---- Plan catalog ----

adminRouter.get('/plans', async (_req, res) => {
  await ensurePlans();
  const plans = await Plan.find().sort({ sortOrder: 1 });
  const counts = await Subscription.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$planCode', n: { $sum: 1 } } }]).option({ skipTenantScope: true });
  res.json({ plans: plans.map((p) => ({ ...toPublicPlan(p), sortOrder: p.sortOrder, providerPlanIds: p.providerPlanIds, subscribers: counts.find((c) => c._id === p.code)?.n ?? 0 })) });
});

const limitValue = z.number().int().min(0).max(100_000_000).nullable();
const planUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(300),
    priceMonthly: z.number().int().min(0).max(100_000_000),
    priceYearly: z.number().int().min(0).max(1_000_000_000),
    limits: z.object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, limitValue])) as Record<LimitKey, typeof limitValue>).partial(),
    features: z.object(Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean()])) as Record<FeatureKey, z.ZodBoolean>).partial(),
    trialDays: z.number().int().min(0).max(90),
    graceDays: z.number().int().min(0).max(60),
    isPublic: z.boolean(),
    providerPlanIds: z.object({ monthly: z.string().trim().max(64).nullable(), yearly: z.string().trim().max(64).nullable() }).partial(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

adminRouter.patch('/plans/:code', async (req, res) => {
  const input = parse(planUpdateSchema, req.body);
  await ensurePlans();
  const plan = await Plan.findOne({ code: String(req.params.code).toLowerCase() });
  if (!plan) throw notFound('Plan not found.');
  const before = toPublicPlan(plan);
  const { limits, features, providerPlanIds, ...rest } = input;
  plan.set(rest);
  for (const [k, v] of Object.entries(limits ?? {})) plan.set(`limits.${k}`, v);
  for (const [k, v] of Object.entries(features ?? {})) plan.set(`features.${k}`, v);
  for (const [k, v] of Object.entries(providerPlanIds ?? {})) plan.set(`providerPlanIds.${k}`, v || null);
  await plan.save();
  await adminLog(req, { action: 'admin.plan_updated', targetType: 'plan', targetId: plan.code, metadata: { before, change: input } });
  res.json({ plan: toPublicPlan(plan) });
});

// ---- Operations ----

/** Health of the moving parts: queues, failing deliveries/sends/runs, billing attention list. */
adminRouter.get('/ops', async (_req, res) => {
  const dayAgo = new Date(Date.now() - 86_400_000);
  const weekAhead = new Date(Date.now() + 7 * 86_400_000);
  const cross = { skipTenantScope: true } as const;
  const [queues, failedMessages, failedRuns, deadDeliveries, retryingDeliveries, webhookBacklog, disabledEndpoints, trialsEnding, pastDue, brokenConnections] = await Promise.all([
    queueStats().catch(() => null),
    Message.countDocuments({ status: 'failed', failedAt: { $gte: dayAgo } }).setOptions(cross),
    FlowExecution.countDocuments({ status: 'failed', endedAt: { $gte: dayAgo } }).setOptions(cross),
    WebhookDelivery.countDocuments({ status: 'dead', createdAt: { $gte: dayAgo } }).setOptions(cross),
    WebhookDelivery.countDocuments({ status: 'retrying' }).setOptions(cross),
    WebhookEvent.countDocuments({ status: { $in: ['pending', 'failed'] } }).setOptions(cross),
    WebhookEndpoint.countDocuments({ status: 'disabled' }).setOptions(cross),
    Subscription.find({ status: 'trialing', trialEndsAt: { $lte: weekAhead } }).setOptions(cross).sort({ trialEndsAt: 1 }).limit(20).lean(),
    Subscription.find({ status: { $in: ['past_due', 'suspended'] } }).setOptions(cross).sort({ graceEndsAt: 1 }).limit(20).lean(),
    ProviderConnection.countDocuments({ status: { $ne: 'connected' } }).setOptions(cross),
  ]);
  const wsIds = [...trialsEnding, ...pastDue].map((x) => x.workspaceId);
  const names = new Map((await Workspace.find({ _id: { $in: wsIds } }).select('name').lean()).map((w) => [w._id.toString(), w.name]));
  const row = (x: (typeof pastDue)[number]) => ({ workspaceId: x.workspaceId.toString(), name: names.get(x.workspaceId.toString()) ?? '?', planCode: x.planCode, status: x.status, trialEndsAt: x.trialEndsAt, graceEndsAt: x.graceEndsAt });
  res.json({
    db: mongoose.connection.readyState === 1 ? 'up' : 'down',
    queues,
    last24h: { failedMessages, failedRuns, deadDeliveries },
    now: { retryingDeliveries, webhookBacklog, disabledEndpoints, brokenConnections },
    billing: { trialsEnding: trialsEnding.map(row), pastDue: pastDue.map(row) },
  });
});

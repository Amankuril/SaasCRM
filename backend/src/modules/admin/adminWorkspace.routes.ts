import { Router } from 'express';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { emailSchema, objectId, parse, timezoneSchema } from '../../lib/validate.js';
import { AuditLog } from '../audit/auditLog.model.js';
import { User } from '../auth/user.model.js';
import { FEATURE_KEYS, Invoice, LIMIT_KEYS, USAGE_METRICS, UsageCounter, type FeatureKey, type LimitKey } from '../billing/billing.model.js';
import { toPublicSubscription, usageSummary } from '../billing/billing.routes.js';
import { getEntitlements, usageFor } from '../billing/billing.service.js';
import { ROLES } from '../roles.js';
import { ProviderConnection, toPublicConnection } from '../whatsapp/connection.model.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { WORKSPACE_STATUSES, Workspace, toPublicWorkspace } from '../workspaces/workspace.model.js';
import { adminLog, deleteWorkspaceData, exportWorkspace, workspaceDataCounts } from './admin.service.js';

/** Mounted at /api/admin/workspaces/:id. Platform admin only. */
export const adminWorkspaceRouter = Router({ mergeParams: true });

async function loadWs(id: string | undefined) {
  const ws = await Workspace.findById(objectId(id, 'Workspace'));
  if (!ws) throw notFound('Workspace not found.');
  return ws;
}

/** Everything about one business on one screen: members, plan, usage, data, WhatsApp, invoices, recent activity. */
adminWorkspaceRouter.get('/', async (req, res) => {
  const ws = await loadWs((req.params as { id?: string }).id);
  const e = await getEntitlements(ws._id);
  const sub = e.subscription;
  const [members, usage, counts, connection, invoices, auditRows] = await Promise.all([
    WorkspaceMember.find({ workspaceId: ws._id }).sort({ joinedAt: 1 }).lean(),
    usageSummary(ws._id, sub.currentPeriodStart),
    workspaceDataCounts(ws._id),
    ProviderConnection.findOne({ workspaceId: ws._id }),
    Invoice.find({ workspaceId: ws._id }).sort({ createdAt: -1 }).limit(50).lean(),
    AuditLog.find({ workspaceId: ws._id }).sort({ _id: -1 }).limit(100).lean(),
  ]);
  const userIds = [...members.map((m) => m.userId), ...auditRows.map((r) => r.actorUserId).filter((x) => x != null)];
  const users = await User.find({ _id: { $in: userIds } }).lean();
  const userById = new Map(users.map((u) => [u._id.toString(), u]));

  res.json({
    workspace: { ...toPublicWorkspace(ws), suspendedReason: ws.suspendedReason, updatedAt: ws.updatedAt },
    members: members.map((m) => {
      const u = userById.get(m.userId.toString());
      return { id: m._id.toString(), userId: m.userId.toString(), name: u?.name ?? 'Unknown user', email: u?.email ?? null, userStatus: u?.status ?? null, lastLoginAt: u?.lastLoginAt ?? null, role: m.role, joinedAt: m.joinedAt };
    }),
    subscription: { ...toPublicSubscription(sub), providerSubscriptionId: sub.providerSubscriptionId },
    plan: { code: e.plan.code, name: e.plan.name, limits: e.plan.toObject().limits, features: e.plan.toObject().features },
    overrides: { limits: sub.limitOverrides ?? {}, features: sub.featureOverrides ?? {} },
    entitlements: { access: e.access, limits: e.limits, features: e.features },
    usage,
    counts,
    connection: connection ? toPublicConnection(connection) : null,
    invoices: invoices.map((i) => ({ id: i._id.toString(), number: i.number, planCode: i.planCode, cycle: i.cycle, amount: i.amount, currency: i.currency, status: i.status, provider: i.provider, providerPaymentId: i.providerPaymentId, failureReason: i.failureReason, paidAt: i.paidAt, createdAt: i.createdAt })),
    audit: auditRows.map((r) => {
      const u = r.actorUserId ? userById.get(r.actorUserId.toString()) : undefined;
      return { id: r._id.toString(), action: r.action, targetType: r.targetType, targetId: r.targetId, metadata: r.metadata, actor: u ? { name: u.name, email: u.email, isPlatformAdmin: u.isPlatformAdmin } : null, ip: r.ip, createdAt: r.createdAt };
    }),
  });
});

const editSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    timezone: timezoneSchema,
    country: z.string().trim().length(2).toUpperCase(),
    currency: z.string().trim().length(3).toUpperCase(),
    industry: z.string().trim().max(60).nullable(),
    status: z.enum(WORKSPACE_STATUSES),
    reason: z.string().trim().max(500).optional(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

/** Edit any business field, or change its status (suspend / reactivate / back to setup). */
adminWorkspaceRouter.patch('/', async (req, res) => {
  const { reason, ...changes } = parse(editSchema, req.body);
  const ws = await loadWs((req.params as { id?: string }).id);
  const before = Object.fromEntries(Object.keys(changes).map((k) => [k, ws.get(k)]));
  ws.set(changes);
  if (changes.status) ws.suspendedReason = changes.status === 'suspended' ? (reason ?? null) : null;
  await ws.save();
  const action = changes.status && Object.keys(changes).length === 1 ? 'admin.workspace_status_changed' : 'admin.workspace_updated';
  await adminLog(req, { action, targetType: 'workspace', targetId: ws.id, workspace: ws, metadata: { before, change: changes, reason: reason ?? null } });
  res.json({ workspace: { ...toPublicWorkspace(ws), suspendedReason: ws.suspendedReason } });
});

// ---- Members ----

const addMemberSchema = z.object({ email: emailSchema, role: z.enum(ROLES) });

/** Adds an existing account straight into the workspace (no invite email). */
adminWorkspaceRouter.post('/members', async (req, res) => {
  const { email, role } = parse(addMemberSchema, req.body);
  const ws = await loadWs((req.params as { id?: string }).id);
  const user = await User.findOne({ email });
  if (!user) throw notFound('No account with this email. Ask them to sign up first, or invite them from the workspace.');
  if (await WorkspaceMember.exists({ workspaceId: ws._id, userId: user._id })) throw conflict('ALREADY_MEMBER', 'This person is already a member.');
  const m = await WorkspaceMember.create({ workspaceId: ws._id, userId: user._id, role, invitedBy: req.user!._id });
  await adminLog(req, { action: 'admin.member_added', targetType: 'member', targetId: m.id, workspace: ws, metadata: { email, role } });
  res.status(201).json({ member: { id: m.id, userId: user.id, email, role } });
});

const roleSchema = z.object({ role: z.enum(ROLES) });

/** Any role change, including making someone owner (ownership transfer). */
adminWorkspaceRouter.patch('/members/:memberId', async (req, res) => {
  const { role } = parse(roleSchema, req.body);
  const ws = await loadWs((req.params as { id?: string }).id);
  const m = await WorkspaceMember.findOne({ workspaceId: ws._id, _id: objectId(req.params.memberId, 'Member') });
  if (!m) throw notFound('Member not found.');
  if (m.role === 'owner' && role !== 'owner') await assertAnotherOwner(ws._id);
  const from = m.role;
  m.role = role;
  await m.save();
  await adminLog(req, { action: 'admin.member_role_changed', targetType: 'member', targetId: m.id, workspace: ws, metadata: { userId: m.userId.toString(), from, to: role } });
  res.json({ member: { id: m.id, role: m.role } });
});

adminWorkspaceRouter.delete('/members/:memberId', async (req, res) => {
  const ws = await loadWs((req.params as { id?: string }).id);
  const m = await WorkspaceMember.findOne({ workspaceId: ws._id, _id: objectId(req.params.memberId, 'Member') });
  if (!m) throw notFound('Member not found.');
  if (m.role === 'owner') await assertAnotherOwner(ws._id);
  await m.deleteOne();
  await adminLog(req, { action: 'admin.member_removed', targetType: 'member', targetId: m.id, workspace: ws, metadata: { userId: m.userId.toString(), role: m.role } });
  res.status(204).end();
});

async function assertAnotherOwner(workspaceId: import('mongoose').Types.ObjectId) {
  const owners = await WorkspaceMember.countDocuments({ workspaceId, role: 'owner' });
  if (owners <= 1) throw badRequest('LAST_OWNER', 'A workspace needs at least one owner. Make someone else owner first.');
}

// ---- Plan overrides (custom limits / features for one business) ----

const limitOverride = z.number().int().min(0).max(1_000_000_000).nullable();
const overridesSchema = z.object({
  // A key set to `"plan"` removes that override (back to the plan value).
  limits: z.record(z.enum(LIMIT_KEYS), z.union([limitOverride, z.literal('plan')])).optional(),
  features: z.record(z.enum(FEATURE_KEYS), z.union([z.boolean(), z.literal('plan')])).optional(),
});

adminWorkspaceRouter.put('/overrides', async (req, res) => {
  const input = parse(overridesSchema, req.body);
  const ws = await loadWs((req.params as { id?: string }).id);
  const { subscription: sub } = await getEntitlements(ws._id);
  const before = { limits: { ...(sub.limitOverrides ?? {}) }, features: { ...(sub.featureOverrides ?? {}) } };
  const limits = { ...(sub.limitOverrides ?? {}) } as Record<string, unknown>;
  const features = { ...(sub.featureOverrides ?? {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(input.limits ?? {})) {
    if (v === 'plan') delete limits[k as LimitKey];
    else limits[k] = v;
  }
  for (const [k, v] of Object.entries(input.features ?? {})) {
    if (v === 'plan') delete features[k as FeatureKey];
    else features[k] = v;
  }
  sub.limitOverrides = limits;
  sub.featureOverrides = features;
  sub.markModified('limitOverrides');
  sub.markModified('featureOverrides');
  await sub.save();
  await adminLog(req, { action: 'admin.plan_overrides_changed', targetType: 'workspace', targetId: ws.id, workspace: ws, metadata: { before, after: { limits, features } } });
  const e = await getEntitlements(ws._id);
  res.json({ overrides: { limits, features }, entitlements: { access: e.access, limits: e.limits, features: e.features } });
});

// ---- Usage ----

const usageSchema = z.object({
  metric: z.enum(USAGE_METRICS).optional(),
  // Set the counter to this value (default 0 = reset).
  value: z.number().int().min(0).max(1_000_000_000).default(0),
});

/** Resets (or corrects) this period's metered usage, e.g. messages wrongly counted. */
adminWorkspaceRouter.post('/usage', async (req, res) => {
  const { metric, value } = parse(usageSchema, req.body);
  const ws = await loadWs((req.params as { id?: string }).id);
  const { subscription: sub } = await getEntitlements(ws._id);
  const before = await usageFor(ws._id, sub.currentPeriodStart);
  for (const m of metric ? [metric] : USAGE_METRICS) {
    await UsageCounter.updateOne({ workspaceId: ws._id, periodStart: sub.currentPeriodStart, metric: m }, { $set: { count: value } }, { upsert: true });
  }
  const after = await usageFor(ws._id, sub.currentPeriodStart);
  await adminLog(req, { action: 'admin.usage_adjusted', targetType: 'workspace', targetId: ws.id, workspace: ws, metadata: { before, after } });
  res.json({ usage: after });
});

// ---- Support access ----

/** Logged once when an admin opens the business's app (the access itself is checked in loadWorkspace). */
adminWorkspaceRouter.post('/support-access', async (req, res) => {
  const ws = await loadWs((req.params as { id?: string }).id);
  await adminLog(req, { action: 'admin.support_access_opened', targetType: 'workspace', targetId: ws.id, workspace: ws });
  res.json({ url: `/w/${ws.id}` });
});

// ---- Data ----

adminWorkspaceRouter.get('/export', async (req, res) => {
  const ws = await loadWs((req.params as { id?: string }).id);
  const data = await exportWorkspace(ws._id);
  await adminLog(req, { action: 'admin.workspace_exported', targetType: 'workspace', targetId: ws.id, workspace: ws, metadata: { collections: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])) } });
  res.setHeader('Content-Disposition', `attachment; filename="${ws.slug}-export.json"`);
  res.json({ exportedAt: new Date(), workspace: ws.toObject(), data });
});

const deleteSchema = z.object({ confirm: z.string() });

/** Permanently deletes the business and everything it owns. The caller must type the exact name. */
adminWorkspaceRouter.delete('/', async (req, res) => {
  const { confirm } = parse(deleteSchema, req.body);
  const ws = await loadWs((req.params as { id?: string }).id);
  if (confirm !== ws.name) throw badRequest('CONFIRM_MISMATCH', 'Type the exact business name to confirm.');
  const removed = await deleteWorkspaceData(ws._id);
  await ws.deleteOne();
  // The workspace's own audit log is gone with it; the platform log keeps the record.
  await adminLog(req, { action: 'admin.workspace_deleted', targetType: 'workspace', targetId: ws.id, metadata: { name: ws.name, slug: ws.slug, removed } });
  res.json({ removed });
});

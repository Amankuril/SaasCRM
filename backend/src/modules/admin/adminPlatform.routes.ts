import { Router } from 'express';
import { z } from 'zod';
import { enqueue } from '../../jobs/queue.js';
import { objectId, parse } from '../../lib/validate.js';
import { AuditLog } from '../audit/auditLog.model.js';
import { User } from '../auth/user.model.js';
import { Workspace } from '../workspaces/workspace.model.js';
import { WebhookEvent } from '../whatsapp/webhookEvent.model.js';
import { AdminAction } from './admin.model.js';
import { adminLog, clearPlatformSettingsCache, platformSettings } from './admin.service.js';
import { escapeRegex } from './adminUsers.routes.js';

/** Mounted at /api/admin (settings, activity, audit search, ops actions). Platform admin only. */
export const adminPlatformRouter = Router();

// ---- Platform settings ----

function publicSettings(s: Awaited<ReturnType<typeof platformSettings>>) {
  return {
    announcement: { active: s.announcement?.active ?? false, text: s.announcement?.text ?? '', tone: s.announcement?.tone ?? 'info' },
    signupsEnabled: s.signupsEnabled,
    maintenanceMode: s.maintenanceMode,
    maintenanceMessage: s.maintenanceMessage,
    updatedAt: s.updatedAt,
  };
}

adminPlatformRouter.get('/settings', async (_req, res) => {
  clearPlatformSettingsCache();
  res.json({ settings: publicSettings(await platformSettings()) });
});

const settingsSchema = z
  .object({
    announcement: z.object({ active: z.boolean(), text: z.string().trim().max(500), tone: z.enum(['info', 'warning', 'critical']) }).partial(),
    signupsEnabled: z.boolean(),
    maintenanceMode: z.boolean(),
    maintenanceMessage: z.string().trim().max(300),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

adminPlatformRouter.patch('/settings', async (req, res) => {
  const input = parse(settingsSchema, req.body);
  clearPlatformSettingsCache();
  const s = await platformSettings();
  const before = publicSettings(s);
  const { announcement, ...rest } = input;
  s.set(rest);
  for (const [k, v] of Object.entries(announcement ?? {})) s.set(`announcement.${k}`, v);
  await s.save();
  clearPlatformSettingsCache();
  const after = publicSettings(s);
  await adminLog(req, { action: 'admin.platform_settings_changed', targetType: 'platform', metadata: { before, after } });
  res.json({ settings: after });
});

// ---- Admin activity (everything done from this panel) ----

const activitySchema = z.object({
  before: z.string().optional(),
  action: z.string().trim().max(80).optional(),
  workspaceId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

adminPlatformRouter.get('/activity', async (req, res) => {
  const { before, action, workspaceId, limit } = parse(activitySchema, req.query);
  const filter = {
    ...(before ? { _id: { $lt: objectId(before, 'Cursor') } } : {}),
    ...(action ? { action: { $regex: escapeRegex(action), $options: 'i' } } : {}),
    ...(workspaceId ? { workspaceId: objectId(workspaceId, 'Workspace') } : {}),
  };
  const rows = await AdminAction.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const page = rows.slice(0, limit);
  const actors = await User.find({ _id: { $in: page.map((r) => r.actorUserId) } }).select('name email').lean();
  const byId = new Map(actors.map((u) => [u._id.toString(), { name: u.name, email: u.email }]));
  res.json({
    items: page.map((r) => ({
      id: r._id.toString(),
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      workspaceId: r.workspaceId?.toString() ?? null,
      workspaceName: r.workspaceName,
      metadata: r.metadata,
      actor: byId.get(r.actorUserId.toString()) ?? null,
      ip: r.ip,
      createdAt: r.createdAt,
    })),
    nextCursor: rows.length > limit ? page.at(-1)!._id.toString() : null,
  });
});

// ---- Audit logs across every business ----

const auditSchema = z.object({
  before: z.string().optional(),
  action: z.string().trim().max(80).optional(),
  workspaceId: z.string().optional(),
  actorEmail: z.string().trim().toLowerCase().max(254).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

adminPlatformRouter.get('/audit-logs', async (req, res) => {
  const { before, action, workspaceId, actorEmail, limit } = parse(auditSchema, req.query);
  const actor = actorEmail ? await User.findOne({ email: actorEmail }).select('_id').lean() : null;
  if (actorEmail && !actor) return void res.json({ items: [], nextCursor: null });
  const filter = {
    ...(before ? { _id: { $lt: objectId(before, 'Cursor') } } : {}),
    ...(action ? { action: { $regex: escapeRegex(action), $options: 'i' } } : {}),
    ...(workspaceId ? { workspaceId: objectId(workspaceId, 'Workspace') } : {}),
    ...(actor ? { actorUserId: actor._id } : {}),
  };
  // Deliberate cross-tenant read for the platform owner.
  const rows = await AuditLog.find(filter).setOptions({ skipTenantScope: true }).sort({ _id: -1 }).limit(limit + 1).lean();
  const page = rows.slice(0, limit);
  const [users, workspaces] = await Promise.all([
    User.find({ _id: { $in: page.map((r) => r.actorUserId).filter((x) => x != null) } }).select('name email isPlatformAdmin').lean(),
    Workspace.find({ _id: { $in: page.map((r) => r.workspaceId) } }).select('name').lean(),
  ]);
  const userById = new Map(users.map((u) => [u._id.toString(), { name: u.name, email: u.email, isPlatformAdmin: u.isPlatformAdmin }]));
  const wsName = new Map(workspaces.map((w) => [w._id.toString(), w.name]));
  res.json({
    items: page.map((r) => ({
      id: r._id.toString(),
      workspaceId: r.workspaceId.toString(),
      workspaceName: wsName.get(r.workspaceId.toString()) ?? null,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: r.metadata,
      actor: r.actorUserId ? (userById.get(r.actorUserId.toString()) ?? null) : null,
      ip: r.ip,
      createdAt: r.createdAt,
    })),
    nextCursor: rows.length > limit ? page.at(-1)!._id.toString() : null,
  });
});

// ---- Ops actions ----

/** Re-queues Meta webhooks that failed or got stuck (e.g. after an outage or a bug fix). */
adminPlatformRouter.post('/ops/webhook-events/retry', async (req, res) => {
  const stuckBefore = new Date(Date.now() - 5 * 60_000);
  const events = await WebhookEvent.find({ $or: [{ status: 'failed' }, { status: 'pending', createdAt: { $lt: stuckBefore } }] }).select('_id').limit(5_000).lean();
  for (const e of events) await enqueue('webhook.process', { eventId: e._id.toString() }, { jobId: `retry-${e._id.toString()}-${Date.now()}` });
  await adminLog(req, { action: 'admin.webhook_events_requeued', targetType: 'platform', metadata: { count: events.length } });
  res.json({ requeued: events.length });
});

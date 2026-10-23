import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { audit } from '../audit/audit.service.js';
import { User } from '../auth/user.model.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { WORKSPACE_STATUSES, Workspace, toPublicWorkspace } from '../workspaces/workspace.model.js';

const listSchema = z.object({
  status: z.enum(WORKSPACE_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
});

const statusSchema = z.object({
  status: z.enum(WORKSPACE_STATUSES),
  reason: z.string().trim().max(500).optional(),
});

/** Mounted at /api/admin behind requireAuth + requirePlatformAdmin. */
export const adminRouter = Router();

adminRouter.get('/stats', async (_req, res) => {
  const [users, byStatus] = await Promise.all([
    User.countDocuments(),
    Workspace.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const workspaces = Object.fromEntries(WORKSPACE_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const row of byStatus) workspaces[row._id] = row.count;
  res.json({ users, workspaces });
});

adminRouter.get('/workspaces', async (req, res) => {
  const { status, q } = parse(listSchema, req.query);
  const filter = {
    ...(status ? { status } : {}),
    ...(q ? { name: { $regex: escapeRegex(q), $options: 'i' } } : {}),
  };
  const workspaces = await Workspace.find(filter).sort({ createdAt: -1 }).limit(200);
  const ids = workspaces.map((w) => w._id);

  // Platform-admin view: deliberately reads memberships of many tenants at once ($in).
  const members = await WorkspaceMember.find({ workspaceId: { $in: ids } }).lean();
  const owners = await User.find({ _id: { $in: members.filter((m) => m.role === 'owner').map((m) => m.userId) } }).lean();
  const ownerEmail = new Map(owners.map((u) => [u._id.toString(), u.email]));

  res.json({
    workspaces: workspaces.map((ws) => {
      const own = members.filter((m) => m.workspaceId.equals(ws._id));
      return {
        ...toPublicWorkspace(ws),
        suspendedReason: ws.suspendedReason,
        memberCount: own.length,
        owners: own.filter((m) => m.role === 'owner').map((m) => ownerEmail.get(m.userId.toString()) ?? null),
      };
    }),
  });
});

adminRouter.patch('/workspaces/:id', async (req, res) => {
  const { status, reason } = parse(statusSchema, req.body);
  const workspace = await Workspace.findById(objectId(req.params.id, 'Workspace'));
  if (!workspace) throw notFound('Workspace not found.');

  const from = workspace.status;
  workspace.status = status;
  workspace.suspendedReason = status === 'suspended' ? (reason ?? null) : null;
  await workspace.save();
  await audit(req, {
    workspaceId: workspace._id,
    action: 'admin.workspace_status_changed',
    targetType: 'workspace',
    targetId: workspace.id,
    metadata: { from, to: status, reason: reason ?? null },
  });
  res.json({ workspace: { ...toPublicWorkspace(workspace), suspendedReason: workspace.suspendedReason } });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

import { Router } from 'express';
import { z } from 'zod';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { User } from '../auth/user.model.js';
import { AuditLog } from './auditLog.model.js';

const querySchema = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Mounted at /api/workspaces/:workspaceId/audit-logs (workspace already loaded). */
export const auditRouter = Router({ mergeParams: true });

auditRouter.get('/', requirePermission('audit:read'), async (req, res) => {
  const { before, limit } = parse(querySchema, req.query);
  const filter = {
    workspaceId: req.workspace!._id,
    ...(before ? { _id: { $lt: objectId(before, 'Cursor') } } : {}),
  };
  const rows = await AuditLog.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const page = rows.slice(0, limit);

  const actorIds = [...new Set(page.map((r) => r.actorUserId?.toString()).filter(Boolean))];
  const actors = await User.find({ _id: { $in: actorIds } }).lean();
  const actorById = new Map(actors.map((u) => [u._id.toString(), { name: u.name, email: u.email }]));

  res.json({
    items: page.map((r) => ({
      id: r._id.toString(),
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: r.metadata,
      actor: r.actorUserId ? (actorById.get(r.actorUserId.toString()) ?? null) : null,
      createdAt: r.createdAt,
    })),
    nextCursor: rows.length > limit ? page.at(-1)!._id.toString() : null,
  });
});

import type { RequestHandler } from 'express';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { objectId } from '../lib/validate.js';
import { can, type Permission, type Role } from '../modules/roles.js';
import { WorkspaceMember } from '../modules/workspaces/member.model.js';
import { Workspace } from '../modules/workspaces/workspace.model.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves `:workspaceId` through the signed-in user's membership. A user who is not a
 * member gets 404 (not 403) so workspace ids cannot be probed.
 */
export const loadWorkspace: RequestHandler = async (req, _res, next) => {
  const workspaceId = objectId(req.params.workspaceId, 'Workspace');

  const membership = await WorkspaceMember.findOne({ workspaceId, userId: req.user!._id });
  if (!membership) throw notFound('Workspace not found.');

  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) throw notFound('Workspace not found.');

  // Suspended workspaces stay readable (export, history) but cannot change anything.
  if (workspace.status === 'suspended' && !READ_METHODS.has(req.method)) {
    throw new AppError(403, 'WORKSPACE_SUSPENDED', 'This workspace is suspended. Contact support to restore access.');
  }

  req.workspace = workspace;
  req.membership = membership;
  next();
};

export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.membership || !can(req.membership.role as Role, permission)) throw forbidden();
    next();
  };
}

import { Router } from 'express';
import { z } from 'zod';
import { conflict, forbidden, notFound, badRequest } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { audit } from '../audit/audit.service.js';
import { User } from '../auth/user.model.js';
import { ROLES, can, canAssignRole, type Role } from '../roles.js';
import { WorkspaceMember } from './member.model.js';

const updateRoleSchema = z.object({ role: z.enum(ROLES) });

/** Mounted at /api/workspaces/:workspaceId/members (workspace already loaded). */
export const memberRouter = Router({ mergeParams: true });

memberRouter.get('/', requirePermission('members:read'), async (req, res) => {
  const members = await WorkspaceMember.find({ workspaceId: req.workspace!._id }).sort({ joinedAt: 1 }).lean();
  const users = await User.find({ _id: { $in: members.map((m) => m.userId) } }).lean();
  const userById = new Map(users.map((u) => [u._id.toString(), u]));

  res.json({
    members: members.map((m) => {
      const user = userById.get(m.userId.toString());
      return {
        id: m._id.toString(),
        userId: m.userId.toString(),
        name: user?.name ?? 'Unknown user',
        email: user?.email ?? null,
        role: m.role,
        joinedAt: m.joinedAt,
      };
    }),
  });
});

memberRouter.patch('/:memberId', requirePermission('members:manage'), async (req, res) => {
  const { role: newRole } = parse(updateRoleSchema, req.body);
  const actorRole = req.membership!.role as Role;
  const target = await findMember(req.workspace!._id, req.params.memberId);

  if (target.userId.equals(req.user!._id)) throw badRequest('CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role.');
  if (target.role === 'owner' && actorRole !== 'owner') throw forbidden('Only an owner can change another owner.');
  if (!canAssignRole(actorRole, newRole)) throw forbidden('You cannot assign this role.');
  if (target.role === 'owner' && newRole !== 'owner') await assertNotLastOwner(req.workspace!._id);

  const previousRole = target.role;
  target.role = newRole;
  await target.save();
  await audit(req, {
    workspaceId: req.workspace!._id,
    action: 'member.role_changed',
    targetType: 'member',
    targetId: target.id,
    metadata: { userId: target.userId.toString(), from: previousRole, to: newRole },
  });
  res.json({ member: { id: target.id, role: target.role } });
});

memberRouter.delete('/:memberId', async (req, res) => {
  const actorRole = req.membership!.role as Role;
  const target = await findMember(req.workspace!._id, req.params.memberId);
  const leaving = target.userId.equals(req.user!._id);

  if (!leaving) {
    if (!can(actorRole, 'members:manage')) throw forbidden();
    if (target.role === 'owner' && actorRole !== 'owner') throw forbidden('Only an owner can remove another owner.');
  }
  if (target.role === 'owner') await assertNotLastOwner(req.workspace!._id);

  await WorkspaceMember.deleteOne({ _id: target._id, workspaceId: req.workspace!._id });
  await audit(req, {
    workspaceId: req.workspace!._id,
    action: leaving ? 'member.left' : 'member.removed',
    targetType: 'member',
    targetId: target.id,
    metadata: { userId: target.userId.toString(), role: target.role },
  });
  res.status(204).end();
});

async function findMember(workspaceId: unknown, memberId: unknown) {
  const member = await WorkspaceMember.findOne({ _id: objectId(memberId, 'Member'), workspaceId });
  if (!member) throw notFound('Member not found.');
  return member;
}

async function assertNotLastOwner(workspaceId: unknown) {
  const owners = await WorkspaceMember.countDocuments({ workspaceId, role: 'owner' });
  if (owners <= 1) throw conflict('LAST_OWNER', 'A workspace must keep at least one owner. Make someone else an owner first.');
}

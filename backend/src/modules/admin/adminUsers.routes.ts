import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { hashPassword } from '../auth/auth.service.js';
import { Session } from '../auth/session.model.js';
import { User, toPublicUser } from '../auth/user.model.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { Workspace } from '../workspaces/workspace.model.js';
import { adminLog } from './admin.service.js';

/** Mounted at /api/admin/users. Platform admin only. */
export const adminUsersRouter = Router();

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  admins: z.enum(['1']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const PAGE = 50;

adminUsersRouter.get('/', async (req, res) => {
  const { q, status, admins, page } = parse(listSchema, req.query);
  const filter = {
    ...(status ? { status } : {}),
    ...(admins ? { isPlatformAdmin: true } : {}),
    ...(q ? { $or: [{ email: { $regex: escapeRegex(q), $options: 'i' } }, { name: { $regex: escapeRegex(q), $options: 'i' } }] } : {}),
  };
  const [total, users] = await Promise.all([User.countDocuments(filter), User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE)]);
  const ids = users.map((u) => u._id);
  // Platform-admin view: memberships and sessions of many users at once.
  const [members, live] = await Promise.all([
    WorkspaceMember.find({ userId: { $in: ids } }).setOptions({ skipTenantScope: true }).lean(),
    Session.aggregate<{ _id: string; n: number }>([{ $match: { userId: { $in: ids }, revokedAt: null, expiresAt: { $gt: new Date() } } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]),
  ]);
  const sessions = new Map(live.map((r) => [r._id.toString(), r.n]));
  res.json({
    total,
    pageSize: PAGE,
    users: users.map((u) => ({
      ...toPublicUser(u),
      status: u.status,
      lastLoginAt: u.lastLoginAt,
      workspaceCount: members.filter((m) => m.userId.equals(u._id)).length,
      activeSessions: sessions.get(u.id as string) ?? 0,
    })),
  });
});

adminUsersRouter.get('/:id', async (req, res) => {
  const user = await loadUser(req.params.id);
  const memberships = await WorkspaceMember.find({ userId: user._id }).setOptions({ skipTenantScope: true }).lean();
  const workspaces = await Workspace.find({ _id: { $in: memberships.map((m) => m.workspaceId) } }).select('name status').lean();
  const wsById = new Map(workspaces.map((w) => [w._id.toString(), w]));
  const sessions = await Session.find({ userId: user._id, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ lastSeenAt: -1 }).lean();
  res.json({
    user: { ...toPublicUser(user), status: user.status, lastLoginAt: user.lastLoginAt, updatedAt: user.updatedAt },
    memberships: memberships.map((m) => ({ workspaceId: m.workspaceId.toString(), name: wsById.get(m.workspaceId.toString())?.name ?? '(deleted)', status: wsById.get(m.workspaceId.toString())?.status ?? null, role: m.role, joinedAt: m.joinedAt })),
    sessions: sessions.map((s) => ({ id: s._id.toString(), portal: s.portal, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt })),
  });
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
    status: z.enum(['active', 'disabled']),
    isPlatformAdmin: z.boolean(),
    emailVerified: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

adminUsersRouter.patch('/:id', async (req, res) => {
  const input = parse(updateSchema, req.body);
  const user = await loadUser(req.params.id);
  const self = user._id.equals(req.user!._id);
  if (self && (input.status === 'disabled' || input.isPlatformAdmin === false)) throw badRequest('SELF_LOCKOUT', 'You cannot disable yourself or remove your own admin access.');
  if (input.email && input.email !== user.email && (await User.exists({ email: input.email }))) throw conflict('EMAIL_TAKEN', 'Another account already uses this email.');

  const before = { name: user.name, email: user.email, status: user.status, isPlatformAdmin: user.isPlatformAdmin, emailVerified: Boolean(user.emailVerifiedAt) };
  const { emailVerified, ...rest } = input;
  user.set(rest);
  if (emailVerified !== undefined) user.emailVerifiedAt = emailVerified ? (user.emailVerifiedAt ?? new Date()) : null;
  await user.save();
  // A disabled account is signed out everywhere at once.
  if (input.status === 'disabled') await revokeAll(user._id);
  await adminLog(req, { action: 'admin.user_updated', targetType: 'user', targetId: user.id, metadata: { email: user.email, before, change: input } });
  res.json({ user: { ...toPublicUser(user), status: user.status, lastLoginAt: user.lastLoginAt } });
});

const passwordSchema = z.object({
  // Omit to generate a temporary password (returned once).
  password: z.string().min(8, 'Use at least 8 characters.').max(128).optional(),
});

adminUsersRouter.post('/:id/password', async (req, res) => {
  const { password } = parse(passwordSchema, req.body);
  const user = await loadUser(req.params.id);
  const next = password ?? randomBytes(9).toString('base64url');
  await User.updateOne({ _id: user._id }, { passwordHash: await hashPassword(next) });
  await revokeAll(user._id);
  await adminLog(req, { action: 'admin.user_password_reset', targetType: 'user', targetId: user.id, metadata: { email: user.email, generated: !password } });
  res.json({ password: password ? null : next });
});

adminUsersRouter.post('/:id/logout', async (req, res) => {
  const user = await loadUser(req.params.id);
  const revoked = await revokeAll(user._id, user._id.equals(req.user!._id) ? req.sessionId : undefined);
  await adminLog(req, { action: 'admin.user_sessions_revoked', targetType: 'user', targetId: user.id, metadata: { email: user.email, revoked } });
  res.json({ revoked });
});

adminUsersRouter.delete('/:id/sessions/:sessionId', async (req, res) => {
  const user = await loadUser(req.params.id);
  const result = await Session.updateOne({ _id: objectId(req.params.sessionId, 'Session'), userId: user._id, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'logout' });
  if (!result.modifiedCount) throw notFound('Session not found.');
  await adminLog(req, { action: 'admin.user_session_revoked', targetType: 'user', targetId: user.id, metadata: { email: user.email, sessionId: req.params.sessionId } });
  res.status(204).end();
});

/** Deletes the account. Refused while the user is the only owner of a workspace. */
adminUsersRouter.delete('/:id', async (req, res) => {
  const user = await loadUser(req.params.id);
  if (user._id.equals(req.user!._id)) throw badRequest('SELF_DELETE', 'You cannot delete your own account.');
  const owned = await WorkspaceMember.find({ userId: user._id, role: 'owner' }).setOptions({ skipTenantScope: true }).lean();
  for (const m of owned) {
    const owners = await WorkspaceMember.countDocuments({ workspaceId: m.workspaceId, role: 'owner' });
    if (owners <= 1) {
      const ws = await Workspace.findById(m.workspaceId).select('name').lean();
      throw conflict('SOLE_OWNER', `${user.email} is the only owner of "${ws?.name ?? 'a workspace'}". Transfer ownership or delete that workspace first.`);
    }
  }
  const memberships = await WorkspaceMember.find({ userId: user._id }).setOptions({ skipTenantScope: true }).lean();
  await WorkspaceMember.deleteMany({ userId: user._id }).setOptions({ skipTenantScope: true });
  await Session.deleteMany({ userId: user._id });
  await User.deleteOne({ _id: user._id });
  await adminLog(req, { action: 'admin.user_deleted', targetType: 'user', targetId: user.id, metadata: { email: user.email, name: user.name, workspaces: memberships.map((m) => ({ id: m.workspaceId.toString(), role: m.role })) } });
  res.status(204).end();
});

async function loadUser(id: string | undefined) {
  const user = await User.findById(objectId(id, 'User'));
  if (!user) throw notFound('User not found.');
  return user;
}

/** Revokes every live session of a user (optionally keeping one, e.g. the admin's own). */
async function revokeAll(userId: import('mongoose').Types.ObjectId, keep?: string): Promise<number> {
  const { modifiedCount } = await Session.updateMany({ userId, revokedAt: null, ...(keep ? { _id: { $ne: keep } } : {}) }, { revokedAt: new Date(), revokedReason: 'logout' });
  return modifiedCount;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { generateOpaqueToken, hashToken } from '../../lib/tokens.js';
import { emailSchema, objectId, parse } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/workspace.js';
import { mailer } from '../../services/mailer.js';
import { audit } from '../audit/audit.service.js';
import { assertWithinLimit } from '../billing/billing.service.js';
import { User } from '../auth/user.model.js';
import { ROLES, canAssignRole, type Role } from '../roles.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { Workspace, toPublicWorkspace } from '../workspaces/workspace.model.js';
import { INVITE_TTL_DAYS, Invitation, invitationStatus, type InvitationDoc } from './invitation.model.js';

const createSchema = z.object({ email: emailSchema, role: z.enum(ROLES) });

const acceptUrl = (token: string) => `${env.APP_URL}/invite/${token}`;

function serialize(inv: InvitationDoc) {
  return {
    id: inv.id as string,
    email: inv.email,
    role: inv.role,
    status: invitationStatus(inv),
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
  };
}

/** Mounted at /api/workspaces/:workspaceId/invitations (workspace already loaded). */
export const invitationRouter = Router({ mergeParams: true });

invitationRouter.use(requirePermission('members:manage'));

invitationRouter.get('/', async (req, res) => {
  const invitations = await Invitation.find({ workspaceId: req.workspace!._id, acceptedAt: null, revokedAt: null }).sort({
    createdAt: -1,
  });
  res.json({ invitations: invitations.map(serialize) });
});

invitationRouter.post('/', async (req, res) => {
  const { email, role } = parse(createSchema, req.body);
  const workspace = req.workspace!;
  if (!canAssignRole(req.membership!.role as Role, role)) throw forbidden('You cannot invite someone with this role.');

  const existingUser = await User.findOne({ email }).lean();
  if (existingUser && (await WorkspaceMember.exists({ workspaceId: workspace._id, userId: existingUser._id }))) {
    throw conflict('ALREADY_MEMBER', 'This person is already a member of the workspace.');
  }

  // Seats = members + pending invitations (a re-invite of the same email doesn't take another seat).
  const [members, pendingOthers] = await Promise.all([
    WorkspaceMember.countDocuments({ workspaceId: workspace._id }),
    Invitation.countDocuments({ workspaceId: workspace._id, email: { $ne: email }, acceptedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } }),
  ]);
  await assertWithinLimit(workspace._id, 'seats', members + pendingOthers);

  // Re-inviting replaces any earlier pending invite for the same email.
  await Invitation.updateMany(
    { workspaceId: workspace._id, email, acceptedAt: null, revokedAt: null },
    { revokedAt: new Date() },
  );

  const token = generateOpaqueToken();
  const invitation = await Invitation.create({
    workspaceId: workspace._id,
    email,
    role,
    tokenHash: hashToken(token),
    invitedBy: req.user!._id,
    expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
  });

  await mailer.send({
    to: email,
    subject: `${req.user!.name} invited you to ${workspace.name} on Zeta Connect`,
    text: `You have been invited to join ${workspace.name} as ${role}.\n\nAccept the invitation: ${acceptUrl(token)}\n\nThis link expires in ${INVITE_TTL_DAYS} days.`,
  });
  await audit(req, {
    workspaceId: workspace._id,
    action: 'member.invited',
    targetType: 'invitation',
    targetId: invitation.id,
    metadata: { email, role },
  });

  // The inviter may also copy the link directly (useful until a real mail provider is set up).
  res.status(201).json({ invitation: serialize(invitation), acceptUrl: acceptUrl(token) });
});

invitationRouter.delete('/:invitationId', async (req, res) => {
  const invitation = await Invitation.findOneAndUpdate(
    { _id: objectId(req.params.invitationId, 'Invitation'), workspaceId: req.workspace!._id, acceptedAt: null, revokedAt: null },
    { revokedAt: new Date() },
    { new: true },
  );
  if (!invitation) throw notFound('Invitation not found.');
  await audit(req, {
    workspaceId: req.workspace!._id,
    action: 'invitation.revoked',
    targetType: 'invitation',
    targetId: invitation.id,
    metadata: { email: invitation.email },
  });
  res.status(204).end();
});

/** Mounted at /api/invitations: looked up by the secret token from the email link. */
export const publicInvitationRouter = Router();

async function findByToken(token: unknown) {
  if (typeof token !== 'string' || !token) throw notFound('Invitation not found.');
  // Deliberate cross-tenant lookup: the unguessable token identifies the invitation.
  const invitation = await Invitation.findOne({ tokenHash: hashToken(token) }).setOptions({ skipTenantScope: true });
  if (!invitation) throw notFound('Invitation not found.');
  return invitation;
}

publicInvitationRouter.get('/:token', async (req, res) => {
  const invitation = await findByToken(req.params.token);
  const [workspace, inviter] = await Promise.all([
    Workspace.findById(invitation.workspaceId).lean(),
    User.findById(invitation.invitedBy).lean(),
  ]);
  res.json({
    invitation: {
      email: invitation.email,
      role: invitation.role,
      status: invitationStatus(invitation),
      workspaceName: workspace?.name ?? 'Unknown workspace',
      invitedByName: inviter?.name ?? null,
    },
  });
});

publicInvitationRouter.post('/:token/accept', requireAuth, async (req, res) => {
  const invitation = await findByToken(req.params.token);
  const status = invitationStatus(invitation);
  if (status !== 'pending') throw new AppError(410, 'INVITE_NOT_PENDING', `This invitation is ${status}.`);
  if (invitation.email !== req.user!.email) {
    throw forbidden(`This invitation was sent to ${invitation.email}. Log in with that email to accept it.`, 'INVITE_EMAIL_MISMATCH');
  }

  // The plan may have shrunk since the invite was sent.
  await assertWithinLimit(invitation.workspaceId, 'seats', await WorkspaceMember.countDocuments({ workspaceId: invitation.workspaceId }));

  // Claim the invitation atomically so it can only be used once.
  const claimed = await Invitation.findOneAndUpdate(
    { _id: invitation._id, workspaceId: invitation.workspaceId, acceptedAt: null, revokedAt: null },
    { acceptedAt: new Date(), acceptedBy: req.user!._id },
    { new: true },
  );
  if (!claimed) throw new AppError(410, 'INVITE_NOT_PENDING', 'This invitation is no longer valid.');

  const workspace = await Workspace.findById(invitation.workspaceId);
  if (!workspace) throw notFound('Workspace not found.');

  let membership = await WorkspaceMember.findOne({ workspaceId: workspace._id, userId: req.user!._id });
  if (!membership) {
    membership = await WorkspaceMember.create({
      workspaceId: workspace._id,
      userId: req.user!._id,
      role: invitation.role,
      invitedBy: invitation.invitedBy,
    });
  }

  await audit(req, {
    workspaceId: workspace._id,
    action: 'invitation.accepted',
    targetType: 'member',
    targetId: membership.id,
    metadata: { email: invitation.email, role: membership.role },
  });
  res.json({ workspace: { ...toPublicWorkspace(workspace), role: membership.role } });
});

import { randomBytes } from 'node:crypto';
import type { Types } from 'mongoose';
import { permissionsFor, type Role } from '../roles.js';
import type { UserDoc } from '../auth/user.model.js';
import { WorkspaceMember, type MemberDoc } from './member.model.js';
import { Workspace, toPublicWorkspace, type WorkspaceDoc } from './workspace.model.js';

export interface CreateWorkspaceInput {
  name: string;
  timezone: string;
  country: string;
  currency: string;
  industry?: string | null;
}

/** All workspaces the user belongs to, with their role in each. */
export async function listUserWorkspaces(userId: Types.ObjectId) {
  // Deliberate cross-tenant read: this user's own memberships across workspaces.
  const memberships = await WorkspaceMember.find({ userId }).setOptions({ skipTenantScope: true }).lean();
  const workspaces = await Workspace.find({ _id: { $in: memberships.map((m) => m.workspaceId) } }).sort({ name: 1 });
  const roleByWorkspace = new Map(memberships.map((m) => [m.workspaceId.toString(), m.role as Role]));
  return workspaces.map((ws) => ({ ...toPublicWorkspace(ws), role: roleByWorkspace.get(ws.id as string)! }));
}

export async function createWorkspace(user: UserDoc, input: CreateWorkspaceInput): Promise<WorkspaceDoc> {
  const workspace = await Workspace.create({ ...input, slug: await uniqueSlug(input.name), createdBy: user._id });
  try {
    await WorkspaceMember.create({ workspaceId: workspace._id, userId: user._id, role: 'owner' });
  } catch (err) {
    // No transaction (works on standalone MongoDB too): undo the workspace if the owner row fails.
    await Workspace.deleteOne({ _id: workspace._id });
    throw err;
  }
  return workspace;
}

export function workspaceContext(workspace: WorkspaceDoc, membership: MemberDoc) {
  const role = membership.role as Role;
  return {
    workspace: toPublicWorkspace(workspace),
    membership: { id: membership.id as string, role, permissions: permissionsFor(role) },
  };
}

async function uniqueSlug(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace';
  for (;;) {
    const slug = `${base}-${randomBytes(3).toString('hex')}`;
    if (!(await Workspace.exists({ slug }))) return slug;
  }
}

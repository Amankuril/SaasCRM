import { describe, expect, it } from 'vitest';
import { addMember, api, createWorkspace, signup, type TestUser } from './helpers.js';

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

async function members(user: TestUser, workspaceId: string) {
  const res = await api().get(`/api/workspaces/${workspaceId}/members`).set(auth(user)).expect(200);
  return res.body.members as { id: string; email: string; role: string }[];
}

describe('invitations', () => {
  it('invites, previews and accepts with the matching account', async () => {
    const owner = await signup();
    const ws = await createWorkspace(owner, 'Mehta Clinic');
    const invitee = await signup({ email: 'reception@example.com' });

    const inv = await api()
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(auth(owner))
      .send({ email: 'Reception@Example.com', role: 'agent' })
      .expect(201);
    expect(inv.body.invitation).toMatchObject({ email: 'reception@example.com', role: 'agent', status: 'pending' });
    const token = (inv.body.acceptUrl as string).split('/invite/')[1];

    const preview = await api().get(`/api/invitations/${token}`).expect(200);
    expect(preview.body.invitation).toMatchObject({ workspaceName: 'Mehta Clinic', role: 'agent', status: 'pending' });

    const accepted = await api().post(`/api/invitations/${token}/accept`).set(auth(invitee)).expect(200);
    expect(accepted.body.workspace).toMatchObject({ id: ws.id, role: 'agent' });

    // One-time use.
    const again = await api().post(`/api/invitations/${token}/accept`).set(auth(invitee));
    expect(again.status).toBe(410);

    expect((await members(owner, ws.id)).map((m) => m.role).sort()).toEqual(['agent', 'owner']);
  });

  it('refuses acceptance from a different email', async () => {
    const owner = await signup();
    const ws = await createWorkspace(owner);
    const stranger = await signup();
    const inv = await api().post(`/api/workspaces/${ws.id}/invitations`).set(auth(owner)).send({ email: 'someone@example.com', role: 'agent' });
    const token = (inv.body.acceptUrl as string).split('/invite/')[1];

    const res = await api().post(`/api/invitations/${token}/accept`).set(auth(stranger));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVITE_EMAIL_MISMATCH');
  });

  it('revoked and replaced invitations cannot be used', async () => {
    const owner = await signup();
    const ws = await createWorkspace(owner);
    const invitee = await signup({ email: 'staff@example.com' });

    const first = await api().post(`/api/workspaces/${ws.id}/invitations`).set(auth(owner)).send({ email: invitee.email, role: 'agent' });
    const second = await api().post(`/api/workspaces/${ws.id}/invitations`).set(auth(owner)).send({ email: invitee.email, role: 'manager' });
    const firstToken = (first.body.acceptUrl as string).split('/invite/')[1];
    await api().post(`/api/invitations/${firstToken}/accept`).set(auth(invitee)).expect(410);

    await api().delete(`/api/workspaces/${ws.id}/invitations/${second.body.invitation.id}`).set(auth(owner)).expect(204);
    const secondToken = (second.body.acceptUrl as string).split('/invite/')[1];
    await api().post(`/api/invitations/${secondToken}/accept`).set(auth(invitee)).expect(410);
  });

  it('rejects inviting an existing member, and admins cannot invite owners', async () => {
    const owner = await signup();
    const admin = await signup();
    const ws = await createWorkspace(owner);
    await addMember(owner, ws.id, admin, 'admin');

    const dup = await api().post(`/api/workspaces/${ws.id}/invitations`).set(auth(owner)).send({ email: admin.email, role: 'agent' });
    expect(dup.body.error.code).toBe('ALREADY_MEMBER');

    await api().post(`/api/workspaces/${ws.id}/invitations`).set(auth(admin)).send({ email: 'boss@example.com', role: 'owner' }).expect(403);
    await api().post(`/api/workspaces/${ws.id}/invitations`).set(auth(admin)).send({ email: 'agent@example.com', role: 'agent' }).expect(201);
  });
});

describe('member management', () => {
  it('owner can change roles; admins cannot touch owners; nobody changes their own role', async () => {
    const owner = await signup();
    const admin = await signup();
    const agent = await signup();
    const ws = await createWorkspace(owner);
    await addMember(owner, ws.id, admin, 'admin');
    await addMember(owner, ws.id, agent, 'agent');
    const list = await members(owner, ws.id);
    const byEmail = (e: string) => list.find((m) => m.email === e)!;

    await api().patch(`/api/workspaces/${ws.id}/members/${byEmail(agent.email).id}`).set(auth(admin)).send({ role: 'manager' }).expect(200);
    await api().patch(`/api/workspaces/${ws.id}/members/${byEmail(owner.email).id}`).set(auth(admin)).send({ role: 'agent' }).expect(403);
    await api().patch(`/api/workspaces/${ws.id}/members/${byEmail(agent.email).id}`).set(auth(admin)).send({ role: 'owner' }).expect(403);

    const self = await api().patch(`/api/workspaces/${ws.id}/members/${byEmail(owner.email).id}`).set(auth(owner)).send({ role: 'agent' });
    expect(self.body.error.code).toBe('CANNOT_CHANGE_OWN_ROLE');
  });

  it('keeps at least one owner, and members can leave', async () => {
    const owner = await signup();
    const agent = await signup();
    const ws = await createWorkspace(owner);
    await addMember(owner, ws.id, agent, 'agent');
    const list = await members(owner, ws.id);
    const ownerRow = list.find((m) => m.email === owner.email)!;
    const agentRow = list.find((m) => m.email === agent.email)!;

    const leave = await api().delete(`/api/workspaces/${ws.id}/members/${ownerRow.id}`).set(auth(owner));
    expect(leave.status).toBe(409);
    expect(leave.body.error.code).toBe('LAST_OWNER');

    // An agent cannot remove others but can leave.
    await api().delete(`/api/workspaces/${ws.id}/members/${ownerRow.id}`).set(auth(agent)).expect(403);
    await api().delete(`/api/workspaces/${ws.id}/members/${agentRow.id}`).set(auth(agent)).expect(204);
    await api().get(`/api/workspaces/${ws.id}`).set(auth(agent)).expect(404);
  });
});

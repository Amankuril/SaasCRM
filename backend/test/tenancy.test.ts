import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/auditLog.model.js';
import { WorkspaceMember } from '../src/modules/workspaces/member.model.js';
import { addMember, api, createWorkspace, signup } from './helpers.js';

describe('tenant guard (mongoose plugin)', () => {
  it('throws when a tenant-owned query has no workspaceId filter', async () => {
    await expect(WorkspaceMember.find({})).rejects.toThrow(/Tenant scope missing/);
    await expect(WorkspaceMember.findById(new Types.ObjectId())).rejects.toThrow(/Tenant scope missing/);
    await expect(AuditLog.deleteMany({})).rejects.toThrow(/Tenant scope missing/);
    await expect(AuditLog.aggregate([{ $group: { _id: '$action' } }])).rejects.toThrow(/Tenant scope missing/);
  });

  it('allows scoped queries and explicit opt-outs', async () => {
    const workspaceId = new Types.ObjectId();
    await expect(WorkspaceMember.find({ workspaceId })).resolves.toEqual([]);
    await expect(WorkspaceMember.find({}).setOptions({ skipTenantScope: true })).resolves.toEqual([]);
    await expect(AuditLog.aggregate([{ $match: { workspaceId } }])).resolves.toEqual([]);
  });
});

describe('workspace isolation (API)', () => {
  it('creates a workspace with the creator as owner, in setup state', async () => {
    const owner = await signup();
    const ws = await createWorkspace(owner, 'Sharma Dental');
    expect(ws).toMatchObject({ name: 'Sharma Dental', role: 'owner', status: 'setup', timezone: 'Asia/Kolkata' });

    const ctx = await api().get(`/api/workspaces/${ws.id}`).set('Authorization', `Bearer ${owner.token}`).expect(200);
    expect(ctx.body.membership.role).toBe('owner');
    expect(ctx.body.membership.permissions).toContain('billing:manage');
  });

  it('validates workspace input', async () => {
    const owner = await signup();
    const res = await api()
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'A', timezone: 'Mars/Base', country: 'India', currency: 'RUPEE' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.details)).toEqual(expect.arrayContaining(['name', 'timezone', 'country', 'currency']));
  });

  it('Workspace A users cannot read or change Workspace B by changing the id', async () => {
    const alice = await signup();
    const bob = await signup();
    const wsA = await createWorkspace(alice, 'Alice Clinic');
    const wsB = await createWorkspace(bob, 'Bob Store');
    const asAlice = (r: ReturnType<ReturnType<typeof api>['get']>) => r.set('Authorization', `Bearer ${alice.token}`);

    for (const path of ['', '/members', '/invitations', '/audit-logs']) {
      const res = await asAlice(api().get(`/api/workspaces/${wsB.id}${path}`));
      expect(res.status, `GET ${path}`).toBe(404);
    }
    await api()
      .patch(`/api/workspaces/${wsB.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Hacked' })
      .expect(404);
    await api()
      .post(`/api/workspaces/${wsB.id}/invitations`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: 'evil@example.com', role: 'owner' })
      .expect(404);

    // Malformed ids look exactly like missing ones.
    await asAlice(api().get('/api/workspaces/not-an-id')).expect(404);

    // Alice only sees her own workspace.
    const list = await asAlice(api().get('/api/workspaces')).expect(200);
    expect(list.body.workspaces.map((w: { id: string }) => w.id)).toEqual([wsA.id]);
  });

  it('enforces role permissions inside a workspace', async () => {
    const owner = await signup();
    const agent = await signup();
    const analyst = await signup();
    const ws = await createWorkspace(owner);
    await addMember(owner, ws.id, agent, 'agent');
    await addMember(owner, ws.id, analyst, 'analyst');

    // Agents and analysts can read the workspace but not settings, members or audit logs.
    for (const user of [agent, analyst]) {
      await api().get(`/api/workspaces/${ws.id}`).set('Authorization', `Bearer ${user.token}`).expect(200);
      await api().patch(`/api/workspaces/${ws.id}`).set('Authorization', `Bearer ${user.token}`).send({ name: 'Nope' }).expect(403);
      await api().get(`/api/workspaces/${ws.id}/members`).set('Authorization', `Bearer ${user.token}`).expect(403);
      await api().get(`/api/workspaces/${ws.id}/audit-logs`).set('Authorization', `Bearer ${user.token}`).expect(403);
      await api()
        .post(`/api/workspaces/${ws.id}/invitations`)
        .set('Authorization', `Bearer ${user.token}`)
        .send({ email: 'x@example.com', role: 'agent' })
        .expect(403);
    }
  });

  it('writes audit events for privileged changes', async () => {
    const owner = await signup();
    const ws = await createWorkspace(owner);
    await api().patch(`/api/workspaces/${ws.id}`).set('Authorization', `Bearer ${owner.token}`).send({ name: 'Renamed Clinic' }).expect(200);

    const res = await api().get(`/api/workspaces/${ws.id}/audit-logs`).set('Authorization', `Bearer ${owner.token}`).expect(200);
    expect(res.body.items.map((i: { action: string }) => i.action)).toEqual(['workspace.updated', 'workspace.created']);
    expect(res.body.items[0].metadata).toMatchObject({ before: { name: 'Acme Clinic' }, after: { name: 'Renamed Clinic' } });
    expect(res.body.items[0].actor.email).toBe(owner.email);
  });
});

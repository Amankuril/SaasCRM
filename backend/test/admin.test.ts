import { describe, expect, it } from 'vitest';
import { User } from '../src/modules/auth/user.model.js';
import { api, createWorkspace, signup } from './helpers.js';

describe('platform admin', () => {
  it('has its own login that refuses non-admin accounts without starting a session', async () => {
    const admin = await signup({ email: 'root@example.com' });
    await User.updateOne({ email: admin.email }, { isPlatformAdmin: true });
    const owner = await signup({ email: 'clinic@example.com' });

    const ok = await api().post('/api/auth/login').send({ email: admin.email, password: 'password123', portal: 'admin' }).expect(200);
    expect(ok.body.user.isPlatformAdmin).toBe(true);

    const denied = await api().post('/api/auth/login').send({ email: owner.email, password: 'password123', portal: 'admin' }).expect(403);
    expect(denied.body.error.code).toBe('NOT_PLATFORM_ADMIN');
    expect(denied.headers['set-cookie']).toBeUndefined();
    // A wrong password gets the usual answer, so the admin portal reveals nothing extra.
    expect((await api().post('/api/auth/login').send({ email: owner.email, password: 'wrong-pass', portal: 'admin' }).expect(401)).body.error.code).toBe('INVALID_CREDENTIALS');
    // Business login is unchanged.
    await api().post('/api/auth/login').send({ email: owner.email, password: 'password123' }).expect(200);
  });

  it('is forbidden for normal users', async () => {
    const user = await signup();
    await api().get('/api/admin/workspaces').set('Authorization', `Bearer ${user.token}`).expect(403);
  });

  it('lists tenants and suspends one, which makes it read-only', async () => {
    const admin = await signup();
    await User.updateOne({ email: admin.email }, { isPlatformAdmin: true });
    const owner = await signup();
    const ws = await createWorkspace(owner, 'Late Payer Ltd');

    const list = await api().get('/api/admin/workspaces').set('Authorization', `Bearer ${admin.token}`).expect(200);
    expect(list.body.workspaces).toHaveLength(1);
    expect(list.body.workspaces[0]).toMatchObject({ name: 'Late Payer Ltd', memberCount: 1, owners: [owner.email] });

    await api()
      .patch(`/api/admin/workspaces/${ws.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'suspended', reason: 'Unpaid invoice' })
      .expect(200);

    const asOwner = { Authorization: `Bearer ${owner.token}` };
    await api().get(`/api/workspaces/${ws.id}`).set(asOwner).expect(200);
    const write = await api().patch(`/api/workspaces/${ws.id}`).set(asOwner).send({ name: 'Still here' });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('WORKSPACE_SUSPENDED');

    const stats = await api().get('/api/admin/stats').set('Authorization', `Bearer ${admin.token}`).expect(200);
    expect(stats.body).toMatchObject({ users: 2, workspaces: { setup: 0, active: 0, suspended: 1 } });
  });
});

describe('platform admin superpowers', () => {
  async function setup() {
    const admin = await signup();
    await User.updateOne({ email: admin.email }, { isPlatformAdmin: true });
    const owner = await signup();
    const ws = await createWorkspace(owner, 'Support Me Ltd');
    return { admin, owner, ws, asAdmin: { Authorization: `Bearer ${admin.token}` }, asOwner: { Authorization: `Bearer ${owner.token}` } };
  }

  it('opens any workspace on support access, even when suspended, and audits it as support', async () => {
    const { ws, asAdmin, asOwner } = await setup();
    const ctx = await api().get(`/api/workspaces/${ws.id}`).set(asAdmin).expect(200);
    expect(ctx.body.supportAccess).toBe(true);
    expect(ctx.body.membership.role).toBe('owner');

    await api().patch(`/api/admin/workspaces/${ws.id}`).set(asAdmin).send({ status: 'suspended', reason: 'x' }).expect(200);
    await api().patch(`/api/workspaces/${ws.id}`).set(asAdmin).send({ name: 'Fixed By Support' }).expect(200);
    expect((await api().patch(`/api/workspaces/${ws.id}`).set(asOwner).send({ name: 'Nope' })).status).toBe(403);

    const logs = await api().get(`/api/workspaces/${ws.id}/audit-logs`).set(asOwner).expect(200);
    expect(logs.body.items.find((i: { action: string }) => i.action === 'workspace.updated').metadata.supportAccess).toBe(true);
    const activity = await api().get('/api/admin/activity').set(asAdmin).expect(200);
    expect(activity.body.items[0]).toMatchObject({ action: 'admin.workspace_status_changed', workspaceName: 'Support Me Ltd' });
  });

  it('shows workspace detail and applies per-workspace limit overrides and usage resets', async () => {
    const { ws, asAdmin } = await setup();
    const detail = await api().get(`/api/admin/workspaces/${ws.id}`).set(asAdmin).expect(200);
    expect(detail.body.members).toHaveLength(1);
    expect(detail.body.counts.WorkspaceMember).toBe(1);

    const o = await api().put(`/api/admin/workspaces/${ws.id}/overrides`).set(asAdmin).send({ limits: { contacts: 123456, seats: null }, features: { ai: true } }).expect(200);
    expect(o.body.entitlements.limits).toMatchObject({ contacts: 123456, seats: null });
    expect(o.body.entitlements.features.ai).toBe(true);
    const back = await api().put(`/api/admin/workspaces/${ws.id}/overrides`).set(asAdmin).send({ limits: { contacts: 'plan' } }).expect(200);
    expect(back.body.overrides.limits).toEqual({ seats: null });

    const usage = await api().post(`/api/admin/workspaces/${ws.id}/usage`).set(asAdmin).send({ metric: 'messages', value: 5 }).expect(200);
    expect(usage.body.usage.messages).toBe(5);
  });

  it('manages members and keeps at least one owner', async () => {
    const { ws, asAdmin } = await setup();
    const other = await signup();
    const added = await api().post(`/api/admin/workspaces/${ws.id}/members`).set(asAdmin).send({ email: other.email, role: 'agent' }).expect(201);
    const detail = await api().get(`/api/admin/workspaces/${ws.id}`).set(asAdmin).expect(200);
    const ownerRow = detail.body.members.find((m: { role: string }) => m.role === 'owner');
    expect((await api().patch(`/api/admin/workspaces/${ws.id}/members/${ownerRow.id}`).set(asAdmin).send({ role: 'admin' })).body.error.code).toBe('LAST_OWNER');
    await api().patch(`/api/admin/workspaces/${ws.id}/members/${added.body.member.id}`).set(asAdmin).send({ role: 'owner' }).expect(200);
    await api().patch(`/api/admin/workspaces/${ws.id}/members/${ownerRow.id}`).set(asAdmin).send({ role: 'admin' }).expect(200);
  });

  it('disables users, resets passwords and signs them out', async () => {
    const { admin, owner, asAdmin, asOwner } = await setup();
    const list = await api().get(`/api/admin/users?q=${encodeURIComponent(owner.email)}`).set(asAdmin).expect(200);
    expect(list.body.users[0]).toMatchObject({ email: owner.email, workspaceCount: 1 });

    const reset = await api().post(`/api/admin/users/${owner.id}/password`).set(asAdmin).send({}).expect(200);
    expect(reset.body.password).toHaveLength(12);
    await api().get('/api/auth/me').set(asOwner).expect(401);

    await api().patch(`/api/admin/users/${owner.id}`).set(asAdmin).send({ status: 'disabled' }).expect(200);
    expect((await api().patch(`/api/admin/users/${admin.id}`).set(asAdmin).send({ isPlatformAdmin: false })).body.error.code).toBe('SELF_LOCKOUT');
    expect((await api().delete(`/api/admin/users/${owner.id}`).set(asAdmin)).body.error.code).toBe('SOLE_OWNER');
  });

  it('exports and permanently deletes a workspace', async () => {
    const { ws, asAdmin } = await setup();
    const exp = await api().get(`/api/admin/workspaces/${ws.id}/export`).set(asAdmin).expect(200);
    expect(exp.body.data.WorkspaceMember).toHaveLength(1);
    expect((await api().delete(`/api/admin/workspaces/${ws.id}`).set(asAdmin).send({ confirm: 'wrong' })).body.error.code).toBe('CONFIRM_MISMATCH');
    await api().delete(`/api/admin/workspaces/${ws.id}`).set(asAdmin).send({ confirm: 'Support Me Ltd' }).expect(200);
    await api().get(`/api/admin/workspaces/${ws.id}`).set(asAdmin).expect(404);
  });

  it('pauses sign-ups, locks businesses out in maintenance and shows an announcement', async () => {
    const { asAdmin, asOwner } = await setup();
    await api().patch('/api/admin/settings').set(asAdmin).send({ signupsEnabled: false, announcement: { active: true, text: 'Meta outage', tone: 'warning' } }).expect(200);
    expect((await api().post('/api/auth/signup').send({ name: 'N', email: 'new@example.com', password: 'password123' })).body.error.code).toBe('SIGNUPS_DISABLED');
    expect((await api().get('/api/auth/announcement').set(asOwner).expect(200)).body.announcement).toEqual({ text: 'Meta outage', tone: 'warning' });

    await api().patch('/api/admin/settings').set(asAdmin).send({ maintenanceMode: true }).expect(200);
    expect((await api().get('/api/auth/me').set(asOwner)).status).toBe(503);
    await api().get('/api/auth/me').set(asAdmin).expect(200);
    await api().patch('/api/admin/settings').set(asAdmin).send({ maintenanceMode: false, signupsEnabled: true }).expect(200);
  });
});

describe('privacy, terms and support pages', () => {
  it('serves editable public pages and hides unpublished ones', async () => {
    const admin = await signup();
    await User.updateOne({ email: admin.email }, { isPlatformAdmin: true });
    const asAdmin = { Authorization: `Bearer ${admin.token}` };

    const privacy = await api().get('/api/pages/privacy').expect(200);
    expect(privacy.body.page).toMatchObject({ slug: 'privacy', title: 'Privacy Policy', contact: null });
    await api().get('/api/pages/nope').expect(404);

    await api().put('/api/admin/pages/support').set(asAdmin).send({ content: '## Help', contact: { email: 'help@zeta.test', phone: '' } }).expect(200);
    const support = await api().get('/api/pages/support').expect(200);
    expect(support.body.page).toMatchObject({ content: '## Help', contact: { email: 'help@zeta.test', phone: null } });

    await api().put('/api/admin/pages/terms').set(asAdmin).send({ published: false }).expect(200);
    await api().get('/api/pages/terms').expect(404);
    expect((await api().get('/api/admin/pages').set(asAdmin).expect(200)).body.pages).toHaveLength(3);
    await api().put('/api/admin/pages/terms').send({ published: true }).expect(401);
  });
});

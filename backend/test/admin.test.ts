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

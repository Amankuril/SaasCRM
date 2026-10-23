import { describe, expect, it } from 'vitest';
import { Session } from '../src/modules/auth/session.model.js';
import { api, refreshCookie, signup } from './helpers.js';

describe('auth', () => {
  it('signs up, returns an access token and sets an httpOnly refresh cookie', async () => {
    const res = await api()
      .post('/api/auth/signup')
      .send({ name: 'Asha', email: 'Asha@Example.com', password: 'password123' })
      .expect(201);

    expect(res.body.user).toMatchObject({ name: 'Asha', email: 'asha@example.com', isPlatformAdmin: false });
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.accessToken).toEqual(expect.any(String));
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('zc_rt='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('rejects duplicate emails and invalid input', async () => {
    await signup({ email: 'dup@example.com' });
    const dup = await api().post('/api/auth/signup').send({ name: 'X', email: 'dup@example.com', password: 'password123' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');

    const bad = await api().post('/api/auth/signup').send({ name: '', email: 'nope', password: 'short' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(bad.body.error.details)).toEqual(expect.arrayContaining(['name', 'email', 'password']));
    expect(bad.body.error.request_id).toEqual(expect.any(String));
  });

  it('logs in with correct credentials only', async () => {
    await signup({ email: 'login@example.com', password: 'password123' });
    await api().post('/api/auth/login').send({ email: 'login@example.com', password: 'password123' }).expect(200);

    const wrong = await api().post('/api/auth/login').send({ email: 'login@example.com', password: 'wrong-pass' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');

    const missing = await api().post('/api/auth/login').send({ email: 'ghost@example.com', password: 'password123' });
    expect(missing.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('protects /me and returns the user with their workspaces', async () => {
    await api().get('/api/auth/me').expect(401);
    await api().get('/api/auth/me').set('Authorization', 'Bearer garbage').expect(401);

    const user = await signup();
    const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${user.token}`).expect(200);
    expect(me.body.user.email).toBe(user.email);
    expect(me.body.workspaces).toEqual([]);
  });

  it('rotates the refresh token and detects reuse of an old one', async () => {
    const user = await signup();

    const first = await api().post('/api/auth/refresh').set('Cookie', user.cookie).expect(200);
    const rotated = refreshCookie(first.headers);
    expect(rotated).not.toBe(user.cookie);
    expect(first.body.accessToken).toEqual(expect.any(String));

    // Within the grace window the old cookie still yields an access token (parallel tabs)...
    const parallel = await api().post('/api/auth/refresh').set('Cookie', user.cookie).expect(200);
    expect(refreshCookie(parallel.headers)).toBe('');

    // ...and the new cookie keeps working.
    await api().post('/api/auth/refresh').set('Cookie', rotated).expect(200);
  });

  it('revokes the whole session when an old refresh token is replayed after the grace window', async () => {
    const user = await signup();
    const first = await api().post('/api/auth/refresh').set('Cookie', user.cookie).expect(200);
    const rotated = refreshCookie(first.headers);
    await Session.updateMany({}, { lastUsedAt: new Date(Date.now() - 60_000) });

    const replay = await api().post('/api/auth/refresh').set('Cookie', user.cookie);
    expect(replay.status).toBe(401);
    // The legitimate holder is logged out too, forcing a fresh login.
    await api().post('/api/auth/refresh').set('Cookie', rotated).expect(401);
  });

  it('logout revokes the session so its tokens stop working', async () => {
    const user = await signup();
    await api().post('/api/auth/logout').set('Cookie', user.cookie).expect(204);

    await api().post('/api/auth/refresh').set('Cookie', user.cookie).expect(401);
    const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${user.token}`);
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_EXPIRED');
  });
});

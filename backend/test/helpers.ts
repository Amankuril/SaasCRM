import request from 'supertest';
import { createApp } from '../src/app.js';

export const app = createApp();
export const api = () => request(app);

let counter = 0;

export interface TestUser {
  id: string;
  email: string;
  token: string;
  cookie: string;
}

export async function signup(overrides: Partial<{ name: string; email: string; password: string }> = {}): Promise<TestUser> {
  counter += 1;
  const body = { name: `User ${counter}`, email: `user${counter}@example.com`, password: 'password123', ...overrides };
  const res = await api().post('/api/auth/signup').send(body).expect(201);
  return { id: res.body.user.id, email: body.email, token: res.body.accessToken, cookie: refreshCookie(res.headers) };
}

export async function createWorkspace(user: TestUser, name = 'Acme Clinic') {
  const res = await api()
    .post('/api/workspaces')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ name, timezone: 'Asia/Kolkata', country: 'IN', currency: 'INR' })
    .expect(201);
  return res.body.workspace as { id: string; name: string; role: string };
}

/** Invites `invitee` into the workspace with `role` and accepts on their behalf. */
export async function addMember(owner: TestUser, workspaceId: string, invitee: TestUser, role: string) {
  const res = await api()
    .post(`/api/workspaces/${workspaceId}/invitations`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ email: invitee.email, role })
    .expect(201);
  const token = (res.body.acceptUrl as string).split('/invite/')[1];
  await api().post(`/api/invitations/${token}/accept`).set('Authorization', `Bearer ${invitee.token}`).expect(200);
}

export function refreshCookie(headers: Record<string, unknown>): string {
  const cookies = (headers['set-cookie'] as string[] | undefined) ?? [];
  const cookie = cookies.find((c) => c.startsWith('zc_rt='));
  return cookie ? cookie.split(';')[0]! : '';
}

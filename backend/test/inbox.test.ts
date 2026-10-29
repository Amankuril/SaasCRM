import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachRealtime } from '../src/realtime/socket.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { FakeProvider, inboundPayload, sign } from './fakeProvider.js';
import { addMember, api, app, createWorkspace, signup, type TestUser } from './helpers.js';

const PHONE_ID = '1112223334445';
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

let fake: FakeProvider;
beforeEach(() => {
  fake = new FakeProvider();
  setWhatsAppProvider(fake);
});
afterEach(() => setWhatsAppProvider(undefined));

let seq = 0;
async function inbound(from: string, text: string, phoneNumberId = PHONE_ID) {
  seq += 1;
  const body = JSON.stringify(inboundPayload(phoneNumberId, { id: `wamid.in.${seq}.${Date.now()}`, from, text, name: `Customer ${from.slice(-4)}` }));
  await api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body).expect(200);
}

async function team() {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  const agent1 = await signup();
  const agent2 = await signup();
  const manager = await signup();
  await addMember(owner, ws.id, agent1, 'agent');
  await addMember(owner, ws.id, agent2, 'agent');
  await addMember(owner, ws.id, manager, 'manager');
  await api().put(`/api/workspaces/${ws.id}/whatsapp/connection`).set(auth(owner)).send({ wabaId: '9998887776665', phoneNumberId: PHONE_ID, accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
  return { owner, ws, agent1, agent2, manager, base: `/api/workspaces/${ws.id}/conversations` };
}

const list = async (user: TestUser, base: string, query = '') => (await api().get(`${base}${query}`).set(auth(user)).expect(200)).body.conversations;

describe('team inbox', () => {
  it('"+" starts a chat with a new number, reusing the contact and conversation if they exist', async () => {
    const { owner, agent1, base, ws } = await team();
    const started = await api().post(base).set(auth(owner)).send({ phone: '98111 33344', name: 'Walk-in Riya' }).expect(201);
    expect(started.body).toMatchObject({ created: true, createdContact: true });
    expect(started.body.conversation).toMatchObject({ status: 'open', serviceWindowOpen: false, lastMessagePreview: 'New chat', contact: { phone: '+919811133344', name: 'Walk-in Riya' } });
    expect((await list(owner, base))[0].id).toBe(started.body.conversation.id);

    // Same number again: same chat, no duplicate contact.
    const again = await api().post(base).set(auth(owner)).send({ phone: '+919811133344' }).expect(200);
    expect(again.body).toMatchObject({ created: false, createdContact: false, conversation: { id: started.body.conversation.id } });
    expect((await api().get(`/api/workspaces/${ws.id}/contacts`).set(auth(owner))).body.total).toBe(1);

    // No 24h window yet: free text is refused, a template is required.
    const text = await api().post(`${base}/${started.body.conversation.id}/messages`).set(auth(owner)).send({ type: 'text', text: 'Hello!' }).expect(422);
    expect(text.body.error.code).toBe('OUTSIDE_SERVICE_WINDOW');

    // An agent's new chat is assigned to them so it appears in their list.
    const mine = await api().post(base).set(auth(agent1)).send({ phone: '+919811155566' }).expect(201);
    expect(mine.body.conversation.assignee).toMatchObject({ id: agent1.id });
    await api().post(base).set(auth(owner)).send({ phone: '12' }).expect(400);
  });

  it('a customer message creates an open, unread conversation; replies clear unread', async () => {
    const { owner, base } = await team();
    await inbound('919811112222', 'Hi, need an appointment');
    await inbound('919811112222', 'Tomorrow if possible');

    const [conv] = await list(owner, base);
    expect(conv).toMatchObject({ status: 'open', unreadCount: 2, lastMessagePreview: 'Tomorrow if possible', lastMessageDirection: 'inbound', serviceWindowOpen: true, assignee: null });
    expect(conv.contact).toMatchObject({ phone: '+919811112222', name: 'Customer 2222' });

    const reply = await api().post(`${base}/${conv.id}/messages`).set(auth(owner)).send({ type: 'text', text: 'Sure, 11 AM works?' }).expect(202);
    expect(reply.body.message.status).toBe('submitted');
    const [after] = await list(owner, base);
    expect(after).toMatchObject({ unreadCount: 0, lastMessageDirection: 'outbound', lastMessagePreview: 'Sure, 11 AM works?' });

    const timeline = await api().get(`${base}/${conv.id}/timeline`).set(auth(owner)).expect(200);
    expect(timeline.body.items.map((i: { direction: string }) => i.direction)).toEqual(['inbound', 'inbound', 'outbound']);
  });

  it('resolved conversations reopen when the customer writes again', async () => {
    const { owner, base } = await team();
    await inbound('919811112222', 'Thanks!');
    const [conv] = await list(owner, base);
    await api().patch(`${base}/${conv.id}`).set(auth(owner)).send({ status: 'resolved' }).expect(200);
    expect(await list(owner, base)).toHaveLength(0);
    expect(await list(owner, base, '?status=resolved')).toHaveLength(1);

    await inbound('919811112222', 'One more question');
    const [reopened] = await list(owner, base);
    expect(reopened).toMatchObject({ id: conv.id, status: 'open' });
  });

  it('agents only see unassigned conversations and their own', async () => {
    const { owner, agent1, agent2, manager, base } = await team();
    await inbound('919811112222', 'A');
    await inbound('919822223333', 'B');
    const convs = await list(owner, base);
    const a = convs.find((c: { contact: { phone: string } }) => c.contact.phone === '+919811112222');

    await api().patch(`${base}/${a.id}`).set(auth(manager)).send({ assigneeId: agent1.id }).expect(200);

    expect(await list(agent1, base)).toHaveLength(2);
    expect(await list(agent1, base, '?view=mine')).toHaveLength(1);
    expect(await list(agent2, base)).toHaveLength(1); // only the unassigned one
    await api().get(`${base}/${a.id}`).set(auth(agent2)).expect(404);
    await api().get(`${base}/${a.id}/timeline`).set(auth(agent2)).expect(404);
    await api().post(`${base}/${a.id}/messages`).set(auth(agent2)).send({ type: 'text', text: 'hijack' }).expect(404);

    const counts = await api().get(`${base}/counts`).set(auth(agent1));
    expect(counts.body).toMatchObject({ all: 2, mine: 1, unassigned: 1 });
  });

  it('an agent replying to an unassigned conversation takes it; agents cannot assign others', async () => {
    const { agent1, agent2, base } = await team();
    await inbound('919811112222', 'Hello?');
    const [conv] = await list(agent1, base);

    await api().patch(`${base}/${conv.id}`).set(auth(agent1)).send({ assigneeId: agent2.id }).expect(403);
    await api().post(`${base}/${conv.id}/messages`).set(auth(agent1)).send({ type: 'text', text: 'Hi, how can I help?' }).expect(202);

    const detail = await api().get(`${base}/${conv.id}`).set(auth(agent1)).expect(200);
    expect(detail.body.conversation.assignee).toMatchObject({ id: agent1.id });
    expect(await list(agent2, base)).toHaveLength(0);

    // Releasing it makes it visible to everyone again.
    await api().patch(`${base}/${conv.id}`).set(auth(agent1)).send({ assigneeId: null }).expect(200);
    expect(await list(agent2, base)).toHaveLength(1);
  });

  it('cannot assign to analysts or non-members; assignments are audited', async () => {
    const { owner, ws, base } = await team();
    const analyst = await signup();
    await addMember(owner, ws.id, analyst, 'analyst');
    const outsider = await signup();
    await inbound('919811112222', 'Hi');
    const [conv] = await list(owner, base);

    await api().patch(`${base}/${conv.id}`).set(auth(owner)).send({ assigneeId: analyst.id }).expect(400);
    await api().patch(`${base}/${conv.id}`).set(auth(owner)).send({ assigneeId: outsider.id }).expect(400);
    await api().patch(`${base}/${conv.id}`).set(auth(owner)).send({ assigneeId: owner.id }).expect(200);

    const audit = await api().get(`/api/workspaces/${ws.id}/audit-logs`).set(auth(owner));
    expect(audit.body.items[0]).toMatchObject({ action: 'conversation.assigned', metadata: { from: null, to: owner.id } });

    // Analysts can read the inbox but not reply.
    expect(await list(analyst, base)).toHaveLength(1);
    await api().post(`${base}/${conv.id}/messages`).set(auth(analyst)).send({ type: 'text', text: 'x' }).expect(403);
  });

  it('internal notes appear in the timeline but are never sent', async () => {
    const { owner, base } = await team();
    await inbound('919811112222', 'Is the doctor available?');
    const [conv] = await list(owner, base);

    await api().post(`${base}/${conv.id}/notes`).set(auth(owner)).send({ body: 'VIP patient, offer priority slot' }).expect(201);
    const timeline = await api().get(`${base}/${conv.id}/timeline`).set(auth(owner));
    expect(timeline.body.items.at(-1)).toMatchObject({ kind: 'note', body: 'VIP patient, offer priority slot' });
    expect(fake.sent).toHaveLength(0);
    const [after] = await list(owner, base);
    expect(after.lastMessagePreview).toBe('Is the doctor available?');
  });

  it('marks a conversation read', async () => {
    const { owner, base } = await team();
    await inbound('919811112222', 'hi');
    const [conv] = await list(owner, base);
    await api().post(`${base}/${conv.id}/read`).set(auth(owner)).expect(204);
    expect((await list(owner, base))[0].unreadCount).toBe(0);
  });
});

describe('realtime', () => {
  let socket: Socket | undefined;
  afterEach(() => socket?.disconnect());

  async function startServer() {
    const server = createServer(app);
    attachRealtime(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it('rejects connections without a valid token', async () => {
    const { server, url } = await startServer();
    socket = connect(url, { auth: { token: 'nope' }, transports: ['websocket'], reconnection: false });
    const err = await new Promise<Error>((resolve) => socket!.on('connect_error', resolve));
    expect(err.message).toBe('unauthorized');
    server.close();
  });

  it('only members can join a workspace room, and they get change events', async () => {
    const { owner, ws } = await team();
    const stranger = await signup();
    const { server, url } = await startServer();

    const join = (user: TestUser) =>
      new Promise<{ ok: boolean; socket: Socket }>((resolve) => {
        const s = connect(url, { auth: { token: user.token }, transports: ['websocket'], reconnection: false });
        s.on('connect', () => s.emit('workspace:join', ws.id, (res: { ok: boolean }) => resolve({ ok: res.ok, socket: s })));
      });

    const outsider = await join(stranger);
    expect(outsider.ok).toBe(false);
    outsider.socket.disconnect();

    const member = await join(owner);
    socket = member.socket;
    expect(member.ok).toBe(true);
    const received = new Promise<{ type: string }>((resolve) => socket!.on('event', resolve));
    await inbound('919811112222', 'ping');
    expect((await received).type).toMatch(/conversation\.changed|messages\.changed/);
    server.close();
  });
});

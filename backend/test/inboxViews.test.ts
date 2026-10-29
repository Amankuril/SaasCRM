import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Conversation } from '../src/modules/inbox/conversation.model.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { FakeProvider, inboundPayload, sign } from './fakeProvider.js';
import { addMember, api, createWorkspace, signup, type TestUser } from './helpers.js';

const PHONE_ID = '1112223334445';
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

let fake: FakeProvider;
beforeEach(() => {
  fake = new FakeProvider();
  setWhatsAppProvider(fake);
});
afterEach(() => setWhatsAppProvider(undefined));

let seq = 0;
async function inbound(from: string, text: string) {
  seq += 1;
  const body = JSON.stringify(inboundPayload(PHONE_ID, { id: `wamid.v.${seq}.${Date.now()}`, from, text, name: `Customer ${from.slice(-4)}` }));
  await api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body).expect(200);
}

async function setup() {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  const agent = await signup();
  await addMember(owner, ws.id, agent, 'agent');
  await api().put(`/api/workspaces/${ws.id}/whatsapp/connection`).set(auth(owner)).send({ wabaId: '9998887776665', phoneNumberId: PHONE_ID, accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
  await inbound('919811100001', 'Hi, price?');
  await inbound('919811100002', 'Need help');
  await inbound('919811100003', 'Hello');
  const base = `/api/workspaces/${ws.id}/conversations`;
  const all = (await api().get(base).set(auth(owner)).expect(200)).body.conversations as { id: string; contact: { phone: string } }[];
  const byPhone = (p: string) => all.find((c) => c.contact.phone === p)!.id;
  return { owner, agent, ws, base, a: byPhone('+919811100001'), b: byPhone('+919811100002'), c: byPhone('+919811100003') };
}

const ids = async (u: TestUser, url: string) => ((await api().get(url).set(auth(u)).expect(200)).body.conversations as { id: string }[]).map((c) => c.id).sort();

describe('inbox views', () => {
  it('stars per teammate, mentions in notes, waiting-for-a-person and the 24h window tabs', async () => {
    const { owner, agent, ws, base, a, b, c } = await setup();

    await api().post(`${base}/${a}/star`).set(auth(owner)).send({ starred: true }).expect(200);
    expect(await ids(owner, `${base}?view=starred`)).toEqual([a]);
    expect(await ids(agent, `${base}?view=starred`)).toEqual([]);
    expect((await api().get(`${base}/${a}`).set(auth(owner))).body.conversation.starred).toBe(true);

    // @mention the agent in a note on b.
    const team = (await api().get(`${base}/team`).set(auth(agent)).expect(200)).body.team as { id: string; name: string }[];
    expect(team.map((t) => t.id)).toContain(agent.id);
    await api().post(`${base}/${b}/notes`).set(auth(owner)).send({ body: 'Can you take this? @agent', mentions: [agent.id, '64b000000000000000000000'] }).expect(201);
    expect(await ids(agent, `${base}?view=mentions`)).toEqual([b]);
    expect(await ids(owner, `${base}?view=mentions`)).toEqual([]);

    // A flow/AI hand-off waits for a person until a teammate replies.
    await Conversation.updateOne({ _id: c, workspaceId: ws.id }, { botPaused: true, handoffSource: 'ai', handoffAt: new Date(), awaitingHuman: true, aiTouchedAt: new Date() });
    expect(await ids(owner, `${base}?view=waiting`)).toEqual([c]);
    expect(await ids(owner, `${base}?view=ai&ai=escalated`)).toEqual([c]);
    await api().post(`${base}/${c}/messages`).set(auth(owner)).send({ type: 'text', text: 'Hi, I am here to help' }).expect(202);
    expect(await ids(owner, `${base}?view=waiting`)).toEqual([]);

    // Rolling over: the customer's last message is older than 24 hours.
    await Conversation.updateOne({ _id: a, workspaceId: ws.id }, { lastInboundAt: new Date(Date.now() - 30 * 3600_000) });
    expect(await ids(owner, `${base}?window=rolling`)).toEqual([a]);
    expect(await ids(owner, `${base}?window=active`)).toEqual([b, c].sort());

    const counts = (await api().get(`${base}/counts`).set(auth(agent)).expect(200)).body;
    expect(counts).toMatchObject({ all: 3, unassigned: 3, mentions: 1, starred: 0, ai: { all: 1, escalated: 1 } });
  });

  it('snoozes chats out of the open list until the customer writes again', async () => {
    const { owner, base, a, b } = await setup();
    const later = new Date(Date.now() + 3600_000).toISOString();
    await api().patch(`${base}/${a}`).set(auth(owner)).send({ snoozedUntil: new Date(Date.now() - 1000).toISOString() }).expect(400);
    const res = await api().patch(`${base}/${a}`).set(auth(owner)).send({ snoozedUntil: later }).expect(200);
    expect(res.body.conversation.snoozedUntil).toBe(later);
    expect(await ids(owner, base)).not.toContain(a);
    expect(await ids(owner, `${base}?status=snoozed`)).toEqual([a]);
    expect((await api().get(`${base}/counts`).set(auth(owner))).body).toMatchObject({ all: 2, snoozed: 1 });

    await inbound('919811100001', 'Any update?');
    expect(await ids(owner, base)).toContain(a);
    expect(await ids(owner, `${base}?status=snoozed`)).toEqual([]);
    expect(b).toBeTruthy();
  });

  it('applies bulk actions, skipping chats the user may not act on', async () => {
    const { owner, agent, base, a, b, c } = await setup();
    const bulk = (u: TestUser, body: object) => api().post(`${base}/bulk`).set(auth(u)).send(body);
    expect((await bulk(owner, { ids: [a, b], action: 'assign', assigneeId: agent.id }).expect(200)).body).toEqual({ updated: 2, skipped: 0 });
    expect(await ids(agent, `${base}?view=mine`)).toEqual([a, b].sort());
    await bulk(agent, { ids: [c], action: 'assign', assigneeId: agent.id }).expect(403);

    expect((await bulk(owner, { ids: [a, b, c], action: 'resolve' }).expect(200)).body.updated).toBe(3);
    expect(await ids(owner, base)).toEqual([]);
    expect(await ids(owner, `${base}?status=resolved`)).toEqual([a, b, c].sort());
    await bulk(owner, { ids: [a], action: 'reopen' }).expect(200);
    await bulk(owner, { ids: [a, b], action: 'star' }).expect(200);
    expect(await ids(owner, `${base}?view=starred&status=all`)).toEqual([a, b].sort());
    await bulk(owner, { ids: [a], action: 'snooze' }).expect(400);
  });

  it('filters by assignee, priority, unread and tag', async () => {
    const { owner, ws, base, a, b } = await setup();
    await api().patch(`${base}/${a}`).set(auth(owner)).send({ priority: 'high' }).expect(200);
    expect(await ids(owner, `${base}?priority=high`)).toEqual([a]);
    await api().post(`${base}/${b}/read`).set(auth(owner)).expect(204);
    expect(await ids(owner, `${base}?unread=true`)).not.toContain(b);
    const tag = (await api().post(`/api/workspaces/${ws.id}/tags`).set(auth(owner)).send({ name: 'VIP' }).expect(201)).body.tag;
    const contactId = (await api().get(`${base}/${b}`).set(auth(owner))).body.conversation.contact.id;
    await api().patch(`/api/workspaces/${ws.id}/contacts/${contactId}`).set(auth(owner)).send({ tags: [tag.id] }).expect(200);
    expect(await ids(owner, `${base}?tag=${tag.id}`)).toEqual([b]);
    expect(await ids(owner, `${base}?assignee=none`)).toHaveLength(3);
  });
});

describe('canned replies', () => {
  it('creates, lists by use, edits and deletes shortcut messages', async () => {
    const { owner, agent, ws } = await setup();
    const base = `/api/workspaces/${ws.id}/canned-replies`;
    const created = (await api().post(base).set(auth(agent)).send({ shortcut: '/Hours', body: 'We are open 9am–7pm, Mon–Sat.' }).expect(201)).body.reply;
    expect(created.shortcut).toBe('hours');
    await api().post(base).set(auth(owner)).send({ shortcut: 'hours', body: 'dup' }).expect(409);
    await api().post(base).set(auth(owner)).send({ shortcut: 'two words', body: 'x' }).expect(400);
    const other = (await api().post(base).set(auth(owner)).send({ shortcut: 'thanks', body: 'Thank you {{name}}!' }).expect(201)).body.reply;
    await api().post(`${base}/${other.id}/used`).set(auth(owner)).expect(204);
    expect((await api().get(base).set(auth(agent)).expect(200)).body.replies.map((r: { shortcut: string }) => r.shortcut)).toEqual(['thanks', 'hours']);
    await api().patch(`${base}/${created.id}`).set(auth(owner)).send({ body: 'Open 10–6.' }).expect(200);
    await api().delete(`${base}/${created.id}`).set(auth(owner)).expect(204);
    expect((await api().get(base).set(auth(owner))).body.replies).toHaveLength(1);
  });
});

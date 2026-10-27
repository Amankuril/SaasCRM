import { describe, expect, it } from 'vitest';
import { addMember, api, createWorkspace, signup, type TestUser } from './helpers.js';

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

async function setup() {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  return { owner, ws, base: `/api/workspaces/${ws.id}`, as: auth(owner) };
}

describe('ticket / task board', () => {
  it('seeds columns, numbers tasks, moves and reorders them, and filters', async () => {
    const ctx = await setup();
    const agent = await signup();
    await addMember(ctx.owner, ctx.ws.id, agent, 'agent');
    const columns = (await api().get(`${ctx.base}/task-columns`).set(ctx.as).expect(200)).body.columns;
    expect(columns.map((c: { name: string }) => c.name)).toEqual(['Open', 'In Progress', 'Unit Testing', 'Done']);

    const contact = (await api().post(`${ctx.base}/contacts`).set(ctx.as).send({ phone: '+919811111111', name: 'Asha' }).expect(201)).body.contact;
    const create = (body: object) => api().post(`${ctx.base}/tasks`).set(ctx.as).send(body);
    const t1 = (await create({ title: 'Call back about invoice', type: 'ticket', contactId: contact.id, assigneeId: agent.id, priority: 'high' }).expect(201)).body.task;
    const t2 = (await create({ title: 'Prepare demo' }).expect(201)).body.task;
    const t3 = (await create({ title: 'Fix typo', status: 'in_progress' }).expect(201)).body.task;
    expect([t1.number, t2.number, t3.number]).toEqual([1, 2, 3]);
    expect(t1).toMatchObject({ status: 'open', type: 'ticket', contact: { name: 'Asha' }, assignee: { id: agent.id } });
    await create({ title: '' }).expect(400);
    await create({ title: 'x', status: 'nope' }).expect(400);
    await create({ title: 'x', assigneeId: '64b000000000000000000000' }).expect(400);

    // Drag "Prepare demo" above "Fix typo" in In Progress.
    await api().post(`${ctx.base}/tasks/${t2.id}/move`).set(ctx.as).send({ status: 'in_progress', orderedIds: [t2.id, t3.id] }).expect(200);
    const done = await api().post(`${ctx.base}/tasks/${t1.id}/move`).set(ctx.as).send({ status: 'done', orderedIds: [t1.id] }).expect(200);
    expect(done.body.task.completedAt).toEqual(expect.any(String));
    const all = (await api().get(`${ctx.base}/tasks`).set(ctx.as).expect(200)).body.tasks as { id: string; status: string }[];
    expect(all.filter((t) => t.status === 'in_progress').map((t) => t.id)).toEqual([t2.id, t3.id]);

    expect((await api().get(`${ctx.base}/tasks?assignee=${agent.id}`).set(ctx.as)).body.tasks).toHaveLength(1);
    expect((await api().get(`${ctx.base}/tasks?assignee=unassigned`).set(ctx.as)).body.tasks).toHaveLength(2);
    expect((await api().get(`${ctx.base}/tasks?q=%233`).set(ctx.as)).body.tasks.map((t: { title: string }) => t.title)).toEqual(['Fix typo']);
    expect((await api().get(`${ctx.base}/tasks?type=ticket`).set(ctx.as)).body.tasks).toHaveLength(1);

    // Deleting a column moves its tasks.
    const inProgress = columns.find((c: { key: string }) => c.key === 'in_progress');
    await api().delete(`${ctx.base}/task-columns/${inProgress.id}?moveTo=open`).set(ctx.as).expect(200);
    const after = (await api().get(`${ctx.base}/tasks`).set(ctx.as)).body.tasks as { status: string }[];
    expect(after.filter((t) => t.status === 'open')).toHaveLength(2);
    const added = (await api().post(`${ctx.base}/task-columns`).set(ctx.as).send({ name: 'QA Review', color: 'pink' }).expect(201)).body.column;
    expect(added.key).toBe('qa_review');
  });
});

describe('appointments', () => {
  it('books, filters, counts and exports appointments', async () => {
    const ctx = await setup();
    const inHour = new Date(Date.now() + 3600_000).toISOString();
    const lastWeek = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const book = (body: object) => api().post(`${ctx.base}/appointments`).set(ctx.as).send(body);

    const a = (await book({ phone: '+919811111111', name: 'Asha', service: 'Teeth cleaning', startAt: inHour }).expect(201)).body.appointment;
    expect(a).toMatchObject({ service: 'Teeth cleaning', status: 'scheduled', source: 'manual', contact: { name: 'Asha', phone: '+919811111111' } });
    const b = (await book({ contactId: a.contact.id, service: 'Consultation', startAt: lastWeek }).expect(201)).body.appointment;
    await book({ service: 'No customer', startAt: inHour }).expect(400);

    await api().patch(`${ctx.base}/appointments/${b.id}`).set(ctx.as).send({ status: 'cancelled' }).expect(200);
    const list = (await api().get(`${ctx.base}/appointments`).set(ctx.as).expect(200)).body;
    expect(list).toMatchObject({ total: 2, stats: { upcoming: 1, cancelled: 1 } });
    expect(list.appointments.map((x: { id: string }) => x.id)).toEqual([a.id, b.id]);
    expect((await api().get(`${ctx.base}/appointments?q=clean`).set(ctx.as)).body.total).toBe(1);
    expect((await api().get(`${ctx.base}/appointments?q=98111`).set(ctx.as)).body.total).toBe(2);
    expect((await api().get(`${ctx.base}/appointments?from=${encodeURIComponent(new Date().toISOString())}`).set(ctx.as)).body.total).toBe(1);

    const csv = await api().get(`${ctx.base}/appointments/export?sort=oldest`).set(ctx.as).expect(200);
    expect(csv.text.split('\n')[1]).toMatch(/^Asha,'\+919811111111,Consultation,.*,cancelled,manual/);
    await api().delete(`${ctx.base}/appointments/${b.id}`).set(ctx.as).expect(204);
  });
});

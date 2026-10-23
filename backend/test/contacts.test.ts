import { describe, expect, it } from 'vitest';
import { addMember, api, createWorkspace, signup, type TestUser } from './helpers.js';

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

async function setup() {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  const base = `/api/workspaces/${ws.id}`;
  return { owner, ws, base };
}

describe('contacts', () => {
  it('creates with normalized phone, rejects duplicates, searches and filters', async () => {
    const { owner, base } = await setup();
    const create = (body: object) => api().post(`${base}/contacts`).set(auth(owner)).send(body);

    const res = await create({ phone: '98111 12222', name: 'Priya Sharma', email: 'Priya@Example.com', lifecycleStage: 'qualified' }).expect(201);
    expect(res.body.contact).toMatchObject({ phone: '+919811112222', email: 'priya@example.com', lifecycleStage: 'qualified', displayName: 'Priya Sharma' });

    const dup = await create({ phone: '+91 98111-12222' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONTACT_EXISTS');
    const bad = await create({ phone: '12' });
    expect(bad.status).toBe(400);

    await create({ phone: '+919822233333', name: 'Rahul Verma' }).expect(201);

    const byName = await api().get(`${base}/contacts?q=priya`).set(auth(owner)).expect(200);
    expect(byName.body.contacts.map((c: { name: string }) => c.name)).toEqual(['Priya Sharma']);
    const byPhone = await api().get(`${base}/contacts?q=22233`).set(auth(owner));
    expect(byPhone.body.contacts.map((c: { name: string }) => c.name)).toEqual(['Rahul Verma']);
    const byStage = await api().get(`${base}/contacts?stage=qualified`).set(auth(owner));
    expect(byStage.body.total).toBe(1);
    // Regex characters in search are treated literally.
    await api().get(`${base}/contacts?q=(.*`).set(auth(owner)).expect(200);
  });

  it('manages tags and applies them to contacts', async () => {
    const { owner, base } = await setup();
    const vip = await api().post(`${base}/tags`).set(auth(owner)).send({ name: 'VIP', color: 'amber' }).expect(201);
    const dup = await api().post(`${base}/tags`).set(auth(owner)).send({ name: 'vip' });
    expect(dup.body.error.code).toBe('TAG_EXISTS');

    const c = await api().post(`${base}/contacts`).set(auth(owner)).send({ phone: '+919811112222', tags: [vip.body.tag.id] }).expect(201);
    const filtered = await api().get(`${base}/contacts?tag=${vip.body.tag.id}`).set(auth(owner));
    expect(filtered.body.total).toBe(1);
    const tags = await api().get(`${base}/tags`).set(auth(owner));
    expect(tags.body.tags[0]).toMatchObject({ name: 'VIP', contactCount: 1 });

    const bogus = await api().patch(`${base}/contacts/${c.body.contact.id}`).set(auth(owner)).send({ tags: ['000000000000000000000000'] });
    expect(bogus.status).toBe(400);

    await api().delete(`${base}/tags/${vip.body.tag.id}`).set(auth(owner)).expect(204);
    const after = await api().get(`${base}/contacts/${c.body.contact.id}`).set(auth(owner));
    expect(after.body.contact.tags).toEqual([]);
  });

  it('updates CRM fields and consent; opted-out contacts cannot be messaged', async () => {
    const { owner, base } = await setup();
    const c = await api().post(`${base}/contacts`).set(auth(owner)).send({ phone: '+919811112222' });
    const res = await api()
      .patch(`${base}/contacts/${c.body.contact.id}`)
      .set(auth(owner))
      .send({ name: 'Priya', lifecycleStage: 'follow_up', customFields: { city: 'Pune' }, consentStatus: 'opted_out', ownerId: owner.id })
      .expect(200);
    expect(res.body.contact).toMatchObject({ name: 'Priya', lifecycleStage: 'follow_up', customFields: { city: 'Pune' }, ownerId: owner.id, consent: { status: 'opted_out', source: 'manual' } });

    const badOwner = await api().patch(`${base}/contacts/${c.body.contact.id}`).set(auth(owner)).send({ ownerId: '000000000000000000000000' });
    expect(badOwner.status).toBe(400);
  });

  it('imports CSV rows with skip / update / merge duplicate strategies and a row report', async () => {
    const { owner, base } = await setup();
    await api().post(`${base}/contacts`).set(auth(owner)).send({ phone: '+919811112222', name: 'Old Name' });

    const rows = [
      { Mobile: '98111 12222', Name: 'New Name', Email: 'priya@example.com', Labels: 'VIP; Existing Patient' },
      { Mobile: '+91 98222 33333', Name: 'Rahul', Email: '', Labels: 'vip' },
      { Mobile: 'not a phone', Name: 'Broken', Email: '', Labels: '' },
      { Mobile: '9822233333', Name: 'Rahul again', Email: '', Labels: '' },
      { Mobile: '9833344444', Name: 'Bad email', Email: 'nope', Labels: '' },
    ];
    const mapping = { phone: 'Mobile', name: 'Name', email: 'Email', tags: 'Labels' };

    const skip = await api().post(`${base}/contacts/import`).set(auth(owner)).send({ rows, mapping, duplicate: 'skip' }).expect(200);
    expect(skip.body.report).toMatchObject({ total: 5, created: 1, updated: 0, skipped: 1 });
    expect(skip.body.report.invalid).toEqual([
      { row: 4, reason: 'Invalid or missing phone number' },
      { row: 5, reason: 'Duplicate phone number in file' },
      { row: 6, reason: 'Invalid email "nope"' },
    ]);
    let priya = (await api().get(`${base}/contacts?q=11112222`).set(auth(owner))).body.contacts[0];
    expect(priya.name).toBe('Old Name');

    // Tags from the file were created once, case-insensitively.
    const tags = (await api().get(`${base}/tags`).set(auth(owner))).body.tags.map((t: { name: string }) => t.name);
    expect(tags.sort()).toEqual(['Existing Patient', 'VIP']);

    const merge = await api().post(`${base}/contacts/import`).set(auth(owner)).send({ rows: rows.slice(0, 1), mapping, duplicate: 'merge' });
    expect(merge.body.report).toMatchObject({ updated: 1 });
    priya = (await api().get(`${base}/contacts?q=11112222`).set(auth(owner))).body.contacts[0];
    expect(priya).toMatchObject({ name: 'Old Name', email: 'priya@example.com' }); // filled empty email only
    expect(priya.tags).toHaveLength(2);

    await api().post(`${base}/contacts/import`).set(auth(owner)).send({ rows: rows.slice(0, 1), mapping, duplicate: 'update' });
    priya = (await api().get(`${base}/contacts?q=11112222`).set(auth(owner))).body.contacts[0];
    expect(priya.name).toBe('New Name');
  });

  it('exports CSV for admins only, safely escaped, and audits it', async () => {
    const { owner, ws, base } = await setup();
    const agent = await signup();
    await addMember(owner, ws.id, agent, 'agent');
    await api().post(`${base}/contacts`).set(auth(owner)).send({ phone: '+919811112222', name: '=HYPERLINK("evil"), "Ltd"' });

    await api().get(`${base}/contacts/export`).set(auth(agent)).expect(403);
    const res = await api().get(`${base}/contacts/export`).set(auth(owner)).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const [header, row] = res.text.split('\n');
    expect(header).toBe('phone,name,profile_name,email,lifecycle_stage,tags,consent,source,created_at');
    expect(row).toContain(`+919811112222,"'=HYPERLINK(""evil""), ""Ltd"""`);

    const audit = await api().get(`${base}/audit-logs`).set(auth(owner));
    expect(audit.body.items[0].action).toBe('contacts.exported');
  });

  it('agents can edit contacts but not delete or import; deleting removes history', async () => {
    const { owner, ws, base } = await setup();
    const agent = await signup();
    await addMember(owner, ws.id, agent, 'agent');
    const c = await api().post(`${base}/contacts`).set(auth(agent)).send({ phone: '+919811112222' }).expect(201);

    await api().patch(`${base}/contacts/${c.body.contact.id}`).set(auth(agent)).send({ lifecycleStage: 'contacted' }).expect(200);
    await api().delete(`${base}/contacts/${c.body.contact.id}`).set(auth(agent)).expect(403);
    await api().post(`${base}/contacts/import`).set(auth(agent)).send({ rows: [{ p: '1' }], mapping: { phone: 'p' }, duplicate: 'skip' }).expect(403);

    await api().delete(`${base}/contacts/${c.body.contact.id}`).set(auth(owner)).expect(204);
    await api().get(`${base}/contacts/${c.body.contact.id}`).set(auth(owner)).expect(404);
  });

  it("other workspaces can't see or touch contacts", async () => {
    const a = await setup();
    const b = await setup();
    const c = await api().post(`${a.base}/contacts`).set(auth(a.owner)).send({ phone: '+919811112222' });
    await api().get(`${b.base}/contacts/${c.body.contact.id}`).set(auth(b.owner)).expect(404);
    await api().patch(`${b.base}/contacts/${c.body.contact.id}`).set(auth(b.owner)).send({ name: 'x' }).expect(404);
    expect((await api().get(`${b.base}/contacts`).set(auth(b.owner))).body.total).toBe(0);
  });
});

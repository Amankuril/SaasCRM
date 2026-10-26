import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CampaignRecipient } from '../src/modules/campaigns/campaign.model.js';
import { Contact } from '../src/modules/contacts/contact.model.js';
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

async function setup() {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  const base = `/api/workspaces/${ws.id}`;
  const as = auth(owner);
  const contact = async (phone: string, body: object = {}) => (await api().post(`${base}/contacts`).set(as).send({ phone, ...body }).expect(201)).body.contact;
  const audience = (query: object = {}) => api().get(`${base}/audience?query=${encodeURIComponent(JSON.stringify(query))}`).set(as).expect(200);
  return { owner, ws, base, as, contact, audience };
}

describe('pipeline stages', () => {
  it('seeds the default stages, validates stage keys, and moves contacts when a stage is deleted', async () => {
    const ctx = await setup();
    const stages = (await api().get(`${ctx.base}/pipeline-stages`).set(ctx.as).expect(200)).body.stages;
    expect(stages.map((s: { name: string }) => s.name)).toEqual(['New Lead', 'Hot Lead', 'Warm Lead', 'Invoice issued', 'Payment in progress', 'Payment made', 'Cold Lead', 'No budget']);

    await api().post(`${ctx.base}/contacts`).set(ctx.as).send({ phone: '+919811111111', lifecycleStage: 'made_up' }).expect(400);
    const created = (await api().post(`${ctx.base}/pipeline-stages`).set(ctx.as).send({ name: 'Demo booked', color: 'blue' }).expect(201)).body.stage;
    expect(created.key).toBe('demo_booked');
    await api().post(`${ctx.base}/pipeline-stages`).set(ctx.as).send({ name: 'demo BOOKED' }).expect(409);
    const c = await ctx.contact('+919811111111', { lifecycleStage: 'demo_booked' });

    const newLead = stages.find((s: { key: string }) => s.key === 'new');
    await api().delete(`${ctx.base}/pipeline-stages/${newLead.id}`).set(ctx.as).expect(409);
    const del = await api().delete(`${ctx.base}/pipeline-stages/${created.id}?moveTo=hot`).set(ctx.as).expect(200);
    expect(del.body.moved).toBe(1);
    expect((await Contact.findOne({ _id: c.id, workspaceId: ctx.ws.id }))!.lifecycleStage).toBe('hot');
  });

  it('keeps stages that existing contacts already use', async () => {
    const ctx = await setup();
    await Contact.create({ workspaceId: ctx.ws.id, phoneE164: '+919800000001', lifecycleStage: 'qualified' });
    const stages = (await api().get(`${ctx.base}/pipeline-stages`).set(ctx.as)).body.stages;
    expect(stages.at(-1)).toMatchObject({ key: 'qualified', name: 'Qualified', count: 1 });
  });
});

describe('audience', () => {
  it('filters, sorts, bulk-edits and exports', async () => {
    const ctx = await setup();
    const agent = await signup();
    await addMember(ctx.owner, ctx.ws.id, agent, 'agent');
    const vip = (await api().post(`${ctx.base}/tags`).set(ctx.as).send({ name: 'VIP' })).body.tag;
    const a = await ctx.contact('+919811111111', { name: 'Asha', lifecycleStage: 'hot' });
    const b = await ctx.contact('+919822222222', { name: 'bina' });
    await ctx.contact('+919833333333', { name: 'Chetan', tags: [vip.id] });

    expect((await ctx.audience({ filter: { stages: ['hot'] } })).body).toMatchObject({ total: 1, contacts: [{ id: a.id }] });
    expect((await ctx.audience({ sort: 'name', dir: 'asc' })).body.contacts.map((c: { name: string }) => c.name)).toEqual(['Asha', 'bina', 'Chetan']);
    expect((await ctx.audience({ q: '98222' })).body.contacts.map((c: { id: string }) => c.id)).toEqual([b.id]);
    expect((await ctx.audience({ limit: 2, page: 2 })).body).toMatchObject({ total: 3, pages: 2, page: 2 });

    const bulk = (body: object) => api().post(`${ctx.base}/audience/bulk`).set(ctx.as).send(body);
    await bulk({ action: 'set_stage', contactIds: [a.id, b.id], stage: 'warm' }).expect(200);
    await bulk({ action: 'set_stage', contactIds: [a.id], stage: 'nope' }).expect(400);
    await bulk({ action: 'add_tags', contactIds: [a.id, b.id], tagIds: [vip.id] }).expect(200);
    await bulk({ action: 'set_owner', contactIds: [a.id], ownerId: agent.id }).expect(200);
    await bulk({ action: 'set_owner', contactIds: [a.id], ownerId: '64b000000000000000000000' }).expect(400);

    const warm = (await ctx.audience({ filter: { stages: ['warm'], tagsAny: [vip.id] } })).body;
    expect(warm.total).toBe(2);
    const asha = warm.contacts.find((c: { id: string }) => c.id === a.id);
    expect(asha.owner).toEqual({ id: agent.id, name: expect.any(String) });
    expect((await ctx.audience({ filter: { unassigned: true } })).body.total).toBe(2);
    expect((await ctx.audience({ filter: { ownerIds: [agent.id] } })).body.total).toBe(1);

    const csv = await api().get(`${ctx.base}/audience/export?query=${encodeURIComponent(JSON.stringify({ filter: { stages: ['warm'] }, sort: 'name', dir: 'asc' }))}`).set(ctx.as).expect(200);
    const lines = csv.text.split('\n');
    expect(lines[0]).toContain('stage,tags,chat_source');
    expect(lines[1]).toMatch(/^Asha,'\+919811111111,,Warm Lead,VIP,/);
    expect(lines).toHaveLength(3);

    await bulk({ action: 'delete', contactIds: [b.id] }).expect(200);
    expect((await ctx.audience()).body.total).toBe(2);
  });

  it('tracks follow-ups and custom fields', async () => {
    const ctx = await setup();
    const a = await ctx.contact('+919811111111', { name: 'Asha' });
    await ctx.contact('+919822222222', { name: 'Bina' });
    const past = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const f1 = (await api().post(`${ctx.base}/follow-ups`).set(ctx.as).send({ contactId: a.id, dueAt: future, note: 'Send quote' }).expect(201)).body.followUp;
    await api().post(`${ctx.base}/follow-ups`).set(ctx.as).send({ contactId: a.id, dueAt: past, note: 'Call back' }).expect(201);

    const row = (await ctx.audience({ followUp: 'any' })).body;
    expect(row).toMatchObject({ total: 1, contacts: [{ id: a.id, openFollowUps: 2, nextFollowUp: { note: 'Call back' } }] });
    expect((await ctx.audience({ followUp: 'overdue' })).body.total).toBe(1);
    expect((await ctx.audience({ followUp: 'none' })).body.total).toBe(1);
    await api().patch(`${ctx.base}/follow-ups/${f1.id}`).set(ctx.as).send({ done: true }).expect(200);
    const list = (await api().get(`${ctx.base}/follow-ups?status=open`).set(ctx.as).expect(200)).body.followUps;
    expect(list).toEqual([expect.objectContaining({ note: 'Call back', contact: expect.objectContaining({ name: 'Asha' }) })]);

    const field = (await api().post(`${ctx.base}/custom-fields`).set(ctx.as).send({ label: 'Clinic city' }).expect(201)).body.field;
    expect(field.key).toBe('clinic_city');
    await api().post(`${ctx.base}/custom-fields`).set(ctx.as).send({ label: 'clinic CITY' }).expect(409);
    await api().patch(`${ctx.base}/contacts/${a.id}`).set(ctx.as).send({ customFields: { other: 'kept' } }).expect(200);
    const patched = await api().patch(`${ctx.base}/contacts/${a.id}`).set(ctx.as).send({ customFieldPatch: { clinic_city: 'Indore' } }).expect(200);
    expect(patched.body.contact.customFields).toEqual({ other: 'kept', clinic_city: 'Indore' });
  });

  it('records the chat source and backfills broadcast leads with Sync Campaigns', async () => {
    const ctx = await setup();
    await api().put(`${ctx.base}/whatsapp/connection`).set(ctx.as).send({ wabaId: '9998887776665', phoneNumberId: PHONE_ID, accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
    const post = async (p: unknown) => {
      const body = JSON.stringify(p);
      await api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body).expect(200);
    };
    await post(inboundPayload(PHONE_ID, { id: 'wamid.d1', from: '919811111111', text: 'Hi' }));
    const direct = (await ctx.audience({ filter: { sources: ['direct'] } })).body;
    expect(direct.contacts[0]).toMatchObject({ phone: '+919811111111', attribution: { source: 'direct' } });

    // A broadcast reply recorded before tracking existed gets backfilled.
    const old = await ctx.contact('+919822222222', { name: 'Old lead' });
    const campaign = (await api().post(`${ctx.base}/campaigns`).set(ctx.as).send({ name: 'Indore_skin_16/1026' }).expect(201)).body.campaign;
    await CampaignRecipient.create({ workspaceId: ctx.ws.id, campaignId: campaign.id, contactId: old.id, phone: old.phone, status: 'read', repliedAt: new Date() });
    const sync = await api().post(`${ctx.base}/audience/sync-campaigns`).set(ctx.as).expect(200);
    expect(sync.body.broadcast).toBe(1);
    const leads = (await ctx.audience({ filter: { sources: ['broadcast'], campaignIds: [campaign.id] } })).body;
    expect(leads.contacts).toEqual([expect.objectContaining({ id: old.id, attribution: expect.objectContaining({ source: 'broadcast', campaignName: 'Indore_skin_16/1026' }) })]);
    expect((await ctx.audience({ filter: { sources: ['none'] } })).body.total).toBe(0);
  });
});

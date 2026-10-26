import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Contact } from '../src/modules/contacts/contact.model.js';
import { MessageTemplate } from '../src/modules/templates/template.model.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { FakeProvider } from './fakeProvider.js';
import { api, createWorkspace, signup, type TestUser } from './helpers.js';

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
  const newList = async (name: string) => (await api().post(`${base}/contact-lists`).set(as).send({ name }).expect(201)).body.list as { id: string };
  return { owner, ws, base, as, newList };
}

describe('contact lists', () => {
  it('creates lists with unique names and adds contacts one by one', async () => {
    const ctx = await setup();
    const list = await ctx.newList('Diwali Leads');
    expect((await api().post(`${ctx.base}/contact-lists`).set(ctx.as).send({ name: 'diwali leads' }).expect(409)).body.error.code).toBe('LIST_EXISTS');
    await api().post(`${ctx.base}/contact-lists`).set(ctx.as).send({ name: '  ' }).expect(400);

    const add = (body: object) => api().post(`${ctx.base}/contact-lists/${list.id}/contacts`).set(ctx.as).send(body);
    const first = await add({ country: 'IN', phone: '98765 43210', name: 'Priya' }).expect(201);
    expect(first.body).toMatchObject({ created: true, contact: { phone: '+919876543210', name: 'Priya', lists: [list.id] } });
    // Same number again: already in the list, nothing duplicated.
    expect((await add({ country: 'IN', phone: '+91 98765 43210' }).expect(200)).body).toMatchObject({ created: false, alreadyInList: true });
    await add({ country: 'IN', phone: '12' }).expect(400);

    const lists = await api().get(`${ctx.base}/contact-lists`).set(ctx.as).expect(200);
    expect(lists.body.lists).toEqual([expect.objectContaining({ name: 'Diwali Leads', count: 1 })]);
  });

  it('imports the sample CSV format (with and without tags) and reports bad rows', async () => {
    const ctx = await setup();
    const list = await ctx.newList('Indore dental');
    // An existing contact joins the list and keeps their name.
    await api().post(`${ctx.base}/contacts`).set(ctx.as).send({ phone: '+919811111111', name: 'Asha' }).expect(201);

    const imported = await api()
      .post(`${ctx.base}/contact-lists/${list.id}/import`)
      .set(ctx.as)
      .send({
        international: true,
        withTags: true,
        rows: [
          ['Mr. John', '919822222222', 'VIP, Dental'],
          ['Renamed', '919811111111', 'Dental'],
          ['Mr. Adam', '67988898459'],
          ['Dup', '919822222222'],
          ['', ''],
        ],
      })
      .expect(200);
    expect(imported.body.report).toEqual({
      total: 4,
      created: 1,
      added: 1,
      alreadyInList: 0,
      invalid: [
        { row: 3, reason: '"67988898459" is not a valid phone number' },
        { row: 4, reason: 'Duplicate number in file' },
      ],
    });
    const asha = await Contact.findOne({ workspaceId: ctx.ws.id, phoneE164: '+919811111111' });
    expect(asha!.name).toBe('Asha');
    const john = (await api().get(`${ctx.base}/contact-lists/${list.id}/contacts?q=john`).set(ctx.as).expect(200)).body.contacts[0];
    expect(john).toMatchObject({ name: 'Mr. John', phone: '+919822222222', tags: [expect.any(String), expect.any(String)] });

    // Numbers without a country code use the chosen country; a header line is tolerated.
    const local = await api()
      .post(`${ctx.base}/contact-lists/${list.id}/import`)
      .set(ctx.as)
      .send({ international: false, country: 'IN', rows: [['Name', 'Number'], ['Ravi', '9833333333']] })
      .expect(200);
    expect(local.body.report).toMatchObject({ total: 1, created: 1, invalid: [] });
    await api().post(`${ctx.base}/contact-lists/${list.id}/import`).set(ctx.as).send({ international: false, rows: [['A', '9833333333']] }).expect(400);

    const lists = (await api().get(`${ctx.base}/contact-lists`).set(ctx.as)).body.lists;
    expect(lists[0]).toMatchObject({ count: 3, tags: [expect.objectContaining({ name: 'Dental' }), expect.objectContaining({ name: 'VIP' })] });
  });

  it('assigns, removes and deletes without losing contacts; campaigns can target a list', async () => {
    const ctx = await setup();
    const a = await ctx.newList('A');
    const b = await ctx.newList('B');
    const contact = (await api().post(`${ctx.base}/contacts`).set(ctx.as).send({ phone: '+919844444444', name: 'Neha' }).expect(201)).body.contact;
    await api().post(`${ctx.base}/contacts`).set(ctx.as).send({ phone: '+919855555555', name: 'Not in list' }).expect(201);

    await api().post(`${ctx.base}/contact-lists/assign`).set(ctx.as).send({ contactIds: [contact.id], listIds: [a.id, b.id] }).expect(200);
    expect((await api().get(`${ctx.base}/contacts?list=${b.id}`).set(ctx.as)).body.total).toBe(1);
    await api().post(`${ctx.base}/contact-lists/${b.id}/remove`).set(ctx.as).send({ contactIds: [contact.id] }).expect(200);
    expect((await api().get(`${ctx.base}/contacts?list=${b.id}`).set(ctx.as)).body.total).toBe(0);
    await api().delete(`${ctx.base}/contact-lists/${b.id}`).set(ctx.as).expect(204);
    expect(await Contact.countDocuments({ workspaceId: ctx.ws.id })).toBe(2);

    await api().put(`${ctx.base}/whatsapp/connection`).set(ctx.as).send({ wabaId: '9998887776665', phoneNumberId: '1112223334445', accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
    fake.templates = [{ providerTemplateId: 't1', name: 'hello', language: 'en', category: 'MARKETING', status: 'APPROVED', rejectedReason: null, components: [{ type: 'BODY', text: 'Hello there!' }] }];
    await api().post(`${ctx.base}/templates/sync`).set(ctx.as).expect(200);
    const template = await MessageTemplate.findOne({ workspaceId: ctx.ws.id, name: 'hello' });
    const draft = {
      name: 'List blast',
      templateId: template!.id,
      headerVariables: [],
      bodyVariables: [],
      audience: { type: 'list', segmentId: null, filter: { tagsAny: [], excludeTags: [], stages: [], requireOptIn: false, listsAny: [] } },
      sendRatePerMinute: 60,
      quietHours: { enabled: false, start: '21:00', end: '09:00' },
    };
    await api().post(`${ctx.base}/campaigns`).set(ctx.as).send(draft).expect(400);
    const campaign = (await api().post(`${ctx.base}/campaigns`).set(ctx.as).send({ ...draft, audience: { ...draft.audience, filter: { ...draft.audience.filter, listsAny: [a.id] } } }).expect(201)).body.campaign;
    expect(campaign.audience).toMatchObject({ type: 'list', filter: { listsAny: [a.id] } });
    await api().post(`${ctx.base}/campaigns/${campaign.id}/launch`).set(ctx.as).send({}).expect(200);
    expect(fake.sent.map((s) => s.message.to)).toEqual(['+919844444444']);
  });

  it('sorts members, exports one list as CSV and lets contacts be edited', async () => {
    const ctx = await setup();
    const list = await ctx.newList('Indore skin');
    const add = (phone: string, name: string) => api().post(`${ctx.base}/contact-lists/${list.id}/contacts`).set(ctx.as).send({ country: 'IN', phone, name }).expect(201);
    const zara = (await add('9811111111', 'zara')).body.contact;
    await add('9822222222', 'Anil');
    await api().post(`${ctx.base}/contacts`).set(ctx.as).send({ phone: '+919833333333', name: 'Outside list' }).expect(201);

    const sorted = await api().get(`${ctx.base}/contact-lists/${list.id}/contacts?sort=name&dir=asc`).set(ctx.as).expect(200);
    expect(sorted.body.contacts.map((c: { name: string }) => c.name)).toEqual(['Anil', 'zara']);

    const csv = await api().get(`${ctx.base}/contacts/export?list=${list.id}`).set(ctx.as).expect(200);
    expect(csv.headers['content-disposition']).toMatch(/filename="indore-skin-/);
    expect(csv.text.split('\n')).toHaveLength(3);
    expect(csv.text).not.toContain('Outside list');

    const edited = await api().patch(`${ctx.base}/contacts/${zara.id}`).set(ctx.as).send({ name: 'Zara Khan', phone: '+91 98444 44444' }).expect(200);
    expect(edited.body.contact).toMatchObject({ name: 'Zara Khan', phone: '+919844444444', lists: [list.id] });
    expect((await api().patch(`${ctx.base}/contacts/${zara.id}`).set(ctx.as).send({ phone: '+919833333333' }).expect(409)).body.error.code).toBe('CONTACT_EXISTS');
  });
});

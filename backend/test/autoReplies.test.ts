import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Contact } from '../src/modules/contacts/contact.model.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { FakeProvider, inboundPayload, sign } from './fakeProvider.js';
import { api, createWorkspace, signup, type TestUser } from './helpers.js';

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
  await api().put(`${base}/whatsapp/connection`).set(auth(owner)).send({ wabaId: '9998887776665', phoneNumberId: PHONE_ID, accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
  const create = (body: object) => api().post(`${base}/auto-replies`).set(auth(owner)).send({ active: true, ...body });
  return { owner, ws, base, create };
}

let seq = 0;
function customerWrites(text: string, from = '919811112222') {
  const body = JSON.stringify(inboundPayload(PHONE_ID, { id: `wamid.in.${++seq}`, from, text, name: 'Priya Sharma' }));
  return api().post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body).expect(200);
}

const sentTexts = () => fake.sent.map((s) => (s.message as { text?: string; body?: string }).text ?? (s.message as { body?: string }).body);

describe('keyword triggers', () => {
  it('validates, rejects clashing keywords and lists with filters', async () => {
    const ctx = await setup();
    const bad = await ctx.create({ name: 'x', match: 'equals', keywords: [], action: { type: 'text', config: { text: '' } } }).expect(400);
    expect(Object.keys(bad.body.error.details)).toEqual(expect.arrayContaining(['keywords', 'action']));

    await ctx.create({ name: 'Prices', match: 'equals', keywords: ['Price List ', 'rates'], action: { type: 'text', config: { text: 'Here you go' } } }).expect(201);
    const clash = await ctx.create({ name: 'Dup', match: 'equals', keywords: ['price list'], action: { type: 'text', config: { text: 'x' } } }).expect(409);
    expect(clash.body.error.code).toBe('KEYWORD_IN_USE');
    // An inactive copy is fine, but can't be switched on while the other is active.
    const off = await ctx.create({ name: 'Dup', active: false, match: 'equals', keywords: ['price list'], action: { type: 'text', config: { text: 'x' } } }).expect(201);
    await api().patch(`${ctx.base}/auto-replies/${off.body.autoReply.id}/status`).set(auth(ctx.owner)).send({ active: true }).expect(409);

    const list = await api().get(`${ctx.base}/auto-replies?status=active&q=PRICE`).set(auth(ctx.owner)).expect(200);
    expect(list.body).toMatchObject({ total: 2, autoReplies: [{ name: 'Prices', keywords: ['price list', 'rates'], createdBy: expect.any(String) }] });
  });

  it('answers inbound messages: equals beats contains, contacts are personalized, cooldown is respected', async () => {
    const ctx = await setup();
    await ctx.create({ name: 'Generic price', match: 'contains', keywords: ['price'], cooldownMinutes: 60, action: { type: 'text', config: { text: 'Prices start at ₹499.' } } }).expect(201);
    await ctx.create({ name: 'Exact', match: 'equals', keywords: ['price list'], action: { type: 'text', config: { text: 'Hi {{first_name}}, here is the full list.' } } }).expect(201);

    await customerWrites('Price list');
    await customerWrites('what is the price?');
    await customerWrites('price please'); // inside the 60-minute cooldown of "Generic price"
    expect(sentTexts()).toEqual(['Hi Priya, here is the full list.', 'Prices start at ₹499.']);

    const list = await api().get(`${ctx.base}/auto-replies`).set(auth(ctx.owner));
    expect(list.body.autoReplies.find((r: { name: string }) => r.name === 'Generic price')).toMatchObject({ firedCount: 1, lastFiredAt: expect.any(String) });
  });

  it('sends quick replies, files and locations, and unsubscribes on request', async () => {
    const ctx = await setup();
    await ctx.create({ name: 'Menu', match: 'equals', keywords: ['menu'], action: { type: 'quick_reply', config: { text: 'Pick one', buttons: [{ title: 'Book' }, { title: 'Prices' }] } } }).expect(201);
    await ctx.create({ name: 'Brochure', match: 'contains', keywords: ['brochure'], action: { type: 'file', config: { mediaType: 'document', link: 'https://cdn.example.com/b.pdf', filename: 'Brochure.pdf', caption: 'Our brochure' } } }).expect(201);
    await ctx.create({ name: 'Where', match: 'contains', keywords: ['address'], action: { type: 'location', config: { latitude: 19.07, longitude: 72.87, name: 'Clinic' } } }).expect(201);
    await ctx.create({ name: 'Bye', match: 'equals', keywords: ['no need of this service'], action: { type: 'unsubscribe', config: { text: 'No problem, you will not hear from us again.' } } }).expect(201);

    await customerWrites('menu');
    await customerWrites('send the brochure');
    await customerWrites('clinic address?');
    await customerWrites('No need of this service');
    expect(fake.sent.map((s) => s.message)).toEqual([
      expect.objectContaining({ type: 'buttons', body: 'Pick one', buttons: [expect.objectContaining({ title: 'Book' }), expect.objectContaining({ title: 'Prices' })] }),
      expect.objectContaining({ type: 'media', mediaType: 'document', link: 'https://cdn.example.com/b.pdf', caption: 'Our brochure', filename: 'Brochure.pdf' }),
      expect.objectContaining({ type: 'location', latitude: 19.07, longitude: 72.87, name: 'Clinic' }),
      expect.objectContaining({ type: 'text', text: 'No problem, you will not hear from us again.' }),
    ]);
    const contact = await Contact.findOne({ workspaceId: ctx.ws.id, phoneE164: '+919811112222' });
    expect(contact!.consent).toMatchObject({ status: 'opted_out', source: 'auto_reply' });
  });

  it('event triggers: first message beats any message; keywords still win', async () => {
    const ctx = await setup();
    await ctx.create({ name: 'Welcome', match: 'event', event: 'first_message', action: { type: 'text', config: { text: 'Welcome!' } } }).expect(201);
    await ctx.create({ name: 'Fallback', match: 'event', event: 'any_message', action: { type: 'text', config: { text: 'We will reply soon.' } } }).expect(201);
    await ctx.create({ name: 'Hours', match: 'contains', keywords: ['timing'], action: { type: 'text', config: { text: '9 to 6.' } } }).expect(201);

    await customerWrites('hello');
    await customerWrites('anyone there?');
    await customerWrites('what are your timings');
    expect(sentTexts()).toEqual(['Welcome!', 'We will reply soon.', '9 to 6.']);
  });

  it('"Try a message" explains which trigger would answer without sending', async () => {
    const ctx = await setup();
    const exact = await ctx.create({ name: 'Exact', match: 'equals', keywords: ['hi'], action: { type: 'text', config: { text: 'Hello!' } } }).expect(201);
    await ctx.create({ name: 'Ads only', match: 'contains', keywords: ['offer'], sources: ['ad'], action: { type: 'text', config: { text: 'Ad offer' } } }).expect(201);
    const tryIt = (body: object) => api().post(`${ctx.base}/auto-replies/try`).set(auth(ctx.owner)).send(body).expect(200);

    expect((await tryIt({ text: '  HI ' })).body).toMatchObject({ outcome: 'auto_reply', matchedBy: 'equals', matchedKeyword: 'hi', autoReply: { id: exact.body.autoReply.id } });
    expect((await tryIt({ text: 'any offer?' })).body.outcome).toBe('none');
    expect((await tryIt({ text: 'any offer?', source: 'ad' })).body).toMatchObject({ outcome: 'auto_reply', autoReply: { name: 'Ads only' } });
    expect(fake.sent).toHaveLength(0);
  });
});

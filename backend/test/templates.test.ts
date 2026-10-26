import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageTemplate } from '../src/modules/templates/template.model.js';
import { setWhatsAppProvider } from '../src/modules/whatsapp/provider/index.js';
import { FakeProvider } from './fakeProvider.js';
import { api, createWorkspace, signup, type TestUser } from './helpers.js';

const WABA_ID = '9998887776665';

let fake: FakeProvider;
beforeEach(() => {
  fake = new FakeProvider();
  setWhatsAppProvider(fake);
});
afterEach(() => setWhatsAppProvider(undefined));

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

async function connected(name = 'Acme Clinic') {
  const owner = await signup();
  const ws = await createWorkspace(owner, name);
  await api()
    .put(`/api/workspaces/${ws.id}/whatsapp/connection`)
    .set(auth(owner))
    .send({ wabaId: WABA_ID, phoneNumberId: `11122233${Math.floor(Math.random() * 1e5)}`, accessToken: 'EAAG-test-access-token-0123456789' })
    .expect(200);
  const base = `/api/workspaces/${ws.id}/templates`;
  return { owner, ws, base, as: auth(owner) };
}

describe('template types', () => {
  it('builds Meta components for media headers, offers, carousels and OTP templates', async () => {
    const { base, as } = await connected();

    const media = await api().post(`${base}/media`).set(as).set('Content-Type', 'image/png').set('X-File-Name', 'banner.png').send(Buffer.from('png-bytes')).expect(201);
    expect(media.body.handle).toBe('handle-9');

    await api()
      .post(base)
      .set(as)
      .send({
        type: 'CUSTOM',
        name: 'sale_banner',
        language: 'en_US',
        category: 'MARKETING',
        header: { format: 'IMAGE', handle: media.body.handle },
        body: { text: 'Our sale starts {{1}}. Don’t miss it!', examples: ['today'] },
        buttons: [
          { type: 'URL', text: 'Shop', url: 'https://shop.example.com/{{1}}', example: 'sale' },
          { type: 'COPY_CODE', example: 'SAVE20' },
        ],
      })
      .expect(201);
    expect(fake.created[0]!.components).toEqual([
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['handle-9'] } },
      { type: 'BODY', text: 'Our sale starts {{1}}. Don’t miss it!', example: { body_text: [['today']] } },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'Shop', url: 'https://shop.example.com/{{1}}', example: ['sale'] },
          { type: 'COPY_CODE', example: 'SAVE20' },
        ],
      },
    ]);

    const lto = await api()
      .post(base)
      .set(as)
      .send({
        type: 'LIMITED_TIME_OFFER',
        name: 'flash_deal',
        language: 'en_US',
        category: 'MARKETING',
        offer: { text: 'Ends tonight!' },
        body: { text: 'Get 30% off everything in store.', examples: [] },
        buttons: [{ type: 'URL', text: 'Redeem', url: 'https://shop.example.com' }],
      })
      .expect(201);
    expect(lto.body.template.type).toBe('LIMITED_TIME_OFFER');
    expect(fake.created[1]!.components[0]).toEqual({ type: 'LIMITED_TIME_OFFER', limited_time_offer: { text: 'Ends tonight!', has_expiration: true } });

    const card = (n: number) => ({
      header: { format: 'IMAGE', handle: `h${n}` },
      body: { text: `Product ${n} is back in stock.`, examples: [] },
      buttons: [{ type: 'QUICK_REPLY', text: 'Interested' }],
    });
    const carousel = await api()
      .post(base)
      .set(as)
      .send({ type: 'CAROUSEL', name: 'new_arrivals', language: 'en_US', category: 'MARKETING', body: { text: 'Fresh picks for you this week.', examples: [] }, cards: [card(1), card(2)] })
      .expect(201);
    expect(carousel.body.template.type).toBe('CAROUSEL');
    expect(fake.created[2]!.components[1]!.cards).toHaveLength(2);

    await api()
      .post(base)
      .set(as)
      .send({ type: 'AUTHENTICATION', name: 'login_code', language: 'en_US', category: 'AUTHENTICATION', otp: { otpType: 'COPY_CODE', expiryMinutes: 10 } })
      .expect(201);
    expect(fake.created[3]!.components).toEqual([
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: 10 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
    ]);
  });

  it('rejects structures WhatsApp would refuse', async () => {
    const { base, as } = await connected();
    const bad = async (body: object) => (await api().post(base).set(as).send(body).expect(400)).body.error.details;

    expect(await bad({ type: 'CAROUSEL', name: 'c', language: 'en', category: 'MARKETING', body: { text: 'Look at these', examples: [] }, cards: [] })).toHaveProperty('cards');
    expect(await bad({ type: 'LIMITED_TIME_OFFER', name: 'l', language: 'en', category: 'UTILITY', body: { text: 'Deal', examples: [] } })).toHaveProperty('category');
    expect(await bad({ type: 'CUSTOM', name: 'm', language: 'en', category: 'MARKETING', header: { format: 'VIDEO' }, body: { text: 'Watch', examples: [] } })).toHaveProperty('header');
    expect(await bad({ type: 'CUSTOM', name: 'u', language: 'en', category: 'MARKETING', body: { text: 'Hi', examples: [] }, buttons: [{ type: 'URL', text: 'Go', url: 'https://x.com/{{1}}' }] })).toHaveProperty('buttons');
    expect(await bad({ type: 'AUTHENTICATION', name: 'a', language: 'en', category: 'AUTHENTICATION', otp: { otpType: 'ONE_TAP' } })).toHaveProperty('otp');
    expect(fake.created).toHaveLength(0);
  });
});

describe('template lifecycle', () => {
  it('saves drafts, submits them, edits, duplicates, favorites, paginates and deletes', async () => {
    const { ws, base, as } = await connected();

    const draft = await api().post(`${base}/drafts`).set(as).send({ name: 'welcome', language: 'en', category: 'MARKETING', body: { text: 'Half writ' } }).expect(201);
    expect(draft.body.template).toMatchObject({ status: 'DRAFT', draft: { body: { text: 'Half writ' } } });
    expect(fake.created).toHaveLength(0);

    const submitted = await api()
      .post(`${base}?draftId=${draft.body.template.id}`)
      .set(as)
      .send({ name: 'welcome', language: 'en', category: 'MARKETING', body: { text: 'Welcome to our store!', examples: [] } })
      .expect(201);
    expect(submitted.body.template).toMatchObject({ id: draft.body.template.id, status: 'PENDING', draft: null, providerTemplateId: 'tpl-1' });

    // Pending templates cannot be edited; rejected ones can, and go back to review.
    const edit = { name: 'welcome', language: 'en', category: 'MARKETING', body: { text: 'Welcome back to our store!', examples: [] } };
    expect((await api().put(`${base}/${submitted.body.template.id}`).set(as).send(edit).expect(400)).body.error.code).toBe('TEMPLATE_NOT_EDITABLE');
    await MessageTemplate.updateOne({ _id: submitted.body.template.id, workspaceId: ws.id }, { status: 'REJECTED' });
    const edited = await api().put(`${base}/${submitted.body.template.id}`).set(as).send(edit).expect(200);
    expect(edited.body.template.status).toBe('PENDING');
    expect(fake.edited[0]).toMatchObject({ providerTemplateId: 'tpl-1', edit: { components: [{ type: 'BODY', text: 'Welcome back to our store!' }] } });

    const copy = await api().post(`${base}/${submitted.body.template.id}/duplicate`).set(as).expect(201);
    expect(copy.body.template).toMatchObject({ name: 'welcome_copy', status: 'DRAFT' });
    const copy2 = await api().post(`${base}/${submitted.body.template.id}/duplicate`).set(as).expect(201);
    expect(copy2.body.template.name).toBe('welcome_copy_2');

    await api().post(`${base}/${copy.body.template.id}/favorite`).set(as).send({ favorite: true }).expect(200);
    const favs = await api().get(`${base}?favorite=true&limit=10`).set(as).expect(200);
    expect(favs.body.templates.map((t: { name: string }) => t.name)).toEqual(['welcome_copy']);

    const page = await api().get(`${base}?limit=2&page=2`).set(as).expect(200);
    expect(page.body).toMatchObject({ total: 3, page: 2, limit: 2 });
    expect(page.body.templates[0].usage).toEqual({ campaigns: 0, flows: 0 });
    expect(page.body.templates[0].createdBy).toEqual(expect.any(String));

    // Drafts are deleted locally only; submitted ones on WhatsApp too.
    await api().delete(`${base}/${copy2.body.template.id}`).set(as).expect(204);
    await api().delete(`${base}/${submitted.body.template.id}`).set(as).expect(204);
    expect(fake.deleted).toEqual([{ providerTemplateId: 'tpl-1', name: 'welcome' }]);
    expect((await api().get(`${base}`).set(as)).body.templates.map((t: { name: string }) => t.name)).toEqual(['welcome_copy']);
  });
});

describe('libraries', () => {
  it('browses and creates from the Meta library', async () => {
    const { base, as } = await connected();
    fake.library = [
      {
        id: 'l1',
        name: 'order_confirmation_1',
        language: 'en_US',
        category: 'UTILITY',
        topic: 'ORDER_MANAGEMENT',
        usecase: 'ORDER_CONFIRMATION',
        industry: ['E_COMMERCE'],
        header: 'Order confirmed',
        body: 'Hi {{1}}, your order {{2}} is confirmed.',
        bodyParams: ['Priya', '#1'],
        buttons: [{ type: 'URL', text: 'View order' }],
      },
    ];
    const list = await api().get(`${base}/library?industry=E_COMMERCE`).set(as).expect(200);
    expect(list.body.templates).toHaveLength(1);

    const created = await api()
      .post(`${base}/library`)
      .set(as)
      .send({ name: 'my_order_confirmed', language: 'en_US', libraryTemplateName: 'order_confirmation_1', buttonInputs: [{ type: 'URL', url: { base_url: 'https://shop.example.com/orders' } }] })
      .expect(201);
    expect(created.body.template).toMatchObject({ status: 'PENDING', libraryTemplateName: 'order_confirmation_1' });
    expect(created.body.template.components[2].buttons[0]).toEqual({ type: 'URL', text: 'View order', url: 'https://shop.example.com/orders' });
  });

  it('shares approved templates with other businesses, without media handles', async () => {
    const a = await connected('Business A');
    const b = await connected('Business B');
    fake.templates = [
      {
        providerTemplateId: 'tpl-a',
        name: 'promo',
        language: 'en',
        category: 'MARKETING',
        status: 'APPROVED',
        rejectedReason: null,
        components: [
          { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://scontent.example/a.png'] } },
          { type: 'BODY', text: 'Big sale this weekend.' },
        ],
      },
    ];
    await api().post(`${a.base}/sync`).set(a.as).expect(200);
    const mine = (await api().get(a.base).set(a.as)).body.templates[0];

    const shared = await api().post(`${a.base}/${mine.id}/contribute`).set(a.as).expect(201);
    expect(shared.body.template.components[0]).toEqual({ type: 'HEADER', format: 'IMAGE' });

    const seen = await api().get(`${b.base}/community?q=promo`).set(b.as).expect(200);
    const item = seen.body.templates.find((t: { contributorName: string }) => t.contributorName === 'Business A');
    expect(item).toMatchObject({ name: 'promo', mine: false, type: 'CUSTOM' });

    const used = await api().post(`${b.base}/community/${item.id}/use`).set(b.as).expect(200);
    expect(used.body.template.uses).toBe(1);
    await api().delete(`${b.base}/community/${item.id}`).set(b.as).expect(403);
    await api().delete(`${a.base}/community/${item.id}`).set(a.as).expect(204);
  });
});

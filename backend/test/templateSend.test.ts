import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Form } from '../src/modules/forms/form.model.js';
import { parseFlowToken } from '../src/modules/forms/flowToken.js';
import { sendRequirements } from '../src/modules/templates/templateSend.js';
import { templateComponents } from '../src/modules/whatsapp/provider/metaCloud.js';
import { setWhatsAppProvider, type ProviderTemplate, type TemplateSendParams } from '../src/modules/whatsapp/provider/index.js';
import { FakeProvider } from './fakeProvider.js';
import { api, createWorkspace, signup, type TestUser } from './helpers.js';

let fake: FakeProvider;
beforeEach(() => {
  fake = new FakeProvider();
  setWhatsAppProvider(fake);
});
afterEach(() => setWhatsAppProvider(undefined));

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const approved = (name: string, components: ProviderTemplate['components'], category = 'MARKETING'): ProviderTemplate => ({
  providerTemplateId: `tpl-${name}`,
  name,
  language: 'en',
  category,
  status: 'APPROVED',
  rejectedReason: null,
  components,
});

const SALE = approved('sale', [
  { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://cdn.example.com/a.png'] } },
  { type: 'LIMITED_TIME_OFFER', limited_time_offer: { text: 'Ends soon', has_expiration: true } },
  { type: 'BODY', text: 'Hi {{1}}, 30% off everything.', example: { body_text: [['Priya']] } },
  {
    type: 'BUTTONS',
    buttons: [
      { type: 'COPY_CODE', example: 'SAVE30' },
      { type: 'URL', text: 'Shop', url: 'https://shop.example.com/{{1}}' },
    ],
  },
]);

const CAROUSEL = approved('arrivals', [
  { type: 'BODY', text: 'New this week.' },
  {
    type: 'CAROUSEL',
    cards: [1, 2].map(() => ({
      components: [
        { type: 'HEADER' as const, format: 'IMAGE' },
        { type: 'BODY' as const, text: 'Only {{1}} left.' },
        { type: 'BUTTONS' as const, buttons: [{ type: 'QUICK_REPLY', text: 'Interested' }, { type: 'URL', text: 'Buy', url: 'https://shop.example.com/p/{{1}}' }] },
      ],
    })),
  },
]);

const OTP = approved('login_code', [{ type: 'BODY', add_security_recommendation: true }, { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] }], 'AUTHENTICATION');

async function connected(templates: ProviderTemplate[]) {
  const owner = await signup();
  const ws = await createWorkspace(owner);
  const base = `/api/workspaces/${ws.id}`;
  await api().put(`${base}/whatsapp/connection`).set(auth(owner)).send({ wabaId: '9998887776665', phoneNumberId: '1112223334445', accessToken: 'EAAG-test-access-token-0123456789' }).expect(200);
  fake.templates = templates;
  await api().post(`${base}/templates/sync`).set(auth(owner)).expect(200);
  const list = (await api().get(`${base}/templates`).set(auth(owner))).body.templates as { id: string; name: string; requirements: unknown }[];
  const id = (name: string) => list.find((t) => t.name === name)!.id;
  const send = (body: object) => api().post(`${base}/messages`).set(auth(owner)).send({ type: 'template', to: '919811112222', ...body });
  return { owner, ws, base, id, list, send };
}

describe('send requirements', () => {
  it('derives what each template needs from its components', () => {
    expect(sendRequirements(SALE.components)).toMatchObject({
      body: 1,
      headerMedia: 'IMAGE',
      offer: { expires: true },
      buttons: [
        { index: 0, type: 'COPY_CODE' },
        { index: 1, type: 'URL', text: 'Shop' },
      ],
    });
    expect(sendRequirements(CAROUSEL.components).cards).toEqual([
      { media: 'IMAGE', body: 1, buttons: [{ index: 1, type: 'URL', text: 'Buy' }] },
      { media: 'IMAGE', body: 1, buttons: [{ index: 1, type: 'URL', text: 'Buy' }] },
    ]);
    expect(sendRequirements(OTP.components)).toMatchObject({ otp: true, body: 0 });
  });

  it('builds the Cloud API components for media, offers, buttons and carousels', () => {
    const params: TemplateSendParams = {
      name: 'x',
      language: 'en',
      headerParams: [],
      bodyParams: ['Priya'],
      headerMedia: { type: 'image', id: 'media-1' },
      offerExpiresAt: 1_900_000_000_000,
      buttons: [
        { index: 0, subType: 'copy_code', couponCode: 'SAVE30' },
        { index: 1, subType: 'url', text: 'diwali' },
        { index: 2, subType: 'mpm', thumbnail: 'SKU1', sections: [{ title: 'Products', items: ['SKU1', 'SKU2'] }] },
      ],
      cards: [{ media: { type: 'video', link: 'https://cdn.example.com/v.mp4' }, bodyParams: ['3'], buttons: [{ index: 0, subType: 'quick_reply', payload: 'card_1_1' }] }],
    };
    expect(templateComponents(params)).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { id: 'media-1' } }] },
      { type: 'limited_time_offer', parameters: [{ type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: 1_900_000_000_000 } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Priya' }] },
      { type: 'button', index: '0', sub_type: 'copy_code', parameters: [{ type: 'coupon_code', coupon_code: 'SAVE30' }] },
      { type: 'button', index: '1', sub_type: 'url', parameters: [{ type: 'text', text: 'diwali' }] },
      {
        type: 'button',
        index: '2',
        sub_type: 'mpm',
        parameters: [{ type: 'action', action: { thumbnail_product_retailer_id: 'SKU1', sections: [{ title: 'Products', product_items: [{ product_retailer_id: 'SKU1' }, { product_retailer_id: 'SKU2' }] }] } }],
      },
      {
        type: 'carousel',
        cards: [
          {
            card_index: 0,
            components: [
              { type: 'header', parameters: [{ type: 'video', video: { link: 'https://cdn.example.com/v.mp4' } }] },
              { type: 'body', parameters: [{ type: 'text', text: '3' }] },
              { type: 'button', index: '0', sub_type: 'quick_reply', parameters: [{ type: 'payload', payload: 'card_1_1' }] },
            ],
          },
        ],
      },
    ]);
  });
});

describe('sending rich templates', () => {
  it('requires media, offer expiry and button values, then sends them', async () => {
    const ctx = await connected([SALE]);
    const missing = await ctx.send({ templateId: ctx.id('sale'), bodyParams: ['Priya'] }).expect(400);
    expect(Object.keys(missing.body.error.details)).toEqual(expect.arrayContaining(['headerMedia', 'offerExpiresAt', 'buttonParams']));

    const media = await api().post(`${ctx.base}/messages/media`).set(auth(ctx.owner)).set('Content-Type', 'image/png').set('X-File-Name', 'sale.png').send(Buffer.from('png')).expect(201);
    expect(media.body.mediaId).toBe('media-1');

    const before = Date.now();
    await ctx
      .send({ templateId: ctx.id('sale'), bodyParams: ['Priya'], buttonParams: ['SAVE30', 'diwali'], extras: { headerMedia: { id: media.body.mediaId }, offerExpiresInMinutes: 60 } })
      .expect(202);
    const sent = fake.sent[0]!.message as { template: TemplateSendParams };
    expect(sent.template).toMatchObject({
      bodyParams: ['Priya'],
      headerMedia: { type: 'image', id: 'media-1' },
      buttons: [
        { index: 0, subType: 'copy_code', couponCode: 'SAVE30' },
        { index: 1, subType: 'url', text: 'diwali' },
      ],
    });
    // The relative expiry is pinned when the message is created.
    expect(sent.template.offerExpiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(sent.template.offerExpiresAt).toBeLessThan(Date.now() + 3_600_000 + 1_000);
  });

  it('sends carousel cards and OTP codes', async () => {
    const ctx = await connected([CAROUSEL, OTP]);
    const card = (n: number) => ({ media: { link: `https://cdn.example.com/${n}.png` }, bodyParams: [String(n)], buttonParams: [`sku-${n}`] });
    await ctx.send({ templateId: ctx.id('arrivals'), extras: { cards: [card(1)] } }).expect(400);
    await ctx.send({ templateId: ctx.id('arrivals'), extras: { cards: [card(1), card(2)] } }).expect(202);
    expect((fake.sent[0]!.message as { template: TemplateSendParams }).template.cards).toEqual([
      { media: { type: 'image', link: 'https://cdn.example.com/1.png' }, bodyParams: ['1'], buttons: [{ index: 0, subType: 'quick_reply', payload: 'card_1_1' }, { index: 1, subType: 'url', text: 'sku-1' }] },
      { media: { type: 'image', link: 'https://cdn.example.com/2.png' }, bodyParams: ['2'], buttons: [{ index: 0, subType: 'quick_reply', payload: 'card_2_1' }, { index: 1, subType: 'url', text: 'sku-2' }] },
    ]);

    const otp = await ctx.send({ templateId: ctx.id('login_code'), extras: { otpCode: '482913' } }).expect(202);
    expect(otp.body.message.content.preview).toBe('482913 is your verification code.');
    expect((fake.sent[1]!.message as { template: TemplateSendParams }).template).toMatchObject({
      bodyParams: ['482913'],
      buttons: [{ index: 0, subType: 'url', text: '482913' }],
    });
  });

  it('gives form buttons a flow token that points back to the form', async () => {
    const ctx = await connected([approved('book', [{ type: 'BODY', text: 'Book a visit.' }, { type: 'BUTTONS', buttons: [{ type: 'FLOW', text: 'Book', flow_id: 'flow-99' }] }])]);
    const form = await Form.create({ workspaceId: ctx.ws.id, name: 'Booking', status: 'published', providerFlowId: 'flow-99', version: 3, fields: [], createdBy: ctx.owner.id });
    await ctx.send({ templateId: ctx.id('book') }).expect(202);
    const button = (fake.sent[0]!.message as { template: TemplateSendParams }).template.buttons![0]!;
    expect(button).toMatchObject({ index: 0, subType: 'flow' });
    expect(parseFlowToken((button as { flowToken: string }).flowToken)).toEqual({ formId: form.id, version: 3 });
  });

  it('campaigns map button values per contact and share media across recipients', async () => {
    const ctx = await connected([SALE]);
    const vip = (await api().post(`${ctx.base}/tags`).set(auth(ctx.owner)).send({ name: 'VIP' })).body.tag;
    await api().post(`${ctx.base}/contacts`).set(auth(ctx.owner)).send({ phone: '+919811111111', name: 'Priya', tags: [vip.id], customFields: { slug: 'priya-deals' } }).expect(201);
    const campaign = (
      await api()
        .post(`${ctx.base}/campaigns`)
        .set(auth(ctx.owner))
        .send({
          name: 'Sale',
          templateId: ctx.id('sale'),
          headerVariables: [],
          bodyVariables: [{ source: 'field', value: 'first_name', fallback: '' }],
          buttonVariables: [
            { source: 'static', value: 'SAVE30', fallback: '' },
            { source: 'field', value: 'custom.slug', fallback: 'all' },
          ],
          audience: { type: 'filter', segmentId: null, filter: { tagsAny: [vip.id], excludeTags: [], stages: [], requireOptIn: false } },
          sendRatePerMinute: 60,
          quietHours: { enabled: false, start: '21:00', end: '09:00' },
        })
        .expect(201)
    ).body.campaign;

    const blocked = await api().post(`${ctx.base}/campaigns/${campaign.id}/launch`).set(auth(ctx.owner)).send({}).expect(400);
    expect(Object.keys(blocked.body.error.details)).toEqual(expect.arrayContaining(['headerMedia', 'offerExpiresAt']));

    await api()
      .patch(`${ctx.base}/campaigns/${campaign.id}`)
      .set(auth(ctx.owner))
      .send({ templateExtras: { headerMedia: { link: 'https://cdn.example.com/sale.png' }, offerExpiresInMinutes: 120 } })
      .expect(200);
    await api().post(`${ctx.base}/campaigns/${campaign.id}/launch`).set(auth(ctx.owner)).send({}).expect(200);
    expect((fake.sent[0]!.message as { template: TemplateSendParams }).template).toMatchObject({
      headerMedia: { type: 'image', link: 'https://cdn.example.com/sale.png' },
      bodyParams: ['Priya'],
      buttons: [
        { subType: 'copy_code', couponCode: 'SAVE30' },
        { subType: 'url', text: 'priya-deals' },
      ],
    });
  });
});

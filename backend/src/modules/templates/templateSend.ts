import { z } from 'zod';
import type { TemplateButtonParam, TemplateComponent, TemplateMediaParam, TemplateSendParams } from '../whatsapp/provider/types.js';
import { countVariables } from './template.model.js';

/**
 * What a template needs at send time beyond header/body text variables:
 * media for the header or carousel cards, URL suffixes, coupon codes, an
 * offer expiry, catalog products or an OTP code. Derived from the stored
 * Meta components, so synced templates work the same as ones built here.
 */
export interface SendRequirements {
  header: number;
  body: number;
  headerMedia: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null;
  headerLocation: boolean;
  /** Top-level buttons that take a value per send, in button order. */
  buttons: { index: number; type: 'URL' | 'COPY_CODE'; text: string }[];
  offer: { expires: boolean } | null;
  products: 'CATALOG' | 'MPM' | null;
  otp: boolean;
  cards: { media: 'IMAGE' | 'VIDEO'; body: number; buttons: { index: number; type: 'URL'; text: string }[] }[];
}

const upper = (s?: string) => (s ?? '').toUpperCase();
const find = (cs: TemplateComponent[], type: string) => cs.find((c) => upper(c.type) === type);
const hasUrlVariable = (url?: string) => /\{\{1\}\}/.test(url ?? '');

export function sendRequirements(components: TemplateComponent[]): SendRequirements {
  const header = find(components, 'HEADER');
  const headerFormat = upper(header?.format) || 'TEXT';
  const buttons = find(components, 'BUTTONS')?.buttons ?? [];
  const offer = find(components, 'LIMITED_TIME_OFFER')?.limited_time_offer;
  const buttonTypes = buttons.map((b) => upper(b.type));

  return {
    header: headerFormat === 'TEXT' ? countVariables(header?.text) : 0,
    body: countVariables(find(components, 'BODY')?.text),
    headerMedia: header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat) ? (headerFormat as 'IMAGE' | 'VIDEO' | 'DOCUMENT') : null,
    headerLocation: headerFormat === 'LOCATION' && !!header,
    buttons: buttons.flatMap((b, index): SendRequirements['buttons'] => {
      const type = upper(b.type);
      if (type === 'URL' && hasUrlVariable(b.url)) return [{ index, type: 'URL' as const, text: b.text ?? 'Website' }];
      if (type === 'COPY_CODE') return [{ index, type: 'COPY_CODE' as const, text: 'Copy offer code' }];
      return [];
    }),
    offer: offer ? { expires: !!offer.has_expiration } : null,
    products: buttonTypes.includes('CATALOG') ? 'CATALOG' : buttonTypes.includes('MPM') ? 'MPM' : null,
    otp: buttonTypes.includes('OTP'),
    cards: (find(components, 'CAROUSEL')?.cards ?? []).map((card) => ({
      media: upper(find(card.components, 'HEADER')?.format) === 'VIDEO' ? 'VIDEO' : 'IMAGE',
      body: countVariables(find(card.components, 'BODY')?.text),
      buttons: (find(card.components, 'BUTTONS')?.buttons ?? []).flatMap((b, index) =>
        upper(b.type) === 'URL' && hasUrlVariable(b.url) ? [{ index, type: 'URL' as const, text: b.text ?? 'Website' }] : [],
      ),
    })),
  };
}

const mediaInput = z
  .object({
    link: z.string().trim().url('Use a full https:// link.').max(2000).optional(),
    id: z.string().trim().max(100).optional(),
    filename: z.string().trim().max(240).optional(),
  })
  .refine((m) => !!m.link || !!m.id, 'Add a media link or upload a file.');

/** Send-time values that are not plain text variables. */
export const templateExtrasSchema = z.object({
  headerMedia: mediaInput.optional(),
  headerLocation: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      name: z.string().trim().max(100).optional(),
      address: z.string().trim().max(300).optional(),
    })
    .optional(),
  offerExpiresAt: z.string().datetime({ offset: true }).optional(),
  // Alternative to a fixed time: the offer ends this long after each message is sent.
  offerExpiresInMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
  // Catalog thumbnail product, plus the products shown by a multi-product message.
  products: z
    .object({
      thumbnail: z.string().trim().min(1, 'Enter a product SKU (retailer id).').max(100),
      items: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
    })
    .optional(),
  otpCode: z.string().trim().min(1).max(15).optional(),
  cards: z
    .array(
      z.object({
        media: mediaInput,
        bodyParams: z.array(z.string().max(1024)).max(20).default([]),
        buttonParams: z.array(z.string().max(2000)).max(2).default([]),
      }),
    )
    .max(10)
    .optional(),
});
export type TemplateExtras = z.infer<typeof templateExtrasSchema>;

export const buttonParamsSchema = z.array(z.string().max(2000)).max(10).default([]);

/** Field errors for anything the template needs but the send is missing. */
export function checkSendValues(
  req: SendRequirements,
  values: { headerParams: string[]; bodyParams: string[]; buttonParams: string[]; extras: TemplateExtras },
  now = Date.now(),
): Record<string, string[]> {
  const { headerParams, bodyParams, buttonParams, extras } = values;
  const details: Record<string, string[]> = {};
  const add = (key: string, message: string) => (details[key] ??= []).push(message);
  const blank = (v: string[]) => v.some((p) => !p.trim());

  if (headerParams.length !== req.header) add('headerParams', `This template needs ${req.header} header value(s).`);
  if (bodyParams.length !== req.body) add('bodyParams', `This template needs ${req.body} body value(s).`);
  if (blank([...headerParams, ...bodyParams])) add('bodyParams', 'Template values cannot be empty.');
  if (buttonParams.length !== req.buttons.length || blank(buttonParams)) {
    add('buttonParams', `Fill in ${req.buttons.map((b) => (b.type === 'COPY_CODE' ? 'the offer code' : `the "${b.text}" link value`)).join(' and ')}.`);
  }
  if (req.headerMedia && !extras.headerMedia) add('headerMedia', `This template needs a header ${req.headerMedia.toLowerCase()}.`);
  if (req.headerLocation && !extras.headerLocation) add('headerLocation', 'This template needs a location.');
  if (req.offer?.expires && !extras.offerExpiresInMinutes) {
    const at = extras.offerExpiresAt ? Date.parse(extras.offerExpiresAt) : NaN;
    if (!Number.isFinite(at)) add('offerExpiresAt', 'Choose when the offer expires.');
    else if (at <= now) add('offerExpiresAt', 'The offer expiry must be in the future.');
  }
  if (req.products && !extras.products) add('products', 'Enter the product SKU to feature.');
  if (req.products === 'MPM' && !extras.products?.items.length) add('products', 'List the product SKUs to show.');
  if (req.otp && !extras.otpCode) add('otpCode', 'Enter the one-time code to send.');
  if (req.cards.length) {
    const cards = extras.cards ?? [];
    if (cards.length !== req.cards.length) add('cards', `Fill in all ${req.cards.length} carousel cards.`);
    req.cards.forEach((c, i) => {
      const card = cards[i];
      if (!card) return;
      if (card.bodyParams.length !== c.body || blank(card.bodyParams)) add('cards', `Card ${i + 1}: fill in its ${c.body} text value(s).`);
      if (card.buttonParams.length !== c.buttons.length || blank(card.buttonParams)) add('cards', `Card ${i + 1}: fill in its button link value.`);
    });
  }
  return details;
}

function media(type: string, m: { link?: string; id?: string; filename?: string }): TemplateMediaParam {
  const t = type.toLowerCase() as TemplateMediaParam['type'];
  return { type: t, ...(m.id ? { id: m.id } : { link: m.link }), ...(t === 'document' && m.filename ? { filename: m.filename } : {}) };
}

/** Pins a relative offer expiry to an absolute time at the moment a message is created. */
export function pinOfferExpiry(extras: TemplateExtras, now = Date.now()): TemplateExtras {
  if (!extras.offerExpiresInMinutes) return extras;
  const { offerExpiresInMinutes, ...rest } = extras;
  return { ...rest, offerExpiresAt: new Date(now + offerExpiresInMinutes * 60_000).toISOString() };
}

/**
 * Provider-neutral send parameters for a stored message. `flowTokens` maps a
 * WhatsApp flow id to a fresh token so form submissions find their form.
 */
export function toSendParams(
  template: { name: string; language: string; components: TemplateComponent[] },
  values: { headerParams: string[]; bodyParams: string[]; buttonParams?: string[]; extras?: TemplateExtras },
  flowTokens: Map<string, string> = new Map(),
): TemplateSendParams {
  const req = sendRequirements(template.components);
  const extras = values.extras ?? {};
  const buttonValues = values.buttonParams ?? [];
  const params: TemplateSendParams = {
    name: template.name,
    language: template.language,
    headerParams: values.headerParams,
    // OTP templates carry the code as their only body value.
    bodyParams: req.otp && extras.otpCode ? [extras.otpCode] : values.bodyParams,
  };

  if (req.headerMedia && extras.headerMedia) params.headerMedia = media(req.headerMedia, extras.headerMedia);
  if (req.headerLocation && extras.headerLocation) params.headerLocation = extras.headerLocation;
  if (req.offer?.expires && extras.offerExpiresAt) params.offerExpiresAt = Date.parse(extras.offerExpiresAt);

  const buttons: TemplateButtonParam[] = [];
  req.buttons.forEach((b, i) => {
    const value = buttonValues[i] ?? '';
    buttons.push(b.type === 'URL' ? { index: b.index, subType: 'url', text: value } : { index: b.index, subType: 'copy_code', couponCode: value });
  });
  (find(template.components, 'BUTTONS')?.buttons ?? []).forEach((b, index) => {
    const type = upper(b.type);
    if (type === 'OTP' && extras.otpCode) buttons.push({ index, subType: 'url', text: extras.otpCode });
    if (type === 'FLOW' && b.flow_id && flowTokens.has(b.flow_id)) buttons.push({ index, subType: 'flow', flowToken: flowTokens.get(b.flow_id)! });
    if (type === 'CATALOG' && extras.products) buttons.push({ index, subType: 'catalog', thumbnail: extras.products.thumbnail });
    if (type === 'MPM' && extras.products) {
      buttons.push({ index, subType: 'mpm', thumbnail: extras.products.thumbnail, sections: [{ title: 'Products', items: extras.products.items }] });
    }
  });
  if (buttons.length) params.buttons = buttons.sort((a, b) => a.index - b.index);

  const cards = find(template.components, 'CAROUSEL')?.cards;
  if (cards && extras.cards) {
    params.cards = cards.map((card, i) => {
      const input = extras.cards![i]!;
      const cardReq = req.cards[i]!;
      const cardButtons: TemplateButtonParam[] = [];
      (find(card.components, 'BUTTONS')?.buttons ?? []).forEach((b, index) => {
        const urlSlot = cardReq.buttons.findIndex((x) => x.index === index);
        // Carousel quick replies must echo a payload back when tapped.
        if (upper(b.type) === 'QUICK_REPLY') cardButtons.push({ index, subType: 'quick_reply', payload: `card_${i + 1}_${index + 1}` });
        else if (urlSlot >= 0) cardButtons.push({ index, subType: 'url', text: input.buttonParams[urlSlot] ?? '' });
      });
      return { media: media(cardReq.media, input.media), bodyParams: input.bodyParams, buttons: cardButtons };
    });
  }
  return params;
}

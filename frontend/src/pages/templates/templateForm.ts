import {
  Clock,
  KeyRound,
  LayoutGrid,
  MessageSquare,
  Package,
  PhoneCall,
  ShoppingBag,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { MessageTemplate, TemplateButton, TemplateComponent, TemplateType } from '../../lib/api';

export type Category = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
export type HeaderFormat = 'NONE' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
export type ButtonType = 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER' | 'COPY_CODE' | 'FLOW';

export interface ButtonDraft {
  type: ButtonType;
  text: string;
  url?: string;
  /** URL variable example (URL) or the sample code (COPY_CODE). */
  example?: string;
  phone?: string;
  formId?: string;
}

export interface CardDraft {
  format: 'IMAGE' | 'VIDEO';
  handle: string;
  /** Object URL or synced media URL, only for the preview. */
  previewUrl?: string;
  body: string;
  examples: string[];
  buttons: ButtonDraft[];
}

/** Everything the builder edits. Drafts are saved as this object. */
export interface TemplateForm {
  type: TemplateType;
  name: string;
  language: string;
  category: Category;
  headerFormat: HeaderFormat;
  headerText: string;
  headerExample: string;
  headerHandle: string;
  headerPreviewUrl?: string;
  headerFileName?: string;
  body: string;
  bodyExamples: string[];
  footer: string;
  buttons: ButtonDraft[];
  otpType: 'COPY_CODE' | 'ONE_TAP';
  otpButtonText: string;
  autofillText: string;
  securityRecommendation: boolean;
  expiryMinutes: string;
  packageName: string;
  signatureHash: string;
  offerText: string;
  offerHasExpiration: boolean;
  cards: CardDraft[];
}

export const TYPE_INFO: { type: TemplateType; label: string; description: string; icon: LucideIcon; tint: string }[] = [
  { type: 'CUSTOM', label: 'Custom Message', description: 'Standard template with header, body, footer & buttons', icon: MessageSquare, tint: 'bg-sky-50 text-sky-600' },
  { type: 'FLOW', label: 'Flows', description: 'WhatsApp form (flow) button template', icon: Workflow, tint: 'bg-indigo-50 text-indigo-600' },
  { type: 'AUTHENTICATION', label: 'Authentication/OTP', description: 'One-time password template', icon: KeyRound, tint: 'bg-emerald-50 text-emerald-600' },
  { type: 'LIMITED_TIME_OFFER', label: 'Limited Time Offer', description: 'Template with expiring offer text', icon: Clock, tint: 'bg-amber-50 text-amber-600' },
  { type: 'CAROUSEL', label: 'Carousel', description: 'Multiple cards with images & buttons', icon: LayoutGrid, tint: 'bg-violet-50 text-violet-600' },
  { type: 'CATALOG', label: 'Catalog', description: 'Product catalog template', icon: ShoppingBag, tint: 'bg-orange-50 text-orange-600' },
  { type: 'MULTI_PRODUCT', label: 'Multi-product', description: 'Multiple product message', icon: Package, tint: 'bg-cyan-50 text-cyan-600' },
  { type: 'CALL_PERMISSION', label: 'Call Permission', description: 'Request call permission template', icon: PhoneCall, tint: 'bg-rose-50 text-rose-600' },
];

export const typeInfo = (type: TemplateType) => TYPE_INFO.find((t) => t.type === type) ?? TYPE_INFO[0]!;

export const CATEGORY_LABEL: Record<string, string> = { MARKETING: 'Marketing', UTILITY: 'Utility', AUTHENTICATION: 'Authentication' };

export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en_US', label: 'English (US)' },
  { code: 'en_GB', label: 'English (UK)' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'mr', label: 'Marathi' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'bn', label: 'Bengali' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'kn', label: 'Kannada' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'pa', label: 'Punjabi' },
  { code: 'ur', label: 'Urdu' },
  { code: 'ar', label: 'Arabic' },
  { code: 'es', label: 'Spanish' },
  { code: 'es_MX', label: 'Spanish (Mexico)' },
  { code: 'pt_BR', label: 'Portuguese (Brazil)' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ms', label: 'Malay' },
  { code: 'ne', label: 'Nepali' },
  { code: 'si', label: 'Sinhala' },
];

export const languageLabel = (code: string) => LANGUAGES.find((l) => l.code === code)?.label ?? code;

/** Which header formats each type allows. */
export function headerFormatsFor(type: TemplateType): HeaderFormat[] {
  switch (type) {
    case 'AUTHENTICATION':
    case 'CAROUSEL':
      return [];
    case 'LIMITED_TIME_OFFER':
      return ['NONE', 'IMAGE', 'VIDEO'];
    case 'CATALOG':
    case 'CALL_PERMISSION':
      return ['NONE', 'TEXT'];
    case 'MULTI_PRODUCT':
      return ['TEXT'];
    default:
      return ['NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'];
  }
}

/** Button kinds the builder offers for a type (empty: fixed or no buttons). */
export function buttonTypesFor(type: TemplateType): ButtonType[] {
  switch (type) {
    case 'CUSTOM':
      return ['URL', 'PHONE_NUMBER', 'COPY_CODE', 'QUICK_REPLY'];
    case 'LIMITED_TIME_OFFER':
      return ['URL', 'COPY_CODE'];
    case 'CAROUSEL':
      return ['URL', 'PHONE_NUMBER', 'QUICK_REPLY'];
    default:
      return [];
  }
}

export const BUTTON_LIMITS: Partial<Record<ButtonType, number>> = { URL: 2, PHONE_NUMBER: 1, COPY_CODE: 1, QUICK_REPLY: 10 };

export function fixedCategory(type: TemplateType): Category | null {
  if (type === 'AUTHENTICATION') return 'AUTHENTICATION';
  if (['LIMITED_TIME_OFFER', 'CAROUSEL', 'CATALOG', 'MULTI_PRODUCT'].includes(type)) return 'MARKETING';
  return null;
}

export const emptyCard = (): CardDraft => ({ format: 'IMAGE', handle: '', body: '', examples: [], buttons: [{ type: 'QUICK_REPLY', text: '' }] });

export function emptyForm(type: TemplateType): TemplateForm {
  const category = fixedCategory(type) ?? 'MARKETING';
  return {
    type,
    name: '',
    language: 'en_US',
    category,
    headerFormat: type === 'MULTI_PRODUCT' ? 'TEXT' : 'NONE',
    headerText: '',
    headerExample: '',
    headerHandle: '',
    body: '',
    bodyExamples: [],
    footer: category === 'MARKETING' && type !== 'LIMITED_TIME_OFFER' && type !== 'CAROUSEL' ? 'reply STOP to unsubscribe' : '',
    buttons:
      type === 'FLOW'
        ? [{ type: 'FLOW', text: 'Open form', formId: '' }]
        : type === 'LIMITED_TIME_OFFER'
          ? [
              { type: 'COPY_CODE', text: '', example: '' },
              { type: 'URL', text: 'Shop now', url: '' },
            ]
          : [],
    otpType: 'COPY_CODE',
    otpButtonText: 'Copy code',
    autofillText: 'Autofill',
    securityRecommendation: true,
    expiryMinutes: '10',
    packageName: '',
    signatureHash: '',
    offerText: '',
    offerHasExpiration: true,
    cards: type === 'CAROUSEL' ? [emptyCard(), emptyCard()] : [],
  };
}

export function variableCount(text: string): number {
  const nums = [...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

/** Resizes the examples list to match the variables in the text. */
export const examplesFor = (text: string, examples: string[]) => Array.from({ length: variableCount(text) }, (_, i) => examples[i] ?? '');

function buttonPayload(b: ButtonDraft) {
  switch (b.type) {
    case 'URL':
      return { type: 'URL', text: b.text, url: b.url ?? '', ...(b.url?.includes('{{1}}') ? { example: b.example ?? '' } : {}) };
    case 'PHONE_NUMBER':
      return { type: 'PHONE_NUMBER', text: b.text, phone: b.phone ?? '' };
    case 'COPY_CODE':
      return { type: 'COPY_CODE', example: b.example ?? '' };
    case 'FLOW':
      return { type: 'FLOW', text: b.text, formId: b.formId ?? '' };
    default:
      return { type: 'QUICK_REPLY', text: b.text };
  }
}

/** What the API's template input schema expects. */
export function toPayload(f: TemplateForm) {
  const base = { type: f.type, name: f.name, language: f.language, category: f.category };
  if (f.type === 'AUTHENTICATION') {
    return {
      ...base,
      otp: {
        otpType: f.otpType,
        buttonText: f.otpButtonText || 'Copy code',
        securityRecommendation: f.securityRecommendation,
        ...(f.expiryMinutes ? { expiryMinutes: Number(f.expiryMinutes) } : {}),
        ...(f.otpType === 'ONE_TAP' ? { packageName: f.packageName, signatureHash: f.signatureHash, autofillText: f.autofillText } : {}),
      },
    };
  }
  const header =
    f.headerFormat === 'NONE'
      ? undefined
      : f.headerFormat === 'TEXT'
        ? { format: 'TEXT', text: f.headerText, ...(variableCount(f.headerText) ? { example: f.headerExample } : {}) }
        : f.headerFormat === 'LOCATION'
          ? { format: 'LOCATION' }
          : { format: f.headerFormat, handle: f.headerHandle };
  return {
    ...base,
    ...(header ? { header } : {}),
    body: { text: f.body, examples: examplesFor(f.body, f.bodyExamples) },
    ...(f.footer.trim() && !['LIMITED_TIME_OFFER', 'CAROUSEL'].includes(f.type) ? { footer: { text: f.footer.trim() } } : {}),
    buttons: ['CATALOG', 'MULTI_PRODUCT', 'CALL_PERMISSION', 'CAROUSEL'].includes(f.type) ? [] : f.buttons.map(buttonPayload),
    ...(f.type === 'LIMITED_TIME_OFFER' ? { offer: { text: f.offerText, hasExpiration: f.offerHasExpiration } } : {}),
    ...(f.type === 'CAROUSEL'
      ? {
          cards: f.cards.map((c) => ({
            header: { format: c.format, handle: c.handle },
            body: { text: c.body, examples: examplesFor(c.body, c.examples) },
            buttons: c.buttons.map(buttonPayload),
          })),
        }
      : {}),
  };
}

/** The draft as saved: the form minus browser-only object URLs. */
export function toDraft(f: TemplateForm) {
  const local = (url?: string) => (url?.startsWith('blob:') ? undefined : url);
  return { ...f, headerPreviewUrl: local(f.headerPreviewUrl), cards: f.cards.map((c) => ({ ...c, previewUrl: local(c.previewUrl) })) };
}

function toButtonDraft(b: TemplateButton): ButtonDraft {
  const type = b.type.toUpperCase();
  const example = Array.isArray(b.example) ? b.example[0] : b.example;
  if (type === 'URL') return { type: 'URL', text: b.text ?? '', url: b.url ?? '', example };
  if (type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text ?? '', phone: b.phone_number ? `+${b.phone_number.replace(/^\+/, '')}` : '' };
  if (type === 'COPY_CODE') return { type: 'COPY_CODE', text: '', example };
  if (type === 'FLOW') return { type: 'FLOW', text: b.text ?? '', formId: '' };
  return { type: 'QUICK_REPLY', text: b.text ?? '' };
}

/** Rebuilds builder state from Meta components (synced, submitted or community templates). */
export function componentsToForm(t: Pick<MessageTemplate, 'type' | 'name' | 'language' | 'category' | 'components'>): TemplateForm {
  const form = emptyForm(t.type);
  const find = (cs: TemplateComponent[], type: string) => cs.find((c) => c.type.toUpperCase() === type);
  const cs = t.components;
  const header = find(cs, 'HEADER');
  const body = find(cs, 'BODY');
  const footer = find(cs, 'FOOTER');
  const buttons = find(cs, 'BUTTONS')?.buttons ?? [];
  const mediaUrl = (h?: TemplateComponent) => {
    const sample = h?.example?.header_handle?.[0];
    return sample && /^https?:\/\//.test(sample) ? sample : undefined;
  };

  Object.assign(form, {
    name: t.name,
    language: t.language,
    category: (['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(t.category) ? t.category : form.category) as Category,
    body: body?.text ?? '',
    bodyExamples: body?.example?.body_text?.[0] ?? [],
    footer: footer?.text ?? '',
  });

  if (header) {
    const format = (header.format ?? 'TEXT').toUpperCase() as HeaderFormat;
    form.headerFormat = format;
    form.headerText = header.text ?? '';
    form.headerExample = header.example?.header_text?.[0] ?? '';
    // Synced media samples come back as URLs; Meta accepts them again on edit.
    form.headerHandle = header.example?.header_handle?.[0] ?? '';
    form.headerPreviewUrl = mediaUrl(header);
  }

  const offer = find(cs, 'LIMITED_TIME_OFFER')?.limited_time_offer;
  if (offer) Object.assign(form, { offerText: offer.text, offerHasExpiration: offer.has_expiration ?? false });

  if (t.type === 'AUTHENTICATION') {
    const otp = buttons[0];
    Object.assign(form, {
      securityRecommendation: body?.add_security_recommendation ?? true,
      expiryMinutes: footer?.code_expiration_minutes ? String(footer.code_expiration_minutes) : '',
      otpType: otp?.otp_type?.toUpperCase() === 'ONE_TAP' ? 'ONE_TAP' : 'COPY_CODE',
      otpButtonText: otp?.text ?? 'Copy code',
      footer: '',
    });
  } else if (!['CATALOG', 'MULTI_PRODUCT'].includes(t.type)) {
    form.buttons = buttons.map(toButtonDraft);
  }

  const cards = find(cs, 'CAROUSEL')?.cards;
  if (cards) {
    form.cards = cards.map((card) => {
      const h = find(card.components, 'HEADER');
      const b = find(card.components, 'BODY');
      return {
        format: (h?.format?.toUpperCase() === 'VIDEO' ? 'VIDEO' : 'IMAGE') as CardDraft['format'],
        handle: h?.example?.header_handle?.[0] ?? '',
        previewUrl: mediaUrl(h),
        body: b?.text ?? '',
        examples: b?.example?.body_text?.[0] ?? [],
        buttons: (find(card.components, 'BUTTONS')?.buttons ?? []).map(toButtonDraft),
      };
    });
  }
  return form;
}

/** Live preview components built from the form (mirrors the server's toComponents). */
export function previewComponents(f: TemplateForm): TemplateComponent[] {
  const btn = (b: ButtonDraft): TemplateButton => (b.type === 'COPY_CODE' ? { type: 'COPY_CODE' } : { type: b.type, text: b.text || defaultButtonText(b.type) });
  if (f.type === 'AUTHENTICATION') {
    return [
      { type: 'BODY', add_security_recommendation: f.securityRecommendation },
      ...(f.expiryMinutes ? [{ type: 'FOOTER' as const, code_expiration_minutes: Number(f.expiryMinutes) }] : []),
      { type: 'BUTTONS', buttons: [{ type: 'OTP', text: f.otpButtonText || 'Copy code' }] },
    ];
  }
  const cs: TemplateComponent[] = [];
  if (f.headerFormat === 'TEXT' && f.headerText) cs.push({ type: 'HEADER', format: 'TEXT', text: f.headerText });
  else if (f.headerFormat !== 'NONE' && f.headerFormat !== 'TEXT') cs.push({ type: 'HEADER', format: f.headerFormat });
  if (f.type === 'LIMITED_TIME_OFFER') cs.push({ type: 'LIMITED_TIME_OFFER', limited_time_offer: { text: f.offerText, has_expiration: f.offerHasExpiration } });
  cs.push({ type: 'BODY', text: f.body });
  if (f.footer && !['LIMITED_TIME_OFFER', 'CAROUSEL'].includes(f.type)) cs.push({ type: 'FOOTER', text: f.footer });
  if (f.type === 'CAROUSEL') {
    cs.push({
      type: 'CAROUSEL',
      cards: f.cards.map((c) => ({
        components: [
          { type: 'HEADER', format: c.format },
          { type: 'BODY', text: c.body || 'Card text…' },
          { type: 'BUTTONS', buttons: c.buttons.map(btn) },
        ],
      })),
    });
  }
  if (f.type === 'CALL_PERMISSION') cs.push({ type: 'CALL_PERMISSION_REQUEST' });
  const buttons =
    f.type === 'CATALOG'
      ? [{ type: 'CATALOG', text: 'View catalog' }]
      : f.type === 'MULTI_PRODUCT'
        ? [{ type: 'MPM', text: 'View items' }]
        : f.type === 'CAROUSEL' || f.type === 'CALL_PERMISSION'
          ? []
          : f.buttons.map(btn);
  if (buttons.length) cs.push({ type: 'BUTTONS', buttons });
  return cs;
}

export function defaultButtonText(type: ButtonType): string {
  return { QUICK_REPLY: 'Quick reply', URL: 'Visit website', PHONE_NUMBER: 'Call us', COPY_CODE: 'Copy offer code', FLOW: 'Open form' }[type];
}

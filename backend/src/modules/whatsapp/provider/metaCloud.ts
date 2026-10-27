import { env } from '../../../config/env.js';
import {
  ProviderError,
  type OutboundMessage,
  type PhoneNumberInfo,
  type ProviderCredentials,
  type ProviderErrorKind,
  type LibraryFilters,
  type LibraryTemplate,
  type LibraryTemplateDraft,
  type ProviderTemplate,
  type TemplateButtonParam,
  type TemplateComponent,
  type TemplateDraft,
  type TemplateMediaParam,
  type TemplateSendParams,
  type WhatsAppProvider,
} from './types.js';

const RATE_LIMIT_CODES = new Set(['4', '80007', '130429', '131048', '131056', '613']);
const TRANSIENT_CODES = new Set(['1', '2', '131000', '133004']);
const REQUEST_TIMEOUT_MS = 15_000;

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
}

/** Official WhatsApp Business Platform (Cloud API) via the Meta Graph API. */
export class MetaCloudProvider implements WhatsAppProvider {
  readonly name = 'meta_cloud';

  async getPhoneNumber(creds: ProviderCredentials): Promise<PhoneNumberInfo> {
    const data = await this.graph<{
      display_phone_number: string;
      verified_name: string;
      quality_rating?: string;
      messaging_limit_tier?: string;
    }>(creds, 'GET', `/${creds.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`);
    return {
      displayPhoneNumber: data.display_phone_number,
      verifiedName: data.verified_name,
      qualityRating: data.quality_rating ?? null,
      messagingLimitTier: data.messaging_limit_tier ?? null,
    };
  }

  async subscribeApp(creds: ProviderCredentials): Promise<void> {
    await this.graph(creds, 'POST', `/${creds.wabaId}/subscribed_apps`);
  }

  async sendMessage(creds: ProviderCredentials, message: OutboundMessage): Promise<{ providerMessageId: string }> {
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: message.to.replace(/^\+/, '') };
    const interactiveParts = (m: { body: string; header?: string; footer?: string }) => ({
      ...(m.header ? { header: { type: 'text', text: m.header } } : {}),
      body: { text: m.body },
      ...(m.footer ? { footer: { text: m.footer } } : {}),
    });
    const body =
      message.type === 'text'
        ? { ...base, type: 'text', text: { body: message.text, preview_url: false } }
        : message.type === 'buttons'
          ? {
              ...base,
              type: 'interactive',
              interactive: {
                type: 'button',
                ...interactiveParts(message),
                action: { buttons: message.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
              },
            }
          : message.type === 'flow'
            ? {
                ...base,
                type: 'interactive',
                interactive: {
                  type: 'flow',
                  ...interactiveParts(message),
                  action: {
                    name: 'flow',
                    parameters: {
                      flow_message_version: '3',
                      flow_token: message.flowToken,
                      flow_id: message.flowId,
                      flow_cta: message.ctaText,
                      flow_action: 'navigate',
                      flow_action_payload: { screen: message.screen },
                    },
                  },
                },
              }
          : message.type === 'media'
            ? {
                ...base,
                type: message.mediaType,
                [message.mediaType]: {
                  ...(message.id ? { id: message.id } : { link: message.link }),
                  ...(message.caption && message.mediaType !== 'audio' ? { caption: message.caption } : {}),
                  ...(message.filename && message.mediaType === 'document' ? { filename: message.filename } : {}),
                },
              }
          : message.type === 'location'
            ? { ...base, type: 'location', location: { latitude: message.latitude, longitude: message.longitude, name: message.name, address: message.address } }
          : message.type === 'address_request'
            ? {
                ...base,
                type: 'interactive',
                interactive: { type: 'address_message', body: { text: message.body }, action: { name: 'address_message', parameters: { country: message.country } } },
              }
          : message.type === 'cta_url'
            ? {
                ...base,
                type: 'interactive',
                interactive: {
                  type: 'cta_url',
                  ...interactiveParts(message),
                  action: { name: 'cta_url', parameters: { display_text: message.buttonText, url: message.url } },
                },
              }
            : {
            ...base,
            type: 'template',
            template: {
              name: message.template.name,
              language: { code: message.template.language },
              components: templateComponents(message.template),
            },
          };

    const data = await this.graph<{ messages?: { id: string }[] }>(creds, 'POST', `/${creds.phoneNumberId}/messages`, body);
    const id = data.messages?.[0]?.id;
    if (!id) throw new ProviderError('Provider did not return a message id.', 'transient');
    return { providerMessageId: id };
  }

  async listTemplates(creds: ProviderCredentials): Promise<ProviderTemplate[]> {
    type Row = { id: string; name: string; language: string; category: string; status: string; components?: ProviderTemplate['components']; rejected_reason?: string };
    const templates: ProviderTemplate[] = [];
    let path: string | null = `/${creds.wabaId}/message_templates?fields=id,name,language,category,status,components,rejected_reason&limit=100`;

    while (path) {
      const page: { data: Row[]; paging?: { next?: string } } = await this.graph(creds, 'GET', path);
      for (const t of page.data) {
        templates.push({
          providerTemplateId: t.id,
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          components: t.components ?? [],
          rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
        });
      }
      // `next` is an absolute URL; strip the host + version so it goes through graph().
      path = page.paging?.next ? page.paging.next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, '') : null;
    }
    return templates;
  }

  async createTemplate(creds: ProviderCredentials, draft: TemplateDraft) {
    const data = await this.graph<{ id: string; status: string; category: string }>(creds, 'POST', `/${creds.wabaId}/message_templates`, draft);
    return { providerTemplateId: data.id, status: data.status, category: data.category };
  }

  async editTemplate(creds: ProviderCredentials, providerTemplateId: string, edit: { category?: string; components: TemplateComponent[] }) {
    await this.graph(creds, 'POST', `/${providerTemplateId}`, edit);
  }

  async deleteTemplate(creds: ProviderCredentials, template: { providerTemplateId: string; name: string }) {
    // hsm_id limits the delete to this one language version.
    const params = new URLSearchParams({ name: template.name, hsm_id: template.providerTemplateId });
    await this.graph(creds, 'DELETE', `/${creds.wabaId}/message_templates?${params}`);
  }

  /** Resumable Upload API: open an upload session on our app, then send the bytes in one go. */
  async uploadTemplateMedia(creds: ProviderCredentials, file: { data: Buffer; mimeType: string; fileName: string }) {
    if (!env.META_APP_ID) throw new ProviderError('META_APP_ID must be set to upload template media.', 'permanent');
    const params = new URLSearchParams({ file_name: file.fileName, file_length: String(file.data.length), file_type: file.mimeType });
    const session = await this.graph<{ id: string }>(creds, 'POST', `/${env.META_APP_ID}/uploads?${params}`);

    let res: Response;
    try {
      res = await fetch(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${session.id}`, {
        method: 'POST',
        headers: { Authorization: `OAuth ${creds.accessToken}`, file_offset: '0', 'Content-Type': file.mimeType },
        body: new Uint8Array(file.data),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new ProviderError(`Could not reach WhatsApp: ${(err as Error).message}`, 'transient');
    }
    const data = (await res.json().catch(() => ({}))) as { h?: string } & GraphError;
    if (!res.ok || !data.h) {
      const code = data.error?.code != null ? String(data.error.code) : null;
      throw new ProviderError(data.error?.message ?? `Media upload failed (HTTP ${res.status}).`, classify(res.status, code), code, res.status);
    }
    return data.h;
  }

  async uploadMedia(creds: ProviderCredentials, file: { data: Buffer; mimeType: string; fileName: string }) {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', file.mimeType);
    form.set('file', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.fileName);
    let res: Response;
    try {
      res = await fetch(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${creds.phoneNumberId}/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.accessToken}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new ProviderError(`Could not reach WhatsApp: ${(err as Error).message}`, 'transient');
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string } & GraphError;
    if (!res.ok || !data.id) {
      const code = data.error?.code != null ? String(data.error.code) : null;
      throw new ProviderError(data.error?.message ?? `Media upload failed (HTTP ${res.status}).`, classify(res.status, code), code, res.status);
    }
    return data.id;
  }

  async listLibraryTemplates(creds: ProviderCredentials, filters: LibraryFilters): Promise<LibraryTemplate[]> {
    type Row = {
      id: string;
      name: string;
      language: string;
      category: string;
      topic?: string;
      usecase?: string;
      industry?: string[];
      header?: string;
      body: string;
      body_params?: string[];
      buttons?: { type: string; text: string; url?: string; phone_number?: string }[];
    };
    const params = new URLSearchParams({ limit: '200' });
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    const page = await this.graph<{ data: Row[] }>(creds, 'GET', `/message_template_library?${params}`);
    return page.data.map((t) => ({
      id: t.id,
      name: t.name,
      language: t.language,
      category: t.category,
      topic: t.topic ?? null,
      usecase: t.usecase ?? null,
      industry: t.industry ?? [],
      header: t.header ?? null,
      body: t.body,
      bodyParams: t.body_params ?? [],
      buttons: t.buttons ?? [],
    }));
  }

  async createFromLibrary(creds: ProviderCredentials, draft: LibraryTemplateDraft) {
    const data = await this.graph<{ id: string; status: string; category: string }>(creds, 'POST', `/${creds.wabaId}/message_templates`, {
      name: draft.name,
      language: draft.language,
      category: 'UTILITY',
      library_template_name: draft.libraryTemplateName,
      ...(draft.buttonInputs.length ? { library_template_button_inputs: JSON.stringify(draft.buttonInputs) } : {}),
    });
    return { providerTemplateId: data.id, status: data.status, category: data.category };
  }

  async listFlows(creds: ProviderCredentials) {
    const flows: { id: string; name: string; status: string; categories: string[] }[] = [];
    let path: string | null = `/${creds.wabaId}/flows?fields=id,name,status,categories&limit=100`;
    while (path) {
      const page: { data: { id: string; name: string; status: string; categories?: string[] }[]; paging?: { next?: string } } = await this.graph(creds, 'GET', path);
      for (const f of page.data) flows.push({ id: f.id, name: f.name, status: f.status, categories: f.categories ?? [] });
      path = page.paging?.next ? page.paging.next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, '') : null;
    }
    return flows;
  }

  async getFlowJson(creds: ProviderCredentials, flowId: string) {
    const assets = await this.graph<{ data: { asset_type: string; download_url: string }[] }>(creds, 'GET', `/${flowId}/assets`);
    const url = assets.data.find((a) => a.asset_type === 'FLOW_JSON')?.download_url;
    if (!url) return null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  async publishFlow(creds: ProviderCredentials, flow: { name: string; flowJson: unknown; categories?: string[] }) {
    const data = await this.graph<{ id: string; validation_errors?: { error?: string; message?: string }[] }>(creds, 'POST', `/${creds.wabaId}/flows`, {
      name: flow.name,
      categories: flow.categories?.length ? flow.categories : ['OTHER'],
      flow_json: JSON.stringify(flow.flowJson),
      publish: true,
    });
    return {
      providerFlowId: data.id,
      validationErrors: (data.validation_errors ?? []).map((e) => e.message ?? e.error ?? 'Invalid flow'),
    };
  }

  async exchangeSignupCode(code: string): Promise<string> {
    if (!env.META_APP_ID || !env.META_APP_SECRET) throw new ProviderError('META_APP_ID and META_APP_SECRET must be set for Embedded Signup.', 'permanent');
    const params = new URLSearchParams({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, code });
    let res: Response;
    try {
      res = await fetch(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/oauth/access_token?${params}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw new ProviderError(`Could not reach Meta: ${(err as Error).message}`, 'transient');
    }
    const data = (await res.json().catch(() => ({}))) as { access_token?: string } & GraphError;
    if (!res.ok || !data.access_token) {
      // Usually an expired (30s) or already-used code.
      throw new ProviderError(data.error?.message ?? `Meta rejected the signup code (HTTP ${res.status}).`, 'auth', data.error?.code != null ? String(data.error.code) : null, res.status);
    }
    return data.access_token;
  }

  async registerPhone(creds: ProviderCredentials, pin: string): Promise<void> {
    await this.graph(creds, 'POST', `/${creds.phoneNumberId}/register`, { messaging_product: 'whatsapp', pin });
  }

  private async graph<T = unknown>(creds: ProviderCredentials, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`https://graph.facebook.com/${env.META_GRAPH_VERSION}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ProviderError(`Could not reach WhatsApp: ${(err as Error).message}`, 'transient');
    }

    const data = (await res.json().catch(() => ({}))) as T & GraphError;
    if (!res.ok || data.error) {
      const code = data.error?.code != null ? String(data.error.code) : null;
      const message = data.error?.error_data?.details || data.error?.message || `WhatsApp API error (HTTP ${res.status})`;
      throw new ProviderError(message, classify(res.status, code), code, res.status);
    }
    return data;
  }
}

const mediaObject = (m: TemplateMediaParam) => ({ type: m.type, [m.type]: { ...(m.id ? { id: m.id } : { link: m.link }), ...(m.filename ? { filename: m.filename } : {}) } });
const textParams = (values: string[]) => values.map((text) => ({ type: 'text', text }));

function buttonComponent(b: TemplateButtonParam) {
  const base = { type: 'button', index: String(b.index) };
  switch (b.subType) {
    case 'url':
      return { ...base, sub_type: 'url', parameters: [{ type: 'text', text: b.text }] };
    case 'copy_code':
      return { ...base, sub_type: 'copy_code', parameters: [{ type: 'coupon_code', coupon_code: b.couponCode }] };
    case 'quick_reply':
      return { ...base, sub_type: 'quick_reply', parameters: [{ type: 'payload', payload: b.payload }] };
    case 'flow':
      return { ...base, sub_type: 'flow', parameters: [{ type: 'action', action: { flow_token: b.flowToken } }] };
    case 'catalog':
      return { ...base, sub_type: 'CATALOG', parameters: [{ type: 'action', action: { thumbnail_product_retailer_id: b.thumbnail } }] };
    case 'mpm':
      return {
        ...base,
        sub_type: 'mpm',
        parameters: [
          {
            type: 'action',
            action: {
              thumbnail_product_retailer_id: b.thumbnail,
              sections: b.sections.map((s) => ({ title: s.title, product_items: s.items.map((id) => ({ product_retailer_id: id })) })),
            },
          },
        ],
      };
  }
}

/** Cloud API `template.components` for a send: header, offer, body, buttons and carousel cards. */
export function templateComponents(t: TemplateSendParams): Record<string, unknown>[] {
  const components: Record<string, unknown>[] = [];
  if (t.headerMedia) components.push({ type: 'header', parameters: [mediaObject(t.headerMedia)] });
  else if (t.headerLocation) components.push({ type: 'header', parameters: [{ type: 'location', location: t.headerLocation }] });
  else if (t.headerParams.length) components.push({ type: 'header', parameters: textParams(t.headerParams) });
  if (t.offerExpiresAt) {
    components.push({ type: 'limited_time_offer', parameters: [{ type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: t.offerExpiresAt } }] });
  }
  if (t.bodyParams.length) components.push({ type: 'body', parameters: textParams(t.bodyParams) });
  for (const b of t.buttons ?? []) components.push(buttonComponent(b));
  if (t.cards?.length) {
    components.push({
      type: 'carousel',
      cards: t.cards.map((card, i) => ({
        card_index: i,
        components: [
          { type: 'header', parameters: [mediaObject(card.media)] },
          ...(card.bodyParams.length ? [{ type: 'body', parameters: textParams(card.bodyParams) }] : []),
          ...card.buttons.map(buttonComponent),
        ],
      })),
    });
  }
  return components;
}

function classify(httpStatus: number, code: string | null): ProviderErrorKind {
  if (httpStatus === 401 || code === '190') return 'auth';
  if (httpStatus === 429 || (code && RATE_LIMIT_CODES.has(code))) return 'rate_limit';
  if (httpStatus >= 500 || (code && TRANSIENT_CODES.has(code))) return 'transient';
  return 'permanent';
}

import { createHmac } from 'node:crypto';
import {
  ProviderError,
  type OutboundMessage,
  type ProviderCredentials,
  type LibraryTemplate,
  type LibraryTemplateDraft,
  type ProviderTemplate,
  type TemplateDraft,
  type WhatsAppProvider,
} from '../src/modules/whatsapp/provider/types.js';

type SendBehaviour = () => { providerMessageId: string } | never;

/** Scriptable provider double: records calls, lets tests decide what the "API" returns. */
export class FakeProvider implements WhatsAppProvider {
  readonly name = 'fake';
  sent: { creds: ProviderCredentials; message: OutboundMessage }[] = [];
  created: TemplateDraft[] = [];
  templates: ProviderTemplate[] = [];
  getPhoneError: ProviderError | null = null;
  private sendQueue: SendBehaviour[] = [];
  private counter = 0;

  async getPhoneNumber() {
    if (this.getPhoneError) throw this.getPhoneError;
    return { displayPhoneNumber: '+91 98765 43210', verifiedName: 'Sharma Dental', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K' };
  }

  async subscribeApp() {}

  /** Queue the outcome of upcoming sends; default is success. */
  nextSend(...behaviours: SendBehaviour[]) {
    this.sendQueue.push(...behaviours);
  }

  async sendMessage(creds: ProviderCredentials, message: OutboundMessage) {
    this.sent.push({ creds, message });
    const behaviour = this.sendQueue.shift();
    if (behaviour) return behaviour();
    this.counter += 1;
    return { providerMessageId: `wamid.fake.${this.counter}` };
  }

  async listTemplates() {
    return this.templates;
  }

  published: { name: string; flowJson: unknown }[] = [];
  flowValidationErrors: string[] = [];

  async publishFlow(_creds: ProviderCredentials, flow: { name: string; flowJson: unknown }) {
    this.published.push(flow);
    return { providerFlowId: `flow-${this.published.length}`, validationErrors: this.flowValidationErrors };
  }

  exchanged: string[] = [];
  registered: { phoneNumberId: string; pin: string }[] = [];
  registerError: ProviderError | null = null;

  async exchangeSignupCode(code: string) {
    if (code.startsWith('expired')) throw new ProviderError('This authorization code has expired.', 'auth', '100');
    this.exchanged.push(code);
    return `EAAG-business-token-for-${code}-0123456789`;
  }

  async registerPhone(creds: ProviderCredentials, pin: string) {
    if (this.registerError) throw this.registerError;
    this.registered.push({ phoneNumberId: creds.phoneNumberId, pin });
  }

  edited: { providerTemplateId: string; edit: { category?: string; components: unknown[] } }[] = [];
  deleted: { providerTemplateId: string; name: string }[] = [];
  library: LibraryTemplate[] = [];
  libraryCreated: LibraryTemplateDraft[] = [];

  async editTemplate(_creds: ProviderCredentials, providerTemplateId: string, edit: { category?: string; components: unknown[] }) {
    this.edited.push({ providerTemplateId, edit });
  }

  async deleteTemplate(_creds: ProviderCredentials, template: { providerTemplateId: string; name: string }) {
    this.deleted.push(template);
  }

  async uploadTemplateMedia(_creds: ProviderCredentials, file: { data: Buffer }) {
    return `handle-${file.data.length}`;
  }

  uploaded: { mimeType: string; fileName: string }[] = [];

  async uploadMedia(_creds: ProviderCredentials, file: { data: Buffer; mimeType: string; fileName: string }) {
    this.uploaded.push({ mimeType: file.mimeType, fileName: file.fileName });
    return `media-${this.uploaded.length}`;
  }

  async listLibraryTemplates() {
    return this.library;
  }

  async createFromLibrary(_creds: ProviderCredentials, draft: LibraryTemplateDraft) {
    this.libraryCreated.push(draft);
    return { providerTemplateId: `lib-tpl-${this.libraryCreated.length}`, status: 'PENDING', category: 'UTILITY' };
  }

  async createTemplate(_creds: ProviderCredentials, draft: TemplateDraft) {
    this.created.push(draft);
    return { providerTemplateId: `tpl-${this.created.length}`, status: 'PENDING', category: draft.category };
  }
}

export const failWith = (kind: ProviderError['kind'], code = '0', message = `fake ${kind} error`) => () => {
  throw new ProviderError(message, kind, code);
};

export const TEST_APP_SECRET = 'test-app-secret';

export function sign(body: string): string {
  return `sha256=${createHmac('sha256', TEST_APP_SECRET).update(body).digest('hex')}`;
}

export function inboundPayload(phoneNumberId: string, opts: { id: string; from: string; text: string; name?: string; ts?: number }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '919876543210', phone_number_id: phoneNumberId },
              contacts: [{ wa_id: opts.from, profile: { name: opts.name ?? 'Customer' } }],
              messages: [{ from: opts.from, id: opts.id, timestamp: String(opts.ts ?? Math.floor(Date.now() / 1000)), type: 'text', text: { body: opts.text } }],
            },
          },
        ],
      },
    ],
  };
}

export function statusPayload(
  phoneNumberId: string,
  providerMessageId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed',
  ts: number,
  error?: { code: number; title: string },
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: phoneNumberId },
              statuses: [{ id: providerMessageId, status, timestamp: String(ts), recipient_id: '919811112222', ...(error ? { errors: [error] } : {}) }],
            },
          },
        ],
      },
    ],
  };
}

export function templateStatusPayload(wabaId: string, templateId: string, event: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: wabaId, changes: [{ field: 'message_template_status_update', value: { event, message_template_id: templateId, reason: 'NONE' } }] }],
  };
}

export function inboundButtonPayload(phoneNumberId: string, opts: { id: string; from: string; buttonId: string; title: string }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ wa_id: opts.from, profile: { name: 'Customer' } }],
              messages: [
                {
                  from: opts.from,
                  id: opts.id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'interactive',
                  interactive: { type: 'button_reply', button_reply: { id: opts.buttonId, title: opts.title } },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function inboundFormReplyPayload(phoneNumberId: string, opts: { id: string; from: string; response: Record<string, unknown> }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ wa_id: opts.from, profile: { name: 'Customer' } }],
              messages: [
                {
                  from: opts.from,
                  id: opts.id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'interactive',
                  interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: JSON.stringify(opts.response) } },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

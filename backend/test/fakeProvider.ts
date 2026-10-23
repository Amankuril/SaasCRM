import { createHmac } from 'node:crypto';
import {
  ProviderError,
  type OutboundMessage,
  type ProviderCredentials,
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

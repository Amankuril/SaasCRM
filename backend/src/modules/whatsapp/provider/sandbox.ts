import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  ProviderError,
  type NormalizedEvent,
  type OutboundMessage,
  type ProviderCredentials,
  type ProviderTemplate,
  type TemplateDraft,
  type WhatsAppProvider,
} from './types.js';

/**
 * Development-only fake WhatsApp so the product can be built and demoed before
 * Meta Tech Provider approval. Accepts any credentials (except the token
 * "invalid"), and simulates delivery receipts and template approval by emitting
 * the same normalized events a real webhook would produce.
 *
 * Demo hooks: sending to a number ending in 0000 fails as "undeliverable".
 */
export const sandboxEvents = new EventEmitter<{ events: [NormalizedEvent[]] }>();

const templatesByWaba = new Map<string, ProviderTemplate[]>();

function emitLater(delayMs: number, events: NormalizedEvent[]) {
  setTimeout(() => sandboxEvents.emit('events', events), delayMs).unref();
}

export class SandboxProvider implements WhatsAppProvider {
  readonly name = 'sandbox';

  async getPhoneNumber(creds: ProviderCredentials) {
    if (creds.accessToken === 'invalid') throw new ProviderError('Invalid OAuth access token.', 'auth', '190', 401);
    const digits = creds.phoneNumberId.replace(/\D/g, '').padStart(10, '0').slice(-10);
    return {
      displayPhoneNumber: `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`,
      verifiedName: 'Sandbox Business',
      qualityRating: 'GREEN',
      messagingLimitTier: 'TIER_1K',
    };
  }

  async subscribeApp() {}

  async sendMessage(creds: ProviderCredentials, message: OutboundMessage) {
    const providerMessageId = `wamid.sandbox.${randomBytes(12).toString('hex')}`;
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs);
    const status = (s: 'sent' | 'delivered' | 'read' | 'failed', offsetMs: number, error: { code: string; title: string; message: string } | null = null) =>
      ({ kind: 'status', phoneNumberId: creds.phoneNumberId, providerMessageId, status: s, timestamp: at(offsetMs), error }) as const;

    if (message.to.endsWith('0000')) {
      emitLater(1_000, [status('failed', 1_000, { code: '131026', title: 'Message undeliverable', message: 'Sandbox: recipient cannot receive messages.' })]);
    } else {
      emitLater(1_000, [status('sent', 1_000)]);
      emitLater(2_000, [status('delivered', 2_000)]);
      emitLater(4_000, [status('read', 4_000)]);
    }
    return { providerMessageId };
  }

  async listTemplates(creds: ProviderCredentials) {
    return [...this.templates(creds.wabaId)];
  }

  async createTemplate(creds: ProviderCredentials, draft: TemplateDraft) {
    const providerTemplateId = String(Date.now()) + randomBytes(2).toString('hex');
    this.templates(creds.wabaId).push({ ...draft, providerTemplateId, status: 'PENDING', rejectedReason: null });
    // Simulated review: approved a few seconds later.
    setTimeout(() => {
      const t = this.templates(creds.wabaId).find((x) => x.providerTemplateId === providerTemplateId);
      if (t) t.status = 'APPROVED';
      sandboxEvents.emit('events', [{ kind: 'template_status', wabaId: creds.wabaId, providerTemplateId, status: 'APPROVED', reason: null }]);
    }, 3_000).unref();
    return { providerTemplateId, status: 'PENDING', category: draft.category };
  }

  private templates(wabaId: string): ProviderTemplate[] {
    let list = templatesByWaba.get(wabaId);
    if (!list) {
      list = [
        {
          providerTemplateId: `${wabaId}-hello`,
          name: 'hello_world',
          language: 'en_US',
          category: 'UTILITY',
          status: 'APPROVED',
          rejectedReason: null,
          components: [
            { type: 'HEADER', format: 'TEXT', text: 'Hello World' },
            { type: 'BODY', text: 'Welcome and congratulations!! This message demonstrates your ability to send a WhatsApp message notification.' },
            { type: 'FOOTER', text: 'WhatsApp Business Platform sample message' },
          ],
        },
      ];
      templatesByWaba.set(wabaId, list);
    }
    return list;
  }
}

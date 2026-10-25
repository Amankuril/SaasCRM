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
const flows = new Map<string, { screens: { layout: { children: Record<string, unknown>[] } }[] }>();

/** Plausible answers for a sandbox form submission. */
function sampleAnswers(flowJson: (typeof flows extends Map<string, infer V> ? V : never) | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of flowJson?.screens[0]?.layout.children ?? []) {
    const name = c.name as string | undefined;
    if (!name) continue;
    const options = (c['data-source'] as { id: string }[] | undefined) ?? [];
    switch (c.type) {
      case 'TextInput':
        out[name] = { email: 'test.customer@example.com', phone: '+919811112222', number: '2' }[c['input-type'] as string] ?? 'Test Customer';
        break;
      case 'TextArea':
        out[name] = 'Sandbox submission';
        break;
      case 'Dropdown':
      case 'RadioButtonsGroup':
        out[name] = options[0]?.id ?? '';
        break;
      case 'CheckboxGroup':
        out[name] = options.slice(0, 1).map((o) => o.id);
        break;
      case 'DatePicker':
        out[name] = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
        break;
      case 'OptIn':
        out[name] = true;
        break;
    }
  }
  return out;
}

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

    if (message.type === 'flow') {
      // Simulate the customer filling in the form a few seconds later.
      const response = JSON.stringify({ ...sampleAnswers(flows.get(message.flowId)), flow_token: message.flowToken });
      emitLater(3_000, [
        {
          kind: 'message',
          phoneNumberId: creds.phoneNumberId,
          providerMessageId: `wamid.sandbox.form.${randomBytes(8).toString('hex')}`,
          from: message.to.replace(/^\+/, ''),
          profileName: null,
          timestamp: new Date(),
          type: 'interactive',
          content: { interactiveType: 'nfm_reply', title: 'Sent', response },
        },
      ]);
    }
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

  async publishFlow(_creds: ProviderCredentials, flow: { name: string; flowJson: unknown }) {
    const providerFlowId = `sandbox-flow-${randomBytes(4).toString('hex')}`;
    flows.set(providerFlowId, flow.flowJson as typeof flows extends Map<string, infer V> ? V : never);
    return { providerFlowId, validationErrors: [] };
  }

  async exchangeSignupCode(code: string): Promise<string> {
    return `sandbox-token-${code}-${randomBytes(8).toString('hex')}`;
  }

  async registerPhone(): Promise<void> {}

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

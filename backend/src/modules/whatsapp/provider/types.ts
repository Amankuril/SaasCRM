/**
 * Provider-independent WhatsApp contract. Business logic only talks to this
 * interface, so Meta Cloud API can be swapped for a BSP (360dialog, Gupshup...)
 * without touching campaigns, inbox or flows.
 */

export interface ProviderCredentials {
  accessToken: string;
  wabaId: string;
  phoneNumberId: string;
}

export interface PhoneNumberInfo {
  displayPhoneNumber: string;
  verifiedName: string;
  qualityRating: string | null;
  messagingLimitTier: string | null;
}

export interface TemplateSendParams {
  name: string;
  language: string;
  headerParams: string[];
  bodyParams: string[];
}

export interface InteractiveParts {
  body: string;
  header?: string;
  footer?: string;
}

export type OutboundMessage =
  | { type: 'text'; to: string; text: string }
  | { type: 'template'; to: string; template: TemplateSendParams }
  // Reply buttons (max 3); taps come back as inbound "interactive" messages with the button id.
  | ({ type: 'buttons'; to: string; buttons: { id: string; title: string }[] } & InteractiveParts)
  // A single call-to-action button that opens a URL.
  | ({ type: 'cta_url'; to: string; buttonText: string; url: string } & InteractiveParts);

export interface ProviderTemplate {
  providerTemplateId: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: TemplateComponent[];
  rejectedReason: string | null;
}

/** Meta-shaped template components (also what we store locally). */
export interface TemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: string;
  text?: string;
  example?: Record<string, unknown>;
  buttons?: { type: string; text: string; url?: string; phone_number?: string }[];
}

export interface TemplateDraft {
  name: string;
  language: string;
  category: string;
  components: TemplateComponent[];
}

export interface WhatsAppProvider {
  readonly name: string;
  getPhoneNumber(creds: ProviderCredentials): Promise<PhoneNumberInfo>;
  /** Subscribes our app to the business account so its webhooks reach us. */
  subscribeApp(creds: ProviderCredentials): Promise<void>;
  sendMessage(creds: ProviderCredentials, message: OutboundMessage): Promise<{ providerMessageId: string }>;
  listTemplates(creds: ProviderCredentials): Promise<ProviderTemplate[]>;
  createTemplate(creds: ProviderCredentials, draft: TemplateDraft): Promise<{ providerTemplateId: string; status: string; category: string }>;
}

/**
 * - auth: token invalid/expired -> pause sending, owner must reconnect
 * - rate_limit / transient: retry with backoff
 * - permanent: bad recipient/template/params -> do not retry
 */
export type ProviderErrorKind = 'auth' | 'rate_limit' | 'transient' | 'permanent';

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: ProviderErrorKind,
    public readonly code: string | null = null,
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'transient';
  }
}

// ---- Normalized webhook events ----

export type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface InboundMessageEvent {
  kind: 'message';
  phoneNumberId: string;
  providerMessageId: string;
  from: string; // E.164 without "+"
  profileName: string | null;
  timestamp: Date;
  type: string;
  content: Record<string, unknown>;
}

export interface StatusEvent {
  kind: 'status';
  phoneNumberId: string;
  providerMessageId: string;
  status: MessageStatus;
  timestamp: Date;
  error: { code: string; title: string; message: string } | null;
}

export interface TemplateStatusEvent {
  kind: 'template_status';
  wabaId: string;
  providerTemplateId: string;
  status: string;
  reason: string | null;
}

export type NormalizedEvent = InboundMessageEvent | StatusEvent | TemplateStatusEvent;

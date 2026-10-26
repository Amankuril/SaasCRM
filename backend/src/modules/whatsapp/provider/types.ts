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

export interface TemplateMediaParam {
  type: 'image' | 'video' | 'document';
  /** A public https URL, or the id of media uploaded to WhatsApp. */
  link?: string;
  id?: string;
  filename?: string;
}

export interface TemplateLocationParam {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

/** Per-send values for a template button, addressed by its position. */
export type TemplateButtonParam =
  | { index: number; subType: 'url'; text: string }
  | { index: number; subType: 'copy_code'; couponCode: string }
  | { index: number; subType: 'quick_reply'; payload: string }
  | { index: number; subType: 'flow'; flowToken: string }
  | { index: number; subType: 'catalog'; thumbnail: string }
  | { index: number; subType: 'mpm'; thumbnail: string; sections: { title: string; items: string[] }[] };

export interface TemplateCardParams {
  media: TemplateMediaParam;
  bodyParams: string[];
  buttons: TemplateButtonParam[];
}

export interface TemplateSendParams {
  name: string;
  language: string;
  headerParams: string[];
  bodyParams: string[];
  headerMedia?: TemplateMediaParam;
  headerLocation?: TemplateLocationParam;
  buttons?: TemplateButtonParam[];
  /** Limited-time offer expiry (epoch ms). */
  offerExpiresAt?: number;
  cards?: TemplateCardParams[];
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
  | ({ type: 'cta_url'; to: string; buttonText: string; url: string } & InteractiveParts)
  // Opens a published WhatsApp Flow (our forms). The token comes back with the submission.
  | ({ type: 'flow'; to: string; flowId: string; flowToken: string; ctaText: string; screen: string } & InteractiveParts);

export interface PublishedFlow {
  providerFlowId: string;
  /** Problems Meta reported; empty when the flow is live. */
  validationErrors: string[];
}

export interface ProviderTemplate {
  providerTemplateId: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: TemplateComponent[];
  rejectedReason: string | null;
}

/** A template button, Meta-shaped (fields depend on `type`). */
export interface TemplateButton {
  type: string;
  /** Absent on COPY_CODE buttons (WhatsApp shows a fixed label). */
  text?: string;
  url?: string;
  phone_number?: string;
  example?: string[] | string;
  otp_type?: string;
  autofill_text?: string;
  supported_apps?: { package_name: string; signature_hash: string }[];
  flow_id?: string;
  navigate_screen?: string;
  flow_action?: string;
}

/** Meta-shaped template components (also what we store locally). */
export interface TemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS' | 'LIMITED_TIME_OFFER' | 'CAROUSEL' | 'CALL_PERMISSION_REQUEST';
  format?: string;
  text?: string;
  example?: Record<string, unknown>;
  buttons?: TemplateButton[];
  cards?: { components: TemplateComponent[] }[];
  limited_time_offer?: { text: string; has_expiration?: boolean };
  add_security_recommendation?: boolean;
  code_expiration_minutes?: number;
}

/** A ready-made template from Meta's Template Library. */
export interface LibraryTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  topic: string | null;
  usecase: string | null;
  industry: string[];
  header: string | null;
  body: string;
  bodyParams: string[];
  buttons: { type: string; text: string; url?: string; phone_number?: string }[];
}

export interface LibraryFilters {
  search?: string;
  name?: string;
  topic?: string;
  usecase?: string;
  industry?: string;
  language?: string;
}

export interface LibraryTemplateDraft {
  name: string;
  language: string;
  libraryTemplateName: string;
  buttonInputs: ({ type: 'URL'; url: { base_url: string; url_suffix_example?: string } } | { type: 'PHONE_NUMBER'; phone_number: string })[];
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
  /** Edits a submitted template's content; it goes back into review. */
  editTemplate(creds: ProviderCredentials, providerTemplateId: string, edit: { category?: string; components: TemplateComponent[] }): Promise<void>;
  /** Deletes one language version of a template. */
  deleteTemplate(creds: ProviderCredentials, template: { providerTemplateId: string; name: string }): Promise<void>;
  /** Uploads a sample media file for a template header/card; returns the handle Meta expects in `header_handle`. */
  uploadTemplateMedia(creds: ProviderCredentials, file: { data: Buffer; mimeType: string; fileName: string }): Promise<string>;
  /** Uploads a file for sending (e.g. a template header image); returns the WhatsApp media id. */
  uploadMedia(creds: ProviderCredentials, file: { data: Buffer; mimeType: string; fileName: string }): Promise<string>;
  /** Browses Meta's pre-approved Template Library. */
  listLibraryTemplates(creds: ProviderCredentials, filters: LibraryFilters): Promise<LibraryTemplate[]>;
  createFromLibrary(creds: ProviderCredentials, draft: LibraryTemplateDraft): Promise<{ providerTemplateId: string; status: string; category: string }>;
  /** Creates and publishes a WhatsApp Flow (forms). */
  publishFlow(creds: ProviderCredentials, flow: { name: string; flowJson: unknown }): Promise<PublishedFlow>;
  /** Embedded Signup: swaps the short-lived (30s) code for the business's access token. */
  exchangeSignupCode(code: string): Promise<string>;
  /** Registers the number for Cloud API messaging and sets its two-step verification PIN. */
  registerPhone(creds: ProviderCredentials, pin: string): Promise<void>;
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

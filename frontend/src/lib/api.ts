/**
 * Thin fetch wrapper. The short-lived access token lives only in memory; the refresh
 * token is an httpOnly cookie the browser sends to /api/auth/refresh automatically.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string[]>,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
/** `replaced`: the account logged in on another browser or tab. */
export type SessionEndReason = 'expired' | 'replaced';
let onSessionExpired: ((reason: SessionEndReason) => void) | null = null;
let lastRefreshError: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setSessionExpiredHandler(handler: (reason: SessionEndReason) => void) {
  onSessionExpired = handler;
}

export interface AuthPayload {
  user: User;
  accessToken: string;
}

/** Business login, step 1 answer: a code was emailed. */
export interface LoginChallenge {
  otpRequired: true;
  challengeToken: string;
  /** Masked, e.g. "as****@gmail.com". */
  email: string;
  expiresInSeconds: number;
  resendInSeconds: number;
}

/** Single-flight refresh so parallel 401s trigger only one /refresh call. */
export function refreshAccessToken(): Promise<string | null> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) {
        lastRefreshError = ((await res.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code ?? null;
        return null;
      }
      lastRefreshError = null;
      const body = (await res.json()) as AuthPayload;
      accessToken = body.accessToken;
      return body.accessToken;
    })
    .catch(() => null)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown, retry = true): Promise<T> {
  const headers: Record<string, string> = {};
  const raw = body instanceof Blob;
  if (body !== undefined) headers['Content-Type'] = raw ? body.type : 'application/json';
  if (body instanceof File) headers['X-File-Name'] = body.name;
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });

  if (res.status === 401 && retry && (!path.startsWith('/auth/') || path === '/auth/heartbeat')) {
    const code = ((await res.clone().json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
    const token = code === 'SESSION_REPLACED' ? null : await refreshAccessToken();
    if (token) return request<T>(method, path, body, false);
    onSessionExpired?.(code === 'SESSION_REPLACED' || lastRefreshError === 'SESSION_REPLACED' ? 'replaced' : 'expired');
  }

  if (res.status === 204) return undefined as T;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? 'Request failed.', err?.details);
  }
  return data as T;
}

/** Authenticated file download (e.g. CSV export) that saves via a temporary link. */
async function download(path: string, fallbackName: string): Promise<void> {
  const go = () => fetch(`/api${path}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, credentials: 'include' });
  let res = await go();
  if (res.status === 401 && (await refreshAccessToken())) res = await go();
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error?.code ?? 'UNKNOWN', data?.error?.message ?? 'Download failed.');
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
  /** Sends a file as the raw request body (Content-Type and X-File-Name from the file). */
  upload: <T>(path: string, file: File) => request<T>('POST', path, file),
  download,
};

// ---- Shared API types ----

export type Role = 'owner' | 'admin' | 'manager' | 'agent' | 'analyst';
export const ROLES: Role[] = ['owner', 'admin', 'manager', 'agent', 'analyst'];

export type Permission =
  | 'workspace:read'
  | 'workspace:update'
  | 'members:read'
  | 'members:manage'
  | 'billing:manage'
  | 'provider:manage'
  | 'templates:manage'
  | 'messages:send'
  | 'conversations:view_all'
  | 'conversations:assign'
  | 'contacts:manage'
  | 'contacts:delete'
  | 'contacts:import'
  | 'contacts:export'
  | 'tags:manage'
  | 'campaigns:manage'
  | 'flows:manage'
  | 'ai:manage'
  | 'forms:manage'
  | 'developer:manage'
  | 'audit:read';

export interface User {
  id: string;
  name: string;
  email: string;
  isPlatformAdmin: boolean;
  emailVerified: boolean;
  createdAt: string;
}

export type WorkspaceStatus = 'setup' | 'active' | 'suspended';

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  country: string;
  industry: string | null;
  currency: string;
  status: WorkspaceStatus;
  createdAt: string;
}

export interface WorkspaceSummary extends Workspace {
  role: Role;
}

export interface WorkspaceContextPayload {
  workspace: Workspace;
  membership: { id: string; role: Role; permissions: Permission[] };
  subscription: SubscriptionSummary;
}

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'suspended' | 'cancelled' | 'expired';
export type LimitKey = 'contacts' | 'seats' | 'monthlyMessages' | 'activeFlows' | 'forms' | 'aiRepliesPerMonth' | 'apiRequestsPerMinute';
export type FeatureKey = 'campaigns' | 'flows' | 'forms' | 'ai' | 'api';

export interface SubscriptionSummary {
  planCode: string;
  planName: string;
  status: SubscriptionStatus;
  access: boolean;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  features: Record<FeatureKey, boolean>;
}

export interface WhatsAppConnection {
  id: string;
  provider: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  status: 'connected' | 'error';
  lastError: string | null;
  lastSyncAt: string | null;
  lastWebhookAt: string | null;
  connectedVia: 'embedded_signup' | 'manual';
  registered: boolean;
  createdAt: string;
}

export interface ConnectionPayload {
  connection: WhatsAppConnection | null;
  webhook: { callbackUrl: string; configured: boolean };
  sandbox: boolean;
  embeddedSignup: { enabled: true; appId: string; configId: string; graphVersion: string } | { enabled: false };
}

export interface TemplateButton {
  type: string;
  text?: string;
  url?: string;
  phone_number?: string;
  example?: string[] | string;
  otp_type?: string;
  flow_id?: string;
  navigate_screen?: string;
}

export interface TemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS' | 'LIMITED_TIME_OFFER' | 'CAROUSEL' | 'CALL_PERMISSION_REQUEST';
  format?: string;
  text?: string;
  example?: { header_text?: string[]; body_text?: string[][]; header_handle?: string[] };
  buttons?: TemplateButton[];
  cards?: { components: TemplateComponent[] }[];
  limited_time_offer?: { text: string; has_expiration?: boolean };
  add_security_recommendation?: boolean;
  code_expiration_minutes?: number;
}

export type TemplateType = 'CUSTOM' | 'FLOW' | 'AUTHENTICATION' | 'LIMITED_TIME_OFFER' | 'CAROUSEL' | 'CATALOG' | 'MULTI_PRODUCT' | 'CALL_PERMISSION';

export interface MessageTemplate {
  id: string;
  providerTemplateId: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  rejectedReason: string | null;
  components: TemplateComponent[];
  variables: { header: number; body: number };
  requirements: SendRequirements;
  type: TemplateType;
  /** Raw builder input of a DRAFT. */
  draft: Record<string, unknown> | null;
  isFavorite: boolean;
  libraryTemplateName: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  usage: { campaigns: number; flows: number } | null;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What a template needs at send time beyond header/body text variables. */
export interface SendRequirements {
  header: number;
  body: number;
  headerMedia: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null;
  headerLocation: boolean;
  buttons: { index: number; type: 'URL' | 'COPY_CODE'; text: string }[];
  offer: { expires: boolean } | null;
  products: 'CATALOG' | 'MPM' | null;
  otp: boolean;
  cards: { media: 'IMAGE' | 'VIDEO'; body: number; buttons: { index: number; type: 'URL'; text: string }[] }[];
}

export interface TemplateMediaInput {
  link?: string;
  id?: string;
  filename?: string;
}

export interface TemplateExtras {
  headerMedia?: TemplateMediaInput;
  headerLocation?: { latitude: number; longitude: number; name?: string; address?: string };
  offerExpiresAt?: string;
  offerExpiresInMinutes?: number;
  products?: { thumbnail: string; items: string[] };
  otpCode?: string;
  cards?: { media: TemplateMediaInput; bodyParams: string[]; buttonParams: string[] }[];
}

export interface TemplatePage {
  templates: MessageTemplate[];
  total: number;
  page: number;
  limit: number;
}

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

export interface CommunityTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  type: TemplateType;
  components: TemplateComponent[];
  contributorName: string;
  mine: boolean;
  uses: number;
  createdAt: string;
}

export type MessageStatus = 'queued' | 'submitted' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';

export interface ChatMessage {
  id: string;
  contactId: string;
  contact: { phone: string; name: string | null } | null;
  direction: 'inbound' | 'outbound';
  type: string;
  content: Record<string, unknown>;
  status: MessageStatus;
  error: { code: string; title: string; message: string } | null;
  createdAt: string;
}

/** Key of one of the workspace's pipeline stages. */
export type LifecycleStage = string;
export type ConsentStatus = 'unknown' | 'opted_in' | 'opted_out';
export type TagColor = 'gray' | 'red' | 'amber' | 'green' | 'blue' | 'violet' | 'pink';

export interface Tag {
  id: string;
  name: string;
  color: TagColor;
  contactCount?: number;
}

export interface Contact {
  id: string;
  phone: string;
  name: string | null;
  profileName: string | null;
  displayName: string;
  email: string | null;
  tags: string[];
  lists: string[];
  lifecycleStage: LifecycleStage;
  ownerId: string | null;
  customFields: Record<string, string>;
  consent: { status: ConsentStatus; source: string | null; updatedAt: string | null };
  source: string | null;
  attribution: { source: ChatSource; campaignId: string | null; campaignName: string | null; adTitle: string | null; at: string | null } | null;
  lastInboundAt: string | null;
  createdAt: string;
}

export type ConversationStatus = 'open' | 'pending' | 'resolved';

export interface ConversationSummary {
  id: string;
  status: ConversationStatus;
  priority: 'normal' | 'high';
  botPaused: boolean;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: 'inbound' | 'outbound' | null;
  serviceWindowOpen: boolean;
  contact: { id: string; phone: string; name: string; tags: string[] } | null;
  assignee: { id: string; name: string } | null;
}

export type TimelineItem =
  | {
      kind: 'message';
      id: string;
      createdAt: string;
      direction: 'inbound' | 'outbound';
      type: string;
      content: Record<string, unknown>;
      status: MessageStatus;
      error: { code: string; title: string; message: string } | null;
      sentBy: string | null;
    }
  | { kind: 'note'; id: string; createdAt: string; body: string; author: string };

export interface Member {
  id: string;
  userId: string;
  name: string;
  email: string | null;
  role: Role;
  joinedAt: string;
}

export interface AudienceFilter {
  tagsAny: string[];
  listsAny?: string[];
  sources?: (ChatSource | 'none')[];
  campaignIds?: string[];
  ownerIds?: string[];
  unassigned?: boolean;
  addedWithinDays?: number | null;
  excludeTags: string[];
  stages: LifecycleStage[];
  requireOptIn: boolean;
}

export interface VariableSpec {
  source: 'static' | 'field';
  value: string;
  fallback: string;
}

export type RetargetOutcome = 'read' | 'delivered' | 'sent' | 'failed';

export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  templateId: string | null;
  templateName: string | null;
  headerVariables: VariableSpec[];
  bodyVariables: VariableSpec[];
  buttonVariables: VariableSpec[];
  templateExtras: TemplateExtras | null;
  audience: {
    type: 'all' | 'segment' | 'filter' | 'list' | 'retarget';
    segmentId: string | null;
    filter: AudienceFilter;
    retarget?: { campaignId: string | null; outcomes: RetargetOutcome[] };
  };
  assigneeIds: string[];
  sendRatePerMinute: number;
  quietHours: { enabled: boolean; start: string; end: string };
  scheduledAt: string | null;
  launchedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  stats: Partial<Record<'total' | 'pending' | 'queued' | 'submitted' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped' | 'replied', number>>;
}

export interface Segment {
  id: string;
  name: string;
  filter: AudienceFilter;
}

export interface CampaignPreview {
  matched: number;
  eligible: number;
  skipped: Record<string, number>;
  samples: { contact: string; phone: string; preview: string }[];
}

export type FlowNodeType =
  | 'trigger'
  | 'send_text'
  | 'send_template'
  | 'send_buttons'
  | 'send_cta'
  | 'ask'
  | 'condition'
  | 'delay'
  | 'update_contact'
  | 'send_form'
  | 'ai_answer'
  | 'http_request'
  | 'handoff'
  | 'exit';

export interface FlowGraphNode {
  id: string;
  type: FlowNodeType;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface FlowGraphEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
}

export interface FlowGraph {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
}

export type FlowStatus = 'draft' | 'active' | 'inactive';

export interface FlowSummary {
  id: string;
  name: string;
  description: string;
  status: FlowStatus;
  publishedVersion: number;
  trigger: { event: string | null; keywords: string[] } | null;
  hasUnpublishedChanges: boolean;
  draftUpdatedAt: string;
  updatedAt: string;
  stats30d?: Partial<Record<'running' | 'waiting' | 'completed' | 'exited' | 'failed', number>>;
}

export interface FlowDetail extends FlowSummary {
  draftGraph: FlowGraph;
  settings: { allowReentry: boolean; exitOnReply: boolean };
}

export interface FlowIssue {
  nodeId: string | null;
  message: string;
}

export interface FlowExecution {
  id: string;
  status: 'running' | 'waiting' | 'completed' | 'exited' | 'failed';
  currentNodeId: string | null;
  waiting: { kind: 'delay' | 'reply'; nodeId: string; until: string } | null;
  trigger: { type?: string; text?: string };
  stepCount: number;
  error: string | null;
  exitReason: string | null;
  goal: string | null;
  log: { nodeId: string; type: string; outcome: string; detail?: string; at: string }[];
  createdAt: string;
  endedAt: string | null;
  contact?: { name: string; phone: string } | null;
}

export type AiModel = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5';

export interface AiSettings {
  enabled: boolean;
  autoReply: boolean;
  name: string;
  tone: 'friendly' | 'professional' | 'concise';
  language: string;
  businessContext: string;
  instructions: string;
  fallbackMessage: string;
  handoffMessage: string;
  escalationKeywords: string[];
  maxRepliesPerConversation: number;
  model: AiModel;
  apiKey: { source: 'workspace' | 'platform'; last4: string | null } | null;
}

export interface KnowledgeSource {
  id: string;
  type: 'text' | 'faq' | 'url';
  title: string;
  url: string | null;
  status: 'ready' | 'failed';
  error: string | null;
  chunkCount: number;
  preview: string;
  lastIngestedAt: string | null;
  createdAt: string;
}

export interface AgentDecision {
  outcome: 'answered' | 'handoff';
  answer: string;
  reason: string;
  sources: { id: string; title: string }[];
  error: string | null;
}

export type FormFieldType = 'short_text' | 'long_text' | 'email' | 'phone' | 'number' | 'dropdown' | 'radio' | 'checkbox' | 'date' | 'opt_in';

export interface FormField {
  key: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  options: { id: string; title: string }[];
  saveTo: string | null;
}

export type FormComponentType =
  | 'heading'
  | 'subheading'
  | 'caption'
  | 'body'
  | 'text_input'
  | 'text_area'
  | 'single_choice'
  | 'multi_choice'
  | 'dropdown'
  | 'date'
  | 'image'
  | 'opt_in'
  | 'link';

export interface FormComponent {
  id: string;
  type: FormComponentType;
  key?: string;
  label?: string;
  text?: string;
  required?: boolean;
  inputType?: 'text' | 'email' | 'phone' | 'number' | 'password' | 'passcode';
  helperText?: string;
  options?: { id: string; title: string }[];
  /** Base64 image data without the data: prefix. */
  image?: string;
  height?: number;
  url?: string;
  saveTo?: string | null;
}

export interface FormScreen {
  id: string;
  title: string;
  footerLabel: string;
  components: FormComponent[];
}

export const FORM_CATEGORIES = ['SIGN_UP', 'SIGN_IN', 'APPOINTMENT_BOOKING', 'LEAD_GENERATION', 'CONTACT_US', 'CUSTOMER_SUPPORT', 'SURVEY', 'OTHER'] as const;
export type FormCategory = (typeof FORM_CATEGORIES)[number];

export interface WaForm {
  id: string;
  name: string;
  status: 'draft' | 'published' | 'failed';
  category: FormCategory;
  screens: FormScreen[];
  /** Imported Flow JSON the builder can't edit visually. */
  rawFlowJson: Record<string, unknown> | null;
  providerFlowId: string | null;
  intro: string;
  ctaText: string;
  screenTitle: string;
  submitLabel: string;
  successMessage: string;
  fields: FormField[];
  version: number;
  publishError: string | null;
  publishedAt: string | null;
  hasUnpublishedChanges: boolean;
  submissions?: number;
  updatedAt: string;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  hint: string;
  scopes: string[];
  state: 'active' | 'revoked' | 'expired';
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  rolled: boolean;
}

export interface WebhookInfo {
  id: string;
  url: string;
  description: string;
  events: string[];
  status: 'active' | 'paused' | 'disabled';
  disabledReason: string | null;
  consecutiveFailures: number;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: 'succeeded' | 'failed' | null;
  secretRotating: boolean;
  createdAt: string;
}

export interface WebhookDeliveryInfo {
  id: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'retrying' | 'succeeded' | 'dead';
  attempts: { at: string; statusCode: number | null; durationMs: number; error: string | null; responseSnippet: string | null }[];
  nextAttemptAt: string | null;
  createdAt: string;
  payload: unknown;
}

export interface DeveloperCatalog {
  apiVersion: string;
  scopes: { id: string; description: string }[];
  events: { id: string; description: string }[];
}

export interface PlanInfo {
  code: string;
  name: string;
  description: string;
  currency: string;
  priceMonthly: number;
  priceYearly: number;
  limits: Record<LimitKey, number | null>;
  features: Record<FeatureKey, boolean>;
  trialDays: number;
  graceDays: number;
  isPublic: boolean;
  purchasable: { monthly: boolean; yearly: boolean };
}

export interface SubscriptionInfo {
  planCode: string;
  status: SubscriptionStatus;
  access: boolean;
  cycle: 'monthly' | 'yearly';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  endedAt: string | null;
  provider: 'razorpay' | 'sandbox' | 'manual' | 'none';
  pending: { planCode: string; cycle: string; checkoutUrl: string; createdAt: string } | null;
  lastPaymentAt: string | null;
}

export interface InvoiceInfo {
  id: string;
  number: string;
  planCode: string;
  cycle: string;
  amount: number;
  currency: string;
  status: 'paid' | 'failed';
  periodStart: string | null;
  periodEnd: string | null;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface BillingOverview {
  subscription: SubscriptionInfo;
  plan: PlanInfo;
  usage: Record<Exclude<LimitKey, 'apiRequestsPerMinute'>, number> & { apiRequests: number };
  plans: PlanInfo[];
  provider: 'razorpay' | 'sandbox';
  invoices: InvoiceInfo[];
}

export interface DurationStats {
  count: number;
  avgMs: number | null;
  medianMs: number | null;
}

export interface Analytics {
  range: { days: number; since: string; until: string; timezone: string };
  contacts: { total: number; new: number };
  messages: {
    inbound: number;
    outbound: Record<string, number>;
    deliveryRate: number | null;
    readRate: number | null;
    failureRate: number | null;
    daily: { day: string; inbound: number; outbound: number }[];
  };
  inbox: {
    openNow: number;
    pendingNow: number;
    unassignedOpen: number;
    resolved: number;
    firstResponse: DurationStats;
    resolution: DurationStats;
    agents: { userId: string; name: string; open: number; resolved: number; firstResponse: DurationStats }[];
  };
  campaigns: { id: string; name: string; status: string; launchedAt: string; total: number; delivered: number; read: number; replied: number; failed: number; skipped: number }[];
  automation: {
    flowId: string;
    name: string;
    started: number;
    completed: number;
    active: number;
    exited: number;
    failed: number;
    goals: number;
    dropOffs: { nodeId: string; type: string; label: string | null; status: string; count: number }[];
  }[];
  ai: { total: number; answered: number; handedOff: number; errors: number; resolvedRate: number | null; avgLatencyMs: number | null; inputTokens: number; outputTokens: number };
}

// ---- Auto replies (keyword triggers) ----

export type AutoReplyMatch = 'equals' | 'contains' | 'event';
export type AutoReplyEvent = 'first_message' | 'any_message';
export type MessageSource = 'ad' | 'broadcast' | 'direct';
export type AutoReplyActionType =
  | 'text'
  | 'file'
  | 'quick_reply'
  | 'cta_url'
  | 'form'
  | 'chatbot'
  | 'ai_chatbot'
  | 'location'
  | 'address'
  | 'template'
  | 'unsubscribe';

export interface AutoReplyAction {
  type: AutoReplyActionType;
  config: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- shape depends on type
}

export interface AutoReply {
  id: string;
  name: string;
  active: boolean;
  match: AutoReplyMatch;
  keywords: string[];
  event: AutoReplyEvent | null;
  sources: MessageSource[];
  cooldownMinutes: number;
  action: AutoReplyAction;
  firedCount: number;
  lastFiredAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TryResult {
  outcome: 'auto_reply' | 'flow' | 'ai' | 'none';
  matchedBy?: string | null;
  matchedKeyword?: string | null;
  autoReply: AutoReply | null;
  flow: { id: string; name: string } | null;
  notes: string[];
}

// ---- Contact lists (Broadcast) ----

export interface ContactList {
  id: string;
  name: string;
  count: number;
  tags: { id: string; name: string; color: TagColor }[];
  createdAt: string;
}

export interface ListImportReport {
  total: number;
  created: number;
  added: number;
  alreadyInList: number;
  invalid: { row: number; reason: string }[];
}

// ---- Audience ----

export type ChatSource = 'broadcast' | 'ad' | 'direct';
export type StageColor = 'green' | 'orange' | 'amber' | 'yellow' | 'blue' | 'indigo' | 'violet' | 'pink' | 'red' | 'teal' | 'gray';

export interface PipelineStage {
  id: string;
  key: string;
  name: string;
  color: StageColor;
  order: number;
  count?: number;
}

export interface CustomFieldDef {
  id: string;
  key: string;
  label: string;
  type: 'text' | 'number' | 'date';
  order: number;
}

export interface FollowUp {
  id: string;
  contactId: string;
  dueAt: string;
  note: string;
  assigneeId: string | null;
  status: 'open' | 'done';
  completedAt: string | null;
  createdAt: string;
  contact?: { id: string; name: string; phone: string } | null;
}

export interface AudienceRow extends Contact {
  owner: { id: string; name: string } | null;
  nextFollowUp: FollowUp | null;
  openFollowUps: number;
}

export interface AudienceQuery {
  q?: string;
  filter: Partial<AudienceFilter>;
  addedFrom?: string;
  addedTo?: string;
  consent?: ConsentStatus;
  followUp?: 'overdue' | 'today' | 'upcoming' | 'any' | 'none';
  sort: 'createdAt' | 'name' | 'phone' | 'stage' | 'lastInboundAt';
  dir: 'asc' | 'desc';
  page: number;
  limit: number;
}

// ---- Ticket / Task Board ----

export type TaskType = 'task' | 'ticket';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface TaskColumn {
  id: string;
  key: string;
  name: string;
  color: StageColor;
  order: number;
  isDone: boolean;
}

export interface BoardTask {
  id: string;
  number: number;
  type: TaskType;
  title: string;
  description: string;
  status: string;
  priority: TaskPriority;
  assignee: { id: string; name: string } | null;
  contact: { id: string; name: string; phone: string } | null;
  dueAt: string | null;
  position: number;
  completedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- Appointments ----

export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show';
export type AppointmentSource = 'ai_assistant' | 'flow' | 'manual' | 'api';

export interface Appointment {
  id: string;
  contact: { id: string; name: string; phone: string } | null;
  service: string;
  startAt: string;
  durationMinutes: number;
  status: AppointmentStatus;
  source: AppointmentSource;
  notes: string;
  assignee: { id: string; name: string } | null;
  createdAt: string;
}

// ---- Google Sheets integration ----

export interface SheetVariable {
  source: 'column' | 'static';
  value: string;
  fallback?: string | null;
}

export type SheetRowState = 'skipped' | 'waiting' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
export type SheetCounts = Record<SheetRowState, number> & { messages: number };

export interface SheetCampaign {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'paused';
  /** What the list shows: `error` when the last check failed. */
  state: 'draft' | 'active' | 'paused' | 'error';
  step: 'start' | 'link' | 'connect' | 'select' | 'map' | 'settings';
  sheetUrl: string;
  spreadsheetTitle: string;
  access: 'link' | 'google';
  googleAccount: { id: string; email: string } | null;
  tab: { gid: string; title: string } | null;
  headers: string[];
  phoneColumn: string | null;
  nameColumn: string | null;
  templateId: string | null;
  template: { id: string; name: string; category: string; language: string; status: string } | null;
  headerVariables: SheetVariable[];
  bodyVariables: SheetVariable[];
  buttonVariables: SheetVariable[];
  templateExtras: TemplateExtras | null;
  sendDelayMinutes: number;
  startFrom: 'new' | 'all';
  lastSyncAt: string | null;
  lastError: string | null;
  rowCount: number;
  invalidRows: number;
  waitingRows: number;
  counts: SheetCounts | null;
  createdAt: string;
}

export interface SheetSyncResult {
  rows: number;
  added: number;
  skipped: number;
  waiting: number;
  invalid: number;
  sent: number;
}

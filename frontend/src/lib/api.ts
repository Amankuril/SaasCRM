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
let onSessionExpired: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler;
}

export interface AuthPayload {
  user: User;
  accessToken: string;
}

/** Single-flight refresh so parallel 401s trigger only one /refresh call. */
export function refreshAccessToken(): Promise<string | null> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) return null;
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
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    const token = await refreshAccessToken();
    if (token) return request<T>(method, path, body, false);
    onSessionExpired?.();
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
  createdAt: string;
}

export interface ConnectionPayload {
  connection: WhatsAppConnection | null;
  webhook: { callbackUrl: string; configured: boolean };
  sandbox: boolean;
}

export interface TemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: string;
  text?: string;
  buttons?: { type: string; text: string; url?: string; phone_number?: string }[];
}

export interface MessageTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  rejectedReason: string | null;
  components: TemplateComponent[];
  variables: { header: number; body: number };
  syncedAt: string | null;
  updatedAt: string;
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

export type LifecycleStage = 'new' | 'contacted' | 'qualified' | 'follow_up' | 'converted' | 'lost';
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
  lifecycleStage: LifecycleStage;
  ownerId: string | null;
  customFields: Record<string, string>;
  consent: { status: ConsentStatus; source: string | null; updatedAt: string | null };
  source: string | null;
  lastInboundAt: string | null;
  createdAt: string;
}

export type ConversationStatus = 'open' | 'pending' | 'resolved';

export interface ConversationSummary {
  id: string;
  status: ConversationStatus;
  priority: 'normal' | 'high';
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
  excludeTags: string[];
  stages: LifecycleStage[];
  requireOptIn: boolean;
}

export interface VariableSpec {
  source: 'static' | 'field';
  value: string;
  fallback: string;
}

export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  templateId: string | null;
  templateName: string | null;
  headerVariables: VariableSpec[];
  bodyVariables: VariableSpec[];
  audience: { type: 'all' | 'segment' | 'filter'; segmentId: string | null; filter: AudienceFilter };
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

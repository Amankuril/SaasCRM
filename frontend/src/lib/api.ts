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

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

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

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
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

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * Reading Google Sheets two ways:
 *  - "link": the sheet is shared as "Anyone with the link can view". Tabs come
 *    from the public HTML view and rows from the CSV export. No Google keys.
 *  - "google": a Google account connected with OAuth (read-only scope), read
 *    through the Sheets API. Needs GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
 */

export interface SheetTab {
  gid: string;
  title: string;
}

export interface SpreadsheetInfo {
  title: string;
  tabs: SheetTab[];
}

/** Either nothing (link sharing) or a fresh OAuth access token. */
export type SheetAuth = { mode: 'link' } | { mode: 'google'; accessToken: string };

export class SheetAccessError extends Error {
  constructor(
    public readonly code: 'NOT_SHARED' | 'NOT_FOUND' | 'GOOGLE_AUTH' | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}

export interface SheetsClient {
  info(spreadsheetId: string, auth: SheetAuth): Promise<SpreadsheetInfo>;
  /** Every row of a tab as strings, the first being the header row. */
  rows(spreadsheetId: string, tab: SheetTab, auth: SheetAuth): Promise<string[][]>;
}

/** Spreadsheet id (and tab gid, when present) from a Google Sheets link. */
export function parseSheetUrl(url: string): { spreadsheetId: string; gid: string | null } | null {
  const m = /docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{20,})/.exec(url);
  if (!m) return null;
  const gid = /[#?&]gid=(\d+)/.exec(url)?.[1] ?? null;
  return { spreadsheetId: m[1]!, gid };
}

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF), as Google exports it. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const DOCS = 'https://docs.google.com/spreadsheets/d';
const TIMEOUT_MS = 15_000;

async function get(url: string, headers: Record<string, string> = {}) {
  try {
    return await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new SheetAccessError('UNAVAILABLE', 'Google Sheets could not be reached. Try again in a minute.');
  }
}

const notShared = () =>
  new SheetAccessError('NOT_SHARED', 'This sheet is not shared. In Google Sheets click Share → General access → "Anyone with the link" (Viewer), or connect your Google account.');

/** Google answers private sheets with a sign-in page rather than an error code. */
const isSignInPage = (res: Response) => new URL(res.url).hostname === 'accounts.google.com' || res.status === 401 || res.status === 403;

const decodeJsString = (s: string) => s.replace(/\\x([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');

export const linkClient = {
  async info(spreadsheetId: string): Promise<SpreadsheetInfo> {
    const res = await get(`${DOCS}/${spreadsheetId}/htmlview`);
    if (res.status === 404) throw new SheetAccessError('NOT_FOUND', 'No Google Sheet was found at this link.');
    if (isSignInPage(res)) throw notShared();
    if (!res.ok) throw new SheetAccessError('UNAVAILABLE', `Google Sheets answered ${res.status}. Try again in a minute.`);
    const html = await res.text();
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]?.replace(/ - Google (Drive|Sheets)$/, '').trim() || 'Untitled spreadsheet';
    const tabs = [...html.matchAll(/items\.push\(\{name: "((?:[^"\\]|\\.)*)",[^}]*?gid: "(\d+)"/g)].map((m) => ({ title: decodeJsString(m[1]!), gid: m[2]! }));
    return { title: decodeHtml(title), tabs: tabs.length ? tabs : [{ gid: '0', title: 'Sheet1' }] };
  },
  async rows(spreadsheetId: string, tab: SheetTab): Promise<string[][]> {
    const res = await get(`${DOCS}/${spreadsheetId}/export?format=csv&gid=${tab.gid}`);
    if (res.status === 404) throw new SheetAccessError('NOT_FOUND', 'The sheet or tab no longer exists.');
    if (isSignInPage(res) || (res.headers.get('content-type') ?? '').includes('text/html')) throw notShared();
    if (!res.ok) throw new SheetAccessError('UNAVAILABLE', `Google Sheets answered ${res.status}. Try again in a minute.`);
    return parseCsv(await res.text());
  },
};

const decodeHtml = (s: string) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

async function apiGet<T>(url: string, accessToken: string): Promise<T> {
  const res = await get(url, { Authorization: `Bearer ${accessToken}` });
  if (res.status === 401) throw new SheetAccessError('GOOGLE_AUTH', 'Google access has expired. Reconnect your Google account.');
  if (res.status === 403) throw new SheetAccessError('NOT_SHARED', 'The connected Google account cannot open this sheet. Share it with that account or use another one.');
  if (res.status === 404) throw new SheetAccessError('NOT_FOUND', 'No Google Sheet was found at this link.');
  if (!res.ok) throw new SheetAccessError('UNAVAILABLE', `Google Sheets answered ${res.status}. Try again in a minute.`);
  return (await res.json()) as T;
}

export const apiClient = {
  async info(spreadsheetId: string, accessToken: string): Promise<SpreadsheetInfo> {
    const data = await apiGet<{ properties: { title: string }; sheets: { properties: { sheetId: number; title: string } }[] }>(
      `${API}/${spreadsheetId}?fields=properties.title,sheets.properties(sheetId,title)`,
      accessToken,
    );
    return { title: data.properties.title, tabs: data.sheets.map((s) => ({ gid: String(s.properties.sheetId), title: s.properties.title })) };
  },
  async rows(spreadsheetId: string, tab: SheetTab, accessToken: string): Promise<string[][]> {
    const range = encodeURIComponent(`'${tab.title.replace(/'/g, "''")}'`);
    const data = await apiGet<{ values?: unknown[][] }>(`${API}/${spreadsheetId}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`, accessToken);
    return (data.values ?? []).map((r) => r.map((v) => String(v ?? '')));
  },
};

const defaultClient: SheetsClient = {
  info: (id, auth) => (auth.mode === 'google' ? apiClient.info(id, auth.accessToken) : linkClient.info(id)),
  rows: (id, tab, auth) => (auth.mode === 'google' ? apiClient.rows(id, tab, auth.accessToken) : linkClient.rows(id, tab)),
};

let client: SheetsClient = defaultClient;
export const sheetsClient = () => client;
/** Tests swap in a fake; undefined restores the real one. */
export function setSheetsClient(c: SheetsClient | undefined) {
  client = c ?? defaultClient;
}

// ---- Google OAuth (read-only Sheets access) ----

export const googleOAuthConfigured = () => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
export const GOOGLE_REDIRECT_PATH = '/api/integrations/google/callback';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/spreadsheets.readonly'];

export interface OAuthState {
  workspaceId: string;
  userId: string;
  campaignId: string;
  exp: number;
}

const sign = (body: string) => createHmac('sha256', env.JWT_ACCESS_SECRET).update(`google-oauth:${body}`).digest('base64url');

/** Tamper-proof, 10-minute state for the OAuth round trip. */
export function encodeState(s: Omit<OAuthState, 'exp'>): string {
  const body = Buffer.from(JSON.stringify({ ...s, exp: Date.now() + 10 * 60_000 })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function decodeState(raw: string): OAuthState | null {
  const [body, mac] = raw.split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString()) as OAuthState;
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export function googleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: `${env.PUBLIC_API_URL}${GOOGLE_REDIRECT_PATH}`,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    // Always ask, so Google returns a refresh token even on a repeat connection.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID ?? '', client_secret: env.GOOGLE_CLIENT_SECRET ?? '', ...body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!res) throw new SheetAccessError('UNAVAILABLE', 'Google could not be reached. Try again in a minute.');
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) throw new SheetAccessError('GOOGLE_AUTH', data.error_description || 'Google did not accept the sign-in. Reconnect your Google account.');
  return data;
}

/** Exchanges the callback code; returns the refresh token and the account's email. */
export async function exchangeCode(code: string): Promise<{ refreshToken: string; email: string; accessToken: string; expiresIn: number }> {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: `${env.PUBLIC_API_URL}${GOOGLE_REDIRECT_PATH}` });
  if (!t.refresh_token) throw new SheetAccessError('GOOGLE_AUTH', 'Google did not grant offline access. Try connecting again.');
  // The id_token came straight from Google over TLS, so its payload is read without re-verifying.
  const payload = t.id_token ? (JSON.parse(Buffer.from(t.id_token.split('.')[1] ?? '', 'base64url').toString()) as { email?: string }) : {};
  return { refreshToken: t.refresh_token, email: payload.email ?? 'Google account', accessToken: t.access_token, expiresIn: t.expires_in };
}

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const t = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  return { accessToken: t.access_token, expiresIn: t.expires_in };
}

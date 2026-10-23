import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from './errors.js';

const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

/** True for loopback, private, link-local, CGNAT, multicast and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('ff');
}

async function assertPublicHost(url: URL, allowPrivate = false) {
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new AppError(400, 'UNSAFE_URL', 'Only https:// links are allowed.');
  if (url.username || url.password) throw new AppError(400, 'UNSAFE_URL', 'Links with credentials are not allowed.');
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new AppError(400, 'UNSAFE_URL', 'That website could not be found.');
  if (addresses.some(isPrivateAddress)) throw new AppError(400, 'UNSAFE_URL', 'That address points to a private network and cannot be used.');
}

/** Validates a customer-supplied outbound URL (webhook endpoint, flow HTTP step) before saving it. */
export async function assertSafeOutboundUrl(rawUrl: string, allowPrivate = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(400, 'UNSAFE_URL', 'Enter a valid URL.');
  }
  await assertPublicHost(url, allowPrivate);
  return url;
}

export interface SafeResponse {
  status: number;
  headers: Headers;
  /** First `maxBytes` of the body as text. */
  body: string;
  durationMs: number;
}

/**
 * Server-to-customer HTTP call (webhook deliveries, flow HTTP steps) with the same
 * SSRF guard as imports. Redirects are not followed: a 3xx is returned as is.
 * Network failures throw AppError('REQUEST_FAILED').
 */
export async function safeRequest(
  rawUrl: string,
  init: { method: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number; allowPrivate?: boolean },
): Promise<SafeResponse> {
  const url = await assertSafeOutboundUrl(rawUrl, init.allowPrivate);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: { 'User-Agent': 'ZetaConnect/1.0', ...init.headers },
      body: init.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError';
    throw new AppError(502, 'REQUEST_FAILED', timedOut ? 'The request timed out.' : 'Could not connect to the URL.');
  }
  const body = await readCapped(res, init.maxBytes ?? 100_000);
  return { status: res.status, headers: res.headers, body, durationMs: Date.now() - started };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
    if (size >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, maxBytes);
}

/**
 * Fetches a public web page for knowledge import, guarding against SSRF:
 * https only, every hop's host must resolve to public IPs, manual redirects,
 * a timeout and a size cap.
 */
export async function safeFetchText(rawUrl: string): Promise<{ finalUrl: string; contentType: string; body: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(400, 'UNSAFE_URL', 'Enter a valid URL.');
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'ZetaConnectKnowledgeBot/1.0', Accept: 'text/html,text/plain;q=0.9' },
    }).catch(() => {
      throw new AppError(400, 'FETCH_FAILED', 'Could not reach that website.');
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) throw new AppError(400, 'FETCH_FAILED', `The website responded with HTTP ${res.status}.`);
    const contentType = res.headers.get('content-type') ?? '';
    if (!/text\/(html|plain)/.test(contentType)) throw new AppError(400, 'FETCH_FAILED', 'Only web pages (HTML or plain text) can be imported.');

    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        break; // keep the first megabyte
      }
      chunks.push(value);
    }
    return { finalUrl: url.toString(), contentType, body: Buffer.concat(chunks).toString('utf8') };
  }
  throw new AppError(400, 'FETCH_FAILED', 'Too many redirects.');
}

/** Rough HTML-to-text: drops scripts/styles/markup, keeps readable text. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
  return { title: title ? htmlToText(title).text : null, text };
}

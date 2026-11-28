import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { FbApiLog } from './fbads.model.js';
import { sandboxTransport } from './fbads.sandbox.js';

/**
 * Meta Graph / Marketing API calls for Facebook Ads. One code path for the real
 * API and the in-memory sandbox (ADS_PROVIDER=sandbox): only the transport differs.
 * Every call is logged (fb_api_logs) and checked against Meta's rate-limit headers.
 */

export type Method = 'GET' | 'POST' | 'DELETE';
export interface GraphRequest {
  method: Method;
  path: string; // "/act_123/campaigns"
  params?: Record<string, unknown>;
  /** Multipart upload (videos). */
  file?: { field: string; data: Buffer; mimeType: string; fileName: string };
}
export interface GraphResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
export type Transport = (token: string | null, req: GraphRequest) => Promise<GraphResponse>;

export type FbErrorKind = 'auth' | 'rate_limit' | 'permanent' | 'transient';

export class FbError extends Error {
  constructor(
    message: string,
    public readonly kind: FbErrorKind,
    public readonly code: number | null = null,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'FbError';
  }
}

const TIMEOUT_MS = 30_000;
const BASE = () => `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;

const metaTransport: Transport = async (token, req) => {
  const url = new URL(`${BASE()}${req.path}`);
  const init: RequestInit = { method: req.method, signal: AbortSignal.timeout(req.file ? 300_000 : TIMEOUT_MS), headers: {} };
  if (token) (init.headers as Record<string, string>).Authorization = `Bearer ${token}`;
  const flat = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  if (req.method === 'GET' || req.method === 'DELETE') {
    for (const [k, v] of Object.entries(req.params ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, flat(v));
  } else if (req.file) {
    const form = new FormData();
    for (const [k, v] of Object.entries(req.params ?? {})) if (v !== undefined && v !== null) form.set(k, flat(v));
    form.set(req.file.field, new Blob([req.file.data], { type: req.file.mimeType }), req.file.fileName);
    init.body = form;
  } else {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(req.params ?? {});
  }
  const res = await fetch(url, init);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: res.status, headers, body: await res.json().catch(() => ({})) };
};

let override: Transport | null = null;
/** Tests: swap the transport. */
export function setAdsTransport(t: Transport | null): void {
  override = t;
}
const transport = (): Transport => override ?? (env.ADS_PROVIDER === 'sandbox' ? sandboxTransport : metaTransport);

/**
 * Highest usage % Meta reports for this app / ad account. Above 80 we stop and
 * come back later instead of getting throttled.
 */
function usage(headers: Record<string, string>): { pct: number; regainMs: number } {
  let pct = 0;
  let regainMs = 0;
  const read = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      const rows = Object.values(data).flatMap((v) => (Array.isArray(v) ? v : [v])) as Record<string, number>[];
      for (const r of [data as Record<string, number>, ...rows]) {
        for (const k of ['call_count', 'total_cputime', 'total_time', 'acc_id_util_pct']) if (typeof r?.[k] === 'number') pct = Math.max(pct, r[k]!);
        if (typeof r?.estimated_time_to_regain_access === 'number') regainMs = Math.max(regainMs, r.estimated_time_to_regain_access * 60_000);
      }
    } catch {
      /* ignore malformed header */
    }
  };
  read(headers['x-business-use-case-usage']);
  read(headers['x-app-usage']);
  read(headers['x-ad-account-usage']);
  return { pct, regainMs };
}

const RATE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);

function classify(status: number, code: number | null): FbErrorKind {
  if (code === 190 || code === 102 || code === 463 || code === 467 || status === 401) return 'auth';
  if ((code !== null && RATE_CODES.has(code)) || status === 429) return 'rate_limit';
  if (status >= 500 || code === 1 || code === 2) return 'transient';
  return 'permanent';
}

export interface CallContext {
  workspaceId: Types.ObjectId;
  token: string | null;
}

/** One Graph call. Throws FbError with Meta's own message in plain words. */
export async function graph<T = Record<string, unknown>>(ctx: CallContext, req: GraphRequest): Promise<T> {
  const started = Date.now();
  let res: GraphResponse;
  try {
    res = await transport()(ctx.token, req);
  } catch (err) {
    await logCall(ctx, req, null, (err as Error).message, Date.now() - started);
    throw new FbError(`Could not reach Facebook: ${(err as Error).message}`, 'transient');
  }
  const body = (res.body ?? {}) as { error?: { message?: string; error_user_msg?: string; error_user_title?: string; code?: number; error_subcode?: number } };
  const failed = res.status >= 400 || !!body.error;
  const message = failed ? body.error?.error_user_msg || body.error?.message || `Facebook error (HTTP ${res.status})` : null;
  await logCall(ctx, req, res.status, message, Date.now() - started);
  if (failed) {
    const code = body.error?.code ?? null;
    const kind = classify(res.status, code);
    throw new FbError(message!, kind, code, kind === 'rate_limit' ? usage(res.headers).regainMs || 60_000 : null);
  }
  const u = usage(res.headers);
  if (u.pct > 80) throw new FbError(`Facebook asks us to slow down (${Math.round(u.pct)}% of the limit used).`, 'rate_limit', null, u.regainMs || 60_000);
  return res.body as T;
}

/** Follows `paging.next` cursors until every row is read. */
export async function graphAll<T>(ctx: CallContext, path: string, params: Record<string, unknown>, max = 5000): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < 200 && out.length < max; page++) {
    const res = await graph<{ data?: T[]; paging?: { cursors?: { after?: string }; next?: string } }>(ctx, { method: 'GET', path, params: { limit: 100, ...params, ...(after ? { after } : {}) } });
    out.push(...(res.data ?? []));
    after = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

async function logCall(ctx: CallContext, req: GraphRequest, httpStatus: number | null, error: string | null, durationMs: number) {
  try {
    await FbApiLog.create({ workspaceId: ctx.workspaceId, endpoint: req.path.slice(0, 300), method: req.method, httpStatus, error: error?.slice(0, 500) ?? null, durationMs });
  } catch (err) {
    logger.warn({ err }, 'Could not write Facebook API log');
  }
}

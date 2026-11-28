import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { enqueue } from '../../jobs/queue.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { AppError, badRequest, conflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { Contact } from '../contacts/contact.model.js';
import { FbError, graph, graphAll, type CallContext } from './fbads.graph.js';
import { FbConnection, FbEntity, type FbConnectionDoc, type FbKind } from './fbads.model.js';

export const SCOPES = ['ads_management', 'ads_read', 'business_management', 'leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_metadata'];
const AUTO_SYNC_MS = 6 * 3_600_000;

// ---- OAuth state (signed, no storage) ----

const stateKey = () => createHash('sha256').update(`fbads-oauth-state:${env.ENCRYPTION_KEY}`).digest();

export function signState(workspaceId: string, userId: string): string {
  const payload = Buffer.from(JSON.stringify({ w: workspaceId, u: userId, n: randomBytes(8).toString('hex'), e: Date.now() + 15 * 60_000 })).toString('base64url');
  const sig = createHmac('sha256', stateKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function readState(state: string): { workspaceId: string; userId: string } | null {
  const [payload, sig] = state.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', stateKey()).update(payload).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { w: string; u: string; e: number };
  if (data.e < Date.now()) return null;
  return { workspaceId: data.w, userId: data.u };
}

export const redirectUri = () => `${env.PUBLIC_API_URL}/api/facebook-ads/oauth/callback`;

/** Where "Connect Facebook" sends the browser. In the sandbox, straight to our callback. */
export function authorizeUrl(workspaceId: string, userId: string): string {
  const state = signState(workspaceId, userId);
  if (env.ADS_PROVIDER === 'sandbox') return `${redirectUri()}?code=sandbox&state=${encodeURIComponent(state)}`;
  if (!env.META_APP_ID || !env.META_APP_SECRET) throw new AppError(503, 'FB_NOT_CONFIGURED', 'Facebook login is not set up on this server yet (Meta app id and secret).');
  const url = new URL(`https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', env.META_APP_ID);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  if (env.META_ADS_CONFIG_ID) url.searchParams.set('config_id', env.META_ADS_CONFIG_ID);
  else url.searchParams.set('scope', SCOPES.join(','));
  return url.toString();
}

/** Code -> long-lived token; the connection waits for an ad account to be picked. */
export async function completeOAuth(workspaceId: Types.ObjectId, userId: Types.ObjectId, code: string): Promise<void> {
  const ctx: CallContext = { workspaceId, token: null };
  const short = await graph<{ access_token: string }>(ctx, {
    method: 'GET',
    path: '/oauth/access_token',
    params: { client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, redirect_uri: redirectUri(), code },
  });
  const long = await graph<{ access_token: string; expires_in?: number }>(ctx, {
    method: 'GET',
    path: '/oauth/access_token',
    params: { grant_type: 'fb_exchange_token', client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, fb_exchange_token: short.access_token },
  });
  const me = await graph<{ id: string; name?: string }>({ workspaceId, token: long.access_token }, { method: 'GET', path: '/me', params: { fields: 'id,name' } });
  const conn = (await FbConnection.findOne({ workspaceId })) ?? new FbConnection({ workspaceId });
  conn.set({
    status: conn.adAccountId && conn.status !== 'disconnected' ? 'connected' : 'pending',
    fbUserId: me.id,
    fbUserName: me.name ?? null,
    accessTokenEnc: encryptSecret(long.access_token),
    tokenExpiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null,
    lastError: null,
    connectedBy: userId,
    connectedAt: new Date(),
    disconnectedAt: null,
  });
  // A reconnect after a disconnect starts again from picking the account.
  if (conn.isModified('status') && conn.status === 'pending') conn.adAccountId = null;
  await conn.save();
}

// ---- connection helpers ----

export async function loadConnection(workspaceId: Types.ObjectId): Promise<FbConnectionDoc | null> {
  return FbConnection.findOne({ workspaceId }).select('+accessTokenEnc');
}

export function tokenOf(conn: FbConnectionDoc): string {
  if (!conn.accessTokenEnc) throw conflict('FB_NOT_CONNECTED', 'Connect Facebook first.');
  return decryptSecret(conn.accessTokenEnc);
}

/** For reads and writes on the ad account: connected and working. */
export async function requireConnection(workspaceId: Types.ObjectId): Promise<{ conn: FbConnectionDoc; ctx: CallContext; account: string }> {
  const conn = await loadConnection(workspaceId);
  if (!conn || conn.status === 'disconnected' || !conn.accessTokenEnc) throw conflict('FB_NOT_CONNECTED', 'Connect Facebook first.');
  if (conn.status === 'error') throw conflict('FB_RECONNECT', 'The Facebook connection stopped working. Reconnect Facebook to continue.');
  if (!conn.adAccountId) throw conflict('FB_NO_AD_ACCOUNT', 'Choose an ad account first.');
  return { conn, ctx: { workspaceId, token: tokenOf(conn) }, account: conn.adAccountId };
}

/** Turns a Meta error into an API error; an expired token flips the connection to "reconnect". */
export async function asAppError(workspaceId: Types.ObjectId, err: unknown, doing: string): Promise<never> {
  if (err instanceof FbError) {
    if (err.kind === 'auth') {
      await FbConnection.updateOne({ workspaceId }, { status: 'error', lastError: err.message });
      throw new AppError(409, 'FB_RECONNECT', `Facebook rejected the login: ${err.message} Reconnect Facebook to continue.`);
    }
    if (err.kind === 'rate_limit') throw new AppError(429, 'FB_RATE_LIMITED', `Facebook is limiting requests right now. Try again in a few minutes. (${err.message})`);
    throw new AppError(err.kind === 'transient' ? 502 : 422, 'FB_ERROR', `${doing}: ${err.message}`);
  }
  throw err;
}

export interface AdAccountInfo {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  status: number;
}

export async function listAdAccounts(workspaceId: Types.ObjectId): Promise<AdAccountInfo[]> {
  const conn = await loadConnection(workspaceId);
  if (!conn?.accessTokenEnc || conn.status === 'disconnected') throw conflict('FB_NOT_CONNECTED', 'Connect Facebook first.');
  try {
    const rows = await graphAll<{ id: string; name: string; currency: string; timezone_name: string; account_status: number }>({ workspaceId, token: tokenOf(conn) }, '/me/adaccounts', {
      fields: 'id,name,currency,timezone_name,account_status',
    });
    return rows.map((r) => ({ id: r.id, name: r.name, currency: r.currency, timezone: r.timezone_name, status: r.account_status }));
  } catch (err) {
    return asAppError(workspaceId, err, 'Could not list your ad accounts');
  }
}

export async function selectAdAccount(workspaceId: Types.ObjectId, adAccountId: string): Promise<FbConnectionDoc> {
  const conn = await loadConnection(workspaceId);
  if (!conn?.accessTokenEnc || conn.status === 'disconnected') throw conflict('FB_NOT_CONNECTED', 'Connect Facebook first.');
  const accounts = await listAdAccounts(workspaceId);
  const chosen = accounts.find((a) => a.id === adAccountId);
  if (!chosen) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { adAccountId: ['This ad account is not available to your Facebook login.'] });
  conn.set({ adAccountId: chosen.id, adAccountName: chosen.name, currency: chosen.currency, timezone: chosen.timezone, accountStatus: chosen.status, status: 'connected', lastError: null, lastVerifiedAt: new Date() });
  await conn.save();
  await queueSync(workspaceId);
  return conn;
}

/** "Verify connection": reads the account status and name from Meta. */
export async function verifyConnection(workspaceId: Types.ObjectId): Promise<FbConnectionDoc> {
  const conn = await loadConnection(workspaceId);
  if (!conn?.accessTokenEnc || !conn.adAccountId || conn.status === 'disconnected') throw conflict('FB_NOT_CONNECTED', 'Connect Facebook first.');
  try {
    const info = await graph<{ name: string; account_status: number }>({ workspaceId, token: tokenOf(conn) }, { method: 'GET', path: `/${conn.adAccountId}`, params: { fields: 'account_status,name' } });
    conn.set({ adAccountName: info.name, accountStatus: info.account_status, status: 'connected', lastError: null, lastVerifiedAt: new Date() });
    await conn.save();
    return conn;
  } catch (err) {
    return asAppError(workspaceId, err, 'Could not verify the connection');
  }
}

/** Soft disconnect: the token is wiped, synced data is kept (and hidden until reconnected). */
export async function disconnect(workspaceId: Types.ObjectId): Promise<void> {
  await FbConnection.updateOne({ workspaceId }, { status: 'disconnected', accessTokenEnc: null, tokenExpiresAt: null, disconnectedAt: new Date(), 'sync.status': 'idle' });
}

// ---- sync ----

export async function queueSync(workspaceId: Types.ObjectId): Promise<boolean> {
  const res = await FbConnection.updateOne({ workspaceId, status: 'connected', 'sync.status': { $nin: ['queued', 'running'] } }, { 'sync.status': 'queued', 'sync.error': null });
  if (!res.modifiedCount) return false;
  await enqueue('fbads.sync', { workspaceId: String(workspaceId) });
  return true;
}

const EDGE: Record<FbKind, { path: string; fields: string }> = {
  campaign: { path: 'campaigns', fields: 'id,name,objective,buying_type,status,effective_status,daily_budget,lifetime_budget,special_ad_categories,updated_time' },
  adset: { path: 'adsets', fields: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,targeting,start_time,end_time,updated_time' },
  ad: { path: 'ads', fields: 'id,name,adset_id,campaign_id,creative{id},status,effective_status,ad_review_feedback,updated_time' },
  creative: { path: 'adcreatives', fields: 'id,name,object_type,thumbnail_url,title,body,call_to_action_type,object_story_spec' },
  audience: { path: 'customaudiences', fields: 'id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,time_updated' },
  pixel: { path: 'adspixels', fields: 'id,name,last_fired_time' },
};

const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));
const date = (v: unknown) => (v ? new Date(typeof v === 'number' ? v * 1000 : String(v)) : null);

export function targetingSummary(t: unknown): string | null {
  if (!t || typeof t !== 'object') return null;
  const x = t as { geo_locations?: { countries?: string[]; cities?: { name: string }[]; regions?: { name: string }[] }; age_min?: number; age_max?: number; genders?: number[]; flexible_spec?: { interests?: { name: string }[] }[] };
  const where = [...(x.geo_locations?.cities ?? []).map((c) => c.name), ...(x.geo_locations?.regions ?? []).map((r) => r.name), ...(x.geo_locations?.countries ?? [])].slice(0, 3).join(', ');
  const age = x.age_min || x.age_max ? `${x.age_min ?? 18}-${x.age_max ?? 65}` : null;
  const gender = x.genders?.length === 1 ? (x.genders[0] === 1 ? 'men' : 'women') : null;
  const interests = (x.flexible_spec ?? []).flatMap((f) => f.interests ?? []).map((i) => i.name);
  return [where, age, gender, interests.length ? `${interests.length} interest${interests.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || null;
}

/** Meta row -> our columns (kind-specific). */
export function mapRow(kind: FbKind, r: Record<string, unknown>) {
  const base = { name: String(r.name ?? ''), status: (r.status as string) ?? null, effectiveStatus: (r.effective_status as string) ?? null, metaUpdatedAt: date(r.updated_time ?? r.time_updated), raw: r };
  switch (kind) {
    case 'campaign':
      return { ...base, objective: (r.objective as string) ?? null, buyingType: (r.buying_type as string) ?? null, dailyBudget: num(r.daily_budget), lifetimeBudget: num(r.lifetime_budget) };
    case 'adset':
      return { ...base, campaignMetaId: (r.campaign_id as string) ?? null, dailyBudget: num(r.daily_budget), lifetimeBudget: num(r.lifetime_budget), optimizationGoal: (r.optimization_goal as string) ?? null, billingEvent: (r.billing_event as string) ?? null, targetingSummary: targetingSummary(r.targeting) };
    case 'ad': {
      const eff = String(r.effective_status ?? '');
      const review = eff === 'DISAPPROVED' ? 'Rejected' : eff === 'PENDING_REVIEW' || eff === 'IN_PROCESS' ? 'In review' : eff === 'WITH_ISSUES' ? 'With issues' : 'Approved';
      return { ...base, adsetMetaId: (r.adset_id as string) ?? null, campaignMetaId: (r.campaign_id as string) ?? null, creativeMetaId: ((r.creative as { id?: string })?.id as string) ?? null, reviewStatus: review };
    }
    case 'creative':
      return { ...base, status: 'ACTIVE', creativeType: (r.object_type as string) ?? null, thumbnailUrl: (r.thumbnail_url as string) ?? null, headline: (r.title as string) ?? null, callToAction: (r.call_to_action_type as string) ?? null };
    case 'audience':
      return { ...base, status: 'ACTIVE', subtype: (r.subtype as string) ?? null, approxCount: num(r.approximate_count_upper_bound) ?? num(r.approximate_count_lower_bound) };
    case 'pixel':
      return { ...base, status: 'ACTIVE', lastFiredAt: date(r.last_fired_time) };
  }
}

export async function upsertEntity(workspaceId: Types.ObjectId, account: string, kind: FbKind, row: Record<string, unknown>, syncedAt = new Date()) {
  await FbEntity.updateOne({ workspaceId, adAccountId: account, kind, metaId: String(row.id) }, { $set: { ...mapRow(kind, row), syncedAt, deletedAt: null } }, { upsert: true });
}

/**
 * Pulls every campaign, ad set, ad, creative, audience and pixel (with paging)
 * and upserts them by Meta id; rows Meta no longer returns are marked deleted.
 * Rate limits pause the sync and retry later.
 */
export async function runSync(workspaceId: Types.ObjectId): Promise<void> {
  const conn = await loadConnection(workspaceId);
  if (!conn || conn.status !== 'connected' || !conn.adAccountId || !conn.accessTokenEnc) return;
  const account = conn.adAccountId;
  const ctx: CallContext = { workspaceId, token: tokenOf(conn) };
  const started = new Date();
  await FbConnection.updateOne({ workspaceId }, { 'sync.status': 'running', 'sync.startedAt': started, 'sync.error': null });
  const counts: Record<string, number> = {};
  try {
    for (const kind of Object.keys(EDGE) as FbKind[]) {
      const rows = await graphAll<Record<string, unknown>>(ctx, `/${account}/${EDGE[kind].path}`, { fields: EDGE[kind].fields });
      for (const row of rows) await upsertEntity(workspaceId, account, kind, row, started);
      await FbEntity.updateMany({ workspaceId, adAccountId: account, kind, deletedAt: null, $or: [{ syncedAt: { $lt: started } }, { syncedAt: null }] }, { deletedAt: new Date(), effectiveStatus: 'DELETED' });
      counts[kind] = rows.length;
    }
    await FbConnection.updateOne({ workspaceId }, { 'sync.status': 'idle', 'sync.finishedAt': new Date(), 'sync.counts': counts });
  } catch (err) {
    if (err instanceof FbError && err.kind === 'rate_limit') {
      await FbConnection.updateOne({ workspaceId }, { 'sync.status': 'queued', 'sync.error': 'Waiting: Facebook rate limit' });
      await enqueue('fbads.sync', { workspaceId: String(workspaceId) }, { delayMs: err.retryAfterMs ?? 60_000, jobId: `fbsync-${workspaceId}-${Date.now()}` });
      return;
    }
    if (err instanceof FbError && err.kind === 'auth') await FbConnection.updateOne({ workspaceId }, { status: 'error', lastError: err.message });
    await FbConnection.updateOne({ workspaceId }, { 'sync.status': 'failed', 'sync.finishedAt': new Date(), 'sync.error': (err as Error).message.slice(0, 300) });
    logger.warn({ err, workspaceId: String(workspaceId) }, 'Facebook ads sync failed');
  }
}

/** Hourly: connections not synced in 6 hours get a sync. */
export async function autoSync(): Promise<void> {
  const due = await FbConnection.find({
    status: 'connected',
    adAccountId: { $ne: null },
    'sync.status': { $nin: ['queued', 'running'] },
    $or: [{ 'sync.finishedAt': null }, { 'sync.finishedAt': { $lt: new Date(Date.now() - AUTO_SYNC_MS) } }],
  })
    .select('workspaceId')
    .setOptions({ skipTenantScope: true })
    .lean();
  for (const c of due) await queueSync(c.workspaceId);
}

// ---- writes ----

/** Creates on Meta, then reads the new object back and stores it locally. */
export async function createAndStore(workspaceId: Types.ObjectId, kind: FbKind, params: Record<string, unknown>, doing: string): Promise<string> {
  const { ctx, account } = await requireConnection(workspaceId);
  try {
    const res = await graph<{ id: string }>(ctx, { method: 'POST', path: `/${account}/${EDGE[kind].path}`, params });
    await refreshEntity(workspaceId, kind, res.id);
    return res.id;
  } catch (err) {
    return asAppError(workspaceId, err, doing);
  }
}

export async function refreshEntity(workspaceId: Types.ObjectId, kind: FbKind, metaId: string): Promise<void> {
  const { ctx, account } = await requireConnection(workspaceId);
  const row = await graph<Record<string, unknown>>(ctx, { method: 'GET', path: `/${metaId}`, params: { fields: EDGE[kind].fields } });
  await upsertEntity(workspaceId, account, kind, row);
}

export async function updateEntity(workspaceId: Types.ObjectId, kind: FbKind, metaId: string, params: Record<string, unknown>, doing: string): Promise<void> {
  const { ctx } = await requireConnection(workspaceId);
  try {
    await graph(ctx, { method: 'POST', path: `/${metaId}`, params });
    await refreshEntity(workspaceId, kind, metaId);
  } catch (err) {
    await asAppError(workspaceId, err, doing);
  }
}

export async function duplicateEntity(workspaceId: Types.ObjectId, kind: 'campaign' | 'adset' | 'ad', metaId: string): Promise<string> {
  const { ctx } = await requireConnection(workspaceId);
  try {
    const res = await graph<Record<string, string>>(ctx, { method: 'POST', path: `/${metaId}/copies`, params: { status_option: 'PAUSED', ...(kind === 'ad' ? {} : { deep_copy: false }) } });
    const id = res.copied_campaign_id ?? res.copied_adset_id ?? res.copied_ad_id ?? res.ad_object_ids;
    if (id) await refreshEntity(workspaceId, kind, String(id));
    return String(id ?? '');
  } catch (err) {
    return asAppError(workspaceId, err, 'Could not duplicate it');
  }
}

export async function deleteEntity(workspaceId: Types.ObjectId, kind: FbKind, metaId: string): Promise<void> {
  const { ctx, account } = await requireConnection(workspaceId);
  try {
    await graph(ctx, { method: 'DELETE', path: `/${metaId}` });
  } catch (err) {
    await asAppError(workspaceId, err, 'Could not delete it');
  }
  await FbEntity.updateOne({ workspaceId, adAccountId: account, kind, metaId }, { deletedAt: new Date(), status: 'DELETED', effectiveStatus: 'DELETED' });
}

// ---- audiences ----

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

/** Meta's hashing rules: phone = digits with country code, email = trimmed lowercase. */
export function hashContact(phoneE164: string, email: string | null): [string, string] {
  return [sha(phoneE164.replace(/\D/g, '')), email ? sha(email.trim().toLowerCase()) : ''];
}

/** Custom audience from Zeta contacts (optionally a tag or list); only hashes leave Zeta Connect. */
export async function createCustomAudience(workspaceId: Types.ObjectId, input: { name: string; tagId?: string | null; listId?: string | null }): Promise<{ id: string; uploaded: number }> {
  const filter: Record<string, unknown> = { workspaceId, 'consent.status': { $ne: 'opted_out' } };
  if (input.tagId) filter.tags = new Types.ObjectId(input.tagId);
  if (input.listId) filter.lists = new Types.ObjectId(input.listId);
  const contacts = await Contact.find(filter).select('phoneE164 email').limit(500_000).lean();
  if (!contacts.length) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { tagId: ['No contacts to upload for this choice.'] });
  const id = await createAndStore(workspaceId, 'audience', { name: input.name, subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY', description: 'Uploaded from Zeta Connect' }, 'Could not create the audience');
  const { ctx } = await requireConnection(workspaceId);
  let uploaded = 0;
  try {
    for (let i = 0; i < contacts.length; i += 10_000) {
      const batch = contacts.slice(i, i + 10_000).map((c) => hashContact(c.phoneE164, c.email ?? null));
      const res = await graph<{ num_received?: number }>(ctx, { method: 'POST', path: `/${id}/users`, params: { payload: { schema: ['PHONE', 'EMAIL'], data: batch } } });
      uploaded += res.num_received ?? batch.length;
    }
    await refreshEntity(workspaceId, 'audience', id);
  } catch (err) {
    await asAppError(workspaceId, err, 'The audience was created but uploading contacts failed');
  }
  return { id, uploaded };
}

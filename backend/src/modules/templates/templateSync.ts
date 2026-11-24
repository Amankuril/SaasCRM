import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { enqueue } from '../../jobs/queue.js';
import { publish } from '../../realtime/bus.js';
import { ProviderConnection, type ConnectionDoc } from '../whatsapp/connection.model.js';
import { credentialsOf, getConnection, markConnectionAuthError, providerToAppError } from '../whatsapp/connection.service.js';
import { ProviderError, whatsappProvider, type ProviderTemplate, type TemplateCategoryEvent, type TemplateChangedEvent, type TemplateStatusEvent } from '../whatsapp/provider/index.js';
import { MessageTemplate, type TemplateDoc } from './template.model.js';

/**
 * Keeps local templates equal to what Meta says, three ways:
 *  1. webhooks (`message_template_status_update`) within seconds of a decision,
 *  2. a background reconcile that re-reads the Graph API while anything is in review,
 *  3. the manual "Sync" button.
 * A status is only ever written from something Meta reported.
 */

/** Webhook `event` values that are themselves a template status. */
const STATUS_EVENTS = new Set(['APPROVED', 'REJECTED', 'PENDING', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED', 'LOCKED', 'ARCHIVED']);
/** Statuses Meta is still going to change on its own. */
export const IN_REVIEW = ['PENDING', 'IN_APPEAL', 'PENDING_DELETION'];

const HISTORY_LIMIT = 20;
/** Meta's list can lag a moment behind a create: don't treat a brand-new template as deleted. */
const FRESH_MS = 10 * 60_000;
const LOCK_MS = 2 * 60_000;

const MINUTE = 60_000;
export const SYNC_INTERVALS = {
  /** Something was submitted recently and is still in review. */
  reviewing: 2 * MINUTE,
  /** In review for hours. */
  reviewingSlow: 10 * MINUTE,
  /** Nothing in review: catches pauses, disables and edits made in Meta. */
  idle: 60 * MINUTE,
};

export type SyncSource = 'manual' | 'reconcile' | 'webhook' | 'connect';
type StatusSource = SyncSource | 'submit';

const normalizeStatus = (s: string) => s.trim().toUpperCase();

/** Applies a Meta-confirmed status to a document (in memory) and records the change. */
export function setStatus(template: TemplateDoc, status: string, source: StatusSource, reason: string | null = null, now = new Date()): boolean {
  const next = normalizeStatus(status);
  const changed = template.status !== next || (template.rejectedReason ?? null) !== reason;
  if (template.status !== next) {
    template.statusUpdatedAt = now;
    const history = [...(template.statusHistory as unknown as { status: string; at: Date; source: string; reason: string | null }[]), { status: next, at: now, source, reason }];
    template.set('statusHistory', history.slice(-HISTORY_LIMIT));
  }
  template.status = next;
  template.rejectedReason = reason;
  return changed;
}

export interface SyncResult {
  synced: number;
  added: number;
  updated: number;
  removed: number;
}

/** What went wrong, in words the business owner can act on. */
export function describeSyncError(err: unknown, conn: Pick<ConnectionDoc, 'wabaId'>): { code: string; message: string } {
  if (err instanceof ProviderError) {
    const code = err.code ?? err.kind;
    if (err.kind === 'auth') return { code, message: 'Meta rejected the access token (expired or revoked). Reconnect WhatsApp to continue.' };
    if (code === '10' || code === '200' || code === '294' || code === '3')
      return { code, message: `The connected token does not have the "whatsapp_business_management" permission for WhatsApp Business Account ${conn.wabaId}. Reconnect WhatsApp and allow template management. Meta said: ${err.message}` };
    if (code === '100' || code === '803')
      return { code, message: `Meta could not open WhatsApp Business Account ${conn.wabaId} with this token. Check that the WABA ID is the account that owns your templates. Meta said: ${err.message}` };
    if (err.kind === 'rate_limit') return { code, message: 'Meta is rate limiting requests for this account. The next automatic check will retry.' };
    if (err.kind === 'transient') return { code, message: `Meta could not be reached. The next automatic check will retry. (${err.message})` };
    return { code, message: err.message };
  }
  return { code: 'SYNC_FAILED', message: (err as Error)?.message || 'Template sync failed.' };
}

/**
 * Reads every template from Meta and mirrors it locally. Throws an AppError when
 * Meta cannot be read; the failure is also stored on the connection so the UI can
 * say the statuses may be out of date.
 */
export async function syncTemplates(workspaceId: Types.ObjectId, conn: ConnectionDoc, source: SyncSource = 'manual'): Promise<SyncResult> {
  const startedAt = new Date();
  // One sync per account at a time: overlapping runs could undo each other's changes.
  const lock = await ProviderConnection.findOneAndUpdate(
    { _id: conn._id, workspaceId, $or: [{ 'templateSync.lockedUntil': null }, { 'templateSync.lockedUntil': { $lt: startedAt } }] },
    { $set: { 'templateSync.lockedUntil': new Date(startedAt.getTime() + LOCK_MS), 'templateSync.lastAttemptAt': startedAt } },
    { new: true },
  );
  if (!lock) throw new AppError(409, 'SYNC_RUNNING', 'A template sync is already running. Try again in a moment.');

  try {
    const remote = await whatsappProvider().listTemplates(credentialsOf(conn));
    const result = await mirror(workspaceId, conn, remote, source, startedAt);
    await ProviderConnection.updateOne(
      { _id: conn._id, workspaceId },
      { $set: { 'templateSync.lastSuccessAt': new Date(), 'templateSync.lastError': null, 'templateSync.lastErrorCode': null, 'templateSync.failures': 0, 'templateSync.lastSource': source, 'templateSync.lockedUntil': null } },
    );
    if (result.added || result.updated || result.removed) publish(workspaceId.toString(), { type: 'templates.changed' });
    if (result.added || result.updated || result.removed || source === 'manual') {
      logger.info({ workspaceId: workspaceId.toString(), wabaId: conn.wabaId, source, ...result }, 'Templates synced with Meta');
    }
    return result;
  } catch (err) {
    const { code, message } = describeSyncError(err, conn);
    logger.warn({ workspaceId: workspaceId.toString(), wabaId: conn.wabaId, source, code, err: (err as Error).message }, 'Template sync failed');
    await ProviderConnection.updateOne(
      { _id: conn._id, workspaceId },
      { $set: { 'templateSync.lastError': message, 'templateSync.lastErrorCode': code, 'templateSync.lastSource': source, 'templateSync.lockedUntil': null }, $inc: { 'templateSync.failures': 1 } },
    );
    if (err instanceof ProviderError && err.kind === 'auth') await markConnectionAuthError(conn, err.message);
    publish(workspaceId.toString(), { type: 'templates.changed' });
    if (err instanceof ProviderError) {
      const app = providerToAppError(err, 'Could not fetch templates from WhatsApp');
      throw new AppError(app.status, app.code, `Could not fetch templates from WhatsApp: ${message}`);
    }
    throw err;
  }
}

async function mirror(workspaceId: Types.ObjectId, conn: ConnectionDoc, remote: ProviderTemplate[], source: SyncSource, startedAt: Date): Promise<SyncResult> {
  const result: SyncResult = { synced: remote.length, added: 0, updated: 0, removed: 0 };
  const local = await MessageTemplate.find({ workspaceId });
  const byId = new Map(local.filter((t) => t.providerTemplateId).map((t) => [t.providerTemplateId!, t]));
  const byName = new Map(local.map((t) => [`${t.name}\n${t.language}`, t]));
  const keep = new Set<string>();

  for (const r of remote) {
    // Name + language is unique inside an account, so it also finds templates that were
    // deleted and recreated in Meta (new id) or whose id was never stored.
    const named = byName.get(`${r.name}\n${r.language}`);
    const doc = named ?? byId.get(r.providerTemplateId) ?? new MessageTemplate({ workspaceId, name: r.name, language: r.language, category: r.category, status: 'UNKNOWN' });
    const isNew = doc.isNew;
    const before = JSON.stringify([doc.status, doc.rejectedReason, doc.category, doc.providerTemplateId, doc.components]);
    // A webhook that landed after we asked Meta is newer than this list.
    if (isNew || !doc.statusUpdatedAt || doc.statusUpdatedAt <= startedAt) setStatus(doc, r.status, source, r.rejectedReason, startedAt);
    doc.set({
      name: r.name,
      language: r.language,
      providerTemplateId: r.providerTemplateId,
      wabaId: conn.wabaId,
      category: r.category,
      components: r.components,
      draft: null,
      // Meta lists it now, so a later absence really means it was deleted.
      awaitingRemoteSince: null,
      syncedAt: startedAt,
    });
    try {
      await doc.save();
    } catch (err) {
      // Created by someone else a moment ago: update that record instead of adding a second one.
      if ((err as { code?: number }).code !== 11000) throw err;
      const winner = await MessageTemplate.findOneAndUpdate(
        { workspaceId, name: r.name, language: r.language },
        { $set: { providerTemplateId: r.providerTemplateId, wabaId: conn.wabaId, category: r.category, status: normalizeStatus(r.status), rejectedReason: r.rejectedReason, components: r.components, awaitingRemoteSince: null, syncedAt: startedAt } },
        { new: true },
      );
      if (winner) keep.add(winner.id as string);
      continue;
    }
    keep.add(doc.id as string);
    if (isNew) result.added++;
    else if (before !== JSON.stringify([doc.status, doc.rejectedReason, doc.category, doc.providerTemplateId, doc.components])) result.updated++;
  }

  // An automatic check that gets an empty list is more likely a hiccup than "everything was deleted".
  if (!remote.length && source !== 'manual') return result;
  // Templates deleted in Meta (or belonging to a previously connected account) disappear locally too.
  const removed = await MessageTemplate.deleteMany({
    workspaceId,
    _id: { $nin: [...keep] },
    providerTemplateId: { $ne: null },
    status: { $ne: 'DRAFT' },
    createdAt: { $lt: startedAt },
    $or: [{ awaitingRemoteSince: null }, { awaitingRemoteSince: { $lt: new Date(startedAt.getTime() - FRESH_MS) } }, { wabaId: { $nin: [conn.wabaId, null] } }],
  });
  result.removed = removed.deletedCount;
  return result;
}

// ---- Webhooks ----

/**
 * A review decision pushed by Meta. The same business account can be connected to
 * more than one workspace (one per phone number), so every one of them is updated.
 * Returns false when no workspace uses this account.
 */
export async function applyTemplateStatusEvent(event: TemplateStatusEvent, now = new Date()): Promise<boolean> {
  return forAccount(event.wabaId, now, async (workspaceId) => {
    const template = await findForEvent(workspaceId, event);
    const status = normalizeStatus(event.status);
    // FLAGGED, REINSTATED, UNPAUSED… describe a change without naming the new status: ask Meta.
    if (!template || !STATUS_EVENTS.has(status)) return requestSync(workspaceId, 'webhook');
    const changed = setStatus(template, status, 'webhook', event.reason, now);
    if (event.providerTemplateId) template.providerTemplateId = event.providerTemplateId;
    template.wabaId = event.wabaId;
    template.syncedAt = now;
    await template.save();
    if (changed) publish(workspaceId.toString(), { type: 'templates.changed' });
  });
}

/** Meta moved a template to another category (affects price and where it can be used). */
export async function applyTemplateCategoryEvent(event: TemplateCategoryEvent, now = new Date()): Promise<boolean> {
  return forAccount(event.wabaId, now, async (workspaceId) => {
    const template = await findForEvent(workspaceId, event);
    if (!template) return requestSync(workspaceId, 'webhook');
    template.set({ category: event.category, syncedAt: now });
    await template.save();
    publish(workspaceId.toString(), { type: 'templates.changed' });
  });
}

/** Content edited in Meta: the webhook does not carry the new content reliably, so re-read it. */
export async function applyTemplateChangedEvent(event: TemplateChangedEvent, now = new Date()): Promise<boolean> {
  return forAccount(event.wabaId, now, (workspaceId) => requestSync(workspaceId, 'webhook'));
}

async function forAccount(wabaId: string, now: Date, apply: (workspaceId: Types.ObjectId) => Promise<void>): Promise<boolean> {
  // Deliberate cross-tenant lookup: route by the business account id from the webhook.
  const conns = await ProviderConnection.find({ wabaId }).setOptions({ skipTenantScope: true }).lean();
  for (const conn of conns) {
    await ProviderConnection.updateOne({ _id: conn._id, workspaceId: conn.workspaceId }, { $set: { 'templateSync.lastWebhookAt': now, lastWebhookAt: now } });
    await apply(conn.workspaceId);
  }
  return conns.length > 0;
}

/** By Meta's id first, then by name + language (the id may not be stored yet, or has changed). */
async function findForEvent(workspaceId: Types.ObjectId, event: { providerTemplateId: string; name: string | null; language: string | null }) {
  const byId = event.providerTemplateId ? await MessageTemplate.findOne({ workspaceId, providerTemplateId: event.providerTemplateId }) : null;
  if (byId || !event.name || !event.language) return byId;
  return MessageTemplate.findOne({ workspaceId, name: event.name, language: event.language, status: { $ne: 'DRAFT' } });
}

// ---- Background ----

/** Queues a sync shortly (Meta's list needs a moment to reflect what a webhook announced). */
export async function requestSync(workspaceId: Types.ObjectId, source: SyncSource, delayMs = 5_000): Promise<void> {
  const slot = Math.floor(Date.now() / 10_000);
  await enqueue('templates.sync', { workspaceId: workspaceId.toString(), source }, { delayMs, jobId: `templates-sync-${workspaceId.toString()}-${slot}` });
}

export async function processTemplateSync(data: { workspaceId: string; source: string }): Promise<void> {
  const conn = await ProviderConnection.findOne({ workspaceId: data.workspaceId, status: 'connected' }).select('+accessTokenEncrypted');
  if (!conn) return;
  try {
    await syncTemplates(conn.workspaceId, conn, data.source as SyncSource);
  } catch (err) {
    // Recorded on the connection; the reconcile job retries with backoff.
    if (!(err instanceof AppError)) throw err;
  }
}

/** When an account is next due for an automatic check. */
export function nextSyncDue(sync: { lastAttemptAt?: Date | null; failures?: number | null } | null | undefined, review: { pending: number; newest: Date | null }, now: Date): Date {
  const last = sync?.lastAttemptAt;
  if (!last) return now;
  const failures = sync?.failures ?? 0;
  let wait = review.pending === 0 ? SYNC_INTERVALS.idle : review.newest && now.getTime() - review.newest.getTime() < 2 * 60 * MINUTE ? SYNC_INTERVALS.reviewing : SYNC_INTERVALS.reviewingSlow;
  if (failures > 0) wait = Math.min(SYNC_INTERVALS.idle, Math.max(wait, 2 * MINUTE * 2 ** Math.min(failures, 5)));
  return new Date(last.getTime() + wait);
}

/** Repeating job: re-reads Meta for every connected account that is due. */
export async function reconcileTemplates(now = new Date()): Promise<number> {
  const conns = await ProviderConnection.find({ status: 'connected' }).select('+accessTokenEncrypted').setOptions({ skipTenantScope: true });
  if (!conns.length) return 0;
  const reviewing = await MessageTemplate.aggregate<{ _id: Types.ObjectId; pending: number; newest: Date }>(
    [
      { $match: { workspaceId: { $in: conns.map((c) => c.workspaceId) }, status: { $in: IN_REVIEW } } },
      { $group: { _id: '$workspaceId', pending: { $sum: 1 }, newest: { $max: { $ifNull: ['$statusUpdatedAt', '$createdAt'] } } } },
    ],
    { skipTenantScope: true },
  );
  const review = new Map(reviewing.map((r) => [r._id.toString(), r]));
  let ran = 0;
  for (const conn of conns) {
    if (nextSyncDue(conn.templateSync, review.get(conn.workspaceId.toString()) ?? { pending: 0, newest: null }, now) > now) continue;
    ran++;
    await processTemplateSyncFor(conn);
  }
  return ran;
}

async function processTemplateSyncFor(conn: ConnectionDoc) {
  try {
    await syncTemplates(conn.workspaceId, conn, 'reconcile');
  } catch (err) {
    if (!(err instanceof AppError)) logger.error({ err, workspaceId: conn.workspaceId.toString() }, 'Template reconcile failed');
  }
}

// ---- Status for the UI ----

export interface WebhookCheck {
  ok: boolean;
  items: { key: 'app' | 'waba' | 'field'; label: string; state: 'ok' | 'missing' | 'unknown'; detail: string }[];
}

/** Checks, against Meta, every piece that has to be in place for instant status updates. */
export async function checkWebhookSetup(conn: ConnectionDoc): Promise<WebhookCheck> {
  const items: WebhookCheck['items'] = [];
  const configured = Boolean(env.META_APP_SECRET && env.META_WEBHOOK_VERIFY_TOKEN) || env.WHATSAPP_PROVIDER === 'sandbox';
  items.push({
    key: 'app',
    label: 'Webhook receiver',
    state: configured ? 'ok' : 'missing',
    detail: configured ? 'The server accepts signed webhooks from Meta.' : 'META_APP_SECRET and META_WEBHOOK_VERIFY_TOKEN are not set on the server.',
  });

  const setup = await whatsappProvider()
    .getWebhookSetup?.(credentialsOf(conn))
    .catch((err: Error) => ({ accountSubscribed: null, fields: null, callbackUrl: null, error: err.message }));
  const sub = setup?.accountSubscribed ?? null;
  items.push({
    key: 'waba',
    label: 'Account subscription',
    state: sub === null ? 'unknown' : sub ? 'ok' : 'missing',
    detail:
      sub === null
        ? `Could not read the subscription of account ${conn.wabaId}${setup && 'error' in setup && setup.error ? `: ${setup.error}` : '.'}`
        : sub
          ? `The app is subscribed to account ${conn.wabaId}.`
          : `The app is not subscribed to account ${conn.wabaId}. Press Sync to subscribe it, or reconnect WhatsApp.`,
  });
  const fields = setup?.fields ?? null;
  const hasField = fields?.includes('message_template_status_update');
  items.push({
    key: 'field',
    label: 'Template status events',
    state: fields === null ? 'unknown' : hasField ? 'ok' : 'missing',
    detail:
      fields === null
        ? 'The app’s webhook fields could not be read (needs META_APP_ID and META_APP_SECRET on the server).'
        : hasField
          ? 'The app receives message_template_status_update events.'
          : 'In the Meta app, open WhatsApp > Configuration > Webhook fields and subscribe to message_template_status_update.',
  });
  return { ok: items.every((i) => i.state === 'ok'), items };
}

export function toPublicSync(conn: ConnectionDoc | null, inReview: number) {
  const s = conn?.templateSync;
  return {
    connected: conn?.status === 'connected',
    wabaId: conn?.wabaId ?? null,
    lastSyncedAt: s?.lastSuccessAt ?? null,
    lastAttemptAt: s?.lastAttemptAt ?? null,
    lastSource: s?.lastSource ?? null,
    lastError: s?.lastError ?? null,
    lastErrorCode: s?.lastErrorCode ?? null,
    lastWebhookAt: s?.lastWebhookAt ?? null,
    running: Boolean(s?.lockedUntil && s.lockedUntil > new Date()),
    inReview,
    /** Minutes between automatic checks right now. */
    checkEveryMinutes: Math.round((inReview ? SYNC_INTERVALS.reviewing : SYNC_INTERVALS.idle) / MINUTE),
  };
}

export async function syncStatus(workspaceId: Types.ObjectId) {
  const [conn, inReview] = await Promise.all([getConnection(workspaceId), MessageTemplate.countDocuments({ workspaceId, status: { $in: IN_REVIEW } })]);
  return toPublicSync(conn, inReview);
}

/** Makes sure Meta sends this account's webhooks to us (safe to repeat). */
export async function ensureSubscribed(conn: ConnectionDoc): Promise<void> {
  try {
    await whatsappProvider().subscribeApp(credentialsOf(conn));
  } catch (err) {
    logger.warn({ workspaceId: conn.workspaceId.toString(), wabaId: conn.wabaId, err: (err as Error).message }, 'Could not subscribe the app to the WhatsApp account');
  }
}

import { Types } from 'mongoose';
import { decryptSecret } from '../../lib/crypto.js';
import type { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { enqueue } from '../../jobs/queue.js';
import { hasAccess, consume, refund } from '../billing/billing.service.js';
import { Contact } from '../contacts/contact.model.js';
import { findOrCreateContact, normalizePhone } from '../contacts/contact.service.js';
import { messagePreview, recordOutboundOnConversation } from '../inbox/conversation.service.js';
import { Message } from '../messages/message.model.js';
import { buildTemplateContent } from '../messages/message.service.js';
import { MessageTemplate, type TemplateDoc } from '../templates/template.model.js';
import type { TemplateExtras } from '../templates/templateSend.js';
import { getConnection } from '../whatsapp/connection.service.js';
import { Workspace, type WorkspaceDoc } from '../workspaces/workspace.model.js';
import { SheetAccessError, refreshAccessToken, sheetsClient, type SheetAuth } from './googleSheets.js';
import { GoogleAccount, SheetCampaign, SheetRow, type SheetCampaignDoc } from './sheets.model.js';

export interface ColumnVariable {
  source: 'column' | 'static';
  value: string;
  fallback?: string | null;
}

/** Header names that hold the phone number, as GetGabs-style sheets name them. */
const PHONE_HEADERS = /^(phone|phone ?(no|number)|mobile|mobile ?(no|number)|whatsapp|whatsapp ?(no|number)|contact ?(no|number)|number)$/i;
const NAME_HEADERS = /^(name|full ?name|customer ?name|first ?name|lead ?name)$/i;

export const detectPhoneColumn = (headers: string[]) => headers.find((h) => PHONE_HEADERS.test(h.trim())) ?? null;
export const detectNameColumn = (headers: string[]) => headers.find((h) => NAME_HEADERS.test(h.trim())) ?? null;

// Access tokens are cached per Google account until shortly before they expire.
const tokenCache = new Map<string, { token: string; until: number }>();

export async function authFor(campaign: Pick<SheetCampaignDoc, 'workspaceId' | 'access' | 'googleAccountId'>): Promise<SheetAuth> {
  if (campaign.access !== 'google') return { mode: 'link' };
  const account = campaign.googleAccountId ? await GoogleAccount.findOne({ _id: campaign.googleAccountId, workspaceId: campaign.workspaceId }) : null;
  if (!account) throw new SheetAccessError('GOOGLE_AUTH', 'The connected Google account was removed. Connect it again.');
  const cached = tokenCache.get(account.id as string);
  if (cached && cached.until > Date.now()) return { mode: 'google', accessToken: cached.token };
  const { accessToken, expiresIn } = await refreshAccessToken(decryptSecret(account.refreshTokenEnc));
  tokenCache.set(account.id as string, { token: accessToken, until: Date.now() + (expiresIn - 120) * 1000 });
  return { mode: 'google', accessToken };
}

/** Header row (trimmed) and data rows keyed by header, with their 1-based sheet row numbers. */
export function tableOf(rows: string[][]) {
  const headers = (rows[0] ?? []).map((h) => h.trim());
  const data = rows.slice(1).flatMap((r, i) => {
    if (!r.some((c) => c.trim())) return [];
    const values: Record<string, string> = {};
    headers.forEach((h, j) => {
      if (h) values[h] = (r[j] ?? '').trim();
    });
    return [{ rowNumber: i + 2, values }];
  });
  return { headers: headers.filter(Boolean), data };
}

/** Template values for one row; null while a needed cell is still empty (the row waits). */
export function resolveRow(values: Record<string, string>, specs: ColumnVariable[]): string[] | null {
  const out: string[] = [];
  for (const s of specs) {
    const raw = s.source === 'static' ? s.value : (values[s.value] ?? '');
    const v = raw.trim() || (s.fallback ?? '').trim();
    if (!v) return null;
    out.push(v);
  }
  return out;
}

const specsOf = (c: SheetCampaignDoc) => ({
  header: c.headerVariables as ColumnVariable[],
  body: c.bodyVariables as ColumnVariable[],
  buttons: c.buttonVariables as ColumnVariable[],
});

export interface SyncResult {
  rows: number;
  added: number;
  skipped: number;
  waiting: number;
  invalid: number;
  sent: number;
}

/**
 * Reads the sheet and records new phone numbers. Rows present when the
 * campaign first goes live are skipped (unless "send to existing rows" was
 * chosen); later rows are scheduled after the send delay and sent once due.
 */
export async function syncCampaign(campaign: SheetCampaignDoc, now = new Date()): Promise<SyncResult> {
  const result: SyncResult = { rows: 0, added: 0, skipped: 0, waiting: 0, invalid: 0, sent: 0 };
  const workspace = await Workspace.findById(campaign.workspaceId);
  if (!workspace) return result;
  let rows: string[][];
  try {
    rows = await sheetsClient().rows(campaign.spreadsheetId, { gid: campaign.tabGid ?? '0', title: campaign.tabTitle ?? '' }, await authFor(campaign));
  } catch (err) {
    const message = err instanceof SheetAccessError ? err.message : 'Could not read the sheet.';
    if (!(err instanceof SheetAccessError)) logger.warn({ err, campaignId: campaign.id }, 'Sheet read failed');
    await SheetCampaign.updateOne({ _id: campaign._id, workspaceId: campaign.workspaceId }, { lastError: message, lastSyncAt: now });
    campaign.lastError = message;
    return result;
  }

  const { headers, data } = tableOf(rows);
  const phoneColumn = campaign.phoneColumn && headers.includes(campaign.phoneColumn) ? campaign.phoneColumn : null;
  const baseline = !campaign.baselineAt;
  const skipExisting = baseline && campaign.startFrom === 'new';
  const specs = specsOf(campaign);
  const seen = new Set(
    (await SheetRow.find({ workspaceId: campaign.workspaceId, campaignId: campaign._id }).select('phoneE164').lean()).map((r) => r.phoneE164),
  );
  const dueAt = new Date(now.getTime() + campaign.sendDelayMinutes * 60_000);

  for (const row of phoneColumn ? data : []) {
    const phone = normalizePhone(row.values[phoneColumn!] ?? '', workspace.country);
    if (!phone) {
      if (row.values[phoneColumn!]) result.invalid++;
      continue;
    }
    result.rows++;
    if (seen.has(phone)) continue;
    let status: 'skipped' | 'scheduled' = 'scheduled';
    if (skipExisting) status = 'skipped';
    else if (!resolveRow(row.values, specs.header) || !resolveRow(row.values, specs.body) || !resolveRow(row.values, specs.buttons)) {
      // Someone is probably still typing the row; look again next sync.
      result.waiting++;
      continue;
    }
    try {
      await SheetRow.create({ workspaceId: campaign.workspaceId, campaignId: campaign._id, rowNumber: row.rowNumber, phoneE164: phone, values: row.values, status, dueAt: status === 'scheduled' ? dueAt : null });
      seen.add(phone);
      if (status === 'skipped') result.skipped++;
      else result.added++;
    } catch (err) {
      // A concurrent sync recorded the same number first.
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  campaign.headers = headers;
  campaign.lastSyncAt = now;
  campaign.lastError = phoneColumn ? null : `The phone column "${campaign.phoneColumn ?? ''}" is missing from the sheet.`;
  campaign.rowCount = result.rows;
  campaign.invalidRows = result.invalid;
  campaign.waitingRows = result.waiting;
  if (baseline && phoneColumn) campaign.baselineAt = now;
  await SheetCampaign.updateOne(
    { _id: campaign._id, workspaceId: campaign.workspaceId },
    { headers, lastSyncAt: now, lastError: campaign.lastError, rowCount: result.rows, invalidRows: result.invalid, waitingRows: result.waiting, baselineAt: campaign.baselineAt },
  );
  if (campaign.status === 'active') result.sent = await dispatchDue(workspace, campaign, now);
  return result;
}

/** Sends scheduled rows that are due. Returns how many messages were queued. */
export async function dispatchDue(workspace: WorkspaceDoc, campaign: SheetCampaignDoc, now = new Date()): Promise<number> {
  const workspaceId = workspace._id;
  const fail = (error: string) => SheetCampaign.updateOne({ _id: campaign._id, workspaceId }, { lastError: error });
  if (!(await SheetRow.exists({ workspaceId, campaignId: campaign._id, status: 'scheduled', dueAt: { $lte: now } }))) return 0;
  if (workspace.status === 'suspended' || !(await hasAccess(workspaceId))) return (await fail('Sending is paused because the subscription is not active.'), 0);
  const conn = await getConnection(workspaceId);
  if (!conn || conn.status !== 'connected') return (await fail('WhatsApp connection needs attention. Fix it and messages will continue.'), 0);
  const template = campaign.templateId ? await MessageTemplate.findOne({ _id: campaign.templateId, workspaceId }) : null;
  if (!template || template.status !== 'APPROVED') return (await fail(template ? `Template "${template.name}" is not approved.` : 'Choose a template.'), 0);

  let sent = 0;
  // Claim rows one at a time so overlapping syncs never send a row twice.
  for (;;) {
    const row = await SheetRow.findOneAndUpdate(
      { workspaceId, campaignId: campaign._id, status: 'scheduled', dueAt: { $lte: now } },
      { status: 'sent' },
      { sort: { rowNumber: 1 }, new: true },
    );
    if (!row) break;
    try {
      await sendRow(workspace, campaign, template, row);
      sent++;
    } catch (err) {
      const e = err as AppError;
      if (e.code === 'PLAN_LIMIT_REACHED' || e.code === 'SUBSCRIPTION_INACTIVE') {
        // Out of allowance: keep the row for later.
        await SheetRow.updateOne({ _id: row._id, workspaceId }, { status: 'scheduled' });
        await fail(`${e.message} New rows will be sent once the plan allows more messages.`);
        break;
      }
      await SheetRow.updateOne({ _id: row._id, workspaceId }, { status: 'failed', error: e.message || 'Could not send.' });
    }
  }
  return sent;
}

async function sendRow(workspace: WorkspaceDoc, campaign: SheetCampaignDoc, template: TemplateDoc, row: InstanceType<typeof SheetRow>) {
  const workspaceId = workspace._id;
  const values = (row.values ?? {}) as Record<string, string>;
  const contact = await findOrCreateContact(workspaceId, row.phoneE164, 'google_sheets');
  const name = campaign.nameColumn ? values[campaign.nameColumn]?.trim() : '';
  if (name && !contact.name) await Contact.updateOne({ _id: contact._id, workspaceId }, { name: name.slice(0, 120) });
  if (contact.consent?.status === 'opted_out') {
    await SheetRow.updateOne({ _id: row._id, workspaceId }, { status: 'failed', contactId: contact._id, error: 'This contact has opted out of WhatsApp messages.' });
    return;
  }
  const specs = specsOf(campaign);
  const content = buildTemplateContent(
    template,
    resolveRow(values, specs.header) ?? [],
    resolveRow(values, specs.body) ?? [],
    resolveRow(values, specs.buttons) ?? [],
    (campaign.templateExtras ?? {}) as TemplateExtras,
  );
  const idempotencyKey = `sheet:${row.id as string}`;
  await consume(workspaceId, 'messages');
  let message;
  try {
    message = await Message.create({ workspaceId, contactId: contact._id, direction: 'outbound', type: 'template', content, status: 'queued', idempotencyKey });
  } catch (err) {
    await refund(workspaceId, 'messages');
    if ((err as { code?: number }).code !== 11000) throw err;
    message = (await Message.findOne({ workspaceId, idempotencyKey }))!;
  }
  await SheetRow.updateOne({ _id: row._id, workspaceId }, { contactId: contact._id, messageId: message._id, error: null });
  await recordOutboundOnConversation(workspaceId, contact._id, messagePreview('template', content), new Date());
  await enqueue('whatsapp.send', { workspaceId: workspaceId.toString(), messageId: message.id as string }, { jobId: `send-${message.id as string}` });
}

/** Repeating job: checks every active campaign for new rows and sends due ones. */
export async function pollSheets(): Promise<void> {
  const campaigns = await SheetCampaign.find({ status: 'active' }).setOptions({ skipTenantScope: true }).limit(500);
  for (const c of campaigns) {
    try {
      await syncCampaign(c);
    } catch (err) {
      logger.error({ err, campaignId: c.id }, 'Sheet sync failed');
    }
  }
}

export type RowState = 'skipped' | 'waiting' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

/** Per-row state shown on the data page, from the row and its message. */
export function rowState(status: string, messageStatus: string | null | undefined): RowState {
  if (status === 'skipped') return 'skipped';
  if (status === 'failed') return 'failed';
  if (status === 'scheduled') return 'queued';
  switch (messageStatus) {
    case 'read':
      return 'read';
    case 'delivered':
      return 'delivered';
    // Accepted by WhatsApp counts as sent until a receipt arrives.
    case 'submitted':
    case 'sent':
      return 'sent';
    case 'failed':
      return 'failed';
    default:
      return 'queued';
  }
}

/** Message counts per campaign: sent rows and how their messages fared. */
export async function campaignCounts(workspaceId: Types.ObjectId, campaignIds: Types.ObjectId[]) {
  const rows = await SheetRow.aggregate<{ _id: { c: Types.ObjectId; s: string; m: string | null }; n: number }>([
    { $match: { workspaceId, campaignId: { $in: campaignIds } } },
    { $lookup: { from: 'messages', localField: 'messageId', foreignField: '_id', as: 'm', pipeline: [{ $project: { status: 1 } }] } },
    { $group: { _id: { c: '$campaignId', s: '$status', m: { $first: '$m.status' } }, n: { $sum: 1 } } },
  ]);
  const out = new Map<string, Record<RowState, number> & { messages: number }>();
  for (const r of rows) {
    const key = r._id.c.toString();
    const counts = out.get(key) ?? { skipped: 0, waiting: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, messages: 0 };
    counts[rowState(r._id.s, r._id.m)] += r.n;
    if (r._id.m) counts.messages += r.n;
    out.set(key, counts);
  }
  return out;
}

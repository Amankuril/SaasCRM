import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { encryptSecret } from '../../lib/crypto.js';
import { csvCell } from '../../lib/csv.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { Message } from '../messages/message.model.js';
import { MessageTemplate } from '../templates/template.model.js';
import { checkSendValues, sendRequirements, templateExtrasSchema, type TemplateExtras } from '../templates/templateSend.js';
import type { TemplateComponent } from '../whatsapp/provider/types.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import {
  SheetAccessError,
  decodeState,
  encodeState,
  exchangeCode,
  googleAuthUrl,
  googleOAuthConfigured,
  parseSheetUrl,
  sheetsClient,
} from './googleSheets.js';
import { GoogleAccount, SHEET_STEPS, SheetCampaign, SheetRow, type SheetCampaignDoc } from './sheets.model.js';
import { authFor, campaignCounts, detectNameColumn, detectPhoneColumn, rowState, syncCampaign, tableOf, type RowState } from './sheets.service.js';

export const sheetsRouter = Router({ mergeParams: true });

const accessError = (err: unknown): never => {
  if (err instanceof SheetAccessError) throw new AppError(err.code === 'UNAVAILABLE' ? 502 : 422, `SHEET_${err.code}`, err.message);
  throw err;
};

async function findCampaign(req: Request) {
  const campaign = await SheetCampaign.findOne({ _id: objectId(req.params.campaignId, 'Campaign'), workspaceId: req.workspace!._id });
  if (!campaign) throw notFound('Campaign not found.');
  return campaign;
}

type Counts = Awaited<ReturnType<typeof campaignCounts>> extends Map<string, infer V> ? V : never;

async function serialize(c: SheetCampaignDoc, counts?: Counts) {
  const [template, account] = await Promise.all([
    c.templateId ? MessageTemplate.findOne({ _id: c.templateId, workspaceId: c.workspaceId }).select('name category language status').lean() : null,
    c.googleAccountId ? GoogleAccount.findOne({ _id: c.googleAccountId, workspaceId: c.workspaceId }).select('email').lean() : null,
  ]);
  return {
    id: c.id as string,
    name: c.name,
    status: c.status,
    // What the list shows: problems win over the chosen status.
    state: c.lastError && c.status !== 'draft' ? 'error' : c.status,
    step: c.step,
    sheetUrl: c.sheetUrl,
    spreadsheetTitle: c.spreadsheetTitle,
    access: c.access,
    googleAccount: account ? { id: account._id.toString(), email: account.email } : null,
    tab: c.tabGid ? { gid: c.tabGid, title: c.tabTitle ?? '' } : null,
    headers: c.headers,
    phoneColumn: c.phoneColumn,
    nameColumn: c.nameColumn,
    templateId: c.templateId?.toString() ?? null,
    template: template ? { id: template._id.toString(), name: template.name, category: template.category, language: template.language, status: template.status } : null,
    headerVariables: c.headerVariables,
    bodyVariables: c.bodyVariables,
    buttonVariables: c.buttonVariables,
    templateExtras: c.templateExtras ?? null,
    sendDelayMinutes: c.sendDelayMinutes,
    startFrom: c.startFrom,
    lastSyncAt: c.lastSyncAt,
    lastError: c.lastError,
    rowCount: c.rowCount,
    invalidRows: c.invalidRows,
    waitingRows: c.waitingRows,
    counts: counts ?? null,
    createdAt: (c as unknown as { createdAt: Date }).createdAt,
  };
}

// ---- List ----

sheetsRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const [campaigns, accounts] = await Promise.all([
    SheetCampaign.find({ workspaceId }).sort({ createdAt: -1 }).limit(200),
    GoogleAccount.find({ workspaceId }).select('email').lean(),
  ]);
  const counts = await campaignCounts(workspaceId, campaigns.map((c) => c._id));
  const items = await Promise.all(campaigns.map((c) => serialize(c, counts.get(c.id as string))));
  res.json({
    campaigns: items,
    stats: {
      total: items.length,
      active: items.filter((c) => c.state === 'active').length,
      paused: items.filter((c) => c.status === 'paused').length,
      messages: [...counts.values()].reduce((n, c) => n + c.messages, 0),
    },
    google: { configured: googleOAuthConfigured(), accounts: accounts.map((a) => ({ id: a._id.toString(), email: a.email })) },
  });
});

// ---- Wizard ----

const sheetUrlSchema = z.string().trim().min(1, 'Paste the link to your Google Sheet.').max(2000);

/** Step 2: a draft campaign for the pasted link. */
sheetsRouter.post('/', requirePermission('campaigns:manage'), async (req, res) => {
  const { sheetUrl } = parse(z.object({ sheetUrl: sheetUrlSchema }), req.body);
  const parsed = parseSheetUrl(sheetUrl);
  if (!parsed) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { sheetUrl: ['This is not a Google Sheets link. It looks like https://docs.google.com/spreadsheets/d/…'] });
  const campaign = await SheetCampaign.create({
    workspaceId: req.workspace!._id,
    name: 'Untitled sheet campaign',
    sheetUrl,
    spreadsheetId: parsed.spreadsheetId,
    tabGid: parsed.gid,
    step: 'connect',
    createdBy: req.user!._id,
  });
  res.status(201).json({ campaign: await serialize(campaign) });
});

const variable = z.object({ source: z.enum(['column', 'static']), value: z.string().max(1000), fallback: z.string().max(1000).nullable().optional() });
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    sheetUrl: sheetUrlSchema,
    step: z.enum(SHEET_STEPS),
    tabGid: z.string().regex(/^\d+$/),
    phoneColumn: z.string().max(200).nullable(),
    nameColumn: z.string().max(200).nullable(),
    templateId: z.string().nullable(),
    headerVariables: z.array(variable).max(10),
    bodyVariables: z.array(variable).max(30),
    buttonVariables: z.array(variable).max(10),
    templateExtras: templateExtrasSchema.nullable(),
    sendDelayMinutes: z.number().int().min(0).max(7 * 24 * 60),
    startFrom: z.enum(['new', 'all']),
  })
  .partial();

sheetsRouter.get('/:campaignId', requirePermission('workspace:read'), async (req, res) => {
  const c = await findCampaign(req);
  res.json({ campaign: await serialize(c, (await campaignCounts(c.workspaceId, [c._id])).get(c.id as string)) });
});

sheetsRouter.patch('/:campaignId', requirePermission('campaigns:manage'), async (req, res) => {
  const input = parse(updateSchema, req.body);
  const c = await findCampaign(req);
  const { sheetUrl, templateId, tabGid, ...rest } = input;
  if (sheetUrl !== undefined && sheetUrl !== c.sheetUrl) {
    const parsed = parseSheetUrl(sheetUrl);
    if (!parsed) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { sheetUrl: ['This is not a Google Sheets link.'] });
    if (c.baselineAt) throw conflict('SHEET_LOCKED', 'This campaign has started; create a new one for another sheet.');
    c.set({ sheetUrl, spreadsheetId: parsed.spreadsheetId, tabGid: parsed.gid, tabTitle: null, headers: [], spreadsheetTitle: '' });
  }
  if (templateId !== undefined) {
    const template = templateId ? await MessageTemplate.findOne({ _id: objectId(templateId, 'Template'), workspaceId: c.workspaceId }) : null;
    if (templateId && !template) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { templateId: ['Template not found.'] });
    c.templateId = template?._id ?? null;
  }
  if (tabGid !== undefined && tabGid !== c.tabGid) {
    if (c.baselineAt) throw conflict('SHEET_LOCKED', 'This campaign has started; create a new one for another tab.');
    c.set({ tabGid, tabTitle: null, headers: [] });
  }
  c.set(rest);
  await c.save();
  res.json({ campaign: await serialize(c) });
});

/** Step 3: how the sheet is read (shared link or a Google account); checks it opens. */
sheetsRouter.post('/:campaignId/connect', requirePermission('campaigns:manage'), async (req, res) => {
  const input = parse(z.object({ access: z.enum(['link', 'google']), googleAccountId: z.string().optional() }), req.body);
  const c = await findCampaign(req);
  if (input.access === 'google') {
    const account = input.googleAccountId ? await GoogleAccount.findOne({ _id: objectId(input.googleAccountId, 'Google account'), workspaceId: c.workspaceId }) : null;
    if (!account) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { googleAccountId: ['Connect a Google account first.'] });
    c.googleAccountId = account._id;
  } else c.googleAccountId = null;
  c.access = input.access;
  const info = await sheetsClient()
    .info(c.spreadsheetId, await authFor(c).catch(accessError))
    .catch(accessError);
  c.spreadsheetTitle = info.title;
  if (c.name === 'Untitled sheet campaign') c.name = info.title.slice(0, 80);
  if (c.tabGid && !info.tabs.some((t) => t.gid === c.tabGid)) c.tabGid = null;
  if (SHEET_STEPS.indexOf(c.step) < SHEET_STEPS.indexOf('select')) c.step = 'select';
  await c.save();
  res.json({ campaign: await serialize(c), tabs: info.tabs });
});

sheetsRouter.get('/:campaignId/tabs', requirePermission('workspace:read'), async (req, res) => {
  const c = await findCampaign(req);
  const info = await sheetsClient()
    .info(c.spreadsheetId, await authFor(c).catch(accessError))
    .catch(accessError);
  res.json({ title: info.title, tabs: info.tabs });
});

/** Step 4: reads the chosen tab's header row and a few rows; guesses the phone and name columns. */
sheetsRouter.get('/:campaignId/preview', requirePermission('workspace:read'), async (req, res) => {
  const c = await findCampaign(req);
  const auth = await authFor(c).catch(accessError);
  const info = await sheetsClient().info(c.spreadsheetId, auth).catch(accessError);
  const gid = typeof req.query.gid === 'string' && /^\d+$/.test(req.query.gid) ? req.query.gid : (c.tabGid ?? info.tabs[0]?.gid ?? '0');
  const tab = info.tabs.find((t) => t.gid === gid) ?? info.tabs[0]!;
  const { headers, data } = tableOf(await sheetsClient().rows(c.spreadsheetId, tab, auth).catch(accessError));
  res.json({
    tab,
    headers,
    rows: data.slice(0, 5).map((r) => r.values),
    total: data.length,
    detected: { phoneColumn: detectPhoneColumn(headers), nameColumn: detectNameColumn(headers) },
  });
});

/** Step 4 → 5: saves the tab and its columns. */
sheetsRouter.post('/:campaignId/tab', requirePermission('campaigns:manage'), async (req, res) => {
  const input = parse(z.object({ gid: z.string().regex(/^\d+$/), phoneColumn: z.string().min(1).max(200), nameColumn: z.string().max(200).nullable().optional() }), req.body);
  const c = await findCampaign(req);
  const auth = await authFor(c).catch(accessError);
  const info = await sheetsClient().info(c.spreadsheetId, auth).catch(accessError);
  const tab = info.tabs.find((t) => t.gid === input.gid);
  if (!tab) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { gid: ['This tab is no longer in the sheet.'] });
  if (c.baselineAt && tab.gid !== c.tabGid) throw conflict('SHEET_LOCKED', 'This campaign has started; create a new one for another tab.');
  const { headers } = tableOf(await sheetsClient().rows(c.spreadsheetId, tab, auth).catch(accessError));
  if (!headers.includes(input.phoneColumn)) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { phoneColumn: ['Pick the column with phone numbers.'] });
  c.set({ tabGid: tab.gid, tabTitle: tab.title, headers, phoneColumn: input.phoneColumn, nameColumn: input.nameColumn && headers.includes(input.nameColumn) ? input.nameColumn : null });
  if (SHEET_STEPS.indexOf(c.step) < SHEET_STEPS.indexOf('map')) c.step = 'map';
  await c.save();
  res.json({ campaign: await serialize(c) });
});

/** Everything needed before the campaign can send; empty when it is ready. */
async function readiness(c: SheetCampaignDoc): Promise<Record<string, string[]>> {
  const details: Record<string, string[]> = {};
  if (!c.tabGid || !c.headers.length) details.tabGid = ['Choose the sheet tab.'];
  if (!c.phoneColumn || !c.headers.includes(c.phoneColumn)) details.phoneColumn = ['Pick the column with phone numbers.'];
  const template = c.templateId ? await MessageTemplate.findOne({ _id: c.templateId, workspaceId: c.workspaceId }) : null;
  if (!template) details.templateId = ['Choose a template.'];
  else if (template.status !== 'APPROVED') details.templateId = [`Template "${template.name}" is not approved yet.`];
  else {
    const req = sendRequirements(template.components as TemplateComponent[]);
    const check = (key: 'headerVariables' | 'bodyVariables' | 'buttonVariables', n: number) => {
      const specs = c[key];
      if (specs.length !== n) return (details[key] = [`Map ${n} value(s).`]);
      specs.forEach((s, i) => {
        if (s.source === 'column' && !c.headers.includes(s.value)) details[key] = [`Value ${i + 1}: pick a column from the sheet.`];
        if (s.source === 'static' && !s.value.trim()) details[key] = [`Value ${i + 1}: type the text to send.`];
      });
    };
    check('headerVariables', req.header);
    check('bodyVariables', req.body);
    check('buttonVariables', req.buttons.length);
    // Same-for-everyone values (media, offer expiry, cards) are checked once here.
    const fill = (n: number) => Array<string>(n).fill('x');
    Object.assign(details, checkSendValues(req, { headerParams: fill(req.header), bodyParams: fill(req.body), buttonParams: fill(req.buttons.length), extras: (c.templateExtras ?? {}) as TemplateExtras }));
  }
  return details;
}

/** Step 6: go live (or resume). Reads the sheet straight away. */
sheetsRouter.post('/:campaignId/activate', requirePermission('campaigns:manage'), async (req, res) => {
  const c = await findCampaign(req);
  const details = await readiness(c);
  if (Object.keys(details).length) throw badRequest('VALIDATION_ERROR', 'Finish setting up the campaign first.', details);
  c.status = 'active';
  c.step = 'settings';
  c.lastError = null;
  await c.save();
  const sync = await syncCampaign(c);
  res.json({ campaign: await serialize(c, (await campaignCounts(c.workspaceId, [c._id])).get(c.id as string)), sync });
});

sheetsRouter.post('/:campaignId/pause', requirePermission('campaigns:manage'), async (req, res) => {
  const c = await findCampaign(req);
  if (c.status === 'active') c.status = 'paused';
  await c.save();
  res.json({ campaign: await serialize(c) });
});

/** "Sync Data": reads the sheet now instead of waiting for the next check. */
sheetsRouter.post('/:campaignId/sync', requirePermission('campaigns:manage'), async (req, res) => {
  const c = await findCampaign(req);
  if (c.status === 'draft') throw conflict('CAMPAIGN_DRAFT', 'Finish setting up the campaign first.');
  const sync = await syncCampaign(c);
  res.json({ campaign: await serialize(c, (await campaignCounts(c.workspaceId, [c._id])).get(c.id as string)), sync });
});

sheetsRouter.delete('/:campaignId', requirePermission('campaigns:manage'), async (req, res) => {
  const c = await findCampaign(req);
  await SheetRow.deleteMany({ workspaceId: c.workspaceId, campaignId: c._id });
  await SheetCampaign.deleteOne({ _id: c._id, workspaceId: c.workspaceId });
  res.status(204).end();
});

// ---- Rows (the campaign's data page) ----

const ROW_STATES = ['skipped', 'queued', 'sent', 'delivered', 'read', 'failed'] as const;

async function loadRows(c: SheetCampaignDoc, q: string, state: RowState | null) {
  const filter: Record<string, unknown> = { workspaceId: c.workspaceId, campaignId: c._id };
  const digits = q.replace(/\D/g, '');
  if (digits) filter.phoneE164 = { $regex: digits };
  const rows = await SheetRow.find(filter).sort({ rowNumber: 1 }).limit(5000).lean();
  const messages = await Message.find({ workspaceId: c.workspaceId, _id: { $in: rows.flatMap((r) => (r.messageId ? [r.messageId] : [])) } })
    .select('status error statusUpdatedAt updatedAt')
    .lean();
  const byId = new Map(messages.map((m) => [m._id.toString(), m]));
  return rows
    .map((r) => {
      const m = r.messageId ? byId.get(r.messageId.toString()) : undefined;
      const s = rowState(r.status, m?.status);
      const err = r.error ?? ((m as { error?: { message?: string } } | undefined)?.error?.message || null);
      return { id: r._id.toString(), rowNumber: r.rowNumber, phone: r.phoneE164, values: r.values as Record<string, string>, state: s, error: s === 'failed' ? err : null, dueAt: r.dueAt, updatedAt: (m as { updatedAt?: Date } | undefined)?.updatedAt ?? r.updatedAt };
    })
    .filter((r) => !state || r.state === state);
}

sheetsRouter.get('/:campaignId/rows', requirePermission('workspace:read'), async (req, res) => {
  const c = await findCampaign(req);
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const state = (ROW_STATES as readonly string[]).includes(String(req.query.state)) ? (req.query.state as RowState) : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const rows = await loadRows(c, q, state);
  const counts = (await campaignCounts(c.workspaceId, [c._id])).get(c.id as string);
  res.json({ rows: rows.slice((page - 1) * 50, page * 50), total: rows.length, pages: Math.max(1, Math.ceil(rows.length / 50)), counts: counts ?? null });
});

sheetsRouter.get('/:campaignId/rows/export', requirePermission('workspace:read'), async (req, res) => {
  const c = await findCampaign(req);
  const rows = await loadRows(c, '', null);
  const columns = c.headers;
  const lines = [['Row', 'Phone', 'Status', 'Error', ...columns].map(csvCell).join(',')];
  for (const r of rows) lines.push([r.rowNumber, r.phone, r.state, r.error ?? '', ...columns.map((h) => r.values[h] ?? '')].map(csvCell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'sheet'}-rows.csv"`);
  res.send(lines.join('\n'));
});

// ---- Google account (OAuth) ----

sheetsRouter.get('/google/auth-url', requirePermission('campaigns:manage'), async (req, res) => {
  if (!googleOAuthConfigured()) throw conflict('GOOGLE_NOT_CONFIGURED', 'Google sign-in is not set up on this server. Share the sheet with "Anyone with the link" instead.');
  const campaignId = String(req.query.campaignId ?? '');
  if (!Types.ObjectId.isValid(campaignId)) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { campaignId: ['Missing campaign.'] });
  res.json({ url: googleAuthUrl(encodeState({ workspaceId: req.workspace!.id as string, userId: req.user!.id as string, campaignId })) });
});

sheetsRouter.delete('/google/accounts/:accountId', requirePermission('campaigns:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const account = await GoogleAccount.findOne({ _id: objectId(req.params.accountId, 'Google account'), workspaceId });
  if (!account) throw notFound('Google account not found.');
  if (await SheetCampaign.exists({ workspaceId, googleAccountId: account._id, status: 'active' })) {
    throw conflict('GOOGLE_ACCOUNT_IN_USE', 'Active campaigns read sheets through this account. Pause them or switch them to link sharing first.');
  }
  await GoogleAccount.deleteOne({ _id: account._id, workspaceId });
  res.status(204).end();
});

/** Public: Google sends the browser back here after consent. */
export const googleCallbackRouter = Router();
googleCallbackRouter.get('/google/callback', async (req, res) => {
  const state = decodeState(String(req.query.state ?? ''));
  const back = (campaignId: string, workspaceId: string, result: string) =>
    res.redirect(`${env.APP_URL}/w/${workspaceId}/integrations/google-sheets/${campaignId}/setup?google=${encodeURIComponent(result)}`);
  if (!state) return res.redirect(`${env.APP_URL}/?google=expired`);
  if (req.query.error || !req.query.code) return back(state.campaignId, state.workspaceId, 'denied');
  try {
    const workspaceId = new Types.ObjectId(state.workspaceId);
    // The member who started the flow must still be able to manage campaigns.
    const member = await WorkspaceMember.findOne({ workspaceId, userId: state.userId }).lean();
    if (!member || !['owner', 'admin', 'manager'].includes(member.role)) return back(state.campaignId, state.workspaceId, 'denied');
    const { refreshToken, email } = await exchangeCode(String(req.query.code));
    const account = await GoogleAccount.findOneAndUpdate(
      { workspaceId, email: email.toLowerCase() },
      { refreshTokenEnc: encryptSecret(refreshToken), connectedBy: new Types.ObjectId(state.userId) },
      { upsert: true, new: true },
    );
    await SheetCampaign.updateOne({ _id: state.campaignId, workspaceId }, { access: 'google', googleAccountId: account._id });
    return back(state.campaignId, state.workspaceId, 'connected');
  } catch (err) {
    logger.warn({ err }, 'Google OAuth callback failed');
    return back(state.campaignId, state.workspaceId, 'failed');
  }
});

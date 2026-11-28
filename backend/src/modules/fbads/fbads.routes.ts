import express, { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { audit } from '../audit/audit.service.js';
import { graph, graphAll } from './fbads.graph.js';
import { FB_KINDS, FbApiLog, FbConnection, FbEntity, type FbConnectionDoc, type FbKind } from './fbads.model.js';
import {
  asAppError,
  authorizeUrl,
  completeOAuth,
  createAndStore,
  createCustomAudience,
  deleteEntity,
  disconnect,
  duplicateEntity,
  listAdAccounts,
  queueSync,
  readState,
  requireConnection,
  selectAdAccount,
  updateEntity,
  verifyConnection,
} from './fbads.service.js';

const minor = (major: number) => String(Math.round(major * 100));

function serializeConnection(c: FbConnectionDoc | null) {
  if (!c || c.status === 'disconnected') return null;
  return {
    status: c.status,
    fbUserName: c.fbUserName ?? null,
    adAccountId: c.adAccountId ?? null,
    adAccountName: c.adAccountName ?? null,
    currency: c.currency ?? null,
    timezone: c.timezone ?? null,
    accountStatus: c.accountStatus ?? null,
    tokenExpiresAt: c.tokenExpiresAt ?? null,
    lastError: c.lastError ?? null,
    connectedAt: c.connectedAt ?? null,
    lastVerifiedAt: c.lastVerifiedAt ?? null,
    sync: { status: c.sync?.status ?? 'idle', startedAt: c.sync?.startedAt ?? null, finishedAt: c.sync?.finishedAt ?? null, error: c.sync?.error ?? null },
  };
}

/** Public: Meta sends the browser back here after "Connect Facebook". */
export const fbOAuthRouter = Router();
fbOAuthRouter.get('/oauth/callback', async (req, res) => {
  const state = readState(String(req.query.state ?? ''));
  const back = (workspaceId: string | null, query: string) => res.redirect(`${env.APP_URL}${workspaceId ? `/w/${workspaceId}/facebook/ads` : '/'}?${query}`);
  if (!state) return back(null, 'fb=expired');
  if (req.query.error || !req.query.code) return back(state.workspaceId, 'fb=cancelled');
  try {
    await completeOAuth(new Types.ObjectId(state.workspaceId), new Types.ObjectId(state.userId), String(req.query.code));
    back(state.workspaceId, 'fb=choose');
  } catch (err) {
    logger.warn({ err }, 'Facebook login failed');
    back(state.workspaceId, `fb=error&message=${encodeURIComponent((err as Error).message.slice(0, 200))}`);
  }
});

/** Mounted at /api/workspaces/:workspaceId/facebook-ads. */
export const fbAdsRouter = Router({ mergeParams: true });
const view = requirePermission('ads:view');
const manage = requirePermission('ads:manage');

fbAdsRouter.get('/', view, async (req, res) => {
  const workspaceId = req.workspace!._id;
  const conn = await FbConnection.findOne({ workspaceId });
  const live = conn && conn.status !== 'disconnected' && conn.adAccountId ? conn.adAccountId : null;
  const counts = { campaigns: 0, activeCampaigns: 0, adsets: 0, ads: 0, rejectedAds: 0 };
  if (live) {
    const rows = await FbEntity.aggregate<{ _id: { k: string; s: string | null }; n: number }>([
      { $match: { workspaceId, adAccountId: live, deletedAt: null, kind: { $in: ['campaign', 'adset', 'ad'] } } },
      { $group: { _id: { k: '$kind', s: '$effectiveStatus' }, n: { $sum: 1 } } },
    ]);
    for (const r of rows) {
      if (r._id.k === 'campaign') {
        counts.campaigns += r.n;
        if (r._id.s === 'ACTIVE') counts.activeCampaigns += r.n;
      }
      if (r._id.k === 'adset') counts.adsets += r.n;
      if (r._id.k === 'ad') {
        counts.ads += r.n;
        if (r._id.s === 'DISAPPROVED') counts.rejectedAds += r.n;
      }
    }
  }
  res.json({ connection: serializeConnection(conn), counts, provider: env.ADS_PROVIDER });
});

fbAdsRouter.post('/connect', manage, (req, res) => {
  res.json({ url: authorizeUrl(String(req.workspace!._id), String(req.user!._id)) });
});

fbAdsRouter.get('/accounts', manage, async (req, res) => {
  res.json({ accounts: await listAdAccounts(req.workspace!._id) });
});

fbAdsRouter.post('/account', manage, async (req, res) => {
  const { adAccountId } = parse(z.object({ adAccountId: z.string().regex(/^act_\d+$/, 'Choose an ad account.') }), req.body);
  const conn = await selectAdAccount(req.workspace!._id, adAccountId);
  await audit(req, { workspaceId: req.workspace!._id, action: 'fbads.account_selected', targetType: 'fb_ad_account', targetId: adAccountId, metadata: { name: conn.adAccountName } });
  res.json({ connection: serializeConnection(conn) });
});

fbAdsRouter.post('/verify', manage, async (req, res) => {
  res.json({ connection: serializeConnection(await verifyConnection(req.workspace!._id)) });
});

fbAdsRouter.post('/sync', manage, async (req, res) => {
  const { conn } = await requireConnection(req.workspace!._id);
  const queued = await queueSync(req.workspace!._id);
  res.status(202).json({ queued, connection: serializeConnection((await FbConnection.findOne({ workspaceId: conn.workspaceId })) ?? conn) });
});

fbAdsRouter.get('/logs', view, async (req, res) => {
  const logs = await FbApiLog.find({ workspaceId: req.workspace!._id }).sort({ createdAt: -1 }).limit(500).lean();
  res.json({ logs: logs.map((l) => ({ id: String(l._id), endpoint: l.endpoint, method: l.method, httpStatus: l.httpStatus ?? null, error: l.error ?? null, durationMs: l.durationMs ?? null, at: l.createdAt })) });
});

fbAdsRouter.post('/disconnect', manage, async (req, res) => {
  await disconnect(req.workspace!._id);
  await audit(req, { workspaceId: req.workspace!._id, action: 'fbads.disconnected', targetType: 'fb_connection' });
  res.json({ ok: true });
});

// ---- lists ----

const STATUS_FILTERS: Record<string, string[]> = {
  active: ['ACTIVE'],
  paused: ['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'],
  archived: ['ARCHIVED'],
  deleted: ['DELETED'],
  in_review: ['PENDING_REVIEW', 'IN_PROCESS', 'PREAPPROVED'],
  rejected: ['DISAPPROVED', 'WITH_ISSUES'],
};
const kindParam = z.enum(FB_KINDS);

fbAdsRouter.get('/entities/:kind', view, async (req, res) => {
  const kind = parse(kindParam, req.params.kind);
  const { q, status, page } = parse(
    z.object({ q: z.string().trim().max(100).optional(), status: z.enum(['all', ...Object.keys(STATUS_FILTERS)] as [string, ...string[]]).default('all'), page: z.coerce.number().int().min(1).default(1) }),
    req.query,
  );
  const workspaceId = req.workspace!._id;
  const conn = await FbConnection.findOne({ workspaceId });
  if (!conn?.adAccountId || conn.status === 'disconnected') return void res.json({ rows: [], total: 0, page: 1, pages: 1 });
  const filter: Record<string, unknown> = { workspaceId, adAccountId: conn.adAccountId, kind };
  if (status === 'deleted') filter.deletedAt = { $ne: null };
  else {
    filter.deletedAt = null;
    if (status !== 'all') filter.effectiveStatus = { $in: STATUS_FILTERS[status] };
  }
  if (q) filter.name = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const limit = 50;
  const [rows, total] = await Promise.all([FbEntity.find(filter).sort({ metaUpdatedAt: -1, updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), FbEntity.countDocuments(filter)]);
  // Names of parents for the table (campaign of an ad set, ad set + creative of an ad).
  const ids = [...new Set(rows.flatMap((r) => [r.campaignMetaId, r.adsetMetaId, r.creativeMetaId]).filter((v): v is string => !!v))];
  const parents = ids.length ? await FbEntity.find({ workspaceId, adAccountId: conn.adAccountId, metaId: { $in: ids } }).select('metaId name').lean() : [];
  const nameOf = (id: string | null | undefined) => (id ? (parents.find((p) => p.metaId === id)?.name ?? id) : null);
  res.json({
    rows: rows.map((r) => ({
      id: r.metaId,
      kind: r.kind,
      name: r.name,
      status: r.status ?? null,
      effectiveStatus: r.effectiveStatus ?? null,
      deleted: !!r.deletedAt,
      objective: r.objective ?? null,
      buyingType: r.buyingType ?? null,
      dailyBudget: r.dailyBudget != null ? r.dailyBudget / 100 : null,
      lifetimeBudget: r.lifetimeBudget != null ? r.lifetimeBudget / 100 : null,
      campaign: r.campaignMetaId ? { id: r.campaignMetaId, name: nameOf(r.campaignMetaId) } : null,
      adset: r.adsetMetaId ? { id: r.adsetMetaId, name: nameOf(r.adsetMetaId) } : null,
      creative: r.creativeMetaId ? { id: r.creativeMetaId, name: nameOf(r.creativeMetaId) } : null,
      optimizationGoal: r.optimizationGoal ?? null,
      targetingSummary: r.targetingSummary ?? null,
      reviewStatus: r.reviewStatus ?? null,
      thumbnailUrl: r.thumbnailUrl ?? null,
      creativeType: r.creativeType ?? null,
      headline: r.headline ?? null,
      callToAction: r.callToAction ?? null,
      subtype: r.subtype ?? null,
      approxCount: r.approxCount ?? null,
      lastFiredAt: r.lastFiredAt ?? null,
      updatedAt: r.metaUpdatedAt ?? r.updatedAt,
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
});

// ---- row actions ----

const editSchema = z.object({ name: z.string().trim().min(1).max(200).optional(), dailyBudget: z.number().positive().max(10_000_000).optional(), lifetimeBudget: z.number().positive().max(100_000_000).optional() });

fbAdsRouter.patch('/entities/:kind/:metaId', manage, async (req, res) => {
  const kind = parse(kindParam, req.params.kind);
  const input = parse(editSchema, req.body);
  const metaId = String(req.params.metaId);
  if (kind === 'creative' && (input.dailyBudget || input.lifetimeBudget)) throw badRequest('VALIDATION_ERROR', 'Creatives have no budget.');
  await updateEntity(req.workspace!._id, kind, metaId, { name: input.name, daily_budget: input.dailyBudget ? minor(input.dailyBudget) : undefined, lifetime_budget: input.lifetimeBudget ? minor(input.lifetimeBudget) : undefined }, 'Could not save the changes');
  await audit(req, { workspaceId: req.workspace!._id, action: `fbads.${kind}_updated`, targetType: `fb_${kind}`, targetId: metaId, metadata: input });
  res.json({ ok: true });
});

fbAdsRouter.post('/entities/:kind/:metaId/status', manage, async (req, res) => {
  const kind = parse(z.enum(['campaign', 'adset', 'ad']), req.params.kind);
  const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']) }), req.body);
  const metaId = String(req.params.metaId);
  await updateEntity(req.workspace!._id, kind, metaId, { status }, status === 'ACTIVE' ? 'Could not activate it' : 'Could not pause it');
  await audit(req, { workspaceId: req.workspace!._id, action: `fbads.${kind}_status`, targetType: `fb_${kind}`, targetId: metaId, metadata: { status } });
  res.json({ ok: true });
});

fbAdsRouter.post('/entities/:kind/:metaId/duplicate', manage, async (req, res) => {
  const kind = parse(z.enum(['campaign', 'adset', 'ad']), req.params.kind);
  const id = await duplicateEntity(req.workspace!._id, kind, String(req.params.metaId));
  await audit(req, { workspaceId: req.workspace!._id, action: `fbads.${kind}_duplicated`, targetType: `fb_${kind}`, targetId: id, metadata: { from: req.params.metaId } });
  res.status(201).json({ id });
});

fbAdsRouter.delete('/entities/:kind/:metaId', manage, async (req, res) => {
  const kind = parse(kindParam, req.params.kind);
  const metaId = String(req.params.metaId);
  if (!(await FbEntity.exists({ workspaceId: req.workspace!._id, kind, metaId }))) throw notFound('Not found.');
  await deleteEntity(req.workspace!._id, kind, metaId);
  await audit(req, { workspaceId: req.workspace!._id, action: `fbads.${kind}_deleted`, targetType: `fb_${kind}`, targetId: metaId });
  res.status(204).end();
});

// ---- create ----

export const OBJECTIVES = ['OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_APP_PROMOTION', 'OUTCOME_SALES'] as const;
const statusInput = z.enum(['PAUSED', 'ACTIVE']).default('PAUSED');

const campaignSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the campaign.').max(200),
    objective: z.enum(OBJECTIVES),
    buyingType: z.enum(['AUCTION', 'RESERVED']).default('AUCTION'),
    budgetMode: z.enum(['daily', 'lifetime', 'later']),
    budget: z.number().positive().max(10_000_000).nullable().default(null),
    endTime: z.string().datetime({ offset: true }).nullable().default(null),
    specialAdCategory: z.enum(['NONE', 'HOUSING', 'EMPLOYMENT', 'CREDIT', 'ISSUES_ELECTIONS_POLITICS']).default('NONE'),
    status: statusInput,
  })
  .refine((v) => v.budgetMode === 'later' || !!v.budget, { message: 'Enter the budget.', path: ['budget'] })
  .refine((v) => v.budgetMode !== 'lifetime' || !!v.endTime, { message: 'A lifetime budget needs an end date.', path: ['endTime'] });

fbAdsRouter.post('/campaigns', manage, async (req, res) => {
  const v = parse(campaignSchema, req.body);
  const id = await createAndStore(
    req.workspace!._id,
    'campaign',
    {
      name: v.name,
      objective: v.objective,
      buying_type: v.buyingType,
      status: v.status,
      special_ad_categories: v.specialAdCategory === 'NONE' ? [] : [v.specialAdCategory],
      ...(v.budgetMode === 'daily' ? { daily_budget: minor(v.budget!) } : {}),
      ...(v.budgetMode === 'lifetime' ? { lifetime_budget: minor(v.budget!), stop_time: v.endTime } : {}),
      // Budgets live on the ad sets: Meta needs to know whether they may share.
      ...(v.budgetMode === 'later' ? { is_adset_budget_sharing_enabled: false } : {}),
    },
    'Facebook did not create the campaign',
  );
  await audit(req, { workspaceId: req.workspace!._id, action: 'fbads.campaign_created', targetType: 'fb_campaign', targetId: id, metadata: { name: v.name, objective: v.objective } });
  res.status(201).json({ id });
});

const locationSchema = z.object({ type: z.enum(['country', 'region', 'city']), key: z.string().min(1).max(40), name: z.string().max(200) });
const adsetSchema = z
  .object({
    campaignId: z.string().regex(/^\d+$/, 'Choose a campaign.'),
    name: z.string().trim().min(1, 'Name the ad set.').max(200),
    budgetMode: z.enum(['daily', 'lifetime', 'campaign']).default('campaign'),
    budget: z.number().positive().max(10_000_000).nullable().default(null),
    startTime: z.string().datetime({ offset: true }).nullable().default(null),
    endTime: z.string().datetime({ offset: true }).nullable().default(null),
    locations: z.array(locationSchema).min(1, 'Choose at least one location.').max(50),
    ageMin: z.number().int().min(18).max(65).default(18),
    ageMax: z.number().int().min(18).max(65).default(65),
    gender: z.enum(['all', 'male', 'female']).default('all'),
    interests: z.array(z.object({ id: z.string().min(1).max(40), name: z.string().max(200) })).max(25).default([]),
    placements: z.enum(['auto', 'manual']).default('auto'),
    platforms: z.array(z.enum(['facebook', 'instagram', 'messenger', 'audience_network'])).default([]),
    optimizationGoal: z.enum(['LEAD_GENERATION', 'LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'REACH', 'IMPRESSIONS', 'CONVERSATIONS', 'POST_ENGAGEMENT', 'OFFSITE_CONVERSIONS', 'THRUPLAY']),
    billingEvent: z.enum(['IMPRESSIONS', 'LINK_CLICKS', 'THRUPLAY']).default('IMPRESSIONS'),
    bidStrategy: z.enum(['LOWEST_COST_WITHOUT_CAP', 'COST_CAP', 'LOWEST_COST_WITH_BID_CAP']).default('LOWEST_COST_WITHOUT_CAP'),
    bidAmount: z.number().positive().nullable().default(null),
    status: statusInput,
  })
  .refine((v) => v.budgetMode === 'campaign' || !!v.budget, { message: 'Enter the budget.', path: ['budget'] })
  .refine((v) => v.budgetMode !== 'lifetime' || !!v.endTime, { message: 'A lifetime budget needs an end date.', path: ['endTime'] })
  .refine((v) => v.ageMin <= v.ageMax, { message: 'The minimum age must be below the maximum.', path: ['ageMin'] })
  .refine((v) => v.placements === 'auto' || v.platforms.length > 0, { message: 'Pick at least one placement.', path: ['platforms'] })
  .refine((v) => v.bidStrategy === 'LOWEST_COST_WITHOUT_CAP' || !!v.bidAmount, { message: 'Enter the bid or cost cap.', path: ['bidAmount'] });

fbAdsRouter.post('/adsets', manage, async (req, res) => {
  const v = parse(adsetSchema, req.body);
  const workspaceId = req.workspace!._id;
  const campaign = await FbEntity.findOne({ workspaceId, kind: 'campaign', metaId: v.campaignId, deletedAt: null }).lean();
  if (!campaign) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { campaignId: ['Choose a campaign.'] });
  const campaignBudget = campaign.dailyBudget != null || campaign.lifetimeBudget != null;
  if (!campaignBudget && v.budgetMode === 'campaign') throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { budget: ['This campaign has no budget: set one for the ad set.'] });
  const geo: Record<string, unknown> = {};
  const byType = (t: string) => v.locations.filter((l) => l.type === t);
  if (byType('country').length) geo.countries = byType('country').map((l) => l.key);
  if (byType('region').length) geo.regions = byType('region').map((l) => ({ key: l.key }));
  if (byType('city').length) geo.cities = byType('city').map((l) => ({ key: l.key }));
  const targeting: Record<string, unknown> = {
    geo_locations: geo,
    age_min: v.ageMin,
    age_max: v.ageMax,
    ...(v.gender !== 'all' ? { genders: [v.gender === 'male' ? 1 : 2] } : {}),
    ...(v.interests.length ? { flexible_spec: [{ interests: v.interests }] } : {}),
    ...(v.placements === 'manual' ? { publisher_platforms: v.platforms } : {}),
    targeting_automation: { advantage_audience: 0 },
  };
  const id = await createAndStore(
    workspaceId,
    'adset',
    {
      name: v.name,
      campaign_id: v.campaignId,
      status: v.status,
      targeting,
      optimization_goal: v.optimizationGoal,
      billing_event: v.billingEvent,
      bid_strategy: v.bidStrategy,
      ...(v.bidAmount ? { bid_amount: minor(v.bidAmount) } : {}),
      ...(v.budgetMode === 'daily' ? { daily_budget: minor(v.budget!) } : {}),
      ...(v.budgetMode === 'lifetime' ? { lifetime_budget: minor(v.budget!) } : {}),
      ...(v.startTime ? { start_time: v.startTime } : {}),
      ...(v.endTime ? { end_time: v.endTime } : {}),
    },
    'Facebook did not create the ad set',
  );
  await audit(req, { workspaceId, action: 'fbads.adset_created', targetType: 'fb_adset', targetId: id, metadata: { name: v.name, campaignId: v.campaignId } });
  res.status(201).json({ id });
});

/** Uploads an image (-> hash) or a video (-> id) to the ad account, for a creative. */
const MEDIA = ['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime'];
fbAdsRouter.post('/media', manage, express.raw({ type: MEDIA, limit: '100mb' }), async (req, res) => {
  const mimeType = String(req.headers['content-type'] ?? '').split(';')[0]!;
  if (!MEDIA.includes(mimeType) || !Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('INVALID_MEDIA', 'Upload a JPG or PNG image, or an MP4/MOV video.');
  const fileName = String(req.headers['x-file-name'] ?? 'upload').replace(/[^\w.-]/g, '_').slice(0, 100) || 'upload';
  const workspaceId = req.workspace!._id;
  const { ctx, account } = await requireConnection(workspaceId);
  try {
    if (mimeType.startsWith('image/')) {
      if (req.body.length > 30 * 1024 * 1024) throw badRequest('INVALID_MEDIA', 'Images can be up to 30 MB.');
      const r = await graph<{ images?: Record<string, { hash: string; url?: string }> }>(ctx, { method: 'POST', path: `/${account}/adimages`, params: { bytes: req.body.toString('base64'), name: fileName } });
      const img = Object.values(r.images ?? {})[0];
      if (!img) throw new AppError(502, 'FB_ERROR', 'Facebook did not return the image.');
      return void res.status(201).json({ type: 'image', hash: img.hash, url: img.url ?? null });
    }
    const r = await graph<{ id: string }>(ctx, { method: 'POST', path: `/${account}/advideos`, params: { name: fileName }, file: { field: 'source', data: req.body, mimeType, fileName } });
    res.status(201).json({ type: 'video', videoId: r.id });
  } catch (err) {
    if (err instanceof AppError) throw err;
    await asAppError(workspaceId, err, 'Facebook did not accept the file');
  }
});

export const CTAS = ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'BOOK_NOW', 'CONTACT_US', 'GET_OFFER', 'APPLY_NOW', 'GET_QUOTE', 'WHATSAPP_MESSAGE', 'MESSAGE_PAGE', 'CALL_NOW'] as const;
const creativeSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the creative.').max(200),
    pageId: z.string().regex(/^\d+$/, 'Choose a Facebook Page.'),
    media: z.discriminatedUnion('type', [z.object({ type: z.literal('image'), hash: z.string().min(1) }), z.object({ type: z.literal('video'), videoId: z.string().min(1), thumbnailHash: z.string().min(1, 'Add a thumbnail image for the video.') })]),
    primaryText: z.string().trim().min(1, 'Write the primary text.').max(2000),
    headline: z.string().trim().max(255).default(''),
    description: z.string().trim().max(255).default(''),
    destination: z.enum(['website', 'whatsapp']),
    link: z.string().trim().url().max(1000).nullable().default(null),
    cta: z.enum(CTAS).default('LEARN_MORE'),
  })
  .refine((v) => v.destination === 'whatsapp' || !!v.link, { message: 'Enter the website link.', path: ['link'] });

fbAdsRouter.post('/creatives', manage, async (req, res) => {
  const v = parse(creativeSchema, req.body);
  const whatsapp = v.destination === 'whatsapp';
  const cta = whatsapp ? { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } } : { type: v.cta, value: { link: v.link } };
  const link = whatsapp ? 'https://api.whatsapp.com/send' : v.link!;
  const story =
    v.media.type === 'image'
      ? { page_id: v.pageId, link_data: { image_hash: v.media.hash, link, message: v.primaryText, ...(v.headline ? { name: v.headline } : {}), ...(v.description ? { description: v.description } : {}), call_to_action: cta } }
      : { page_id: v.pageId, video_data: { video_id: v.media.videoId, image_hash: v.media.thumbnailHash, message: v.primaryText, ...(v.headline ? { title: v.headline } : {}), ...(v.description ? { link_description: v.description } : {}), call_to_action: cta } };
  const id = await createAndStore(req.workspace!._id, 'creative', { name: v.name, object_story_spec: story }, 'Facebook did not create the creative');
  await audit(req, { workspaceId: req.workspace!._id, action: 'fbads.creative_created', targetType: 'fb_creative', targetId: id, metadata: { name: v.name, destination: v.destination } });
  res.status(201).json({ id });
});

fbAdsRouter.post('/ads', manage, async (req, res) => {
  const v = parse(z.object({ name: z.string().trim().min(1, 'Name the ad.').max(200), adsetId: z.string().regex(/^\d+$/, 'Choose an ad set.'), creativeId: z.string().regex(/^\d+$/, 'Choose a creative.'), status: statusInput }), req.body);
  const id = await createAndStore(req.workspace!._id, 'ad', { name: v.name, adset_id: v.adsetId, creative: { creative_id: v.creativeId }, status: v.status }, 'Facebook did not create the ad');
  await audit(req, { workspaceId: req.workspace!._id, action: 'fbads.ad_created', targetType: 'fb_ad', targetId: id, metadata: { name: v.name } });
  res.status(201).json({ id });
});

const audienceSchema = z.discriminatedUnion('subtype', [
  z.object({ subtype: z.literal('custom'), name: z.string().trim().min(1).max(200), tagId: z.string().regex(/^[a-f0-9]{24}$/i).nullable().default(null), listId: z.string().regex(/^[a-f0-9]{24}$/i).nullable().default(null) }),
  z.object({ subtype: z.literal('lookalike'), name: z.string().trim().min(1).max(200), sourceAudienceId: z.string().regex(/^\d+$/, 'Choose a source audience.'), country: z.string().length(2).toUpperCase(), percent: z.number().int().min(1).max(10) }),
]);

fbAdsRouter.post('/audiences', manage, async (req, res) => {
  const v = parse(audienceSchema, req.body);
  const workspaceId = req.workspace!._id;
  if (v.subtype === 'custom') {
    const out = await createCustomAudience(workspaceId, v);
    await audit(req, { workspaceId, action: 'fbads.audience_created', targetType: 'fb_audience', targetId: out.id, metadata: { name: v.name, uploaded: out.uploaded } });
    return void res.status(201).json(out);
  }
  const id = await createAndStore(
    workspaceId,
    'audience',
    { name: v.name, subtype: 'LOOKALIKE', origin_audience_id: v.sourceAudienceId, lookalike_spec: JSON.stringify({ type: 'similarity', ratio: v.percent / 100, country: v.country }) },
    'Facebook did not create the lookalike audience',
  );
  await audit(req, { workspaceId, action: 'fbads.audience_created', targetType: 'fb_audience', targetId: id, metadata: { name: v.name, lookalike: v.percent } });
  res.status(201).json({ id, uploaded: 0 });
});

fbAdsRouter.post('/pixels', manage, async (req, res) => {
  const v = parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
  const id = await createAndStore(req.workspace!._id, 'pixel', { name: v.name }, 'Facebook did not create the pixel');
  await audit(req, { workspaceId: req.workspace!._id, action: 'fbads.pixel_created', targetType: 'fb_pixel', targetId: id, metadata: v });
  res.status(201).json({ id });
});

/** The pixel's base code to paste on a website, and what it has received lately. */
fbAdsRouter.get('/pixels/:metaId', view, async (req, res) => {
  const workspaceId = req.workspace!._id;
  const metaId = String(req.params.metaId);
  const pixel = await FbEntity.findOne({ workspaceId, kind: 'pixel', metaId }).lean();
  if (!pixel) throw notFound('Pixel not found.');
  const { ctx } = await requireConnection(workspaceId);
  let events: { event: string; count: number }[] = [];
  try {
    const stats = await graph<{ data?: { data?: { value: string; count: number }[] }[] }>(ctx, { method: 'GET', path: `/${metaId}/stats`, params: { aggregation: 'event' } });
    const totals = new Map<string, number>();
    for (const bucket of stats.data ?? []) for (const e of bucket.data ?? []) totals.set(e.value, (totals.get(e.value) ?? 0) + e.count);
    events = [...totals].map(([event, count]) => ({ event, count })).sort((a, b) => b.count - a.count);
  } catch (err) {
    logger.warn({ err }, 'Pixel stats failed');
  }
  const code = `<!-- Meta Pixel Code -->\n<script>\n!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?\nn.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;\nn.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;\nt.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,\ndocument,'script','https://connect.facebook.net/en_US/fbevents.js');\nfbq('init', '${metaId}');\nfbq('track', 'PageView');\n</script>\n<noscript><img height="1" width="1" style="display:none"\nsrc="https://www.facebook.com/tr?id=${metaId}&ev=PageView&noscript=1"/></noscript>\n<!-- End Meta Pixel Code -->`;
  res.json({ pixel: { id: metaId, name: pixel.name, lastFiredAt: pixel.lastFiredAt ?? null }, code, events });
});

// ---- lookups for the forms ----

fbAdsRouter.get('/pages', manage, async (req, res) => {
  const workspaceId = req.workspace!._id;
  const { ctx } = await requireConnection(workspaceId);
  try {
    const pages = await graphAll<{ id: string; name: string }>(ctx, '/me/accounts', { fields: 'id,name' });
    res.json({ pages: pages.map((p) => ({ id: p.id, name: p.name })) });
  } catch (err) {
    await asAppError(workspaceId, err, 'Could not list your Facebook Pages');
  }
});

fbAdsRouter.get('/search/:type', manage, async (req, res) => {
  const type = parse(z.enum(['interests', 'locations']), req.params.type);
  const { q } = parse(z.object({ q: z.string().trim().min(1).max(100) }), req.query);
  const workspaceId = req.workspace!._id;
  const { ctx } = await requireConnection(workspaceId);
  try {
    if (type === 'interests') {
      const r = await graph<{ data?: { id: string; name: string; audience_size_lower_bound?: number }[] }>(ctx, { method: 'GET', path: '/search', params: { type: 'adinterest', q, limit: 20 } });
      return void res.json({ results: (r.data ?? []).map((i) => ({ id: i.id, name: i.name, size: i.audience_size_lower_bound ?? null })) });
    }
    const r = await graph<{ data?: { key: string; name: string; type: string; country_code?: string; region?: string }[] }>(ctx, { method: 'GET', path: '/search', params: { type: 'adgeolocation', q, location_types: ['country', 'region', 'city'], limit: 20 } });
    res.json({ results: (r.data ?? []).map((l) => ({ key: l.key, name: [l.name, l.region, l.country_code].filter(Boolean).join(', '), type: l.type })) });
  } catch (err) {
    await asAppError(workspaceId, err, 'Search failed');
  }
});

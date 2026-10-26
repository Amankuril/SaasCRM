import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { templateExtrasSchema } from '../templates/templateSend.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { audit } from '../audit/audit.service.js';
import { Contact, LIFECYCLE_STAGES } from '../contacts/contact.model.js';
import { MessageTemplate } from '../templates/template.model.js';
import { CAMPAIGN_STATUSES, Campaign, CampaignRecipient, RECIPIENT_STATUSES, type CampaignDoc } from './campaign.model.js';
import { campaignStats, launchCampaign, previewCampaign, scheduleDispatch } from './campaign.service.js';
import { Segment } from './segment.model.js';

const FIELD_KEYS = /^(name|first_name|phone|email|custom\.[a-z0-9_]{1,40})$/;

const variableSchema = z
  .object({
    source: z.enum(['static', 'field']),
    value: z.string().trim().min(1, 'Choose a value.').max(500),
    fallback: z.string().trim().max(500).default(''),
  })
  .refine((v) => v.source === 'static' || FIELD_KEYS.test(v.value), { message: 'Unknown contact field.', path: ['value'] });

export const audienceFilterInput = z.object({
  tagsAny: z.array(z.string()).max(50).default([]),
  excludeTags: z.array(z.string()).max(50).default([]),
  stages: z.array(z.enum(LIFECYCLE_STAGES)).default([]),
  requireOptIn: z.boolean().default(false),
});

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.');

const campaignInput = z.object({
  name: z.string().trim().min(1, 'Name the campaign.').max(120),
  templateId: z.string().nullable(),
  headerVariables: z.array(variableSchema).max(1),
  bodyVariables: z.array(variableSchema).max(50),
  buttonVariables: z.array(variableSchema).max(10).default([]),
  templateExtras: templateExtrasSchema.nullable().default(null),
  audience: z.object({
    type: z.enum(['all', 'segment', 'filter']),
    segmentId: z.string().nullable().default(null),
    filter: audienceFilterInput.default({}),
  }),
  sendRatePerMinute: z.number().int().min(1).max(1000),
  quietHours: z.object({ enabled: z.boolean(), start: timeOfDay, end: timeOfDay }),
});

const listSchema = z.object({ status: z.enum(CAMPAIGN_STATUSES).optional() });
const recipientsSchema = z.object({
  status: z.enum(RECIPIENT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Mounted at /api/workspaces/:workspaceId/campaigns (workspace already loaded). */
export const campaignRouter = Router({ mergeParams: true });

campaignRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const { status } = parse(listSchema, req.query);
  const workspaceId = req.workspace!._id;
  const campaigns = await Campaign.find({ workspaceId, ...(status ? { status } : {}) }).sort({ createdAt: -1 }).limit(200);
  const stats = await campaignStats(workspaceId, campaigns.map((c) => c._id));
  res.json({ campaigns: campaigns.map((c) => serialize(c, stats.get(c.id as string))) });
});

campaignRouter.post('/', requirePermission('campaigns:manage'), async (req, res) => {
  const input = parse(campaignInput.partial().required({ name: true }), req.body);
  const campaign = await Campaign.create({ workspaceId: req.workspace!._id, createdBy: req.user!._id, ...(await normalize(req.workspace!._id, input)) });
  res.status(201).json({ campaign: serialize(campaign) });
});

campaignRouter.get('/:campaignId', requirePermission('workspace:read'), async (req, res) => {
  const campaign = await findCampaign(req.workspace!._id, req.params.campaignId);
  const stats = await campaignStats(req.workspace!._id, [campaign._id]);
  res.json({ campaign: serialize(campaign, stats.get(campaign.id as string)) });
});

campaignRouter.patch('/:campaignId', requirePermission('campaigns:manage'), async (req, res) => {
  const campaign = await findCampaign(req.workspace!._id, req.params.campaignId);
  if (campaign.status !== 'draft') throw conflict('CAMPAIGN_NOT_DRAFT', 'Only drafts can be edited.');
  const input = parse(campaignInput.partial(), req.body);
  campaign.set(await normalize(req.workspace!._id, input));
  await campaign.save();
  res.json({ campaign: serialize(campaign) });
});

campaignRouter.delete('/:campaignId', requirePermission('campaigns:manage'), async (req, res) => {
  const campaign = await findCampaign(req.workspace!._id, req.params.campaignId);
  if (campaign.status !== 'draft') throw conflict('CAMPAIGN_NOT_DRAFT', 'Only drafts can be deleted. Cancel a running campaign instead.');
  await Campaign.deleteOne({ _id: campaign._id, workspaceId: req.workspace!._id });
  res.status(204).end();
});

campaignRouter.post('/:campaignId/preview', requirePermission('workspace:read'), async (req, res) => {
  const campaign = await findCampaign(req.workspace!._id, req.params.campaignId);
  res.json({ preview: await previewCampaign(req.workspace!, campaign) });
});

campaignRouter.post('/:campaignId/launch', requirePermission('campaigns:manage'), async (req, res) => {
  const { scheduledAt } = parse(z.object({ scheduledAt: z.string().datetime().nullable().default(null) }), req.body);
  const campaign = await findCampaign(req.workspace!._id, req.params.campaignId);
  await launchCampaign(req.workspace!, campaign, req.user!, scheduledAt ? new Date(scheduledAt) : null);
  await audit(req, {
    workspaceId: req.workspace!._id,
    action: 'campaign.launched',
    targetType: 'campaign',
    targetId: campaign.id,
    metadata: { name: campaign.name, scheduledAt: campaign.scheduledAt },
  });
  const stats = await campaignStats(req.workspace!._id, [campaign._id]);
  res.json({ campaign: serialize((await findCampaign(req.workspace!._id, campaign.id))!, stats.get(campaign.id as string)) });
});

campaignRouter.post('/:campaignId/pause', requirePermission('campaigns:manage'), async (req, res) => {
  const campaign = await transition(req.workspace!._id, req.params.campaignId, ['running', 'scheduled'], 'paused');
  await audit(req, { workspaceId: req.workspace!._id, action: 'campaign.paused', targetType: 'campaign', targetId: campaign.id });
  res.json({ campaign: serialize(campaign) });
});

campaignRouter.post('/:campaignId/resume', requirePermission('campaigns:manage'), async (req, res) => {
  const campaign = await transition(req.workspace!._id, req.params.campaignId, ['paused'], 'running');
  campaign.failureReason = null;
  await campaign.save();
  await scheduleDispatch(campaign, 0);
  await audit(req, { workspaceId: req.workspace!._id, action: 'campaign.resumed', targetType: 'campaign', targetId: campaign.id });
  res.json({ campaign: serialize(campaign) });
});

campaignRouter.post('/:campaignId/cancel', requirePermission('campaigns:manage'), async (req, res) => {
  const campaign = await transition(req.workspace!._id, req.params.campaignId, ['running', 'scheduled', 'paused'], 'cancelled');
  // Messages already accepted by WhatsApp can't be recalled; only pending ones are dropped.
  await CampaignRecipient.updateMany({ workspaceId: req.workspace!._id, campaignId: campaign._id, status: 'pending' }, { status: 'skipped', skipReason: 'cancelled' });
  campaign.completedAt = new Date();
  await campaign.save();
  await audit(req, { workspaceId: req.workspace!._id, action: 'campaign.cancelled', targetType: 'campaign', targetId: campaign.id });
  res.json({ campaign: serialize(campaign) });
});

campaignRouter.get('/:campaignId/recipients', requirePermission('workspace:read'), async (req, res) => {
  const { status, page, limit } = parse(recipientsSchema, req.query);
  const workspaceId = req.workspace!._id;
  const campaign = await findCampaign(workspaceId, req.params.campaignId);
  const filter = { workspaceId, campaignId: campaign._id, ...(status ? { status } : {}) };
  const [rows, total] = await Promise.all([
    CampaignRecipient.find(filter).sort({ _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    CampaignRecipient.countDocuments(filter),
  ]);
  const contacts = await Contact.find({ workspaceId, _id: { $in: rows.map((r) => r.contactId) } }).select('name profileName').lean();
  const nameOf = new Map(contacts.map((c) => [c._id.toString(), c.name || c.profileName || null]));
  res.json({
    recipients: rows.map((r) => ({
      id: r._id.toString(),
      contactId: r.contactId.toString(),
      name: nameOf.get(r.contactId.toString()) ?? null,
      phone: r.phone,
      status: r.status,
      skipReason: r.skipReason,
      error: r.error,
      repliedAt: r.repliedAt,
      updatedAt: r.updatedAt,
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
});

async function findCampaign(workspaceId: Types.ObjectId, id: unknown) {
  const campaign = await Campaign.findOne({ _id: objectId(id, 'Campaign'), workspaceId });
  if (!campaign) throw notFound('Campaign not found.');
  return campaign;
}

async function transition(workspaceId: Types.ObjectId, id: unknown, from: string[], to: string) {
  const campaign = await findCampaign(workspaceId, id);
  if (!from.includes(campaign.status)) throw conflict('INVALID_TRANSITION', `A ${campaign.status} campaign can't be ${to}.`);
  campaign.status = to as CampaignDoc['status'];
  await campaign.save();
  return campaign;
}

/** Validates referenced template / segment / tags belong to this workspace. */
async function normalize(workspaceId: Types.ObjectId, input: Partial<z.infer<typeof campaignInput>>) {
  const out: Record<string, unknown> = { ...input };
  if (input.templateId) {
    if (!Types.ObjectId.isValid(input.templateId) || !(await MessageTemplate.exists({ _id: input.templateId, workspaceId }))) {
      throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { templateId: ['Template not found.'] });
    }
  }
  if (input.audience) {
    if (input.audience.type === 'segment') {
      const ok = input.audience.segmentId && Types.ObjectId.isValid(input.audience.segmentId) && (await Segment.exists({ _id: input.audience.segmentId, workspaceId }));
      if (!ok) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { audience: ['Choose a segment.'] });
    }
    const tagIds = [...input.audience.filter.tagsAny, ...input.audience.filter.excludeTags];
    if (tagIds.some((t) => !Types.ObjectId.isValid(t))) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { audience: ['Unknown tag.'] });
  }
  return out;
}

function serialize(c: CampaignDoc, stats?: Record<string, number>) {
  return {
    id: c.id as string,
    name: c.name,
    status: c.status,
    templateId: c.templateId?.toString() ?? null,
    templateName: (c.templateSnapshot as { name?: string } | null)?.name ?? null,
    headerVariables: c.headerVariables,
    bodyVariables: c.bodyVariables,
    buttonVariables: c.buttonVariables,
    templateExtras: c.templateExtras ?? null,
    audience: {
      type: c.audience?.type ?? 'all',
      segmentId: c.audience?.segmentId?.toString() ?? null,
      filter: {
        tagsAny: (c.audience?.filter?.tagsAny ?? []).map(String),
        excludeTags: (c.audience?.filter?.excludeTags ?? []).map(String),
        stages: c.audience?.filter?.stages ?? [],
        requireOptIn: c.audience?.filter?.requireOptIn ?? false,
      },
    },
    sendRatePerMinute: c.sendRatePerMinute,
    quietHours: c.quietHours,
    scheduledAt: c.scheduledAt,
    launchedAt: c.launchedAt,
    completedAt: c.completedAt,
    failureReason: c.failureReason,
    createdAt: c.createdAt,
    stats: stats ?? { total: 0, replied: 0 },
  };
}

import { Types } from 'mongoose';
import { AppError, badRequest, conflict } from '../../lib/errors.js';
import { assertFeature, hasAccess } from '../billing/billing.service.js';
import { emitEvent } from '../developer/webhook.service.js';
import { logger } from '../../lib/logger.js';
import { enqueue, type JobContext } from '../../jobs/queue.js';
import type { UserDoc } from '../auth/user.model.js';
import { Contact, type ContactDoc } from '../contacts/contact.model.js';
import { buildTemplateContent, queueCampaignMessage } from '../messages/message.service.js';
import { MessageTemplate, type TemplateDoc } from '../templates/template.model.js';
import { checkSendValues, sendRequirements, type TemplateExtras } from '../templates/templateSend.js';
import { getConnection } from '../whatsapp/connection.service.js';
import { Workspace, type WorkspaceDoc } from '../workspaces/workspace.model.js';
import { Campaign, CampaignRecipient, type CampaignDoc } from './campaign.model.js';
import { Segment } from './segment.model.js';
import { Conversation } from '../inbox/conversation.model.js';
import { notify } from '../inbox/conversation.service.js';

export interface AudienceFilter {
  tagsAny?: Types.ObjectId[] | string[];
  listsAny?: Types.ObjectId[] | string[];
  /** Exact contacts (retargeting); never stored, resolved at use. */
  contactIds?: Types.ObjectId[];
  excludeTags?: Types.ObjectId[] | string[];
  stages?: string[];
  requireOptIn?: boolean;
}

export interface VariableSpec {
  source: 'static' | 'field';
  value: string;
  fallback?: string | null;
}

export type RetargetOutcome = 'read' | 'delivered' | 'sent' | 'failed';

/** Recipient statuses behind each retarget choice. "Delivered" means received but not read. */
const RETARGET_STATUSES: Record<RetargetOutcome, string[]> = {
  read: ['read'],
  delivered: ['delivered'],
  sent: ['submitted', 'sent', 'delivered', 'read', 'failed'],
  failed: ['failed'],
};

const ids = (list?: (Types.ObjectId | string)[]) => (list ?? []).map((v) => new Types.ObjectId(String(v)));

/**
 * Contacts matching the targeting rules, BEFORE consent is applied (consent
 * decides whether a matched contact is sent to or skipped with a reason).
 */
export function targetingQuery(workspaceId: Types.ObjectId, filter: AudienceFilter) {
  const query: Record<string, unknown> = { workspaceId };
  const tagCond: Record<string, unknown> = {};
  if (filter.tagsAny?.length) tagCond.$in = ids(filter.tagsAny);
  if (filter.excludeTags?.length) tagCond.$nin = ids(filter.excludeTags);
  if (Object.keys(tagCond).length) query.tags = tagCond;
  if (filter.stages?.length) query.lifecycleStage = { $in: filter.stages };
  if (filter.listsAny?.length) query.lists = { $in: ids(filter.listsAny) };
  if (filter.contactIds) query._id = { $in: filter.contactIds };
  return query;
}

export async function resolveAudienceFilter(workspaceId: Types.ObjectId, campaign: CampaignDoc): Promise<AudienceFilter> {
  if (campaign.audience?.type === 'segment') {
    const segment = campaign.audience.segmentId ? await Segment.findOne({ _id: campaign.audience.segmentId, workspaceId }).lean() : null;
    if (!segment) throw badRequest('SEGMENT_MISSING', 'The selected segment no longer exists.');
    return segment.filter as AudienceFilter;
  }
  if (campaign.audience?.type === 'filter') return campaign.audience.filter as AudienceFilter;
  if (campaign.audience?.type === 'retarget') {
    const { campaignId, outcomes } = campaign.audience.retarget ?? {};
    if (!campaignId || !outcomes?.length) throw badRequest('RETARGET_MISSING', 'Choose the campaign and outcomes to retarget.');
    const statuses = [...new Set((outcomes as RetargetOutcome[]).flatMap((o) => RETARGET_STATUSES[o]))];
    const contactIds = await CampaignRecipient.distinct('contactId', { workspaceId, campaignId, status: { $in: statuses } });
    return { contactIds: contactIds as Types.ObjectId[], requireOptIn: campaign.audience.filter?.requireOptIn ?? false };
  }
  if (campaign.audience?.type === 'list') {
    const filter = campaign.audience.filter as AudienceFilter;
    if (!filter.listsAny?.length) throw badRequest('LIST_MISSING', 'Choose a contact list for this campaign.');
    return { listsAny: filter.listsAny, requireOptIn: filter.requireOptIn };
  }
  return {};
}

/** Why a matched contact won't be messaged, or null if they're eligible. */
function consentSkipReason(contact: Pick<ContactDoc, 'consent'>, filter: AudienceFilter): string | null {
  if (contact.consent?.status === 'opted_out') return 'opted_out';
  if (filter.requireOptIn && contact.consent?.status !== 'opted_in') return 'no_opt_in';
  return null;
}

export function fieldValue(contact: Pick<ContactDoc, 'name' | 'profileName' | 'phoneE164' | 'email' | 'customFields'>, key: string): string {
  const name = contact.name || contact.profileName || '';
  if (key === 'name') return name;
  if (key === 'first_name') return name.split(/\s+/)[0] ?? '';
  if (key === 'phone') return contact.phoneE164;
  if (key === 'email') return contact.email ?? '';
  if (key.startsWith('custom.')) return String(((contact.customFields ?? {}) as Record<string, unknown>)[key.slice(7)] ?? '');
  return '';
}

/** Per-recipient template values; null when a required value is missing (no fallback). */
export function resolveVariables(contact: Parameters<typeof fieldValue>[0], specs: VariableSpec[]): string[] | null {
  const values: string[] = [];
  for (const spec of specs) {
    const raw = spec.source === 'static' ? spec.value : fieldValue(contact, spec.value);
    const value = raw.trim() || (spec.fallback ?? '').trim();
    if (!value) return null;
    values.push(value);
  }
  return values;
}

async function loadTemplate(workspaceId: Types.ObjectId, campaign: CampaignDoc): Promise<TemplateDoc> {
  const template = campaign.templateId ? await MessageTemplate.findOne({ _id: campaign.templateId, workspaceId }) : null;
  if (!template) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { templateId: ['Choose a template.'] });
  return template;
}

function assertVariableCounts(template: TemplateDoc, campaign: CampaignDoc) {
  const req = sendRequirements(template.components as never);
  const details: Record<string, string[]> = {};
  if (campaign.headerVariables.length !== req.header) details.headerVariables = [`Map ${req.header} header variable(s).`];
  if (campaign.bodyVariables.length !== req.body) details.bodyVariables = [`Map ${req.body} body variable(s).`];
  if (campaign.buttonVariables.length !== req.buttons.length) details.buttonVariables = [`Map ${req.buttons.length} button value(s).`];
  // The same-for-everyone values are checked once here; per-contact values are resolved per recipient.
  const placeholder = (n: number) => Array<string>(n).fill('x');
  const extras = checkSendValues(req, {
    headerParams: placeholder(req.header),
    bodyParams: placeholder(req.body),
    buttonParams: placeholder(req.buttons.length),
    extras: (campaign.templateExtras ?? {}) as TemplateExtras,
  });
  Object.assign(details, extras);
  if (Object.keys(details).length) throw badRequest('VALIDATION_ERROR', 'Fill in everything this template needs.', details);
}

const extrasOf = (campaign: CampaignDoc) => (campaign.templateExtras ?? {}) as TemplateExtras;

export interface AudiencePreview {
  matched: number;
  eligible: number;
  skipped: Record<string, number>;
  samples: { contact: string; phone: string; preview: string }[];
}

/** Counts exactly what launch would do, plus a few rendered sample messages. */
export async function previewCampaign(workspace: WorkspaceDoc, campaign: CampaignDoc): Promise<AudiencePreview> {
  const filter = await resolveAudienceFilter(workspace._id, campaign);
  const template = campaign.templateId ? await MessageTemplate.findOne({ _id: campaign.templateId, workspaceId: workspace._id }) : null;
  const result: AudiencePreview = { matched: 0, eligible: 0, skipped: {}, samples: [] };

  const cursor = Contact.find(targetingQuery(workspace._id, filter)).select('name profileName phoneE164 email customFields consent').lean().cursor();
  for await (const contact of cursor) {
    result.matched++;
    const reason = consentSkipReason(contact, filter) ?? (template ? variableSkipReason(contact, campaign) : null);
    if (reason) {
      result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
      continue;
    }
    result.eligible++;
    if (template && result.samples.length < 3) {
      const content = renderContent(template, contact, campaign);
      result.samples.push({ contact: contact.name || contact.profileName || contact.phoneE164, phone: contact.phoneE164, preview: String(content?.preview ?? '') });
    }
  }
  return result;
}

function variableSkipReason(contact: Parameters<typeof fieldValue>[0], campaign: CampaignDoc): string | null {
  return resolveVariables(contact, campaign.headerVariables as VariableSpec[]) &&
    resolveVariables(contact, campaign.bodyVariables as VariableSpec[]) &&
    resolveVariables(contact, campaign.buttonVariables as VariableSpec[])
    ? null
    : 'missing_variable';
}

function renderContent(template: TemplateDoc, contact: Parameters<typeof fieldValue>[0], campaign: CampaignDoc) {
  const header = resolveVariables(contact, campaign.headerVariables as VariableSpec[]);
  const body = resolveVariables(contact, campaign.bodyVariables as VariableSpec[]);
  const buttons = resolveVariables(contact, campaign.buttonVariables as VariableSpec[]);
  if (!header || !body || !buttons) return null;
  try {
    return buildTemplateContent(template, header, body, buttons, extrasOf(campaign));
  } catch {
    // Not fully configured yet: the preview still counts the audience.
    return null;
  }
}

/**
 * Validates and starts (or schedules) a campaign. The audience is evaluated once,
 * now, and stored as recipient rows; later contact changes don't alter it.
 */
export async function launchCampaign(workspace: WorkspaceDoc, campaign: CampaignDoc, user: UserDoc, scheduledAt: Date | null): Promise<CampaignDoc> {
  if (campaign.status !== 'draft') throw conflict('CAMPAIGN_NOT_DRAFT', 'Only draft campaigns can be launched.');
  await assertFeature(workspace._id, 'campaigns');
  const conn = await getConnection(workspace._id);
  if (!conn || conn.status !== 'connected') throw conflict('WHATSAPP_NOT_CONNECTED', 'Connect a working WhatsApp number first.');

  const template = await loadTemplate(workspace._id, campaign);
  if (template.status !== 'APPROVED') {
    throw new AppError(422, 'TEMPLATE_NOT_APPROVED', `Template "${template.name}" is ${template.status.toLowerCase()}, not approved.`);
  }
  assertVariableCounts(template, campaign);
  if (scheduledAt && scheduledAt.getTime() < Date.now() - 60_000) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { scheduledAt: ['Choose a time in the future.'] });

  const filter = await resolveAudienceFilter(workspace._id, campaign);
  const rows: Record<string, unknown>[] = [];
  let eligible = 0;
  const cursor = Contact.find(targetingQuery(workspace._id, filter)).select('name profileName phoneE164 email customFields consent').lean().cursor();
  for await (const contact of cursor) {
    const header = resolveVariables(contact, campaign.headerVariables as VariableSpec[]);
    const body = resolveVariables(contact, campaign.bodyVariables as VariableSpec[]);
    const buttons = resolveVariables(contact, campaign.buttonVariables as VariableSpec[]);
    const skipReason = consentSkipReason(contact, filter) ?? (header && body && buttons ? null : 'missing_variable');
    if (!skipReason) eligible++;
    rows.push({
      workspaceId: workspace._id,
      campaignId: campaign._id,
      contactId: contact._id,
      phone: contact.phoneE164,
      status: skipReason ? 'skipped' : 'pending',
      skipReason,
      headerParams: header ?? [],
      bodyParams: body ?? [],
      buttonParams: buttons ?? [],
    });
  }
  if (eligible === 0) throw new AppError(422, 'NO_ELIGIBLE_RECIPIENTS', 'No contacts in this audience can receive the message.');

  for (let i = 0; i < rows.length; i += 1000) {
    await CampaignRecipient.insertMany(rows.slice(i, i + 1000), { ordered: false });
  }

  const now = new Date();
  const future = scheduledAt && scheduledAt.getTime() > now.getTime() ? scheduledAt : null;
  campaign.set({
    status: future ? 'scheduled' : 'running',
    scheduledAt: future,
    launchedAt: now,
    launchedBy: user._id,
    templateSnapshot: { id: template.id, name: template.name, language: template.language, category: template.category, components: template.components },
    audienceSnapshot: { type: campaign.audience?.type, filter },
  });
  await campaign.save();
  await scheduleDispatch(campaign, future ? future.getTime() - now.getTime() : 0);
  return campaign;
}

export async function scheduleDispatch(campaign: CampaignDoc, delayMs: number) {
  await enqueue(
    'campaign.dispatch',
    { workspaceId: campaign.workspaceId.toString(), campaignId: campaign.id as string },
    { jobId: `campaign-${campaign.id}-${Date.now()}`, delayMs },
  );
}

/**
 * Worker: sends the next batch (sendRatePerMinute recipients), then re-schedules
 * itself a minute later until nobody is pending. Recipients are claimed
 * atomically and messages carry an idempotency key, so overlapping or retried
 * runs never send twice.
 */
export async function processCampaignDispatch(data: { workspaceId: string; campaignId: string }, _ctx: JobContext): Promise<void> {
  const workspaceId = new Types.ObjectId(data.workspaceId);
  const campaign = await Campaign.findOne({ _id: data.campaignId, workspaceId });
  if (!campaign) return;

  if (campaign.status === 'scheduled') {
    if (campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now() + 5_000) return; // stale/early job
    campaign.status = 'running';
    await campaign.save();
  }
  if (campaign.status !== 'running') return; // paused, cancelled or done

  const workspace = await Workspace.findById(workspaceId);
  if (!workspace || workspace.status === 'suspended') return pause(campaign, 'Workspace is suspended.');

  if (!(await hasAccess(workspaceId))) return pause(campaign, 'Paused because the subscription is not active. Renew to resume.');

  const waitMs = quietHoursWait(campaign, workspace.timezone);
  if (waitMs > 0) return scheduleDispatch(campaign, waitMs);

  const conn = await getConnection(workspaceId);
  if (!conn || conn.status !== 'connected') return pause(campaign, 'WhatsApp connection needs attention. Fix it, then resume the campaign.');

  const template = campaign.templateSnapshot as { id: string; name: string } | null;
  const liveTemplate = template ? await MessageTemplate.findOne({ _id: template.id, workspaceId }) : null;
  if (!liveTemplate || liveTemplate.status !== 'APPROVED') {
    return pause(campaign, `Template "${template?.name}" is no longer approved.`);
  }

  for (let sent = 0; sent < campaign.sendRatePerMinute; sent++) {
    const recipient = await CampaignRecipient.findOneAndUpdate(
      { workspaceId, campaignId: campaign._id, status: 'pending' },
      { status: 'queued', queuedAt: new Date() },
      { sort: { _id: 1 }, new: true },
    );
    if (!recipient) break;
    try {
      const content = buildTemplateContent(liveTemplate, recipient.headerParams, recipient.bodyParams, recipient.buttonParams, extrasOf(campaign));
      await queueCampaignMessage(workspaceId, recipient, content, `campaign:${campaign.id}:${recipient.contactId}`);
    } catch (err) {
      const code = (err as AppError).code;
      if (code === 'PLAN_LIMIT_REACHED' || code === 'SUBSCRIPTION_INACTIVE') {
        // Out of allowance: put the recipient back and stop until the plan allows more.
        await CampaignRecipient.updateOne({ _id: recipient._id, workspaceId }, { status: 'pending', queuedAt: null });
        return pause(campaign, `${(err as AppError).message} Resume the campaign after upgrading.`);
      }
      logger.error({ err, campaignId: campaign.id }, 'Failed to queue campaign message');
      await CampaignRecipient.updateOne(
        { _id: recipient._id, workspaceId },
        { status: 'failed', error: { code: 'QUEUE_FAILED', title: 'Could not queue', message: (err as Error).message } },
      );
    }
  }

  const remaining = await CampaignRecipient.countDocuments({ workspaceId, campaignId: campaign._id, status: 'pending' });
  if (remaining > 0) return scheduleDispatch(campaign, 60_000);

  const done = await Campaign.updateOne({ _id: campaign._id, workspaceId, status: 'running' }, { status: 'completed', completedAt: new Date() });
  if (done.modifiedCount) {
    await emitEvent(workspaceId, 'campaign.completed', async () => {
      const stats = (await campaignStats(workspaceId, [campaign._id])).get(campaign.id as string) ?? {};
      return { campaign: { id: campaign.id as string, name: campaign.name, completed_at: new Date().toISOString(), recipients: stats.total ?? 0, failed: stats.failed ?? 0, skipped: stats.skipped ?? 0 } };
    });
  }
}

async function pause(campaign: CampaignDoc, reason: string) {
  logger.warn({ campaignId: campaign.id, reason }, 'Campaign paused');
  await Campaign.updateOne({ _id: campaign._id, workspaceId: campaign.workspaceId }, { status: 'paused', failureReason: reason });
}

/** Milliseconds until quiet hours end, or 0 if sending is allowed now. */
export function quietHoursWait(campaign: Pick<CampaignDoc, 'quietHours'>, timezone: string, now = new Date()): number {
  if (!campaign.quietHours?.enabled) return 0;
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const current = Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
  const start = toMin(campaign.quietHours.start ?? '21:00');
  const end = toMin(campaign.quietHours.end ?? '09:00');
  const inQuiet = start <= end ? current >= start && current < end : current >= start || current < end;
  if (!inQuiet) return 0;
  const minutes = (end - current + 24 * 60) % (24 * 60) || 24 * 60;
  return minutes * 60_000;
}

/**
 * A customer replied after a broadcast: if their chat is unassigned and the
 * campaign named teammates, hand it to the next one in turn.
 */
export async function assignCampaignReply(workspaceId: Types.ObjectId, contactId: Types.ObjectId, at: Date): Promise<void> {
  const recipient = await CampaignRecipient.findOne({
    workspaceId,
    contactId,
    status: { $in: ['submitted', 'sent', 'delivered', 'read'] },
    createdAt: { $gte: new Date(at.getTime() - 7 * 24 * 60 * 60 * 1000) },
  })
    .sort({ createdAt: -1 })
    .select('campaignId')
    .lean();
  if (!recipient) return;
  const conv = await Conversation.findOne({ workspaceId, contactId, assigneeId: null }).select('_id').lean();
  if (!conv) return;
  const campaign = await Campaign.findOneAndUpdate(
    { _id: recipient.campaignId, workspaceId, 'assigneeIds.0': { $exists: true } },
    { $inc: { assignCursor: 1 } },
    { new: false },
  ).lean();
  if (!campaign) return;
  const assigneeId = campaign.assigneeIds[(campaign.assignCursor ?? 0) % campaign.assigneeIds.length]!;
  const updated = await Conversation.updateOne({ _id: conv._id, workspaceId, assigneeId: null }, { assigneeId, assignedAt: at });
  if (updated.modifiedCount) notify(workspaceId, conv._id, false);
}

/** Recipient-level counts: the campaign report always reconciles with the rows. */
export async function campaignStats(workspaceId: Types.ObjectId, campaignIds: Types.ObjectId[]) {
  const rows = await CampaignRecipient.aggregate<{ _id: { c: Types.ObjectId; s: string }; count: number; replied: number }>([
    { $match: { workspaceId, campaignId: { $in: campaignIds } } },
    { $group: { _id: { c: '$campaignId', s: '$status' }, count: { $sum: 1 }, replied: { $sum: { $cond: [{ $ifNull: ['$repliedAt', false] }, 1, 0] } } } },
  ]);
  const stats = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const key = r._id.c.toString();
    const s = stats.get(key) ?? { total: 0, replied: 0 };
    s[r._id.s] = r.count;
    s.total = (s.total ?? 0) + r.count;
    s.replied = (s.replied ?? 0) + r.replied;
    stats.set(key, s);
  }
  return stats;
}

import { Router } from 'express';
import type { Types } from 'mongoose';
import { requirePermission } from '../../middleware/workspace.js';
import { logger } from '../../lib/logger.js';
import { Appointment } from '../appointments/appointment.model.js';
import { getEntitlements } from '../billing/billing.service.js';
import { Campaign } from '../campaigns/campaign.model.js';
import { Contact } from '../contacts/contact.model.js';
import { ApiKey, WebhookEndpoint } from '../developer/developer.model.js';
import { Flow } from '../flows/flow.model.js';
import { Conversation } from '../inbox/conversation.model.js';
import { GoogleAccount, SheetCampaign } from '../integrations/sheets.model.js';
import { Message } from '../messages/message.model.js';
import { MessageTemplate } from '../templates/template.model.js';
import { credentialsOf, getConnection } from '../whatsapp/connection.service.js';
import { ProviderError, type AccountHealth } from '../whatsapp/provider/types.js';
import { whatsappProvider } from '../whatsapp/provider/index.js';

const DAY = 86_400_000;

/** Business-initiated conversations Meta allows per rolling 24 hours (null = unlimited). */
const TIER_LIMIT: Record<string, number | null> = { TIER_50: 50, TIER_250: 250, TIER_1K: 1_000, TIER_10K: 10_000, TIER_100K: 100_000, TIER_UNLIMITED: null };
/** Templates a WhatsApp Business Account can hold: 250 until the business is verified, then 6,000. */
const templateQuota = (verification: string | null) => (verification === 'verified' ? 6_000 : 250);

/** Start of today in the workspace's timezone. */
function startOfToday(timeZone: string): Date {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, Number(p.value)])) as Record<string, number>;
  return new Date(now.getTime() - ((parts.hour! * 60 + parts.minute!) * 60 + parts.second!) * 1000 - now.getMilliseconds());
}

async function overview(workspaceId: Types.ObjectId, timeZone: string) {
  const now = Date.now();
  const week = new Date(now - 7 * DAY);
  const outbound = { workspaceId, direction: 'outbound', createdAt: { $gte: week } };
  const [contacts, conversationsToday, conversationsWeek, sent, delivered, read, failed, activeFlows, campaignsRunning, openChats] = await Promise.all([
    Contact.countDocuments({ workspaceId }),
    Conversation.countDocuments({ workspaceId, lastMessageAt: { $gte: startOfToday(timeZone) } }),
    Conversation.countDocuments({ workspaceId, lastMessageAt: { $gte: week } }),
    Message.countDocuments({ ...outbound, status: { $in: ['sent', 'delivered', 'read'] } }),
    Message.countDocuments({ ...outbound, status: { $in: ['delivered', 'read'] } }),
    Message.countDocuments({ ...outbound, status: 'read' }),
    Message.countDocuments({ ...outbound, status: 'failed' }),
    Flow.countDocuments({ workspaceId, status: 'active' }),
    Campaign.countDocuments({ workspaceId, status: { $in: ['running', 'scheduled'] } }),
    Conversation.countDocuments({ workspaceId, status: { $ne: 'resolved' } }),
  ]);
  return { contacts, conversationsToday, conversationsWeek, openChats, messages: { sent, delivered, read, failed }, activeFlows, campaignsRunning };
}

/** Mounted at /api/workspaces/:workspaceId/dashboard (workspace already loaded). */
export const dashboardRouter = Router({ mergeParams: true });

dashboardRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const workspace = req.workspace!;
  const workspaceId = workspace._id;
  const conn = await getConnection(workspaceId, true);

  // Live status from Meta. A failure never breaks the dashboard: the widgets show the error and the last saved values.
  let health: AccountHealth | null = null;
  let metaError: string | null = null;
  if (conn) {
    try {
      health = await whatsappProvider().getAccountHealth(credentialsOf(conn));
      conn.set({ displayPhoneNumber: health.displayPhoneNumber, verifiedName: health.verifiedName, qualityRating: health.qualityRating, messagingLimitTier: health.messagingLimitTier, lastSyncAt: new Date() });
      await conn.save();
    } catch (err) {
      metaError = err instanceof ProviderError ? (err.kind === 'auth' ? 'WhatsApp rejected the saved access token. Reconnect the number on the WhatsApp page.' : `Meta could not be reached: ${err.message}`) : 'Meta could not be reached. Showing the last saved values.';
      if (!(err instanceof ProviderError)) logger.warn({ err, workspaceId: workspaceId.toString() }, 'Dashboard health check failed');
    }
  }

  const dayAgo = new Date(Date.now() - DAY);
  const [stats, entitlements, usedContacts, templates, googleAccounts, sheetAutomations, webhooks, apiKeys] = await Promise.all([
    overview(workspaceId, workspace.timezone || 'UTC'),
    getEntitlements(workspaceId),
    // Business-initiated conversations: distinct customers sent a template in the last 24 hours.
    Message.distinct('contactId', { workspaceId, direction: 'outbound', type: 'template', status: { $ne: 'failed' }, createdAt: { $gte: dayAgo } }),
    MessageTemplate.aggregate<{ _id: string; n: number }>([{ $match: { workspaceId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    GoogleAccount.countDocuments({ workspaceId }),
    SheetCampaign.countDocuments({ workspaceId, status: 'active' }),
    WebhookEndpoint.countDocuments({ workspaceId, status: 'active' }),
    ApiKey.countDocuments({ workspaceId, revokedAt: null }),
  ]);

  const tier = health?.messagingLimitTier ?? conn?.messagingLimitTier ?? null;
  const limit = tier && tier in TIER_LIMIT ? TIER_LIMIT[tier]! : null;
  const unlimited = tier === 'TIER_UNLIMITED';
  const templateCount = (status?: string) => templates.filter((t) => !status || t._id === status).reduce((n, t) => n + t.n, 0);
  const verification = health?.businessVerification ?? null;

  res.json({
    generatedAt: new Date(),
    overview: stats,
    profile: {
      businessName: workspace.name,
      logoUrl: health?.profilePictureUrl ?? null,
      displayName: health?.verifiedName ?? conn?.verifiedName ?? null,
      phoneNumber: health?.displayPhoneNumber ?? conn?.displayPhoneNumber ?? null,
      plan: { name: entitlements.plan.name, status: entitlements.subscription.status, renewsAt: entitlements.subscription.currentPeriodEnd, trialEndsAt: entitlements.subscription.trialEndsAt },
    },
    waba: conn
      ? {
          // Pending: connected but the number isn't registered / approved for sending yet.
          status: conn.status === 'error' ? 'disconnected' : !conn.registeredAt && conn.connectedVia === 'embedded_signup' ? 'pending' : health?.phoneStatus === 'PENDING' ? 'pending' : 'connected',
          wabaId: conn.wabaId,
          wabaName: health?.wabaName ?? null,
          businessVerification: verification,
          accountReview: health?.accountReview ?? null,
          displayNameStatus: health?.nameStatus ?? null,
          lastError: conn.lastError,
          lastSyncAt: conn.lastSyncAt,
        }
      : null,
    health: conn
      ? {
          qualityRating: health?.qualityRating ?? conn.qualityRating ?? null,
          phoneStatus: health?.phoneStatus ?? null,
          canSendMessage: health?.canSendMessage ?? null,
          issues: health?.issues ?? [],
          lastWebhookAt: conn.lastWebhookAt,
        }
      : null,
    limits: {
      tier,
      limit,
      unlimited,
      used: usedContacts.length,
      remaining: unlimited || limit === null ? null : Math.max(0, limit - usedContacts.length),
      templates: { total: templateCount(), approved: templateCount('APPROVED'), pending: templateCount('PENDING'), rejected: templateCount('REJECTED'), quota: templateQuota(verification) },
    },
    connectors: [
      { key: 'google_sheets', name: 'Google Sheets', connected: googleAccounts > 0, detail: googleAccounts > 0 ? `${googleAccounts} account(s) · ${sheetAutomations} active automation(s)` : 'Send messages from new sheet rows', path: 'integrations' },
      { key: 'webhooks', name: 'Webhooks', connected: webhooks > 0, detail: webhooks > 0 ? `${webhooks} active endpoint(s)` : 'Push events to your own systems', path: 'developer' },
      { key: 'meta_ads', name: 'Meta Ads', connected: false, detail: 'Click-to-WhatsApp ad leads are tracked under Flow Builder → Ads', path: 'flows?tab=ads' },
      { key: 'crm', name: 'CRM / API', connected: apiKeys > 0, detail: apiKeys > 0 ? `${apiKeys} API key(s) in use` : 'Sync contacts and messages with your CRM over the API', path: 'developer' },
    ],
    metaError,
  });
});

/** Things that need attention, for the bell in the top bar. Derived live, nothing is stored. */
dashboardRouter.get('/notifications', requirePermission('workspace:read'), async (req, res) => {
  const workspace = req.workspace!;
  const workspaceId = workspace._id;
  const now = new Date();
  const week = new Date(now.getTime() - 7 * DAY);
  const [conn, e, unassigned, waiting, failedCampaigns, rejectedTemplates, appointments] = await Promise.all([
    getConnection(workspaceId),
    getEntitlements(workspaceId),
    Conversation.countDocuments({ workspaceId, status: { $ne: 'resolved' }, assigneeId: null, unreadCount: { $gt: 0 } }),
    Conversation.countDocuments({ workspaceId, status: { $ne: 'resolved' }, awaitingHuman: true }),
    Campaign.find({ workspaceId, status: 'failed', updatedAt: { $gte: week } }).sort({ updatedAt: -1 }).limit(3).select('name updatedAt').lean(),
    MessageTemplate.find({ workspaceId, status: 'REJECTED', updatedAt: { $gte: week } }).sort({ updatedAt: -1 }).limit(3).select('name updatedAt').lean(),
    Appointment.countDocuments({ workspaceId, status: { $in: ['scheduled', 'confirmed'] }, startAt: { $gte: now, $lte: new Date(now.getTime() + DAY) } }),
  ]);

  const items: { id: string; tone: 'red' | 'amber' | 'blue'; title: string; detail: string; path: string; at: Date | null }[] = [];
  const s = e.subscription;
  if (!conn) items.push({ id: 'wa-none', tone: 'amber', title: 'Connect your WhatsApp number', detail: 'Messages cannot be sent or received until a number is connected.', path: 'whatsapp', at: null });
  else if (conn.status === 'error') items.push({ id: 'wa-error', tone: 'red', title: 'WhatsApp is disconnected', detail: conn.lastError ?? 'Reconnect the number to resume messaging.', path: 'whatsapp', at: conn.updatedAt });
  else if (conn.qualityRating === 'RED' || conn.qualityRating === 'YELLOW') {
    items.push({ id: `wa-quality-${conn.qualityRating}`, tone: conn.qualityRating === 'RED' ? 'red' : 'amber', title: `Quality rating is ${conn.qualityRating === 'RED' ? 'low' : 'medium'}`, detail: 'Customers are blocking or reporting your messages. Review recent broadcasts.', path: '', at: conn.lastSyncAt ?? null });
  }
  if (!e.access) items.push({ id: `plan-${s.status}`, tone: 'red', title: 'Subscription inactive', detail: 'Sending, broadcasts and automations are paused. Choose a plan to resume.', path: 'billing', at: s.endedAt ?? null });
  else if (s.status === 'past_due') items.push({ id: 'plan-past-due', tone: 'amber', title: 'Payment failed', detail: 'Update your payment to keep the plan active.', path: 'billing', at: null });
  else if (s.status === 'trialing' && s.trialEndsAt && s.trialEndsAt.getTime() - now.getTime() < 5 * DAY) {
    items.push({ id: 'plan-trial', tone: 'amber', title: `Trial ends in ${Math.max(0, Math.ceil((s.trialEndsAt.getTime() - now.getTime()) / DAY))} day(s)`, detail: 'Choose a plan to keep sending.', path: 'billing', at: null });
  }
  if (waiting > 0) items.push({ id: `chats-waiting-${waiting}`, tone: 'red', title: `${waiting} chat(s) waiting for a human`, detail: 'A flow or the AI agent handed these over to your team.', path: 'inbox?v=waiting', at: null });
  if (unassigned > 0) items.push({ id: `chats-unassigned-${unassigned}`, tone: 'blue', title: `${unassigned} unassigned chat(s) with new messages`, detail: 'Nobody has picked these up yet.', path: 'inbox?v=unassigned', at: null });
  for (const c of failedCampaigns) items.push({ id: `campaign-${c._id.toString()}`, tone: 'red', title: `Broadcast failed: ${c.name}`, detail: 'Open the broadcast to see why and retry.', path: `broadcast/campaigns/${c._id.toString()}`, at: c.updatedAt });
  for (const t of rejectedTemplates) items.push({ id: `template-${t._id.toString()}`, tone: 'amber', title: `Template rejected: ${t.name}`, detail: 'Meta did not approve this template. Edit and resubmit it.', path: 'templates', at: t.updatedAt });
  if (appointments > 0) items.push({ id: `appointments-${appointments}`, tone: 'blue', title: `${appointments} appointment(s) in the next 24 hours`, detail: 'See who is coming in.', path: 'flows?tab=appointments', at: null });

  res.json({ notifications: items });
});

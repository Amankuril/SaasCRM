import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import type { JobContext } from '../../jobs/queue.js';
import { mailer } from '../../services/mailer.js';
import { User } from '../auth/user.model.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { Workspace } from '../workspaces/workspace.model.js';
import { Subscription, type SubscriptionDoc } from './billing.model.js';
import { getPlan, refreshState } from './billing.service.js';

const DAY = 86_400_000;
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : 'none');

interface Notice {
  key: string;
  subject: string;
  text: string;
}

/** Which reminder (if any) a subscription is due for right now. Keys make each one send once. */
export async function dueNotices(sub: SubscriptionDoc, now = new Date()): Promise<Notice[]> {
  const plan = await getPlan(sub.planCode);
  const billingUrl = `${env.APP_URL}/w/${sub.workspaceId.toString()}/billing`;
  const notices: Notice[] = [];
  const left = (d: Date) => Math.ceil((d.getTime() - now.getTime()) / DAY);

  if (sub.status === 'trialing' && sub.trialEndsAt) {
    const days = left(sub.trialEndsAt);
    if (days <= 1) notices.push({ key: `trial_1d:${day(sub.trialEndsAt)}`, subject: 'Your Zeta Connect trial ends tomorrow', text: `Your free trial ends on ${day(sub.trialEndsAt)}. Choose a plan to keep your automations and broadcasts running: ${billingUrl}` });
    else if (days <= 3) notices.push({ key: `trial_3d:${day(sub.trialEndsAt)}`, subject: `Your Zeta Connect trial ends in ${days} days`, text: `Your free trial ends on ${day(sub.trialEndsAt)}. Pick a plan any time: ${billingUrl}` });
  }
  if (sub.status === 'expired') {
    notices.push({ key: `expired:${day(sub.endedAt)}`, subject: 'Your Zeta Connect trial has ended', text: `Sending is paused, but your contacts and history are safe. Choose a plan to continue: ${billingUrl}` });
  }
  if (sub.status === 'past_due') {
    notices.push({ key: `past_due:${day(sub.currentPeriodStart)}`, subject: 'Payment failed for your Zeta Connect subscription', text: `We couldn't charge your ${plan.name} renewal. Everything keeps working until ${day(sub.graceEndsAt)}. Update payment here: ${billingUrl}` });
  }
  if (sub.status === 'suspended') {
    notices.push({ key: `suspended:${day(sub.graceEndsAt)}`, subject: 'Sending is paused on Zeta Connect', text: `Your subscription payment is overdue, so sending, broadcasts and automations are paused. Data export still works. Renew here: ${billingUrl}` });
  }
  if (sub.status === 'active' && !sub.cancelAtPeriodEnd && sub.cycle === 'yearly' && left(sub.currentPeriodEnd) <= 7) {
    notices.push({ key: `renewal_7d:${day(sub.currentPeriodEnd)}`, subject: 'Your Zeta Connect plan renews soon', text: `Your yearly ${plan.name} plan renews on ${day(sub.currentPeriodEnd)}. Manage billing: ${billingUrl}` });
  }
  if (sub.status === 'active' && sub.cancelAtPeriodEnd && left(sub.currentPeriodEnd) <= 3) {
    notices.push({ key: `ending_3d:${day(sub.currentPeriodEnd)}`, subject: 'Your Zeta Connect plan is ending', text: `Your plan ends on ${day(sub.currentPeriodEnd)} as requested. Changed your mind? ${billingUrl}` });
  }
  return notices.filter((n) => !sub.notices.includes(n.key));
}

async function ownerEmails(workspaceId: Types.ObjectId): Promise<string[]> {
  const owners = await WorkspaceMember.find({ workspaceId, role: 'owner' }).select('userId').lean();
  const users = await User.find({ _id: { $in: owners.map((o) => o.userId) } }).select('email').lean();
  return users.map((u) => u.email);
}

/**
 * Hourly durable job: applies time-based transitions (trial end, grace end,
 * scheduled cancellations) and sends billing reminders. Safe to run any time.
 */
export async function processBillingSweep(_data: unknown = {}, _ctx?: JobContext, now = new Date()): Promise<{ checked: number; notices: number }> {
  // Deliberate cross-tenant scan: billing runs for every workspace.
  const subs = await Subscription.find({
    $or: [
      { status: { $in: ['trialing', 'past_due', 'suspended', 'expired'] } },
      { status: 'active', currentPeriodEnd: { $lte: new Date(now.getTime() + 7 * DAY) } },
    ],
  })
    .setOptions({ skipTenantScope: true })
    .limit(5_000);

  let sent = 0;
  for (const sub of subs) {
    try {
      await refreshState(sub, now);
      const notices = await dueNotices(sub, now);
      if (!notices.length) continue;
      const workspace = await Workspace.findById(sub.workspaceId).select('name').lean();
      const to = await ownerEmails(sub.workspaceId as unknown as Types.ObjectId);
      for (const n of notices) {
        for (const email of to) await mailer.send({ to: email, subject: `${n.subject}${workspace ? ` (${workspace.name})` : ''}`, text: n.text });
        sent++;
      }
      await Subscription.updateOne({ _id: sub._id, workspaceId: sub.workspaceId }, { $addToSet: { notices: { $each: notices.map((n) => n.key) } } });
    } catch (err) {
      logger.error({ err, workspaceId: sub.workspaceId.toString() }, 'Billing sweep failed for a workspace');
    }
  }
  return { checked: subs.length, notices: sent };
}

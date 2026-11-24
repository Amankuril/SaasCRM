import type { Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { PlatformSettingsDoc } from '../admin/admin.model.js';
import { platformSettings } from '../admin/admin.service.js';
import { Invoice } from '../billing/billing.model.js';
import { nextInvoiceNumber } from '../billing/billing.service.js';
import { billingProvider, type OneTimePayment } from '../billing/provider.js';
import type { WorkspaceDoc } from '../workspaces/workspace.model.js';
import { FeatureUnlock } from './reminder.model.js';

/** Price, discount and wording all come from Super Admin settings; nothing is fixed in the UI. */
export function reminderOffer(s: PlatformSettingsDoc) {
  const d = s.dateReminders;
  const price = d?.price ?? 0;
  const comparePrice = d?.comparePrice ?? 0;
  return {
    enabled: d?.enabled ?? true,
    paid: d?.paid ?? false,
    title: d?.title ?? 'One-time unlock',
    price,
    comparePrice,
    currency: d?.currency ?? 'INR',
    discountPercent: comparePrice > price && price > 0 ? Math.round(((comparePrice - price) / comparePrice) * 100) : 0,
    benefits: d?.benefits ?? [],
    buttonLabel: d?.buttonLabel ?? 'Unlock now',
    scope: d?.scope ?? 'owner',
  };
}

export async function reminderAccess(workspace: Pick<WorkspaceDoc, '_id' | 'createdBy'>) {
  const offer = reminderOffer(await platformSettings());
  const unlock = await FeatureUnlock.findOne({
    feature: 'date_reminders',
    status: 'unlocked',
    $or: [{ workspaceId: workspace._id }, ...(workspace.createdBy ? [{ ownerUserId: workspace.createdBy }] : [])],
  })
    .setOptions({ skipTenantScope: true })
    .lean();
  return { enabled: offer.enabled, unlocked: offer.enabled && (!offer.paid || !!unlock), source: unlock?.source ?? null, unlockedAt: unlock?.unlockedAt ?? null, offer };
}

/** Creating, importing and activating need the unlock; reminders already running keep running. */
export async function assertReminderAccess(workspace: WorkspaceDoc): Promise<void> {
  const access = await reminderAccess(workspace);
  if (!access.enabled) throw new AppError(403, 'FEATURE_DISABLED', 'Date reminders are turned off on this platform.');
  if (!access.unlocked) throw new AppError(402, 'FEATURE_LOCKED', 'Unlock Date reminders to continue.');
}

export async function startUnlock(workspace: WorkspaceDoc) {
  const access = await reminderAccess(workspace);
  if (access.unlocked) throw new AppError(409, 'ALREADY_UNLOCKED', 'Date reminders are already unlocked.');
  const provider = billingProvider();
  if (!provider.createOrder) throw new AppError(503, 'BILLING_NOT_CONFIGURED', 'Online payments are not set up yet. Contact support.');
  const { price, currency, scope } = access.offer;
  const order = await provider.createOrder({ amount: price, currency, receipt: `rem_${workspace.id as string}`, notes: { workspace_id: workspace.id as string, feature: 'date_reminders' } });
  await FeatureUnlock.findOneAndUpdate(
    { workspaceId: workspace._id, feature: 'date_reminders' },
    { $set: { status: 'pending', source: 'purchase', ownerUserId: scope === 'owner' ? workspace.createdBy : null, amount: price, currency, provider: provider.name, providerOrderId: order.orderId, providerPaymentId: null, unlockedAt: null } },
    { upsert: true },
  );
  return { ...order, provider: provider.name };
}

/** Marks the order paid exactly once (browser confirmation and webhook may both arrive). */
export async function completeUnlock(payment: OneTimePayment): Promise<boolean> {
  const unlock = await FeatureUnlock.findOneAndUpdate(
    { providerOrderId: payment.orderId, status: 'pending' },
    { $set: { status: 'unlocked', providerPaymentId: payment.paymentId, unlockedAt: new Date() } },
    { new: true },
  ).setOptions({ skipTenantScope: true });
  if (!unlock) return false;
  try {
    await Invoice.create({
      workspaceId: unlock.workspaceId,
      number: await nextInvoiceNumber(unlock.workspaceId as unknown as Types.ObjectId),
      planCode: 'date_reminders',
      cycle: 'one_time',
      amount: payment.amount || unlock.amount,
      currency: payment.currency || unlock.currency,
      status: 'paid',
      provider: unlock.provider ?? 'razorpay',
      providerPaymentId: payment.paymentId,
      paidAt: new Date(),
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) logger.error({ err }, 'Could not record the unlock invoice');
  }
  return true;
}

export async function pendingOrder(workspaceId: Types.ObjectId) {
  return FeatureUnlock.findOne({ workspaceId, feature: 'date_reminders', status: 'pending' });
}

export async function grantUnlock(workspaceId: Types.ObjectId, unlocked: boolean): Promise<void> {
  await FeatureUnlock.findOneAndUpdate(
    { workspaceId, feature: 'date_reminders' },
    { $set: { status: unlocked ? 'unlocked' : 'revoked', source: 'granted', ownerUserId: null, unlockedAt: unlocked ? new Date() : null } },
    { upsert: true },
  );
}

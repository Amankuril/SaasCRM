import type { Types } from 'mongoose';
import { Campaign, CampaignRecipient } from '../campaigns/campaign.model.js';
import { Contact } from '../contacts/contact.model.js';

const SENT = ['submitted', 'sent', 'delivered', 'read'];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Remembers how a contact's chat started, once: a click-to-WhatsApp ad, a reply
 * within a week of a broadcast, or a direct message.
 */
export async function recordAttribution(workspaceId: Types.ObjectId, contactId: Types.ObjectId, content: Record<string, unknown>, at: Date): Promise<void> {
  const current = await Contact.findOne({ _id: contactId, workspaceId }).select('attribution').lean();
  if (current?.attribution?.source) return;

  const referral = content.referral as { headline?: string; body?: string } | undefined;
  let attribution: Record<string, unknown> = { source: 'direct', campaignId: null, campaignName: null, adTitle: null, at };
  if (referral) {
    attribution = { ...attribution, source: 'ad', adTitle: (referral.headline || referral.body || '').slice(0, 200) || null };
  } else {
    const recipient = await CampaignRecipient.findOne({ workspaceId, contactId, status: { $in: SENT }, createdAt: { $gte: new Date(at.getTime() - WEEK_MS) } })
      .sort({ createdAt: -1 })
      .select('campaignId')
      .lean();
    const campaign = recipient ? await Campaign.findOne({ _id: recipient.campaignId, workspaceId }).select('name').lean() : null;
    if (campaign) attribution = { ...attribution, source: 'broadcast', campaignId: campaign._id, campaignName: campaign.name };
  }
  await Contact.updateOne({ _id: contactId, workspaceId, 'attribution.source': null }, { attribution });
}

/**
 * "Sync Campaigns": backfills chat sources for contacts from before tracking
 * existed. Anyone who replied to a broadcast becomes a broadcast lead (unless an
 * ad brought them); others who wrote in are direct.
 */
export async function syncCampaignAttribution(workspaceId: Types.ObjectId): Promise<{ broadcast: number; direct: number }> {
  const replied = await CampaignRecipient.find({ workspaceId, repliedAt: { $ne: null } })
    .sort({ repliedAt: 1 })
    .select('contactId campaignId repliedAt')
    .lean();
  const first = new Map<string, (typeof replied)[number]>();
  for (const r of replied) if (!first.has(r.contactId.toString())) first.set(r.contactId.toString(), r);
  const names = new Map(
    (await Campaign.find({ workspaceId, _id: { $in: [...new Set([...first.values()].map((r) => r.campaignId.toString()))] } }).select('name').lean()).map((c) => [c._id.toString(), c.name]),
  );

  let broadcast = 0;
  const writes = [...first.values()].map((r) => ({
    updateOne: {
      filter: { _id: r.contactId, workspaceId, 'attribution.source': { $in: [null, 'direct'] } },
      update: { $set: { 'attribution.source': 'broadcast', 'attribution.campaignId': r.campaignId, 'attribution.campaignName': names.get(r.campaignId.toString()) ?? null, 'attribution.adTitle': null, 'attribution.at': r.repliedAt ?? null } },
    },
  }));
  if (writes.length) broadcast = (await Contact.bulkWrite(writes)).modifiedCount;

  const direct = await Contact.updateMany({ workspaceId, 'attribution.source': null, lastInboundAt: { $ne: null } }, [
    { $set: { attribution: { source: 'direct', campaignId: null, campaignName: null, adTitle: null, at: '$lastInboundAt' } } },
  ]);
  return { broadcast, direct: direct.modifiedCount };
}

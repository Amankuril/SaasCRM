import type { Types } from 'mongoose';
import { logger } from '../../lib/logger.js';
import { phoneFromWaId, recordInboundContact } from '../contacts/contact.service.js';
import { recordInboundOnConversation, messagePreview } from '../inbox/conversation.service.js';
import { CampaignRecipient } from '../campaigns/campaign.model.js';
import { assignCampaignReply } from '../campaigns/campaign.service.js';
import { Contact } from '../contacts/contact.model.js';
import { apiMessage, contactPayload } from '../developer/serializers.js';
import { emitEvent } from '../developer/webhook.service.js';
import { onInboundMessage } from '../flows/triggers.js';
import { handleFormReply } from '../forms/form.service.js';
import { Workspace } from '../workspaces/workspace.model.js';
import { Message } from '../messages/message.model.js';
import { applyStatusEvent } from '../messages/message.service.js';
import { MessageTemplate } from '../templates/template.model.js';
import { ProviderConnection } from './connection.model.js';
import type { InboundMessageEvent, NormalizedEvent } from './provider/types.js';
import { sandboxEvents } from './provider/sandbox.js';

export interface ProcessResult {
  /** Status receipts whose message is not stored yet (worker still saving the provider id). */
  unmatchedStatuses: number;
  ignored: number;
}

/**
 * Applies normalized provider events. Safe to run more than once for the same
 * events: inbound messages are unique per provider id, statuses only move forward.
 */
export async function processEvents(events: NormalizedEvent[]): Promise<ProcessResult> {
  const result: ProcessResult = { unmatchedStatuses: 0, ignored: 0 };
  const touched = new Map<string, Types.ObjectId>();

  for (const event of events) {
    if (event.kind === 'template_status') {
      // Deliberate cross-tenant lookup: route by the business account id from the webhook.
      const conn = await ProviderConnection.findOne({ wabaId: event.wabaId }).setOptions({ skipTenantScope: true }).lean();
      if (!conn) {
        result.ignored++;
        continue;
      }
      await MessageTemplate.updateOne(
        { workspaceId: conn.workspaceId, providerTemplateId: event.providerTemplateId },
        { status: event.status, rejectedReason: event.reason, syncedAt: new Date() },
      );
      continue;
    }

    // Deliberate cross-tenant lookup: the phone number id tells us which workspace this is.
    const conn = await ProviderConnection.findOne({ phoneNumberId: event.phoneNumberId }).setOptions({ skipTenantScope: true }).lean();
    if (!conn) {
      result.ignored++;
      continue;
    }
    touched.set(conn._id.toString(), conn.workspaceId);

    if (event.kind === 'message') {
      await storeInboundMessage(conn.workspaceId, event);
    } else if (!(await applyStatusEvent(conn.workspaceId, event))) {
      result.unmatchedStatuses++;
    }
  }

  for (const [connectionId, workspaceId] of touched) {
    await ProviderConnection.updateOne({ _id: connectionId, workspaceId }, { lastWebhookAt: new Date() });
  }
  return result;
}

async function storeInboundMessage(workspaceId: Types.ObjectId, event: InboundMessageEvent) {
  const { contact, created } = await recordInboundContact(workspaceId, phoneFromWaId(event.from), event.profileName, event.timestamp);
  let messageId: string;
  let stored;
  try {
    stored = await Message.create({
      workspaceId,
      contactId: contact._id,
      direction: 'inbound',
      type: event.type,
      content: event.content,
      status: 'received',
      providerMessageId: event.providerMessageId,
      receivedAt: event.timestamp,
    });
    messageId = stored.id as string;
  } catch (err) {
    // Redelivered webhook: the message is already stored (and counted).
    if ((err as { code?: number }).code === 11000) return;
    throw err;
  }
  await recordInboundOnConversation(workspaceId, contact._id, messagePreview(event.type, event.content), event.timestamp);
  await applyConsentKeyword(workspaceId, contact._id, event);

  if (created) await emitEvent(workspaceId, 'contact.created', async () => ({ contact: await contactPayload(workspaceId, contact._id) }));
  await emitEvent(workspaceId, 'message.received', async () => ({ message: apiMessage(stored), contact: await contactPayload(workspaceId, contact._id) }));

  // A reply within a week of a broadcast counts as a campaign reply.
  await CampaignRecipient.updateMany(
    {
      workspaceId,
      contactId: contact._id,
      repliedAt: null,
      status: { $in: ['submitted', 'sent', 'delivered', 'read'] },
      createdAt: { $gte: new Date(event.timestamp.getTime() - 7 * 24 * 60 * 60 * 1000) },
    },
    { repliedAt: event.timestamp },
  );
  await assignCampaignReply(workspaceId, contact._id, event.timestamp);

  // WhatsApp Flow replies are form submissions: store and validate them first.
  let form: { formId: string; valid: boolean; data: Record<string, unknown> } | undefined;
  if (event.type === 'interactive' && event.content.interactiveType === 'nfm_reply') {
    const workspace = await Workspace.findById(workspaceId);
    const handled = workspace ? await handleFormReply(workspace, contact, { id: messageId, content: event.content }) : null;
    if (handled) form = { formId: handled.form.id as string, valid: handled.submission.valid, data: (handled.submission.data ?? {}) as Record<string, unknown> };
  }

  await onInboundMessage(workspaceId, contact, { id: messageId, type: event.type, content: event.content, form }, created);
}

const OPT_OUT = /^\s*(stop|unsubscribe|opt[\s-]?out|stop all)\s*[.!]?\s*$/i;
const OPT_IN = /^\s*(start|subscribe|opt[\s-]?in)\s*[.!]?\s*$/i;

/** "STOP" opts a contact out of broadcasts; "START" opts them back in. */
async function applyConsentKeyword(workspaceId: Types.ObjectId, contactId: Types.ObjectId, event: InboundMessageEvent) {
  const text = event.type === 'text' ? String(event.content.text ?? '') : event.type === 'button' ? String(event.content.text ?? '') : '';
  const status = OPT_OUT.test(text) ? 'opted_out' : OPT_IN.test(text) ? 'opted_in' : null;
  if (!status) return;
  const before = await Contact.findOneAndUpdate({ _id: contactId, workspaceId }, { consent: { status, source: 'keyword', updatedAt: event.timestamp } });
  if (status === 'opted_out' && before?.consent?.status !== 'opted_out') {
    await emitEvent(workspaceId, 'contact.opted_out', async () => ({ contact: await contactPayload(workspaceId, contactId), source: 'keyword' }));
  }
}

// The sandbox provider emits simulated receipts straight into the same pipeline.
sandboxEvents.on('events', (events) => {
  processEvents(events).catch((err) => logger.error({ err }, 'Failed to process sandbox events'));
});

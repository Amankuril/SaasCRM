import type { Types } from 'mongoose';
import { logger } from '../../lib/logger.js';
import { phoneFromWaId, recordInboundContact } from '../contacts/contact.service.js';
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
  const contact = await recordInboundContact(workspaceId, phoneFromWaId(event.from), event.profileName, event.timestamp);
  try {
    await Message.create({
      workspaceId,
      contactId: contact._id,
      direction: 'inbound',
      type: event.type,
      content: event.content,
      status: 'received',
      providerMessageId: event.providerMessageId,
      receivedAt: event.timestamp,
    });
  } catch (err) {
    // Redelivered webhook: the message is already stored.
    if ((err as { code?: number }).code !== 11000) throw err;
  }
}

// The sandbox provider emits simulated receipts straight into the same pipeline.
sandboxEvents.on('events', (events) => {
  processEvents(events).catch((err) => logger.error({ err }, 'Failed to process sandbox events'));
});

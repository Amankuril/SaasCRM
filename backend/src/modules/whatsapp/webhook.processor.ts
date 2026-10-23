import type { JobContext } from '../../jobs/queue.js';
import { processEvents } from './events.service.js';
import { parseMetaWebhook } from './provider/metaWebhook.js';
import { WebhookEvent } from './webhookEvent.model.js';

export class UnmatchedStatusError extends Error {
  constructor(count: number) {
    super(`${count} status receipt(s) arrived before their message was stored`);
  }
}

/** Worker: parses a stored webhook and applies its events. */
export async function processWebhookJob(data: { eventId: string }, ctx: JobContext): Promise<void> {
  const event = await WebhookEvent.findById(data.eventId);
  if (!event || event.status === 'processed') return;

  event.attempts += 1;
  try {
    const result = await processEvents(parseMetaWebhook(event.payload));
    // A receipt can beat the send worker saving the provider message id. Retry a few
    // times (processing is idempotent), then give up on those receipts.
    if (result.unmatchedStatuses > 0 && ctx.attempt < ctx.maxAttempts) {
      throw new UnmatchedStatusError(result.unmatchedStatuses);
    }
    event.set({ status: 'processed', processedAt: new Date(), error: null });
    await event.save();
  } catch (err) {
    const final = ctx.attempt >= ctx.maxAttempts;
    event.set({ status: final ? 'failed' : 'pending', error: (err as Error).message });
    await event.save();
    if (!final) throw err;
  }
}

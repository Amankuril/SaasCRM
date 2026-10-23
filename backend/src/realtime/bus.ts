import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Realtime change notifications. Events carry ids only: clients refetch through
 * the API, which applies permissions (an agent never receives previews of chats
 * they cannot see).
 *
 * With BullMQ, workers may run in another process, so events travel over Redis
 * pub/sub to whichever process holds the Socket.io connections.
 */
export type RealtimeEvent =
  | { type: 'conversation.changed'; conversationId: string }
  | { type: 'messages.changed'; conversationId: string }
  | { type: 'contacts.changed' };

type Handler = (workspaceId: string, event: RealtimeEvent) => void;

const CHANNEL = 'zeta:realtime';
const local = new EventEmitter<{ event: [string, RealtimeEvent] }>();
let pub: Redis | undefined;
let sub: Redis | undefined;

const useRedis = () => env.QUEUE_DRIVER === 'bullmq';

export function publish(workspaceId: string, event: RealtimeEvent): void {
  if (!useRedis()) {
    local.emit('event', workspaceId, event);
    return;
  }
  pub ??= new Redis(env.REDIS_URL);
  pub.publish(CHANNEL, JSON.stringify({ workspaceId, event })).catch((err) => logger.warn({ err }, 'Realtime publish failed'));
}

export function subscribe(handler: Handler): void {
  local.on('event', handler);
  if (!useRedis() || sub) return;
  sub = new Redis(env.REDIS_URL);
  void sub.subscribe(CHANNEL);
  sub.on('message', (_channel, raw: string) => {
    try {
      const { workspaceId, event } = JSON.parse(raw) as { workspaceId: string; event: RealtimeEvent };
      local.emit('event', workspaceId, event);
    } catch (err) {
      logger.warn({ err }, 'Bad realtime message');
    }
  });
}

export async function closeRealtime(): Promise<void> {
  await Promise.all([pub?.quit(), sub?.quit()]);
}

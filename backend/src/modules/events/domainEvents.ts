import { Types } from 'mongoose';
import { enqueue } from '../../jobs/queue.js';
import { logger } from '../../lib/logger.js';

/**
 * Internal "something happened to a contact" events. Sequences (triggers, goals and
 * stop conditions) listen to them. They travel through the job queue so they
 * survive a process restart and never slow down the request that caused them.
 * (Outgoing customer webhooks are a separate thing: developer/webhook.service.)
 */
export type DomainEvent =
  | { type: 'contact.created'; contactId: string; source: string | null }
  | { type: 'tag.added'; contactId: string; tagIds: string[] }
  | { type: 'lifecycle.changed'; contactId: string; from: string | null; to: string }
  | { type: 'list.member_added'; contactId: string; listIds: string[] }
  | { type: 'field.changed'; contactId: string; key: string; value: unknown }
  | { type: 'message.inbound'; contactId: string; text: string }
  | { type: 'contact.opted_out'; contactId: string };

type Listener = (workspaceId: Types.ObjectId, events: DomainEvent[]) => Promise<void>;
type Interest = (workspaceId: Types.ObjectId) => Promise<boolean>;

const listeners: Listener[] = [];
const interests: Interest[] = [];
const BATCH = 500;

/** `interest` says cheaply whether this workspace has anything listening, so idle workspaces queue nothing. */
export function onDomainEvents(listener: Listener, interest: Interest): void {
  listeners.push(listener);
  interests.push(interest);
}

const interestCache = new Map<string, { value: boolean; at: number }>();
const CACHE_MS = 5_000;

/** Forget the cached "anyone listening?" answer (e.g. right after a sequence goes live). */
export function resetDomainInterest(workspaceId: Types.ObjectId | string): void {
  interestCache.delete(String(workspaceId));
}

async function interested(workspaceId: Types.ObjectId): Promise<boolean> {
  const key = String(workspaceId);
  const hit = interestCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value = false;
  for (const check of interests) {
    if (await check(workspaceId)) {
      value = true;
      break;
    }
  }
  interestCache.set(key, { value, at: Date.now() });
  return value;
}

/** Never throws: an event problem must not break the change that caused it. */
export async function publishDomainEvents(workspaceId: Types.ObjectId, events: DomainEvent[]): Promise<void> {
  if (!events.length) return;
  try {
    if (!(await interested(workspaceId))) return;
    for (let i = 0; i < events.length; i += BATCH) {
      await enqueue('domain.events', { workspaceId: String(workspaceId), events: events.slice(i, i + BATCH) });
    }
  } catch (err) {
    logger.error({ err, workspaceId: String(workspaceId) }, 'Could not publish domain events');
  }
}

export async function processDomainEvents(data: { workspaceId: string; events: DomainEvent[] }): Promise<void> {
  const workspaceId = new Types.ObjectId(data.workspaceId);
  for (const listener of listeners) {
    try {
      await listener(workspaceId, data.events);
    } catch (err) {
      logger.error({ err, workspaceId: data.workspaceId }, 'Domain event listener failed');
    }
  }
}

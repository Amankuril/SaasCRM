import type { Types } from 'mongoose';
import { publishDomainEvents, type DomainEvent } from '../events/domainEvents.js';
import { Contact } from './contact.model.js';

/**
 * Bulk contact changes (imports, Audience bulk actions, list assignment) bypass
 * document hooks, so they report what changed here: only contacts that really
 * gained a tag / list / stage produce an event.
 */
export async function addToSetWithEvents(
  workspaceId: Types.ObjectId,
  filter: Record<string, unknown>,
  field: 'tags' | 'lists',
  ids: Types.ObjectId[],
): Promise<number> {
  if (!ids.length) return 0;
  const scoped = { ...filter, workspaceId };
  const before = await Contact.find({ workspaceId, $and: [filter, { [field]: { $not: { $all: ids } } }] }).select(field).lean();
  const result = await Contact.updateMany(scoped, { $addToSet: { [field]: { $each: ids } } });
  const events: DomainEvent[] = [];
  for (const c of before) {
    const have = new Set(((c as Record<string, unknown>)[field] as Types.ObjectId[] | undefined ?? []).map(String));
    const added = ids.map(String).filter((id) => !have.has(id));
    if (!added.length) continue;
    events.push(field === 'tags' ? { type: 'tag.added', contactId: String(c._id), tagIds: added } : { type: 'list.member_added', contactId: String(c._id), listIds: added });
  }
  await publishDomainEvents(workspaceId, events);
  return result.modifiedCount;
}

export async function setStageWithEvents(workspaceId: Types.ObjectId, filter: Record<string, unknown>, stage: string): Promise<number> {
  const before = await Contact.find({ workspaceId, $and: [filter, { lifecycleStage: { $ne: stage } }] }).select('lifecycleStage').lean();
  const result = await Contact.updateMany({ workspaceId, _id: { $in: before.map((c) => c._id) } }, { lifecycleStage: stage });
  await publishDomainEvents(
    workspaceId,
    before.map((c) => ({ type: 'lifecycle.changed', contactId: String(c._id), from: c.lifecycleStage ?? null, to: stage })),
  );
  return result.modifiedCount;
}

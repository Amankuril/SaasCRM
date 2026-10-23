import type { Types } from 'mongoose';
import { notFound } from '../../lib/errors.js';
import { publish } from '../../realtime/bus.js';
import { can, type Role } from '../roles.js';
import type { MemberDoc } from '../workspaces/member.model.js';
import { Conversation, type ConversationDoc } from './conversation.model.js';

/** Short, human-readable summary of a message for the conversation list. */
export function messagePreview(type: string, content: Record<string, unknown>): string {
  const c = content as { text?: string; preview?: string; caption?: string; title?: string; template?: { name?: string } };
  if (type === 'template') return c.preview || `Template: ${c.template?.name ?? ''}`;
  if (type === 'interactive' && content.interactiveType === 'nfm_reply') return '📝 Form submitted';
  if (type === 'flow') return `📝 Form: ${String(content.formName ?? '')}`;
  const text = c.text ?? c.caption ?? c.title;
  return (text ? String(text) : `[${type}]`).slice(0, 160);
}

/** Customer wrote in: bump the thread, count it unread, and reopen it if it was resolved. */
export async function recordInboundOnConversation(workspaceId: Types.ObjectId, contactId: Types.ObjectId, preview: string, at: Date) {
  const conv = await Conversation.findOneAndUpdate(
    { workspaceId, contactId },
    {
      $setOnInsert: { workspaceId, contactId, status: 'open', openedAt: at },
      $set: { lastMessageAt: at, lastMessagePreview: preview, lastMessageDirection: 'inbound', lastInboundAt: at },
      $inc: { unreadCount: 1 },
    },
    { upsert: true, new: true },
  );
  await Conversation.updateOne({ _id: conv!._id, workspaceId, status: 'resolved' }, { status: 'open', openedAt: at, resolvedAt: null, firstReplyAt: null });
  notify(workspaceId, conv!._id, true);
  return conv!;
}

/** Business replied: bump the thread. A reply means someone has read it. */
export async function recordOutboundOnConversation(workspaceId: Types.ObjectId, contactId: Types.ObjectId, preview: string, at: Date) {
  const conv = await Conversation.findOneAndUpdate(
    { workspaceId, contactId },
    {
      $setOnInsert: { workspaceId, contactId, status: 'open', openedAt: at },
      $set: { lastMessageAt: at, lastMessagePreview: preview, lastMessageDirection: 'outbound', unreadCount: 0 },
    },
    { upsert: true, new: true },
  );
  notify(workspaceId, conv!._id, true);
  return conv!;
}

/** A message in this contact's thread changed (e.g. delivery status). */
export async function notifyMessagesChanged(workspaceId: Types.ObjectId, contactId: Types.ObjectId) {
  const conv = await Conversation.findOne({ workspaceId, contactId }).select('_id').lean();
  if (conv) publish(workspaceId.toString(), { type: 'messages.changed', conversationId: conv._id.toString() });
}

export function notify(workspaceId: Types.ObjectId, conversationId: Types.ObjectId, messages = false) {
  publish(workspaceId.toString(), { type: 'conversation.changed', conversationId: conversationId.toString() });
  if (messages) publish(workspaceId.toString(), { type: 'messages.changed', conversationId: conversationId.toString() });
}

// ---- Access rules ----
// Owners, admins, managers (and read-only analysts) see every conversation.
// Agents see unassigned conversations and the ones assigned to them.

export function canViewAll(membership: MemberDoc): boolean {
  return can(membership.role as Role, 'conversations:view_all');
}

export function visibilityFilter(membership: MemberDoc) {
  return canViewAll(membership) ? {} : { assigneeId: { $in: [null, membership.userId] } };
}

export async function findVisibleConversation(workspaceId: Types.ObjectId, id: Types.ObjectId, membership: MemberDoc): Promise<ConversationDoc> {
  const conv = await Conversation.findOne({ _id: id, workspaceId, ...visibilityFilter(membership) });
  if (!conv) throw notFound('Conversation not found.');
  return conv;
}

import type { Types } from 'mongoose';
import { Contact } from '../contacts/contact.model.js';
import { Tag } from '../contacts/tag.model.js';

/**
 * Public (snake_case) shapes shared by the REST API and webhook event payloads.
 * Keep them stable: integrations depend on these field names.
 */

type Id = { toString(): string };
const id = (v: Id | null | undefined) => (v ? v.toString() : null);

export function apiContact(
  c: {
    _id: Id;
    phoneE164: string;
    name?: string | null;
    profileName?: string | null;
    email?: string | null;
    lifecycleStage?: string | null;
    customFields?: unknown;
    consent?: { status?: string | null } | null;
    externalId?: string | null;
    source?: string | null;
    createdAt?: Date | null;
    lastInboundAt?: Date | null;
  },
  tagNames: string[] = [],
) {
  return {
    id: c._id.toString(),
    phone: c.phoneE164,
    name: c.name || c.profileName || null,
    whatsapp_name: c.profileName ?? null,
    email: c.email ?? null,
    lifecycle_stage: c.lifecycleStage ?? 'new',
    tags: tagNames,
    custom_fields: (c.customFields ?? {}) as Record<string, string>,
    opt_in_status: c.consent?.status ?? 'unknown',
    external_id: c.externalId ?? null,
    source: c.source ?? null,
    last_inbound_at: c.lastInboundAt ?? null,
    created_at: c.createdAt ?? null,
  };
}

export function apiMessage(m: {
  _id: Id;
  contactId: Id;
  direction: string;
  type: string;
  content?: unknown;
  status: string;
  error?: unknown;
  providerMessageId?: string | null;
  campaignId?: Id | null;
  flowExecutionId?: Id | null;
  aiGenerated?: boolean | null;
  createdAt?: Date | null;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  readAt?: Date | null;
  failedAt?: Date | null;
}) {
  const content = (m.content ?? {}) as Record<string, unknown>;
  return {
    id: m._id.toString(),
    contact_id: m.contactId.toString(),
    direction: m.direction,
    type: m.type,
    text: (content.text as string | undefined) ?? (content.preview as string | undefined) ?? (content.title as string | undefined) ?? null,
    content,
    status: m.status,
    error: m.error ?? null,
    provider_message_id: m.providerMessageId ?? null,
    campaign_id: id(m.campaignId),
    flow_execution_id: id(m.flowExecutionId),
    ai_generated: !!m.aiGenerated,
    created_at: m.createdAt ?? null,
    sent_at: m.sentAt ?? null,
    delivered_at: m.deliveredAt ?? null,
    read_at: m.readAt ?? null,
    failed_at: m.failedAt ?? null,
  };
}

export function apiConversation(c: {
  _id: Id;
  contactId: Id;
  status: string;
  priority?: string | null;
  assigneeId?: Id | null;
  botPaused?: boolean | null;
  unreadCount?: number | null;
  lastMessageAt?: Date | null;
  lastMessagePreview?: string | null;
  openedAt?: Date | null;
  resolvedAt?: Date | null;
}) {
  return {
    id: c._id.toString(),
    contact_id: c.contactId.toString(),
    status: c.status,
    priority: c.priority ?? 'normal',
    assignee_id: id(c.assigneeId),
    bot_paused: !!c.botPaused,
    unread_count: c.unreadCount ?? 0,
    last_message_at: c.lastMessageAt ?? null,
    last_message_preview: c.lastMessagePreview ?? null,
    opened_at: c.openedAt ?? null,
    resolved_at: c.resolvedAt ?? null,
  };
}

/** Contact payload for webhook events (resolves tag names). */
export async function contactPayload(workspaceId: Types.ObjectId, contactId: Types.ObjectId) {
  const contact = await Contact.findOne({ _id: contactId, workspaceId }).lean();
  if (!contact) return null;
  const tags = contact.tags?.length ? await Tag.find({ workspaceId, _id: { $in: contact.tags } }).select('name').lean() : [];
  return apiContact(contact, tags.map((t) => t.name));
}

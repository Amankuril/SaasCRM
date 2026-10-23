import type { InboundMessageEvent, MessageStatus, NormalizedEvent } from './types.js';

/* Shapes of the Meta webhook payload we read (everything else is ignored). */
interface MetaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  [key: string]: unknown;
}
interface MetaStatus {
  id: string;
  status: string;
  timestamp: string;
  errors?: { code: number; title?: string; message?: string; error_data?: { details?: string } }[];
}
interface MetaChange {
  field: string;
  value: {
    metadata?: { phone_number_id: string };
    contacts?: { wa_id: string; profile?: { name?: string } }[];
    messages?: MetaMessage[];
    statuses?: MetaStatus[];
    event?: string;
    message_template_id?: number | string;
    reason?: string;
  };
}
interface MetaPayload {
  object?: string;
  entry?: { id: string; changes?: MetaChange[] }[];
}

const STATUSES = new Set<MessageStatus>(['sent', 'delivered', 'read', 'failed']);

/** Turns a Meta `whatsapp_business_account` webhook into provider-independent events. */
export function parseMetaWebhook(payload: unknown): NormalizedEvent[] {
  const body = payload as MetaPayload;
  if (body?.object !== 'whatsapp_business_account') return [];
  const events: NormalizedEvent[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      if (change.field === 'messages') {
        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;
        const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));

        for (const m of value.messages ?? []) {
          events.push({
            kind: 'message',
            phoneNumberId,
            providerMessageId: m.id,
            from: m.from,
            profileName: names.get(m.from) ?? null,
            timestamp: fromUnix(m.timestamp),
            type: m.type,
            content: messageContent(m),
          });
        }

        for (const s of value.statuses ?? []) {
          if (!STATUSES.has(s.status as MessageStatus)) continue;
          const err = s.errors?.[0];
          events.push({
            kind: 'status',
            phoneNumberId,
            providerMessageId: s.id,
            status: s.status as MessageStatus,
            timestamp: fromUnix(s.timestamp),
            error: err
              ? { code: String(err.code), title: err.title ?? 'Error', message: err.error_data?.details ?? err.message ?? err.title ?? '' }
              : null,
          });
        }
      }

      if (change.field === 'message_template_status_update' && value.message_template_id && value.event) {
        events.push({
          kind: 'template_status',
          wabaId: entry.id,
          providerTemplateId: String(value.message_template_id),
          status: value.event,
          reason: value.reason && value.reason !== 'NONE' ? value.reason : null,
        });
      }
    }
  }
  return events;
}

function fromUnix(ts: string): Date {
  const seconds = Number(ts);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
}

function messageContent(m: MetaMessage): InboundMessageEvent['content'] {
  const part = (m[m.type] ?? {}) as Record<string, unknown>;
  const content: Record<string, unknown> = {};

  switch (m.type) {
    case 'text':
      content.text = part.body;
      break;
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker':
      Object.assign(content, { mediaId: part.id, mimeType: part.mime_type, caption: part.caption, filename: part.filename });
      break;
    case 'interactive': {
      const reply = (part.button_reply ?? part.list_reply ?? part.nfm_reply) as Record<string, unknown> | undefined;
      Object.assign(content, { interactiveType: part.type, replyId: reply?.id, title: reply?.title, response: reply?.response_json });
      break;
    }
    case 'button':
      Object.assign(content, { payload: part.payload, text: part.text });
      break;
    case 'location':
      Object.assign(content, { latitude: part.latitude, longitude: part.longitude, name: part.name, address: part.address });
      break;
    case 'reaction':
      Object.assign(content, { emoji: part.emoji, messageId: part.message_id });
      break;
  }

  // Click-to-WhatsApp ad attribution and reply context, kept for later phases.
  if (m.referral) content.referral = m.referral;
  if (m.context) content.context = m.context;
  return Object.fromEntries(Object.entries(content).filter(([, v]) => v !== undefined));
}

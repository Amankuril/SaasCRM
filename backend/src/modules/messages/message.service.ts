import { Types } from 'mongoose';
import { AppError, badRequest, conflict } from '../../lib/errors.js';
import type { JobContext } from '../../jobs/queue.js';
import { enqueue } from '../../jobs/queue.js';
import { Contact } from '../contacts/contact.model.js';
import { findOrCreateContact, isInServiceWindow, normalizePhone } from '../contacts/contact.service.js';
import { MessageTemplate, templateVariables, type TemplateDoc } from '../templates/template.model.js';
import type { UserDoc } from '../auth/user.model.js';
import { credentialsOf, getConnection, markConnectionAuthError } from '../whatsapp/connection.service.js';
import { ProviderError, whatsappProvider, type OutboundMessage, type StatusEvent, type TemplateComponent } from '../whatsapp/provider/index.js';
import type { WorkspaceDoc } from '../workspaces/workspace.model.js';
import { messagePreview, notifyMessagesChanged, recordOutboundOnConversation } from '../inbox/conversation.service.js';
import { CampaignRecipient } from '../campaigns/campaign.model.js';
import { Message, type MessageDoc, type MessageStatusValue } from './message.model.js';

export type SendInput =
  | { to: string; type: 'text'; text: string }
  | { to: string; type: 'template'; templateId: string; headerParams?: string[]; bodyParams?: string[] }
  | { to: string; type: 'buttons'; text: string; header?: string; footer?: string; buttons: { id: string; title: string }[] }
  | { to: string; type: 'cta_url'; text: string; header?: string; footer?: string; buttonText: string; url: string };

export interface SendOptions {
  flowExecutionId?: Types.ObjectId;
}

/**
 * Validates a send request, stores it as `queued` and hands it to the send worker.
 * Idempotency keys make client retries safe: the same key returns the same message.
 */
export async function queueOutboundMessage(
  workspace: WorkspaceDoc,
  user: UserDoc | null,
  input: SendInput,
  idempotencyKey: string | null,
  options: SendOptions = {},
): Promise<{ message: MessageDoc; duplicate: boolean }> {
  if (idempotencyKey) {
    const existing = await Message.findOne({ workspaceId: workspace._id, idempotencyKey });
    if (existing) return { message: existing, duplicate: true };
  }

  const conn = await getConnection(workspace._id);
  if (!conn) throw conflict('WHATSAPP_NOT_CONNECTED', 'Connect a WhatsApp number before sending messages.');
  if (conn.status !== 'connected') {
    throw conflict('WHATSAPP_CONNECTION_ERROR', 'The WhatsApp connection needs attention. Reconnect it in WhatsApp settings.');
  }

  const phoneE164 = normalizePhone(input.to, workspace.country);
  if (!phoneE164) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { to: ['Enter a valid phone number.'] });
  const contact = await findOrCreateContact(workspace._id, phoneE164, 'manual_send');
  if (contact.consent?.status === 'opted_out') {
    throw new AppError(422, 'CONTACT_OPTED_OUT', 'This contact has opted out of WhatsApp messages.');
  }

  let content: Record<string, unknown>;
  if (input.type !== 'template') {
    if (!isInServiceWindow(contact)) {
      throw new AppError(
        422,
        'OUTSIDE_SERVICE_WINDOW',
        "This customer hasn't messaged you in the last 24 hours. WhatsApp only allows approved templates outside that window.",
      );
    }
    if (input.type === 'text') content = { text: input.text };
    else if (input.type === 'buttons') content = { text: input.text, header: input.header, footer: input.footer, buttons: input.buttons };
    else content = { text: input.text, header: input.header, footer: input.footer, buttonText: input.buttonText, url: input.url };
  } else {
    const template = Types.ObjectId.isValid(input.templateId)
      ? await MessageTemplate.findOne({ _id: input.templateId, workspaceId: workspace._id })
      : null;
    if (!template) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { templateId: ['Template not found.'] });
    content = buildTemplateContent(template, input.headerParams ?? [], input.bodyParams ?? []);
  }

  try {
    const message = await Message.create({
      workspaceId: workspace._id,
      contactId: contact._id,
      direction: 'outbound',
      type: input.type,
      content,
      status: 'queued',
      idempotencyKey,
      sentBy: user?._id ?? null,
      flowExecutionId: options.flowExecutionId ?? null,
    });
    await recordOutboundOnConversation(workspace._id, contact._id, messagePreview(input.type, content), new Date());
    await enqueue('whatsapp.send', { workspaceId: workspace.id as string, messageId: message.id as string }, { jobId: `send-${message.id}` });
    return { message: (await Message.findOne({ _id: message._id, workspaceId: workspace._id }))!, duplicate: false };
  } catch (err) {
    // Two concurrent requests with the same idempotency key: return the winner.
    if ((err as { code?: number }).code === 11000 && idempotencyKey) {
      const existing = await Message.findOne({ workspaceId: workspace._id, idempotencyKey });
      if (existing) return { message: existing, duplicate: true };
    }
    throw err;
  }
}

/**
 * Broadcast send for one contact (templates only, so no 24h-window check). The
 * idempotency key makes a re-run of the same campaign batch return the existing
 * message instead of sending twice.
 */
export async function queueCampaignMessage(
  workspaceId: Types.ObjectId,
  recipient: { _id: Types.ObjectId; contactId: Types.ObjectId; campaignId: Types.ObjectId },
  content: Record<string, unknown>,
  idempotencyKey: string,
): Promise<MessageDoc> {
  const { contactId, campaignId } = recipient;
  let message: MessageDoc;
  try {
    message = await Message.create({ workspaceId, contactId, campaignId, direction: 'outbound', type: 'template', content, status: 'queued', idempotencyKey });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    const existing = (await Message.findOne({ workspaceId, idempotencyKey }))!;
    await CampaignRecipient.updateOne({ _id: recipient._id, workspaceId }, { messageId: existing._id, status: existing.status });
    return existing;
  }
  // Link before sending so every later status change finds its recipient row.
  await CampaignRecipient.updateOne({ _id: recipient._id, workspaceId }, { messageId: message._id });
  await recordOutboundOnConversation(workspaceId, contactId, messagePreview('template', content), new Date());
  await enqueue('whatsapp.send', { workspaceId: workspaceId.toString(), messageId: message.id as string }, { jobId: `send-${message.id}` });
  return message;
}

/** Mirrors a broadcast message's delivery status onto its campaign recipient row. */
async function syncCampaignRecipient(message: MessageDoc) {
  if (!message.campaignId) return;
  await CampaignRecipient.updateOne(
    { workspaceId: message.workspaceId, messageId: message._id },
    { status: message.status, error: message.status === 'failed' ? message.error : null },
  );
}

/** Snapshot of the template + rendered parameters, so history stays accurate if the template changes. */
export function buildTemplateContent(template: TemplateDoc, headerParams: string[], bodyParams: string[]) {
  if (template.status !== 'APPROVED') {
    throw new AppError(422, 'TEMPLATE_NOT_APPROVED', `Template "${template.name}" is ${template.status.toLowerCase()}, not approved.`);
  }
  const components = template.components as TemplateComponent[];
  const expected = templateVariables(components);
  const details: Record<string, string[]> = {};
  if (headerParams.length !== expected.header) details.headerParams = [`This template needs ${expected.header} header value(s).`];
  if (bodyParams.length !== expected.body) details.bodyParams = [`This template needs ${expected.body} body value(s).`];
  if ([...headerParams, ...bodyParams].some((p) => !p.trim())) details.bodyParams = ['Template values cannot be empty.'];
  if (Object.keys(details).length) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', details);

  const render = (text: string | undefined, params: string[]) =>
    (text ?? '').replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? '');
  const header = components.find((c) => c.type === 'HEADER');
  const body = components.find((c) => c.type === 'BODY');

  return {
    template: {
      id: template.id as string,
      name: template.name,
      language: template.language,
      category: template.category,
      components,
    },
    headerParams,
    bodyParams,
    preview: [header?.format === 'TEXT' ? render(header.text, headerParams) : null, render(body?.text, bodyParams)]
      .filter(Boolean)
      .join('\n\n'),
  };
}

/** Worker: sends one queued message through the provider. */
export async function processSendJob(data: { workspaceId: string; messageId: string }, ctx: JobContext): Promise<void> {
  const message = await Message.findOne({ _id: data.messageId, workspaceId: data.workspaceId });
  // Already handled (duplicate job or a retry after success).
  if (!message || message.status !== 'queued') return;

  const fail = async (code: string, title: string, text: string) => {
    message.set({ status: 'failed', failedAt: new Date(), error: { code, title, message: text } });
    await message.save();
    await syncCampaignRecipient(message);
    await notifyMessagesChanged(message.workspaceId, message.contactId);
  };

  const conn = await getConnection(message.workspaceId, true);
  if (!conn || conn.status !== 'connected') {
    return fail('NOT_CONNECTED', 'WhatsApp not connected', 'The WhatsApp connection was removed or needs attention.');
  }
  const contact = await Contact.findOne({ _id: message.contactId, workspaceId: message.workspaceId });
  if (!contact) return fail('CONTACT_MISSING', 'Contact missing', 'The recipient contact no longer exists.');

  const content = message.content as Record<string, unknown>;
  const interactive = { body: String(content.text), header: (content.header as string) || undefined, footer: (content.footer as string) || undefined };
  const outbound: OutboundMessage =
    message.type === 'text'
      ? { type: 'text', to: contact.phoneE164, text: String(content.text) }
      : message.type === 'buttons'
        ? { type: 'buttons', to: contact.phoneE164, ...interactive, buttons: content.buttons as { id: string; title: string }[] }
        : message.type === 'cta_url'
          ? { type: 'cta_url', to: contact.phoneE164, ...interactive, buttonText: String(content.buttonText), url: String(content.url) }
          : {
          type: 'template',
          to: contact.phoneE164,
          template: {
            name: (content.template as { name: string }).name,
            language: (content.template as { language: string }).language,
            headerParams: content.headerParams as string[],
            bodyParams: content.bodyParams as string[],
          },
        };

  message.attempts += 1;
  try {
    const { providerMessageId } = await whatsappProvider().sendMessage(credentialsOf(conn), outbound);
    message.set({ status: 'submitted', providerMessageId, submittedAt: new Date(), error: null });
    await message.save();
    await syncCampaignRecipient(message);
    await Contact.updateOne({ _id: contact._id, workspaceId: contact.workspaceId }, { lastOutboundAt: new Date() });
    await notifyMessagesChanged(message.workspaceId, message.contactId);
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    const errorInfo = { code: err.code ?? err.kind, title: 'Send failed', message: err.message };

    if (err.kind === 'auth') {
      await markConnectionAuthError(conn, err.message);
      return fail(errorInfo.code, 'WhatsApp credentials rejected', err.message);
    }
    if (err.retryable && ctx.attempt < ctx.maxAttempts) {
      message.error = errorInfo;
      await message.save();
      throw err; // retried by the queue with backoff
    }
    return fail(errorInfo.code, err.retryable ? 'Send failed after retries' : 'Send rejected', err.message);
  }
}

const RANK: Record<MessageStatusValue, number> = { queued: 0, submitted: 1, sent: 2, delivered: 3, read: 4, failed: -1, received: -1 };
const TIMESTAMP_FIELD = { sent: 'sentAt', delivered: 'deliveredAt', read: 'readAt', failed: 'failedAt' } as const;

/**
 * Applies a delivery receipt. Receipts can arrive late, twice or out of order
 * (e.g. "read" before "delivered"), so status only moves forward and each
 * timestamp is set once.
 * Returns false when no message matches (the send worker may not have saved
 * the provider id yet).
 */
export async function applyStatusEvent(workspaceId: Types.ObjectId, event: StatusEvent): Promise<boolean> {
  const message = await Message.findOne({ workspaceId, providerMessageId: event.providerMessageId });
  if (!message) return false;

  // Keep the earliest time per field: a "read" can stand in for a missing "delivered"
  // time until the real (earlier) delivery receipt shows up.
  const setEarliest = (field: (typeof TIMESTAMP_FIELD)[keyof typeof TIMESTAMP_FIELD]) => {
    const current = message.get(field) as Date | null;
    if (!current || event.timestamp < current) message.set(field, event.timestamp);
  };
  setEarliest(TIMESTAMP_FIELD[event.status]);
  if (event.status === 'read') setEarliest('deliveredAt');

  const current = message.status as MessageStatusValue;
  if (event.status === 'failed') {
    // A failure only counts if the message wasn't already delivered.
    if (RANK[current] < RANK.delivered && current !== 'failed') {
      message.status = 'failed';
      message.error = event.error ?? { code: 'UNKNOWN', title: 'Failed', message: 'The provider reported a failure.' };
    }
  } else if (current !== 'failed' && RANK[event.status] > RANK[current]) {
    message.status = event.status;
  }

  if (message.isModified()) {
    await message.save();
    await syncCampaignRecipient(message);
    await notifyMessagesChanged(workspaceId, message.contactId);
  }
  return true;
}


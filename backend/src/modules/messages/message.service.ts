import { Types } from 'mongoose';
import { AppError, badRequest, conflict } from '../../lib/errors.js';
import type { JobContext } from '../../jobs/queue.js';
import { enqueue } from '../../jobs/queue.js';
import { Contact } from '../contacts/contact.model.js';
import { findOrCreateContact, isInServiceWindow, normalizePhone } from '../contacts/contact.service.js';
import { MessageTemplate, type TemplateDoc } from '../templates/template.model.js';
import { checkSendValues, pinOfferExpiry, sendRequirements, toSendParams, type TemplateExtras } from '../templates/templateSend.js';
import { Form } from '../forms/form.model.js';
import { newFlowToken } from '../forms/flowToken.js';
import type { UserDoc } from '../auth/user.model.js';
import { credentialsOf, getConnection, markConnectionAuthError } from '../whatsapp/connection.service.js';
import { ProviderError, whatsappProvider, type OutboundMessage, type StatusEvent, type TemplateComponent } from '../whatsapp/provider/index.js';
import type { WorkspaceDoc } from '../workspaces/workspace.model.js';
import { messagePreview, notifyMessagesChanged, recordOutboundOnConversation } from '../inbox/conversation.service.js';
import { CampaignRecipient } from '../campaigns/campaign.model.js';
import { Conversation } from '../inbox/conversation.model.js';
import { Message, type MessageDoc, type MessageStatusValue } from './message.model.js';
import { consume, refund } from '../billing/billing.service.js';
import { apiMessage } from '../developer/serializers.js';
import { emitEvent } from '../developer/webhook.service.js';

export type SendInput =
  | { to: string; type: 'text'; text: string }
  | { to: string; type: 'template'; templateId: string; headerParams?: string[]; bodyParams?: string[]; buttonParams?: string[]; extras?: TemplateExtras }
  | { to: string; type: 'buttons'; text: string; header?: string; footer?: string; buttons: { id: string; title: string }[] }
  | { to: string; type: 'cta_url'; text: string; header?: string; footer?: string; buttonText: string; url: string }
  | { to: string; type: 'flow'; text: string; flowId: string; flowToken: string; ctaText: string; screen: string; formId: string; formName: string }
  | { to: string; type: 'media'; mediaType: 'image' | 'video' | 'document' | 'audio'; link?: string; id?: string; caption?: string; filename?: string }
  | { to: string; type: 'location'; latitude: number; longitude: number; name?: string; address?: string }
  | { to: string; type: 'address_request'; text: string; country: 'IN' | 'SG' };

export interface SendOptions {
  flowExecutionId?: Types.ObjectId;
  aiGenerated?: boolean;
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
  if (contact.blocked) throw new AppError(422, 'CONTACT_BLOCKED', 'This contact is blocked. Unblock them to send messages.');

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
    else if (input.type === 'cta_url') content = { text: input.text, header: input.header, footer: input.footer, buttonText: input.buttonText, url: input.url };
    else if (input.type === 'flow') {
      content = { text: input.text, flowId: input.flowId, flowToken: input.flowToken, ctaText: input.ctaText, screen: input.screen, formId: input.formId, formName: input.formName };
    } else if (input.type === 'media') {
      const { to: _to, type: _type, ...media } = input;
      content = { ...media, ...(input.caption ? { text: input.caption } : {}) };
    } else if (input.type === 'location') {
      const { to: _to, type: _type, ...location } = input;
      content = { ...location, text: `📍 ${input.name || 'Location'}` };
    } else content = { text: input.text, country: input.country };
  } else {
    const template = Types.ObjectId.isValid(input.templateId)
      ? await MessageTemplate.findOne({ _id: input.templateId, workspaceId: workspace._id })
      : null;
    if (!template) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { templateId: ['Template not found.'] });
    content = buildTemplateContent(template, input.headerParams ?? [], input.bodyParams ?? [], input.buttonParams ?? [], input.extras ?? {});
  }

  // Counts against the plan's message allowance (accepted sends, not deliveries).
  await consume(workspace._id, 'messages');
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
      aiGenerated: options.aiGenerated ?? false,
    });
    await recordOutboundOnConversation(workspace._id, contact._id, messagePreview(input.type, content), new Date());
    // A teammate's first reply since the conversation opened (bots and broadcasts don't count).
    if (user) {
      await Conversation.updateOne({ workspaceId: workspace._id, contactId: contact._id, firstReplyAt: null }, { firstReplyAt: new Date() });
      // A person answered a handed-over chat.
      await Conversation.updateOne({ workspaceId: workspace._id, contactId: contact._id, awaitingHuman: true }, { awaitingHuman: false });
    }
    await enqueue('whatsapp.send', { workspaceId: workspace.id as string, messageId: message.id as string }, { jobId: `send-${message.id}` });
    return { message: (await Message.findOne({ _id: message._id, workspaceId: workspace._id }))!, duplicate: false };
  } catch (err) {
    // Two concurrent requests with the same idempotency key: return the winner.
    await refund(workspace._id, 'messages');
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
  const existing = await Message.findOne({ workspaceId, idempotencyKey }).select('_id').lean();
  if (!existing) await consume(workspaceId, 'messages');
  let message: MessageDoc;
  try {
    message = await Message.create({ workspaceId, contactId, campaignId, direction: 'outbound', type: 'template', content, status: 'queued', idempotencyKey });
  } catch (err) {
    if (!existing) await refund(workspaceId, 'messages');
    if ((err as { code?: number }).code !== 11000) throw err;
    const winner = (await Message.findOne({ workspaceId, idempotencyKey }))!;
    await CampaignRecipient.updateOne({ _id: recipient._id, workspaceId }, { messageId: winner._id, status: winner.status });
    return winner;
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
export function buildTemplateContent(template: TemplateDoc, headerParams: string[], bodyParams: string[], buttonParams: string[] = [], rawExtras: TemplateExtras = {}) {
  const extras = pinOfferExpiry(rawExtras);
  if (template.status !== 'APPROVED') {
    throw new AppError(422, 'TEMPLATE_NOT_APPROVED', `Template "${template.name}" is ${template.status.toLowerCase()}, not approved.`);
  }
  const components = template.components as TemplateComponent[];
  const requirements = sendRequirements(components);
  const details = checkSendValues(requirements, { headerParams, bodyParams, buttonParams, extras });
  if (Object.keys(details).length) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', details);

  const render = (text: string | undefined, params: string[]) =>
    (text ?? '').replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? '');
  const header = components.find((c) => c.type === 'HEADER');
  const body = components.find((c) => c.type === 'BODY');
  const bodyText = requirements.otp ? `${extras.otpCode} is your verification code.` : render(body?.text, bodyParams);
  const headerText = header?.format === 'TEXT' ? render(header.text, headerParams) : requirements.headerMedia ? `[${requirements.headerMedia.toLowerCase()}]` : null;

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
    ...(buttonParams.length ? { buttonParams } : {}),
    ...(Object.keys(extras).length ? { extras } : {}),
    preview: [headerText, bodyText].filter(Boolean).join('\n\n'),
  };
}

/** Fresh flow tokens for the template's form buttons, so submissions are matched to our forms. */
async function flowTokensFor(workspaceId: Types.ObjectId, components: TemplateComponent[]): Promise<Map<string, string>> {
  const flowIds = (components.find((c) => c.type === 'BUTTONS')?.buttons ?? []).flatMap((b) => (b.type.toUpperCase() === 'FLOW' && b.flow_id ? [b.flow_id] : []));
  const tokens = new Map<string, string>();
  if (!flowIds.length) return tokens;
  const forms = await Form.find({ workspaceId, providerFlowId: { $in: flowIds } }).select('_id version providerFlowId');
  for (const f of forms) tokens.set(f.providerFlowId!, newFlowToken({ id: f.id as string, version: f.version }));
  return tokens;
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
          : message.type === 'media'
            ? {
                type: 'media',
                to: contact.phoneE164,
                mediaType: content.mediaType as 'image' | 'video' | 'document' | 'audio',
                ...(content.id ? { id: String(content.id) } : { link: String(content.link) }),
                ...(content.caption ? { caption: String(content.caption) } : {}),
                ...(content.filename ? { filename: String(content.filename) } : {}),
              }
          : message.type === 'location'
            ? {
                type: 'location',
                to: contact.phoneE164,
                latitude: Number(content.latitude),
                longitude: Number(content.longitude),
                ...(content.name ? { name: String(content.name) } : {}),
                ...(content.address ? { address: String(content.address) } : {}),
              }
          : message.type === 'address_request'
            ? { type: 'address_request', to: contact.phoneE164, body: String(content.text), country: content.country === 'SG' ? 'SG' : 'IN' }
          : message.type === 'flow'
            ? {
                type: 'flow',
                to: contact.phoneE164,
                ...interactive,
                flowId: String(content.flowId),
                flowToken: String(content.flowToken),
                ctaText: String(content.ctaText),
                screen: String(content.screen),
              }
          : {
          type: 'template',
          to: contact.phoneE164,
          template: toSendParams(
            content.template as { name: string; language: string; components: TemplateComponent[] },
            {
              headerParams: content.headerParams as string[],
              bodyParams: content.bodyParams as string[],
              buttonParams: content.buttonParams as string[] | undefined,
              extras: content.extras as TemplateExtras | undefined,
            },
            await flowTokensFor(message.workspaceId, (content.template as { components?: TemplateComponent[] }).components ?? []),
          ),
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
  const previousStatus = message.status;
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
    if (message.status !== previousStatus) await emitEvent(workspaceId, 'message.status_updated', { message: apiMessage(message), previous_status: previousStatus });
  }
  return true;
}


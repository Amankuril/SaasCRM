import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { Contact } from '../contacts/contact.model.js';
import { Message, type MessageDoc } from './message.model.js';
import { queueOutboundMessage } from './message.service.js';

const sendSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), to: z.string().trim().min(5).max(30), text: z.string().trim().min(1).max(4096) }),
  z.object({
    type: z.literal('template'),
    to: z.string().trim().min(5).max(30),
    templateId: z.string().min(1),
    headerParams: z.array(z.string().max(1024)).max(1).default([]),
    bodyParams: z.array(z.string().max(1024)).max(50).default([]),
  }),
]);

const listSchema = z.object({
  contactId: z.string().optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function serialize(m: MessageDoc, contact?: { phoneE164: string; name?: string | null; profileName?: string | null }) {
  return {
    id: m.id as string,
    contactId: m.contactId.toString(),
    contact: contact ? { phone: contact.phoneE164, name: contact.name ?? contact.profileName } : null,
    direction: m.direction,
    type: m.type,
    content: m.content,
    status: m.status,
    error: m.error,
    providerMessageId: m.providerMessageId,
    createdAt: m.createdAt,
    sentAt: m.sentAt,
    deliveredAt: m.deliveredAt,
    readAt: m.readAt,
    failedAt: m.failedAt,
  };
}

/** Mounted at /api/workspaces/:workspaceId/messages (workspace already loaded). */
export const messageRouter = Router({ mergeParams: true });

messageRouter.post('/', requirePermission('messages:send'), async (req, res) => {
  const input = parse(sendSchema, req.body);
  const key = req.get('idempotency-key')?.trim() || null;
  if (key && key.length > 200) throw badRequest('VALIDATION_ERROR', 'Idempotency-Key is too long.');

  const { message, duplicate } = await queueOutboundMessage(req.workspace!, req.user!, input, key);
  res.status(duplicate ? 200 : 202).json({ message: serialize(message) });
});

messageRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const { contactId, before, limit } = parse(listSchema, req.query);
  const messages = await Message.find({
    workspaceId: req.workspace!._id,
    ...(contactId ? { contactId: objectId(contactId, 'Contact') } : {}),
    ...(before ? { _id: { $lt: objectId(before, 'Cursor') } } : {}),
  })
    .sort({ _id: -1 })
    .limit(limit);

  const contacts = await Contact.find({ workspaceId: req.workspace!._id, _id: { $in: messages.map((m) => m.contactId) } }).lean();
  const byId = new Map(contacts.map((c) => [c._id.toString(), c]));
  res.json({ messages: messages.map((m) => serialize(m, byId.get(m.contactId.toString()))) });
});

import { Router } from 'express';
import { apiConversation, contactPayload } from '../developer/serializers.js';
import { emitEvent } from '../developer/webhook.service.js';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, conflict, forbidden } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { getAgent, runAgent } from '../ai/ai.service.js';
import { audit } from '../audit/audit.service.js';
import { User } from '../auth/user.model.js';
import { Contact, toPublicContact } from '../contacts/contact.model.js';
import { isInServiceWindow } from '../contacts/contact.service.js';
import { Message } from '../messages/message.model.js';
import { queueOutboundMessage } from '../messages/message.service.js';
import { can, type Role } from '../roles.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { CONVERSATION_STATUSES, Conversation, type ConversationDoc } from './conversation.model.js';
import { canViewAll, findVisibleConversation, notify, visibilityFilter } from './conversation.service.js';
import { ConversationNote } from './note.model.js';

const listSchema = z.object({
  view: z.enum(['all', 'mine', 'unassigned']).default('all'),
  status: z.enum([...CONVERSATION_STATUSES, 'all']).default('open'),
  q: z.string().trim().max(100).optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const replySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(4096) }),
  z.object({
    type: z.literal('template'),
    templateId: z.string().min(1),
    headerParams: z.array(z.string().max(1024)).max(1).default([]),
    bodyParams: z.array(z.string().max(1024)).max(50).default([]),
  }),
]);

const updateSchema = z
  .object({
    status: z.enum(CONVERSATION_STATUSES),
    assigneeId: z.string().nullable(),
    priority: z.enum(['normal', 'high']),
    botPaused: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

const timelineSchema = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Mounted at /api/workspaces/:workspaceId/conversations (workspace already loaded). */
export const conversationRouter = Router({ mergeParams: true });

conversationRouter.use(requirePermission('workspace:read'));

conversationRouter.get('/', async (req, res) => {
  const { view, status, q, before, limit } = parse(listSchema, req.query);
  const workspaceId = req.workspace!._id;
  const membership = req.membership!;

  const filter: Record<string, unknown> = { workspaceId, ...visibilityFilter(membership) };
  if (status !== 'all') filter.status = status;
  if (view === 'mine') filter.assigneeId = req.user!._id;
  if (view === 'unassigned') filter.assigneeId = null;
  if (before) filter.lastMessageAt = { $lt: new Date(before) };
  if (q) {
    const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const digits = q.replace(/\D/g, '');
    const matches = await Contact.find({
      workspaceId,
      $or: [{ name: rx }, { profileName: rx }, ...(digits.length >= 3 ? [{ phoneE164: { $regex: digits } }] : [])],
    })
      .select('_id')
      .limit(500)
      .lean();
    filter.contactId = { $in: matches.map((c) => c._id) };
  }

  const conversations = await Conversation.find(filter).sort({ lastMessageAt: -1, _id: -1 }).limit(limit + 1);
  const page = conversations.slice(0, limit);
  res.json({
    conversations: await serializeMany(workspaceId, page),
    nextBefore: conversations.length > limit ? page.at(-1)!.lastMessageAt?.toISOString() ?? null : null,
  });
});

/** Open-conversation counts for the inbox sidebar. */
conversationRouter.get('/counts', async (req, res) => {
  const workspaceId = req.workspace!._id;
  const base = { workspaceId, status: { $in: ['open', 'pending'] }, ...visibilityFilter(req.membership!) };
  const [all, mine, unassigned] = await Promise.all([
    Conversation.countDocuments(base),
    Conversation.countDocuments({ ...base, assigneeId: req.user!._id }),
    Conversation.countDocuments({ ...base, assigneeId: null }),
  ]);
  res.json({ all, mine, unassigned });
});

conversationRouter.get('/:conversationId', async (req, res) => {
  const conv = await visible(req);
  const [serialized] = await serializeMany(req.workspace!._id, [conv]);
  const contact = await Contact.findOne({ _id: conv.contactId, workspaceId: req.workspace!._id });
  res.json({ conversation: serialized, contact: contact ? toPublicContact(contact) : null, canReply: canReply(req, conv) });
});

/** Messages and internal notes, newest page first, returned oldest-to-newest. */
conversationRouter.get('/:conversationId/timeline', async (req, res) => {
  const { before, limit } = parse(timelineSchema, req.query);
  const conv = await visible(req);
  const workspaceId = req.workspace!._id;
  const range = before ? { createdAt: { $lt: new Date(before) } } : {};

  const [messages, notes] = await Promise.all([
    Message.find({ workspaceId, contactId: conv.contactId, ...range }).sort({ createdAt: -1 }).limit(limit).lean(),
    ConversationNote.find({ workspaceId, conversationId: conv._id, ...range }).sort({ createdAt: -1 }).limit(limit).lean(),
  ]);
  const authorIds = [...new Set([...notes.map((n) => n.authorId?.toString()), ...messages.map((m) => m.sentBy?.toString())].filter(Boolean))];
  const users = await User.find({ _id: { $in: authorIds } }).select('name').lean();
  const nameOf = new Map(users.map((u) => [u._id.toString(), u.name]));

  const items = [
    ...messages.map((m) => ({
      kind: 'message' as const,
      id: m._id.toString(),
      createdAt: m.createdAt,
      direction: m.direction,
      type: m.type,
      content: m.content,
      status: m.status,
      error: m.error,
      sentBy: m.sentBy ? (nameOf.get(m.sentBy.toString()) ?? null) : m.aiGenerated ? 'AI' : m.flowExecutionId ? 'Bot' : m.campaignId ? 'Broadcast' : null,
    })),
    ...notes.map((n) => ({
      kind: 'note' as const,
      id: n._id.toString(),
      createdAt: n.createdAt,
      body: n.body,
      author: n.authorId ? (nameOf.get(n.authorId.toString()) ?? 'Unknown') : (n.authorLabel ?? 'System'),
    })),
  ]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);

  res.json({
    items: items.reverse(),
    nextBefore: items.length === limit ? items[0]!.createdAt.toISOString() : null,
  });
});

conversationRouter.post('/:conversationId/read', async (req, res) => {
  const conv = await visible(req);
  if (conv.unreadCount > 0) {
    await Conversation.updateOne({ _id: conv._id, workspaceId: conv.workspaceId }, { unreadCount: 0 });
    notify(conv.workspaceId, conv._id);
  }
  res.status(204).end();
});

conversationRouter.post('/:conversationId/messages', requirePermission('messages:send'), async (req, res) => {
  const input = parse(replySchema, req.body);
  const conv = await visible(req);
  if (!canReply(req, conv)) throw forbidden('This conversation is assigned to someone else.');

  // An agent replying to an unassigned conversation takes ownership of it.
  if (!conv.assigneeId && !canViewAll(req.membership!)) {
    await assign(req, conv, req.user!._id);
  }
  const contact = await Contact.findOne({ _id: conv.contactId, workspaceId: req.workspace!._id });
  if (!contact) throw badRequest('CONTACT_MISSING', 'This contact no longer exists.');

  const key = req.get('idempotency-key')?.trim() || null;
  const { message, duplicate } = await queueOutboundMessage(req.workspace!, req.user!, { ...input, to: contact.phoneE164 }, key);
  res.status(duplicate ? 200 : 202).json({ message: { id: message.id, status: message.status } });
});

/** Suggests a reply for the agent to review; nothing is sent. */
conversationRouter.post('/:conversationId/ai-draft', requirePermission('messages:send'), async (req, res) => {
  const conv = await visible(req);
  if (!canReply(req, conv)) throw forbidden('This conversation is assigned to someone else.');
  const agent = await getAgent(req.workspace!._id, true);
  if (!agent?.enabled) throw conflict('AI_DISABLED', 'Turn on the AI agent in AI settings to get reply suggestions.');
  const last = await Message.findOne({ workspaceId: req.workspace!._id, contactId: conv.contactId, direction: 'inbound' }).sort({ createdAt: -1 }).lean();
  const question = String((last?.content as { text?: string; title?: string } | undefined)?.text ?? (last?.content as { title?: string } | undefined)?.title ?? '');
  if (!question) throw conflict('NOTHING_TO_ANSWER', "The customer hasn't asked anything yet.");
  const decision = await runAgent({ workspace: req.workspace!, agent, question, contactId: conv.contactId, conversationId: conv._id, excludeMessageId: last?._id.toString(), purpose: 'draft' });
  res.json({ draft: decision });
});

conversationRouter.post('/:conversationId/notes', requirePermission('contacts:manage'), async (req, res) => {
  const { body } = parse(z.object({ body: z.string().trim().min(1, 'Write a note.').max(4000) }), req.body);
  const conv = await visible(req);
  const note = await ConversationNote.create({
    workspaceId: conv.workspaceId,
    conversationId: conv._id,
    contactId: conv.contactId,
    authorId: req.user!._id,
    body,
  });
  notify(conv.workspaceId, conv._id, true);
  res.status(201).json({ note: { id: note.id, body: note.body, createdAt: note.createdAt } });
});

conversationRouter.patch('/:conversationId', requirePermission('messages:send'), async (req, res) => {
  const input = parse(updateSchema, req.body);
  const conv = await visible(req);
  const userId = req.user!._id;
  const canAssignOthers = can(req.membership!.role as Role, 'conversations:assign');

  if (input.assigneeId !== undefined) {
    const target = input.assigneeId ? objectId(input.assigneeId, 'Member') : null;
    if (!canAssignOthers) {
      // Agents may claim an unassigned conversation or release their own.
      const claiming = target?.equals(userId) && !conv.assigneeId;
      const releasing = target === null && conv.assigneeId?.equals(userId);
      if (!claiming && !releasing) throw forbidden('Only managers can assign conversations to others.');
    }
    if (target) {
      const member = await WorkspaceMember.findOne({ workspaceId: conv.workspaceId, userId: target }).lean();
      if (!member || member.role === 'analyst') {
        throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { assigneeId: ['Choose a team member who can reply.'] });
      }
    }
    const unchanged = target ? (conv.assigneeId?.equals(target) ?? false) : conv.assigneeId == null;
    if (!unchanged) await assign(req, conv, target);
  }

  if ((input.status || input.priority || input.botPaused !== undefined) && !canReply(req, conv)) throw forbidden('This conversation is assigned to someone else.');
  if (input.status && input.status !== conv.status) {
    const from = conv.status;
    conv.status = input.status;
    if (input.status === 'resolved') {
      conv.resolvedAt = new Date();
      conv.botPaused = false; // automations may greet the customer again next time
      conv.aiReplyCount = 0;
    }
    if (from === 'resolved') {
      conv.openedAt = new Date();
      conv.resolvedAt = null;
    }
    await audit(req, { workspaceId: conv.workspaceId, action: 'conversation.status_changed', targetType: 'conversation', targetId: conv.id, metadata: { from, to: input.status } });
  }
  const resolvedNow = input.status === 'resolved' && conv.isModified('status');
  if (input.priority) conv.priority = input.priority;
  if (input.botPaused !== undefined) conv.botPaused = input.botPaused;
  await conv.save();
  notify(conv.workspaceId, conv._id);
  if (resolvedNow) {
    await emitEvent(conv.workspaceId, 'conversation.resolved', async () => ({ conversation: apiConversation(conv), contact: await contactPayload(conv.workspaceId, conv.contactId), resolved_by: req.user!.id as string }));
  }

  const [serialized] = await serializeMany(req.workspace!._id, [conv]);
  res.json({ conversation: serialized });
});

type Req = Parameters<Parameters<typeof conversationRouter.get>[1]>[0];

function visible(req: Req) {
  return findVisibleConversation(req.workspace!._id, objectId(req.params.conversationId, 'Conversation'), req.membership!);
}

function canReply(req: Req, conv: ConversationDoc): boolean {
  if (!can(req.membership!.role as Role, 'messages:send')) return false;
  return canViewAll(req.membership!) || !conv.assigneeId || conv.assigneeId.equals(req.user!._id);
}

async function assign(req: Req, conv: ConversationDoc, assigneeId: Types.ObjectId | null) {
  const from = conv.assigneeId?.toString() ?? null;
  conv.assigneeId = assigneeId;
  conv.assignedAt = assigneeId ? new Date() : null;
  conv.assignedBy = assigneeId ? req.user!._id : null;
  await conv.save();
  await audit(req, {
    workspaceId: conv.workspaceId,
    action: 'conversation.assigned',
    targetType: 'conversation',
    targetId: conv.id,
    metadata: { from, to: assigneeId?.toString() ?? null },
  });
  await emitEvent(conv.workspaceId, 'conversation.assigned', async () => ({
    conversation: apiConversation(conv),
    contact: await contactPayload(conv.workspaceId, conv.contactId),
    previous_assignee_id: from,
    assigned_by: req.user!.id as string,
  }));
}

async function serializeMany(workspaceId: Types.ObjectId, conversations: ConversationDoc[]) {
  const [contacts, users] = await Promise.all([
    Contact.find({ workspaceId, _id: { $in: conversations.map((c) => c.contactId) } }).lean(),
    User.find({ _id: { $in: conversations.map((c) => c.assigneeId).filter(Boolean) } }).select('name').lean(),
  ]);
  const contactById = new Map(contacts.map((c) => [c._id.toString(), c]));
  const userById = new Map(users.map((u) => [u._id.toString(), u.name]));

  return conversations.map((c) => {
    const contact = contactById.get(c.contactId.toString());
    return {
      id: c.id as string,
      status: c.status,
      priority: c.priority,
      botPaused: c.botPaused,
      unreadCount: c.unreadCount,
      lastMessageAt: c.lastMessageAt,
      lastMessagePreview: c.lastMessagePreview,
      lastMessageDirection: c.lastMessageDirection,
      // The 24h window decides whether free text is allowed.
      serviceWindowOpen: contact ? isInServiceWindow(contact) : false,
      contact: contact
        ? { id: contact._id.toString(), phone: contact.phoneE164, name: contact.name || contact.profileName || contact.phoneE164, tags: (contact.tags ?? []).map(String) }
        : null,
      assignee: c.assigneeId ? { id: c.assigneeId.toString(), name: userById.get(c.assigneeId.toString()) ?? 'Unknown' } : null,
    };
  });
}

import { Router } from 'express';
import { ConversationCycle } from '../analytics/analytics.model.js';
import { apiConversation, contactPayload } from '../developer/serializers.js';
import { emitEvent } from '../developer/webhook.service.js';
import { Types } from 'mongoose';
import { z } from 'zod';
import { buttonParamsSchema, templateExtrasSchema } from '../templates/templateSend.js';
import { badRequest, conflict, forbidden } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { publish } from '../../realtime/bus.js';
import { getAgent, runAgent } from '../ai/ai.service.js';
import { audit } from '../audit/audit.service.js';
import { assertWithinLimit } from '../billing/billing.service.js';
import { User } from '../auth/user.model.js';
import { Contact, toPublicContact } from '../contacts/contact.model.js';
import { isInServiceWindow, normalizePhone } from '../contacts/contact.service.js';
import { Message } from '../messages/message.model.js';
import { queueOutboundMessage } from '../messages/message.service.js';
import { can, type Role } from '../roles.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { CONVERSATION_STATUSES, Conversation, type ConversationDoc } from './conversation.model.js';
import { canViewAll, findVisibleConversation, notify, visibilityFilter } from './conversation.service.js';
import { ConversationNote } from './note.model.js';

export const INBOX_VIEWS = ['all', 'mine', 'mentions', 'unassigned', 'starred', 'waiting', 'ai'] as const;

const listSchema = z.object({
  view: z.enum(INBOX_VIEWS).default('all'),
  status: z.enum([...CONVERSATION_STATUSES, 'snoozed', 'all']).default('open'),
  // Active: the customer wrote in the last 24 hours (free replies allowed). Rolling over: templates only.
  window: z.enum(['any', 'active', 'rolling']).default('any'),
  // AI chats: those the AI agent is handling, or handed to the team.
  ai: z.enum(['all', 'active', 'escalated', 'resolved']).default('all'),
  assignee: z.string().optional(),
  priority: z.enum(['normal', 'high']).optional(),
  unread: z.enum(['true', 'false']).optional(),
  tag: z.string().optional(),
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
    buttonParams: buttonParamsSchema,
    extras: templateExtrasSchema.default({}),
  }),
]);

const updateSchema = z
  .object({
    status: z.enum(CONVERSATION_STATUSES),
    assigneeId: z.string().nullable(),
    priority: z.enum(['normal', 'high']),
    botPaused: z.boolean(),
    snoozedUntil: z.string().datetime().nullable(),
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
  const query = parse(listSchema, req.query);
  const { before, limit } = query;
  const workspaceId = req.workspace!._id;
  const filter = await listFilter(req, query);
  if (before) filter.lastMessageAt = { $lt: new Date(before) };
  const conversations = await Conversation.find(filter).sort({ lastMessageAt: -1, _id: -1 }).limit(limit + 1);
  const page = conversations.slice(0, limit);
  res.json({
    conversations: await serializeMany(workspaceId, page, req.user!._id),
    nextBefore: conversations.length > limit ? page.at(-1)!.lastMessageAt?.toISOString() ?? null : null,
  });
});

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const escapeRegex = (q: string) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Mongo filter for an inbox view plus the list's filters. */
async function listFilter(req: Req, query: z.infer<typeof listSchema>): Promise<Record<string, unknown>> {
  const workspaceId = req.workspace!._id;
  const userId = req.user!._id;
  const now = new Date();
  const filter: Record<string, unknown> = { workspaceId, ...visibilityFilter(req.membership!) };
  const and: Record<string, unknown>[] = [];

  if (query.view === 'ai') {
    filter.aiTouchedAt = { $ne: null };
    if (query.ai === 'active') Object.assign(filter, { botPaused: false, status: { $ne: 'resolved' } });
    if (query.ai === 'escalated') Object.assign(filter, { handoffSource: 'ai', botPaused: true, status: { $ne: 'resolved' } });
    if (query.ai === 'resolved') filter.status = 'resolved';
  } else {
    if (query.status === 'snoozed') filter.snoozedUntil = { $gt: now };
    else if (query.status !== 'all') {
      filter.status = query.status;
      // Snoozed chats stay out of the working lists until they wake up.
      if (query.status !== 'resolved') and.push({ $or: [{ snoozedUntil: null }, { snoozedUntil: { $lte: now } }] });
    }
  }
  if (query.view === 'mine') filter.assigneeId = userId;
  if (query.view === 'unassigned') filter.assigneeId = null;
  if (query.view === 'starred') filter.starredBy = userId;
  if (query.view === 'waiting') filter.awaitingHuman = true;
  if (query.view === 'mentions') {
    const ids = await ConversationNote.distinct('conversationId', { workspaceId, mentions: userId });
    filter._id = { $in: ids };
  }

  const windowStart = new Date(now.getTime() - SERVICE_WINDOW_MS);
  if (query.window === 'active') filter.lastInboundAt = { $gte: windowStart };
  if (query.window === 'rolling') and.push({ $or: [{ lastInboundAt: null }, { lastInboundAt: { $lt: windowStart } }] });
  if (query.assignee) filter.assigneeId = query.assignee === 'none' ? null : objectId(query.assignee, 'Member');
  if (query.priority) filter.priority = query.priority;
  if (query.unread === 'true') filter.unreadCount = { $gt: 0 };

  const contactConds: Record<string, unknown>[] = [];
  if (query.tag) contactConds.push({ tags: objectId(query.tag, 'Tag') });
  if (query.q) {
    const rx = { $regex: escapeRegex(query.q), $options: 'i' };
    const digits = query.q.replace(/\D/g, '');
    contactConds.push({ $or: [{ name: rx }, { profileName: rx }, ...(digits.length >= 3 ? [{ phoneE164: { $regex: digits } }] : [])] });
  }
  if (contactConds.length) {
    const matches = await Contact.find({ workspaceId, $and: contactConds }).select('_id').limit(2000).lean();
    filter.contactId = { $in: matches.map((c) => c._id) };
  }
  if (and.length) filter.$and = and;
  return filter;
}

const startSchema = z.object({
  phone: z.string().trim().min(5, 'Enter a phone number.').max(30),
  name: z.string().trim().max(200).optional(),
});

/**
 * "+" in the inbox: opens a chat with a phone number, creating the contact if
 * needed. Outside the 24h window the first message must be a template.
 */
conversationRouter.post('/', requirePermission('contacts:manage'), requirePermission('messages:send'), async (req, res) => {
  const input = parse(startSchema, req.body);
  const workspaceId = req.workspace!._id;
  const phoneE164 = normalizePhone(input.phone, req.workspace!.country);
  if (!phoneE164) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { phone: ['Enter a valid phone number with country code.'] });

  let contact = await Contact.findOne({ workspaceId, phoneE164 });
  const createdContact = !contact;
  if (!contact) {
    await assertWithinLimit(workspaceId, 'contacts', await Contact.countDocuments({ workspaceId }));
    contact = await Contact.create({ workspaceId, phoneE164, name: input.name || null, source: 'manual' });
  } else if (input.name && !contact.name) {
    contact.name = input.name;
    await contact.save();
  }

  // Agents who can't see every chat get it assigned, so it shows up for them.
  const assignee = canViewAll(req.membership!) ? null : req.user!._id;
  const now = new Date();
  const conv = await Conversation.findOneAndUpdate(
    { workspaceId, contactId: contact._id },
    {
      $setOnInsert: {
        workspaceId,
        contactId: contact._id,
        status: 'open',
        openedAt: now,
        // Sorts the new chat to the top until the first message.
        lastMessageAt: now,
        lastMessagePreview: 'New chat',
        ...(assignee ? { assigneeId: assignee, assignedAt: now, assignedBy: req.user!._id } : {}),
      },
    },
    { upsert: true, new: true, includeResultMetadata: true },
  );
  const doc = conv.value!;
  const created = !conv.lastErrorObject?.updatedExisting;
  if (createdContact) {
    await emitEvent(workspaceId, 'contact.created', async () => ({ contact: await contactPayload(workspaceId, contact._id) }));
    publish(req.workspace!.id as string, { type: 'contacts.changed' });
  }
  if (created) notify(workspaceId, doc._id);

  const [serialized] = await serializeMany(workspaceId, [doc], req.user!._id);
  res.status(created ? 201 : 200).json({ conversation: serialized, created, createdContact });
});

/** Counts for the inbox navigation (open chats, not snoozed). */
conversationRouter.get('/counts', async (req, res) => {
  const workspaceId = req.workspace!._id;
  const userId = req.user!._id;
  const now = new Date();
  const base = { workspaceId, status: { $in: ['open', 'pending'] }, ...visibilityFilter(req.membership!), $or: [{ snoozedUntil: null }, { snoozedUntil: { $lte: now } }] };
  const mentionIds = await ConversationNote.distinct('conversationId', { workspaceId, mentions: userId });
  const aiBase = { workspaceId, ...visibilityFilter(req.membership!), aiTouchedAt: { $ne: null } };
  const [all, mine, unassigned, mentions, starred, waiting, snoozed, aiAll, aiActive, aiEscalated] = await Promise.all([
    Conversation.countDocuments(base),
    Conversation.countDocuments({ ...base, assigneeId: userId }),
    Conversation.countDocuments({ ...base, assigneeId: null }),
    Conversation.countDocuments({ ...base, _id: { $in: mentionIds } }),
    Conversation.countDocuments({ workspaceId, ...visibilityFilter(req.membership!), starredBy: userId }),
    Conversation.countDocuments({ ...base, awaitingHuman: true }),
    Conversation.countDocuments({ workspaceId, ...visibilityFilter(req.membership!), snoozedUntil: { $gt: now } }),
    Conversation.countDocuments(aiBase),
    Conversation.countDocuments({ ...aiBase, botPaused: false, status: { $ne: 'resolved' } }),
    Conversation.countDocuments({ ...aiBase, handoffSource: 'ai', botPaused: true, status: { $ne: 'resolved' } }),
  ]);
  res.json({ all, mine, unassigned, mentions, starred, waiting, snoozed, ai: { all: aiAll, active: aiActive, escalated: aiEscalated } });
});

/** Teammates who can be @mentioned or assigned (any role that can reply). */
conversationRouter.get('/team', async (req, res) => {
  const members = await WorkspaceMember.find({ workspaceId: req.workspace!._id, role: { $ne: 'analyst' } }).lean();
  const users = await User.find({ _id: { $in: members.map((m) => m.userId) }, status: 'active' }).select('name email').lean();
  res.json({ team: users.map((u) => ({ id: u._id.toString(), name: u.name, email: u.email })) });
});

const bulkSchema = z.object({
  ids: z.array(z.string()).min(1).max(100),
  action: z.enum(['assign', 'resolve', 'reopen', 'star', 'unstar', 'snooze', 'unsnooze']),
  assigneeId: z.string().nullable().optional(),
  snoozedUntil: z.string().datetime().optional(),
});

/** Bulk actions from the chat list. Chats the user can't act on are skipped and counted. */
conversationRouter.post('/bulk', requirePermission('messages:send'), async (req, res) => {
  const input = parse(bulkSchema, req.body);
  const workspaceId = req.workspace!._id;
  const userId = req.user!._id;
  if (input.action === 'assign' && !can(req.membership!.role as Role, 'conversations:assign')) throw forbidden('Only managers can assign conversations to others.');
  if (input.action === 'snooze' && (!input.snoozedUntil || new Date(input.snoozedUntil) <= new Date())) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { snoozedUntil: ['Pick a time in the future.'] });
  const target = input.action === 'assign' && input.assigneeId ? objectId(input.assigneeId, 'Member') : null;
  if (target) await assertAssignable(workspaceId, target);

  const convs = await Conversation.find({ workspaceId, _id: { $in: input.ids.map((id) => objectId(id, 'Conversation')) }, ...visibilityFilter(req.membership!) });
  let updated = 0;
  for (const conv of convs) {
    if (input.action === 'star' || input.action === 'unstar') {
      await Conversation.updateOne({ _id: conv._id, workspaceId }, input.action === 'star' ? { $addToSet: { starredBy: userId } } : { $pull: { starredBy: userId } });
    } else if (!canReply(req, conv)) continue;
    else if (input.action === 'assign') {
      if ((conv.assigneeId?.toString() ?? null) !== (target?.toString() ?? null)) await assign(req, conv, target);
    } else if (input.action === 'resolve' || input.action === 'reopen') {
      await setStatus(req, conv, input.action === 'resolve' ? 'resolved' : 'open');
      await conv.save();
    } else {
      conv.snoozedUntil = input.action === 'snooze' ? new Date(input.snoozedUntil!) : null;
      await conv.save();
    }
    notify(workspaceId, conv._id);
    updated++;
  }
  res.json({ updated, skipped: input.ids.length - updated });
});

conversationRouter.get('/:conversationId', async (req, res) => {
  const conv = await visible(req);
  const [serialized] = await serializeMany(req.workspace!._id, [conv], req.user!._id);
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

/** Per-user star: each teammate keeps their own "Starred" list. */
conversationRouter.post('/:conversationId/star', async (req, res) => {
  const { starred } = parse(z.object({ starred: z.boolean() }), req.body);
  const conv = await visible(req);
  await Conversation.updateOne({ _id: conv._id, workspaceId: conv.workspaceId }, starred ? { $addToSet: { starredBy: req.user!._id } } : { $pull: { starredBy: req.user!._id } });
  notify(conv.workspaceId, conv._id);
  res.json({ starred });
});

conversationRouter.post('/:conversationId/notes', requirePermission('contacts:manage'), async (req, res) => {
  const { body, mentions } = parse(
    z.object({ body: z.string().trim().min(1, 'Write a note.').max(4000), mentions: z.array(z.string()).max(20).default([]) }),
    req.body,
  );
  const conv = await visible(req);
  // Only teammates of this workspace can be mentioned.
  const mentioned = mentions.length
    ? (await WorkspaceMember.find({ workspaceId: conv.workspaceId, userId: { $in: mentions.filter((m) => Types.ObjectId.isValid(m)) } }).select('userId').lean()).map((m) => m.userId)
    : [];
  const note = await ConversationNote.create({
    workspaceId: conv.workspaceId,
    conversationId: conv._id,
    contactId: conv.contactId,
    authorId: req.user!._id,
    body,
    mentions: mentioned,
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
    if (target) await assertAssignable(conv.workspaceId, target);
    const unchanged = target ? (conv.assigneeId?.equals(target) ?? false) : conv.assigneeId == null;
    if (!unchanged) await assign(req, conv, target);
  }

  if ((input.status || input.priority || input.botPaused !== undefined || input.snoozedUntil !== undefined) && !canReply(req, conv)) throw forbidden('This conversation is assigned to someone else.');
  if (input.status && input.status !== conv.status) await setStatus(req, conv, input.status);
  if (input.snoozedUntil !== undefined) {
    if (input.snoozedUntil && new Date(input.snoozedUntil) <= new Date()) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { snoozedUntil: ['Pick a time in the future.'] });
    conv.snoozedUntil = input.snoozedUntil ? new Date(input.snoozedUntil) : null;
  }
  const resolvedNow = input.status === 'resolved' && conv.isModified('status');
  if (input.priority) conv.priority = input.priority;
  if (input.botPaused !== undefined) {
    conv.botPaused = input.botPaused;
    if (!input.botPaused) conv.awaitingHuman = false;
  }
  await conv.save();
  notify(conv.workspaceId, conv._id);
  if (resolvedNow) {
    await emitEvent(conv.workspaceId, 'conversation.resolved', async () => ({ conversation: apiConversation(conv), contact: await contactPayload(conv.workspaceId, conv.contactId), resolved_by: req.user!.id as string }));
  }

  const [serialized] = await serializeMany(req.workspace!._id, [conv], req.user!._id);
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

async function assertAssignable(workspaceId: Types.ObjectId, userId: Types.ObjectId) {
  const member = await WorkspaceMember.findOne({ workspaceId, userId }).lean();
  if (!member || member.role === 'analyst') throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { assigneeId: ['Choose a team member who can reply.'] });
}

/** Opens, parks or resolves a chat (the caller saves it). Resolving records the cycle for reports. */
async function setStatus(req: Req, conv: ConversationDoc, status: ConversationDoc['status']) {
  const from = conv.status;
  if (from === status) return;
  conv.status = status;
  if (status === 'resolved') {
    conv.resolvedAt = new Date();
    await ConversationCycle.create({ workspaceId: conv.workspaceId, conversationId: conv._id, assigneeId: conv.assigneeId, openedAt: conv.openedAt, firstReplyAt: conv.firstReplyAt, resolvedAt: conv.resolvedAt });
    conv.botPaused = false; // automations may greet the customer again next time
    conv.aiReplyCount = 0;
    conv.awaitingHuman = false;
    conv.snoozedUntil = null;
  }
  if (from === 'resolved') {
    conv.openedAt = new Date();
    conv.resolvedAt = null;
    conv.firstReplyAt = null;
  }
  await audit(req, { workspaceId: conv.workspaceId, action: 'conversation.status_changed', targetType: 'conversation', targetId: conv.id, metadata: { from, to: status } });
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

async function serializeMany(workspaceId: Types.ObjectId, conversations: ConversationDoc[], viewerId: Types.ObjectId) {
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
      starred: c.starredBy.some((u) => u.equals(viewerId)),
      snoozedUntil: c.snoozedUntil && c.snoozedUntil.getTime() > Date.now() ? c.snoozedUntil : null,
      awaitingHuman: c.awaitingHuman,
      handoffSource: c.handoffSource,
      aiHandled: !!c.aiTouchedAt,
      aiReplyCount: c.aiReplyCount,
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

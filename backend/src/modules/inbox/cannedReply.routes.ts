import { Router } from 'express';
import { z } from 'zod';
import { conflict, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { CannedReply, type CannedReplyDoc } from './cannedReply.model.js';

/** Mounted at /api/workspaces/:workspaceId/canned-replies. Anyone who can reply manages them. */
export const cannedReplyRouter = Router({ mergeParams: true });

const input = z.object({
  shortcut: z
    .string()
    .trim()
    .toLowerCase()
    .transform((s) => s.replace(/^\//, ''))
    .pipe(z.string().regex(/^[a-z0-9_-]{1,30}$/, 'Use 1–30 letters, numbers, - or _ (no spaces).')),
  body: z.string().trim().min(1, 'Write the message.').max(4096),
});

const serialize = (c: CannedReplyDoc) => ({ id: c.id as string, shortcut: c.shortcut, body: c.body, useCount: c.useCount, updatedAt: (c as unknown as { updatedAt: Date }).updatedAt });

async function find(workspaceId: unknown, id: unknown) {
  const reply = await CannedReply.findOne({ _id: objectId(id, 'Canned reply'), workspaceId });
  if (!reply) throw notFound('Canned reply not found.');
  return reply;
}

const duplicate = (err: unknown) => {
  if ((err as { code?: number }).code === 11000) throw conflict('SHORTCUT_TAKEN', 'Another canned reply already uses this shortcut.');
  throw err;
};

cannedReplyRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const replies = await CannedReply.find({ workspaceId: req.workspace!._id }).sort({ useCount: -1, shortcut: 1 }).limit(500);
  res.json({ replies: replies.map(serialize) });
});

cannedReplyRouter.post('/', requirePermission('messages:send'), async (req, res) => {
  const body = parse(input, req.body);
  const reply = await CannedReply.create({ workspaceId: req.workspace!._id, ...body, createdBy: req.user!._id }).catch(duplicate);
  res.status(201).json({ reply: serialize(reply) });
});

cannedReplyRouter.patch('/:id', requirePermission('messages:send'), async (req, res) => {
  const body = parse(input.partial(), req.body);
  const reply = await find(req.workspace!._id, req.params.id);
  reply.set(body);
  await reply.save().catch(duplicate);
  res.json({ reply: serialize(reply) });
});

/** Counted when inserted into a reply, so the most used ones list first. */
cannedReplyRouter.post('/:id/used', requirePermission('messages:send'), async (req, res) => {
  await CannedReply.updateOne({ _id: objectId(req.params.id, 'Canned reply'), workspaceId: req.workspace!._id }, { $inc: { useCount: 1 } });
  res.status(204).end();
});

cannedReplyRouter.delete('/:id', requirePermission('messages:send'), async (req, res) => {
  const reply = await find(req.workspace!._id, req.params.id);
  await CannedReply.deleteOne({ _id: reply._id, workspaceId: reply.workspaceId });
  res.status(204).end();
});

import { Router } from 'express';
import { z } from 'zod';
import { conflict, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { publish } from '../../realtime/bus.js';
import { Contact } from './contact.model.js';
import { TAG_COLORS, Tag, toPublicTag } from './tag.model.js';

const tagSchema = z.object({
  name: z.string().trim().min(1, 'Tag name is required.').max(40),
  color: z.enum(TAG_COLORS).default('gray'),
});

/** Mounted at /api/workspaces/:workspaceId/tags (workspace already loaded). */
export const tagRouter = Router({ mergeParams: true });

tagRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const [tags, counts] = await Promise.all([
    Tag.find({ workspaceId }).sort({ name: 1 }).collation({ locale: 'en', strength: 2 }),
    Contact.aggregate<{ _id: string; count: number }>([{ $match: { workspaceId } }, { $unwind: '$tags' }, { $group: { _id: '$tags', count: { $sum: 1 } } }]),
  ]);
  const countById = new Map(counts.map((c) => [String(c._id), c.count]));
  res.json({ tags: tags.map((t) => ({ ...toPublicTag(t), contactCount: countById.get(t.id as string) ?? 0 })) });
});

tagRouter.post('/', requirePermission('tags:manage'), async (req, res) => {
  const input = parse(tagSchema, req.body);
  try {
    const tag = await Tag.create({ workspaceId: req.workspace!._id, ...input });
    res.status(201).json({ tag: toPublicTag(tag) });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('TAG_EXISTS', `A tag named "${input.name}" already exists.`);
    throw err;
  }
});

tagRouter.patch('/:tagId', requirePermission('tags:manage'), async (req, res) => {
  const input = parse(tagSchema.partial(), req.body);
  const tag = await Tag.findOne({ _id: objectId(req.params.tagId, 'Tag'), workspaceId: req.workspace!._id });
  if (!tag) throw notFound('Tag not found.');
  tag.set(input);
  try {
    await tag.save();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('TAG_EXISTS', `A tag named "${input.name}" already exists.`);
    throw err;
  }
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.json({ tag: toPublicTag(tag) });
});

tagRouter.delete('/:tagId', requirePermission('tags:manage'), async (req, res) => {
  const workspaceId = req.workspace!._id;
  const tag = await Tag.findOneAndDelete({ _id: objectId(req.params.tagId, 'Tag'), workspaceId });
  if (!tag) throw notFound('Tag not found.');
  await Contact.updateMany({ workspaceId, tags: tag._id }, { $pull: { tags: tag._id } });
  publish(req.workspace!.id as string, { type: 'contacts.changed' });
  res.status(204).end();
});

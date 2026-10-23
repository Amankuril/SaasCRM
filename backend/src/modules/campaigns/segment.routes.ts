import { Router } from 'express';
import { z } from 'zod';
import { conflict, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { Contact } from '../contacts/contact.model.js';
import { audienceFilterInput } from './campaign.routes.js';
import { targetingQuery, type AudienceFilter } from './campaign.service.js';
import { Segment, type SegmentDoc } from './segment.model.js';

const segmentInput = z.object({ name: z.string().trim().min(1, 'Name the segment.').max(80), filter: audienceFilterInput });

/** How many contacts match, and how many of those can actually be messaged. */
async function countAudience(workspaceId: Parameters<typeof targetingQuery>[0], filter: AudienceFilter) {
  const base = targetingQuery(workspaceId, filter);
  const [matched, optedOut, optedIn] = await Promise.all([
    Contact.countDocuments(base),
    Contact.countDocuments({ ...base, 'consent.status': 'opted_out' }),
    Contact.countDocuments({ ...base, 'consent.status': 'opted_in' }),
  ]);
  return { matched, reachable: filter.requireOptIn ? optedIn : matched - optedOut, optedOut };
}

function serialize(s: SegmentDoc) {
  return {
    id: s.id as string,
    name: s.name,
    filter: {
      tagsAny: (s.filter?.tagsAny ?? []).map(String),
      excludeTags: (s.filter?.excludeTags ?? []).map(String),
      stages: s.filter?.stages ?? [],
      requireOptIn: s.filter?.requireOptIn ?? false,
    },
  };
}

/** Mounted at /api/workspaces/:workspaceId/segments (workspace already loaded). */
export const segmentRouter = Router({ mergeParams: true });

segmentRouter.get('/', requirePermission('workspace:read'), async (req, res) => {
  const segments = await Segment.find({ workspaceId: req.workspace!._id }).sort({ name: 1 });
  res.json({ segments: segments.map(serialize) });
});

/** Live count for an ad-hoc filter (used while building an audience). */
segmentRouter.post('/count', requirePermission('workspace:read'), async (req, res) => {
  const filter = parse(audienceFilterInput, req.body);
  res.json(await countAudience(req.workspace!._id, filter));
});

segmentRouter.post('/', requirePermission('campaigns:manage'), async (req, res) => {
  const input = parse(segmentInput, req.body);
  try {
    const segment = await Segment.create({ workspaceId: req.workspace!._id, createdBy: req.user!._id, ...input });
    res.status(201).json({ segment: serialize(segment) });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('SEGMENT_EXISTS', `A segment named "${input.name}" already exists.`);
    throw err;
  }
});

segmentRouter.get('/:segmentId/count', requirePermission('workspace:read'), async (req, res) => {
  const segment = await Segment.findOne({ _id: objectId(req.params.segmentId, 'Segment'), workspaceId: req.workspace!._id });
  if (!segment) throw notFound('Segment not found.');
  res.json(await countAudience(req.workspace!._id, segment.filter as AudienceFilter));
});

segmentRouter.delete('/:segmentId', requirePermission('campaigns:manage'), async (req, res) => {
  const segment = await Segment.findOneAndDelete({ _id: objectId(req.params.segmentId, 'Segment'), workspaceId: req.workspace!._id });
  if (!segment) throw notFound('Segment not found.');
  res.status(204).end();
});

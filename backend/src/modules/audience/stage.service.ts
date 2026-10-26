import type { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { Contact } from '../contacts/contact.model.js';
import { PipelineStage, type StageDoc } from './stage.model.js';

/** Contacts start in "new"; it can be renamed but not deleted. */
export const ENTRY_STAGE = 'new';

export const stageKeySchema = z.string().regex(/^[a-z0-9_]{1,40}$/, 'Choose a stage.');

const DEFAULTS = [
  { key: 'new', name: 'New Lead', color: 'green' },
  { key: 'hot', name: 'Hot Lead', color: 'orange' },
  { key: 'warm', name: 'Warm Lead', color: 'amber' },
  { key: 'invoice_issued', name: 'Invoice issued', color: 'blue' },
  { key: 'payment_in_progress', name: 'Payment in progress', color: 'yellow' },
  { key: 'payment_made', name: 'Payment made', color: 'teal' },
  { key: 'cold', name: 'Cold Lead', color: 'indigo' },
  { key: 'no_budget', name: 'No budget', color: 'violet' },
] as const;

// Stages from before stages were customisable, kept when contacts still use them.
const LEGACY_NAMES: Record<string, string> = { contacted: 'Contacted', qualified: 'Qualified', follow_up: 'Follow-up', converted: 'Converted', lost: 'Lost' };

/** The workspace's stages in order, creating the defaults the first time. */
export async function listStages(workspaceId: Types.ObjectId): Promise<StageDoc[]> {
  let stages = await PipelineStage.find({ workspaceId }).sort({ order: 1, createdAt: 1 });
  if (stages.length) return stages;

  const used = (await Contact.distinct('lifecycleStage', { workspaceId })) as string[];
  const seed = [
    ...DEFAULTS,
    ...used.filter((k) => !DEFAULTS.some((d) => d.key === k)).map((key) => ({ key, name: LEGACY_NAMES[key] ?? key.replace(/_/g, ' '), color: 'gray' as const })),
  ];
  try {
    await PipelineStage.insertMany(
      seed.map((s, i) => ({ workspaceId, ...s, order: i })),
      { ordered: false },
    );
  } catch (err) {
    // Two first requests at once: the other one seeded already.
    if ((err as { code?: number }).code !== 11000) throw err;
  }
  stages = await PipelineStage.find({ workspaceId }).sort({ order: 1, createdAt: 1 });
  return stages;
}

/** Throws a field error unless `key` is one of the workspace's stages. */
export async function assertStage(workspaceId: Types.ObjectId, key: string, field = 'lifecycleStage'): Promise<void> {
  const stages = await listStages(workspaceId);
  if (!stages.some((s) => s.key === key)) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { [field]: ['Unknown stage.'] });
}

/** Looks a stage up by key or by name (CSV imports use names like "Hot Lead"). */
export async function stageResolver(workspaceId: Types.ObjectId): Promise<(value: string) => string | null> {
  const stages = await listStages(workspaceId);
  return (value) => {
    const v = value.trim().toLowerCase();
    const slug = v.replace(/[\s-]+/g, '_');
    return stages.find((s) => s.key === slug || s.name.toLowerCase() === v)?.key ?? null;
  };
}

export function slugifyStage(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 36) || 'stage'
  );
}

import type { Types } from 'mongoose';
import { z } from 'zod';
import { Contact } from './contact.model.js';
import { LIFECYCLE_STAGES } from './contact.model.js';
import { normalizePhone } from './contact.service.js';
import { Tag } from './tag.model.js';

export const MAX_IMPORT_ROWS = 5_000;

const customKey = z.string().regex(/^[a-z0-9_]{1,40}$/, 'Custom field keys use lowercase letters, numbers and underscores.');

export const importSchema = z.object({
  rows: z.array(z.record(z.string(), z.string().max(2_000))).min(1, 'The file has no rows.').max(MAX_IMPORT_ROWS, `Import at most ${MAX_IMPORT_ROWS} rows at a time.`),
  // CSV column name for each contact field.
  mapping: z.object({
    phone: z.string().min(1, 'Choose the phone number column.'),
    name: z.string().optional(),
    email: z.string().optional(),
    tags: z.string().optional(),
    lifecycleStage: z.string().optional(),
    custom: z.record(customKey, z.string()).default({}),
  }),
  // skip: leave existing contacts alone; update: overwrite with non-empty file values; merge: only fill empty fields.
  duplicate: z.enum(['skip', 'update', 'merge']),
  addTagIds: z.array(z.string()).max(20).default([]),
});

export type ImportInput = z.infer<typeof importSchema>;

export interface ImportReport {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  invalid: { row: number; reason: string }[];
}

const emailOk = (v: string) => z.string().email().safeParse(v).success;

export async function importContacts(workspaceId: Types.ObjectId, country: string, input: ImportInput): Promise<ImportReport> {
  const { rows, mapping, duplicate } = input;
  const report: ImportReport = { total: rows.length, created: 0, updated: 0, skipped: 0, invalid: [] };

  // Resolve tag names from the file (creating missing tags) plus tags applied to every row.
  const fileTagNames = new Set<string>();
  if (mapping.tags) for (const r of rows) for (const t of splitTags(r[mapping.tags])) fileTagNames.add(t);
  const tagIdByName = await ensureTags(workspaceId, [...fileTagNames]);
  const extraTags = (await Tag.find({ workspaceId, _id: { $in: input.addTagIds } }).select('_id').lean()).map((t) => t._id);

  type Parsed = { row: number; phone: string; name?: string; email?: string; stage?: string; tags: Types.ObjectId[]; custom: Record<string, string> };
  const parsed: Parsed[] = [];
  const seen = new Set<string>();

  rows.forEach((r, i) => {
    const rowNo = i + 2; // +1 for the header line, +1 for 1-based numbering
    const phone = normalizePhone(r[mapping.phone] ?? '', country);
    if (!phone) return void report.invalid.push({ row: rowNo, reason: 'Invalid or missing phone number' });
    if (seen.has(phone)) return void report.invalid.push({ row: rowNo, reason: 'Duplicate phone number in file' });
    seen.add(phone);

    const email = clean(mapping.email && r[mapping.email]);
    if (email && !emailOk(email)) return void report.invalid.push({ row: rowNo, reason: `Invalid email "${email}"` });
    const stage = clean(mapping.lifecycleStage && r[mapping.lifecycleStage])?.toLowerCase().replace(/[\s-]+/g, '_');
    if (stage && !(LIFECYCLE_STAGES as readonly string[]).includes(stage)) {
      return void report.invalid.push({ row: rowNo, reason: `Unknown lifecycle stage "${stage}"` });
    }

    const custom: Record<string, string> = {};
    for (const [key, column] of Object.entries(mapping.custom)) {
      const v = clean(r[column]);
      if (v) custom[key] = v;
    }
    parsed.push({
      row: rowNo,
      phone,
      name: clean(mapping.name && r[mapping.name])?.slice(0, 200),
      email: email?.toLowerCase(),
      stage,
      tags: [...splitTags(mapping.tags ? r[mapping.tags] : undefined).map((t) => tagIdByName.get(t.toLowerCase())!), ...extraTags],
      custom,
    });
  });

  const existing = await Contact.find({ workspaceId, phoneE164: { $in: parsed.map((p) => p.phone) } }).lean();
  const byPhone = new Map(existing.map((c) => [c.phoneE164, c]));

  const inserts: Record<string, unknown>[] = [];
  const updates: { filter: Record<string, unknown>; update: Record<string, unknown> }[] = [];

  for (const p of parsed) {
    const current = byPhone.get(p.phone);
    if (!current) {
      inserts.push({
        workspaceId,
        phoneE164: p.phone,
        name: p.name ?? null,
        email: p.email ?? null,
        lifecycleStage: p.stage ?? 'new',
        tags: p.tags,
        customFields: p.custom,
        source: 'import',
      });
      continue;
    }
    if (duplicate === 'skip') {
      report.skipped++;
      continue;
    }

    const set: Record<string, unknown> = {};
    const take = (field: string, value: string | undefined, currentValue: unknown) => {
      if (!value) return;
      if (duplicate === 'update' || !currentValue) set[field] = value;
    };
    take('name', p.name, current.name);
    take('email', p.email, current.email);
    take('lifecycleStage', p.stage, current.lifecycleStage !== 'new' ? current.lifecycleStage : null);
    const currentCustom = (current.customFields ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(p.custom)) take(`customFields.${k}`, v, currentCustom[k]);

    updates.push({
      filter: { _id: current._id, workspaceId },
      update: { ...(Object.keys(set).length ? { $set: set } : {}), ...(p.tags.length ? { $addToSet: { tags: { $each: p.tags } } } : {}) },
    });
  }

  if (inserts.length) {
    await Contact.insertMany(inserts, { ordered: false });
    report.created = inserts.length;
  }
  const effective = updates.filter((u) => Object.keys(u.update).length);
  if (effective.length) await Contact.bulkWrite(effective.map((u) => ({ updateOne: u })));
  report.updated = effective.length;
  report.skipped += updates.length - effective.length;
  return report;
}

function clean(v: string | undefined | false): string | undefined {
  const t = typeof v === 'string' ? v.trim() : '';
  return t || undefined;
}

function splitTags(v: string | undefined): string[] {
  return (v ?? '')
    .split(/[,;|]/)
    .map((t) => t.trim().slice(0, 40))
    .filter(Boolean);
}

/** Returns lowercase name -> id, creating tags that don't exist yet. */
async function ensureTags(workspaceId: Types.ObjectId, names: string[]): Promise<Map<string, Types.ObjectId>> {
  const map = new Map<string, Types.ObjectId>();
  if (!names.length) return map;
  const existing = await Tag.find({ workspaceId }).lean();
  for (const t of existing) map.set(t.name.toLowerCase(), t._id);
  const missing = [...new Set(names.map((n) => n.toLowerCase()))].filter((n) => !map.has(n));
  for (const lower of missing) {
    const original = names.find((n) => n.toLowerCase() === lower)!;
    const tag = await Tag.create({ workspaceId, name: original });
    map.set(lower, tag._id);
  }
  return map;
}

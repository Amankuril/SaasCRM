import type { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { assertWithinLimit } from '../billing/billing.service.js';
import { onTagsAdded } from '../flows/triggers.js';
import { MAX_IMPORT_ROWS, ensureTags } from './contact.import.js';
import { Contact } from './contact.model.js';
import { normalizeImportPhone } from './contact.service.js';
import type { ContactListDoc } from './contactList.model.js';

const countryCode = z.string().regex(/^[A-Z]{2}$/, 'Choose a country.');

export const addOneSchema = z.object({
  country: countryCode,
  phone: z.string().trim().min(4, 'Enter the WhatsApp number.').max(30),
  name: z.string().trim().max(200).optional(),
});

/** Rows as in the sample CSV: no header; name, number (with country code), and optional tags. */
export const listImportSchema = z
  .object({
    rows: z.array(z.array(z.string().max(2_000)).max(10)).min(1, 'The file has no rows.').max(MAX_IMPORT_ROWS, `Upload at most ${MAX_IMPORT_ROWS} rows at a time.`),
    international: z.boolean(),
    country: countryCode.optional(),
    withTags: z.boolean().default(false),
  })
  .refine((v) => v.international || !!v.country, { message: 'Choose the country for numbers without a country code.', path: ['country'] });

export interface ListImportReport {
  total: number;
  created: number;
  added: number;
  alreadyInList: number;
  invalid: { row: number; reason: string }[];
}

interface Row {
  row: number;
  phone: string;
  name?: string;
  tags: string[];
}

const splitTags = (v: string | undefined) =>
  (v ?? '')
    .split(/[,;|]/)
    .map((t) => t.trim().slice(0, 40))
    .filter(Boolean);

/**
 * Adds people to a list: new numbers become contacts, existing contacts just join
 * the list (their empty name is filled in, tags are added, nothing is overwritten).
 */
export async function addToList(workspaceId: Types.ObjectId, list: ContactListDoc, rows: Row[], report: ListImportReport, source: string) {
  const existing = await Contact.find({ workspaceId, phoneE164: { $in: rows.map((r) => r.phone) } }).lean();
  const byPhone = new Map(existing.map((c) => [c.phoneE164, c]));
  const fresh = rows.filter((r) => !byPhone.has(r.phone));
  if (fresh.length) await assertWithinLimit(workspaceId, 'contacts', await Contact.countDocuments({ workspaceId }), fresh.length);

  const tagIds = await ensureTags(workspaceId, rows.flatMap((r) => r.tags));
  const tagsOf = (r: Row) => [...new Set(r.tags.map((t) => tagIds.get(t.toLowerCase())!))];

  if (fresh.length) {
    const created = await Contact.insertMany(
      fresh.map((r) => ({ workspaceId, phoneE164: r.phone, name: r.name ?? null, tags: tagsOf(r), lists: [list._id], source })),
      { ordered: false },
    );
    report.created = created.length;
    for (const c of created) if (c.tags.length) await onTagsAdded(workspaceId, c._id, c.tags);
  }

  const updates = rows.flatMap((r) => {
    const current = byPhone.get(r.phone);
    if (!current) return [];
    const inList = (current.lists ?? []).some((l) => l.equals(list._id));
    if (inList) report.alreadyInList++;
    else report.added++;
    return [
      {
        updateOne: {
          filter: { _id: current._id, workspaceId },
          update: {
            $addToSet: { lists: list._id, tags: { $each: tagsOf(r) } },
            ...(r.name && !current.name ? { $set: { name: r.name } } : {}),
          },
        },
      },
    ];
  });
  if (updates.length) await Contact.bulkWrite(updates);
}

export async function importIntoList(workspaceId: Types.ObjectId, list: ContactListDoc, input: z.infer<typeof listImportSchema>): Promise<ListImportReport> {
  const report: ListImportReport = { total: 0, created: 0, added: 0, alreadyInList: 0, invalid: [] };
  const rows: Row[] = [];
  const seen = new Set<string>();

  input.rows.forEach((cells, i) => {
    const rowNo = i + 1;
    const [name = '', number = '', tags = ''] = cells.map((c) => c.trim());
    if (!name && !number) return; // blank line
    // Tolerate a header line even though the format has none.
    if (i === 0 && !/\d/.test(number)) return;
    report.total++;
    const phone = normalizeImportPhone(number, { international: input.international, country: input.country });
    if (!phone) return void report.invalid.push({ row: rowNo, reason: number ? `"${number}" is not a valid phone number` : 'Missing phone number' });
    if (seen.has(phone)) return void report.invalid.push({ row: rowNo, reason: 'Duplicate number in file' });
    seen.add(phone);
    rows.push({ row: rowNo, phone, name: name.slice(0, 200) || undefined, tags: input.withTags ? splitTags(tags) : [] });
  });
  if (!report.total) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { rows: ['The file has no contacts.'] });

  if (rows.length) await addToList(workspaceId, list, rows, report, 'list_import');
  return report;
}

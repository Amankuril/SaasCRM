import { Types } from 'mongoose';
import { z } from 'zod';
import { normalizePhone } from '../contacts/contact.service.js';
import type { WorkspaceDoc } from '../workspaces/workspace.model.js';
import { categoryOf } from './categories.js';
import { ReminderRecord, type ReminderSetupDoc } from './reminder.model.js';
import { applySchedule, fieldsOf, identityOf } from './reminder.service.js';
import { isRealDate, parseDate, parseTime } from './schedule.js';

export const MAX_IMPORT_ROWS = 5_000;

export const importSchema = z.object({
  rows: z.array(z.record(z.string(), z.string().max(2_000))).min(1, 'The file has no rows.').max(MAX_IMPORT_ROWS, `Import at most ${MAX_IMPORT_ROWS} rows at a time.`),
  // File column for each value.
  mapping: z.object({
    phone: z.string().min(1, 'Choose the phone number column.'),
    date: z.string().min(1, 'Choose the date column.'),
    name: z.string().optional(),
    time: z.string().optional(),
    endDate: z.string().optional(),
    fields: z.record(z.string(), z.string()).default({}),
  }),
  dateOrder: z.enum(['dmy', 'mdy']).default('dmy'),
  /** Same event already there: leave it, or replace its values. */
  duplicate: z.enum(['skip', 'update']).default('skip'),
  /** Check the file without saving anything. */
  dryRun: z.boolean().default(false),
});
export type ReminderImportInput = z.infer<typeof importSchema>;

export interface ReminderImportReport {
  total: number;
  valid: number;
  created: number;
  updated: number;
  duplicates: number;
  invalid: { row: number; reason: string }[];
  sample: { row: number; phone: string; name: string; eventDate: string; eventTime: string | null; fields: Record<string, string> }[];
}

export interface RecordInput {
  phone: string;
  name: string;
  date: string;
  time: string;
  fields: Record<string, string>;
  endDate?: string | null;
}

export type ParsedRecord = { phoneE164: string; name: string; eventDate: string; eventTime: string | null; endDate: string | null; fields: Record<string, string> };

/** Checks one person's values against the category. Returns field errors instead of throwing. */
export function parseRecord(setup: ReminderSetupDoc, workspace: WorkspaceDoc, input: RecordInput, dateOrder: 'dmy' | 'mdy' = 'dmy'): { value: ParsedRecord } | { errors: Record<string, string[]> } {
  const category = categoryOf(setup.category);
  const errors: Record<string, string[]> = {};
  const phoneE164 = normalizePhone(input.phone, workspace.country);
  if (!phoneE164) errors.phone = ['Enter a valid phone number.'];
  const eventDate = isRealDate(input.date) ? input.date : parseDate(input.date, dateOrder, category.yearOptional && (setup.recurrence === 'yearly'));
  if (!eventDate) errors.date = [input.date.trim() ? `"${input.date.trim()}" is not a date we can read.` : `Enter the ${category.dateLabel.toLowerCase()}.`];
  const hourRules = setup.rules.some((r) => r.when !== 'on' && (r.unit === 'hour' || r.unit === 'minute'));
  // A date cell may also carry the time ("2026-12-01 14:30").
  const inlineTime = /[T\s](\d{1,2}:\d{2}(?:\s*[ap]m)?)/i.exec(input.date)?.[1] ?? '';
  const eventTime = category.dateKind === 'datetime' ? parseTime(input.time || inlineTime) : null;
  if (category.dateKind === 'datetime' && !eventTime && (input.time.trim() || hourRules)) errors.time = [input.time.trim() ? `"${input.time.trim()}" is not a time we can read.` : 'Enter the time.'];
  const fields: Record<string, string> = {};
  for (const f of fieldsOf(setup)) {
    const v = (input.fields[f.key] ?? '').trim().slice(0, 500);
    if (f.required && !v) errors[f.key] = [`Enter the ${f.label.toLowerCase()}.`];
    if (v) fields[f.key] = v;
  }
  const endDate = input.endDate?.trim() ? (isRealDate(input.endDate) ? input.endDate : parseDate(input.endDate, dateOrder)) : null;
  if (input.endDate?.trim() && !endDate) errors.endDate = ['Enter a valid end date.'];
  if (Object.keys(errors).length) return { errors };
  return { value: { phoneE164: phoneE164!, name: input.name.trim().slice(0, 120), eventDate: eventDate!, eventTime, endDate, fields } };
}

export async function importRecords(setup: ReminderSetupDoc, workspace: WorkspaceDoc, userId: Types.ObjectId, input: ReminderImportInput): Promise<ReminderImportReport> {
  const report: ReminderImportReport = { total: input.rows.length, valid: 0, created: 0, updated: 0, duplicates: 0, invalid: [], sample: [] };
  const seen = new Map<string, ParsedRecord>();
  const { mapping } = input;
  input.rows.forEach((row, i) => {
    const rowNo = i + 2;
    const get = (column?: string) => (column ? (row[column] ?? '') : '');
    const parsed = parseRecord(
      setup,
      workspace,
      { phone: get(mapping.phone), name: get(mapping.name), date: get(mapping.date), time: get(mapping.time), endDate: get(mapping.endDate), fields: Object.fromEntries(Object.entries(mapping.fields).map(([k, c]) => [k, get(c)])) },
      input.dateOrder,
    );
    if ('errors' in parsed) return void report.invalid.push({ row: rowNo, reason: Object.values(parsed.errors).flat().join(' ') });
    const identity = identityOf(setup, parsed.value);
    if (seen.has(identity)) return void report.invalid.push({ row: rowNo, reason: 'The same event appears earlier in this file.' });
    seen.set(identity, parsed.value);
    report.valid++;
    if (report.sample.length < 5) report.sample.push({ row: rowNo, phone: parsed.value.phoneE164, name: parsed.value.name, eventDate: parsed.value.eventDate, eventTime: parsed.value.eventTime, fields: parsed.value.fields });
  });

  const existing = new Map((await ReminderRecord.find({ workspaceId: workspace._id, setupId: setup._id, identity: { $in: [...seen.keys()] } })).map((r) => [r.identity, r]));
  report.duplicates = existing.size;
  if (input.dryRun) return report;

  const inserts: Record<string, unknown>[] = [];
  for (const [identity, value] of seen) {
    const current = existing.get(identity);
    if (current) {
      if (input.duplicate === 'skip') continue;
      current.set({ ...value, name: value.name || current.name, fields: { ...(current.fields as object), ...value.fields } });
      applySchedule(setup, current, workspace.timezone);
      current.markModified('fields');
      await current.save();
      report.updated++;
      continue;
    }
    const doc = new ReminderRecord({ workspaceId: workspace._id, setupId: setup._id, identity, ...value, source: 'import', createdBy: userId });
    applySchedule(setup, doc, workspace.timezone);
    inserts.push(doc.toObject());
  }
  if (inserts.length) {
    const done = await ReminderRecord.insertMany(inserts, { ordered: false }).catch((err: { code?: number; insertedDocs?: unknown[] }) => {
      // Someone imported the same rows at the same moment.
      if (err.code !== 11000) throw err;
      return err.insertedDocs ?? [];
    });
    report.created = done.length;
  }
  return report;
}

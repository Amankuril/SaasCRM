import type { Recurrence, ReminderRule } from './categories.js';
import { ruleId } from './categories.js';

/** Pure date maths for reminders. Dates are calendar dates ("YYYY-MM-DD") in the workspace timezone. */

const DAY = 86_400_000;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const iso = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const parts = (date: string) => date.split('-').map(Number) as [number, number, number];
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = parts(date);
  return y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY);
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = parts(a);
  const [y2, m2, d2] = parts(b);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY);
}

/** Same day each cycle; the 31st falls on the last day of shorter months and returns to the 31st after. */
function addMonths(date: string, months: number): string {
  const [y, m, d] = parts(date);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return iso(year, month, Math.min(d, daysInMonth(year, month)));
}

const MONTHS: Partial<Record<Recurrence, number>> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };

/** The k-th occurrence (0 = the event date itself). */
export function occurrence(date: string, recurrence: Recurrence, k: number, everyDays = 30): string {
  if (recurrence === 'none' || k === 0) return date;
  const months = MONTHS[recurrence];
  if (months) return addMonths(date, months * k);
  return addDays(date, (recurrence === 'weekly' ? 7 : Math.max(1, everyDays)) * k);
}

/** Minutes to add to UTC to get local time in `timeZone` at that instant. */
function offsetMinutes(at: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(at))
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000) / 60_000);
}

/** The instant a wall-clock time happens in a timezone. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = parts(date);
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const first = wall - offsetMinutes(wall, timeZone) * 60_000;
  return new Date(wall - offsetMinutes(first, timeZone) * 60_000);
}

export function localDate(at: Date, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export interface ScheduleInput {
  eventDate: string;
  /** "HH:MM" for appointments; null for all-day events. */
  eventTime: string | null;
  recurrence: Recurrence;
  everyDays: number;
  /** When day-based reminders go out, "HH:MM". */
  sendTime: string;
  rules: ReminderRule[];
  endDate: string | null;
  maxCycles: number | null;
  /** Occurrences up to this date are done (paid, renewed…). */
  doneThrough: string | null;
  timeZone: string;
}

export interface Run {
  rule: ReminderRule;
  ruleId: string;
  /** 0-based cycle. */
  cycle: number;
  occurrence: string;
  runAt: Date;
  /** After this moment the reminder no longer makes sense and is not sent. */
  expiresAt: Date;
}

const LATE_MS = 12 * 60 * 60_000;

export function runFor(s: ScheduleInput, rule: ReminderRule, cycle: number, occ: string): Run {
  const exact = rule.unit === 'minute' || rule.unit === 'hour';
  const eventAt = zonedToUtc(occ, s.eventTime ?? s.sendTime, s.timeZone);
  let runAt: Date;
  if (exact && rule.when !== 'on') {
    const ms = rule.value * (rule.unit === 'hour' ? 3_600_000 : 60_000);
    runAt = new Date(eventAt.getTime() + (rule.when === 'before' ? -ms : ms));
  } else {
    const days = rule.when === 'on' ? 0 : rule.value * (rule.unit === 'week' ? 7 : 1) * (rule.when === 'before' ? -1 : 1);
    runAt = zonedToUtc(addDays(occ, days), s.sendTime, s.timeZone);
  }
  const late = new Date(runAt.getTime() + LATE_MS);
  // "1 hour before" is pointless once the appointment has started.
  const expiresAt = rule.when === 'before' && s.eventTime && eventAt < late ? eventAt : late;
  return { rule, ruleId: ruleId(rule), cycle, occurrence: s.eventTime ? `${occ}T${s.eventTime}` : occ, runAt, expiresAt };
}

const CYCLE_DAYS: Record<Recurrence, number> = { none: 0, weekly: 7, monthly: 31, quarterly: 92, half_yearly: 184, yearly: 366, custom_days: 0 };

/** Every reminder due in [from, to], in time order, capped. */
export function runsBetween(s: ScheduleInput, from: Date, to: Date, limit = 50): Run[] {
  const out: Run[] = [];
  const visit = (run: Run) => {
    if (run.runAt <= to) out.push(run);
  };
  walk(s, from, visit, to, limit * 4);
  return out.sort((a, b) => a.runAt.getTime() - b.runAt.getTime()).slice(0, limit);
}

/** The first reminder strictly after (or at, when inclusive) a moment. */
export function nextRun(s: ScheduleInput, after: Date, inclusive = false): Run | null {
  const found: { best: Run | null } = { best: null };
  const visit = (run: Run) => {
    if (!inclusive && run.runAt <= after) return;
    if (!found.best || run.runAt < found.best.runAt) found.best = run;
  };
  walk(s, after, visit, null, 2_000, () => found.best?.runAt ?? null);
  return found.best;
}

/** Visits the runs with runAt >= from, occurrence by occurrence. */
function walk(s: ScheduleInput, from: Date, visit: (run: Run) => void, until: Date | null, maxOccurrences: number, bound?: () => Date | null) {
  if (!s.rules.length) return;
  const span = (r: ReminderRule) => r.value * (r.unit === 'week' ? 7 : r.unit === 'day' ? 1 : r.unit === 'hour' ? 1 / 24 : 1 / 1440);
  const maxAfter = Math.ceil(Math.max(0, ...s.rules.filter((r) => r.when === 'after').map(span)));
  const maxBefore = Math.ceil(Math.max(0, ...s.rules.filter((r) => r.when === 'before').map(span)));
  const step = s.recurrence === 'custom_days' ? Math.max(1, s.everyDays) : CYCLE_DAYS[s.recurrence];
  // Skip straight to the first occurrence that can still matter.
  const gap = daysBetween(s.eventDate, localDate(from, s.timeZone)) - maxAfter - 2;
  let k = step > 0 && gap > 0 ? Math.floor(gap / step) : 0;
  for (let i = 0; i < maxOccurrences; i++, k++) {
    if (s.recurrence === 'none' && k > 0) return;
    if (s.maxCycles !== null && k >= s.maxCycles) return;
    const occ = occurrence(s.eventDate, s.recurrence, k, s.everyDays);
    if (s.endDate && occ > s.endDate) return;
    const earliest = zonedToUtc(addDays(occ, -maxBefore - 1), '00:00', s.timeZone);
    if (until && earliest > until) return;
    const best = bound?.();
    if (best && earliest > best) return;
    if (s.doneThrough && occ <= s.doneThrough) continue;
    for (const rule of s.rules) {
      const run = runFor(s, rule, k, occ);
      if (run.runAt >= from) visit(run);
    }
  }
}

// ---- Reading dates from files ----

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Year used when a birthday has none; chosen because it is a leap year. */
export const NO_YEAR = 1904;

/**
 * "14/08/1990", "2026-12-01", "1 Dec 2026", "Dec 1, 2026", Excel serials and (when
 * allowed) "14/08". Returns null when it is not a real date.
 */
export function parseDate(input: string, order: 'dmy' | 'mdy' = 'dmy', yearOptional = false): string | null {
  const raw = input.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  if (!raw) return null;
  const ok = (y: number, m: number, d: number) => {
    const date = iso(y, m, d);
    return isRealDate(date) ? date : null;
  };
  const year = (v: string) => {
    const n = Number(v);
    return v.length <= 2 ? (n > 50 ? 1900 + n : 2000 + n) : n;
  };
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(raw);
  if (m) return ok(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{2}|\d{4})(?:\s.*)?$/.exec(raw);
  if (m) return order === 'dmy' ? ok(year(m[3]!), Number(m[2]), Number(m[1])) : ok(year(m[3]!), Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})[\s-]+([a-z]{3,9})\.?(?:[\s,-]+(\d{4}|\d{2}))?$/i.exec(raw);
  if (m) {
    const month = MONTH_NAMES.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1;
    if (!month || (!m[3] && !yearOptional)) return null;
    return ok(m[3] ? year(m[3]) : NO_YEAR, month, Number(m[1]));
  }
  m = /^([a-z]{3,9})\.?[\s-]+(\d{1,2})(?:[\s,-]+(\d{4}|\d{2}))?$/i.exec(raw);
  if (m) {
    const month = MONTH_NAMES.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1;
    if (!month || (!m[3] && !yearOptional)) return null;
    return ok(m[3] ? year(m[3]) : NO_YEAR, month, Number(m[2]));
  }
  m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(raw);
  if (m && yearOptional) return order === 'dmy' ? ok(NO_YEAR, Number(m[2]), Number(m[1])) : ok(NO_YEAR, Number(m[1]), Number(m[2]));
  // Excel stores dates as days since 1899-12-30.
  if (/^\d{4,5}(\.\d+)?$/.test(raw)) {
    const serial = Math.floor(Number(raw));
    if (serial > 1_000 && serial < 110_000) return addDays('1899-12-30', serial);
  }
  return null;
}

/** "14:30", "2:30 PM", "2 pm", "1430" or an Excel day fraction, as "HH:MM". */
export function parseTime(input: string): string | null {
  const raw = input.trim().toLowerCase().replace(/\./g, '');
  if (!raw) return null;
  let m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/.exec(raw.replace(/\s+/g, ' '));
  if (!m && /^\d{4}$/.test(raw)) m = [raw, raw.slice(0, 2), raw.slice(2), undefined] as unknown as RegExpExecArray;
  if (m && (m[2] || m[3])) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (m[3]) {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
    }
    return h <= 23 && min <= 59 ? `${pad(h)}:${pad(min)}` : null;
  }
  const fraction = Number(`0.${input.trim().split('.')[1] ?? ''}`);
  if (/^\d*\.\d+$/.test(input.trim()) && fraction > 0) {
    const total = Math.round(fraction * 1440);
    return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
  }
  return null;
}

export function formatDate(date: string): string {
  const [y, m, d] = parts(date.slice(0, 10));
  const month = MONTH_NAMES[m - 1]!;
  const label = `${d} ${month[0]!.toUpperCase()}${month.slice(1)}`;
  return y === NO_YEAR ? label : `${label} ${y}`;
}

export function formatTime(time: string | null): string {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number) as [number, number];
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

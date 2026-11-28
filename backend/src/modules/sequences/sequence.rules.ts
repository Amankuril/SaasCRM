import { addDays, localDate, zonedToUtc } from '../reminders/schedule.js';
import { splitBucket, type Condition, type Variable } from './sequence.graph.js';

// ---- time ----

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
const toHHMM = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** ISO weekday (1 = Monday … 7 = Sunday) of a YYYY-MM-DD date. */
export function isoWeekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

function minutesNow(at: Date, timeZone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

export interface WindowRules {
  quietHours: { enabled: boolean; start: string; end: string };
  days: number[];
}

/** Allowed [from, to) minute ranges of one day. */
function openRanges(rules: WindowRules): [number, number][] {
  if (!rules.quietHours.enabled) return [[0, 1440]];
  const s = toMinutes(rules.quietHours.start);
  const e = toMinutes(rules.quietHours.end);
  if (s === e) return [[0, 1440]];
  // Overnight quiet time (21:00–09:00): send between end and start.
  if (s > e) return [[e, s]];
  const ranges: [number, number][] = [
    [0, s],
    [e, 1440],
  ];
  return ranges.filter(([a, b]) => b > a);
}

/** `now` if sending is allowed now, else the next moment it is (quiet hours, allowed weekdays). */
export function nextSendTime(now: Date, rules: WindowRules, timeZone: string): Date {
  const days = rules.days?.length ? rules.days : [1, 2, 3, 4, 5, 6, 7];
  const ranges = openRanges(rules);
  const today = localDate(now, timeZone);
  const nowMin = minutesNow(now, timeZone);
  for (let i = 0; i < 8; i++) {
    const day = addDays(today, i);
    if (!days.includes(isoWeekday(day))) continue;
    for (const [from, to] of ranges) {
      if (i === 0) {
        if (nowMin >= from && nowMin < to) return now;
        if (nowMin < from) return zonedToUtc(day, toHHMM(from), timeZone);
      } else {
        return zonedToUtc(day, toHHMM(from), timeZone);
      }
    }
  }
  return now; // no allowed day at all: do not block forever
}

/** The first allowed send time on the next day (daily cap reached). */
export function nextDaySendTime(now: Date, rules: WindowRules, timeZone: string): Date {
  const tomorrow = zonedToUtc(addDays(localDate(now, timeZone), 1), '00:00', timeZone);
  return nextSendTime(tomorrow, rules, timeZone);
}

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A stored date (Date, "YYYY-MM-DD" or an ISO date-time) as a local calendar day. */
export function dayOf(value: unknown, timeZone: string): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : localDate(value, timeZone);
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : localDate(d, timeZone);
}

/** The moment a dated step runs: `offsetDays` from the date, at `time`, in the timezone. */
export function datedRunAt(day: string, offsetDays: number, time: string, timeZone: string): Date {
  return zonedToUtc(addDays(day, offsetDays), time, timeZone);
}

// ---- contact values ----

export interface ContactValues {
  id: string;
  name: string | null;
  profileName: string | null;
  phoneE164: string;
  email: string | null;
  tags: string[];
  lifecycleStage: string;
  customFields: Record<string, unknown>;
}

const str = (v: unknown) => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)).trim();

/** A variable's value, or null when it is empty and has no fallback (the step then errors). */
export function resolveVariable(v: Variable, contact: ContactValues, data: Record<string, unknown>, timeZone: string, now = new Date()): string | null {
  let raw = '';
  if (v.source === 'contact') {
    const name = contact.name || contact.profileName || '';
    raw = v.value === 'first_name' ? (name.split(/\s+/)[0] ?? '') : v.value === 'phone' ? contact.phoneE164 : v.value === 'email' ? (contact.email ?? '') : name;
  } else if (v.source === 'field') raw = str(contact.customFields[v.value]);
  else if (v.source === 'data') raw = str(data[v.value]);
  else if (v.source === 'today') raw = new Date(now).toLocaleDateString('en-IN', { timeZone, day: 'numeric', month: 'short', year: 'numeric' });
  else raw = v.value;
  const value = raw.trim() || v.fallback.trim();
  return value || null;
}

export function variableLabel(v: Variable): string {
  if (v.source === 'contact') return `contact.${v.value || 'name'}`;
  if (v.source === 'field') return `field "${v.value}"`;
  if (v.source === 'data') return `data "${v.value}"`;
  if (v.source === 'today') return "today's date";
  return 'fixed text';
}

// ---- conditions ----

export interface ConditionContext {
  contact: ContactValues;
  data: Record<string, unknown>;
  stepId: string;
  lastMessage: { status: string; deliveredAt: Date | null; readAt: Date | null } | null;
  replied: boolean;
  lastReplyText: string;
}

function compare(actual: unknown, op: 'equals' | 'not_equals' | 'contains' | 'is_set' | 'not_set', expected: string): boolean {
  const a = str(actual).toLowerCase();
  const e = expected.trim().toLowerCase();
  if (op === 'is_set') return a !== '';
  if (op === 'not_set') return a === '';
  if (op === 'equals') return a === e;
  if (op === 'not_equals') return a !== e;
  return e !== '' && a.includes(e);
}

export function conditionMatches(c: Condition, ctx: ConditionContext): boolean {
  switch (c.kind) {
    case 'tag':
      return ctx.contact.tags.includes(c.tagId) === (c.op === 'has');
    case 'stage':
      return (ctx.contact.lifecycleStage === c.stage) === (c.op === 'is');
    case 'field':
      return compare(ctx.contact.customFields[c.key], c.op, c.value);
    case 'data':
      return compare(ctx.data[c.key], c.op, c.value);
    case 'last_message': {
      const m = ctx.lastMessage;
      if (c.op === 'read') return !!m?.readAt;
      if (c.op === 'delivered') return !!(m?.deliveredAt || m?.readAt);
      return !m?.readAt;
    }
    case 'replied':
      if (c.op === 'replied') return ctx.replied;
      if (c.op === 'not_replied') return !ctx.replied;
      return ctx.replied && compare(ctx.lastReplyText, 'contains', c.value);
    case 'split':
      return splitBucket(ctx.contact.id, ctx.stepId) < c.percent;
  }
}

/** All must match (an empty list always matches). */
export function allMatch(conditions: Condition[], ctx: ConditionContext): boolean {
  return conditions.every((c) => conditionMatches(c, ctx));
}

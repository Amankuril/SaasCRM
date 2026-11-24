import { Activity, Cake, CalendarClock, CalendarPlus, CreditCard, FileClock, Heart, IdCard, Landmark, Tag, Users, type LucideIcon } from 'lucide-react';
import { cn } from '../../components/ui';
import type { ReminderRecurrence, ReminderRule, ReminderSetup } from '../../lib/api';

export const CATEGORY_ICON: Record<string, LucideIcon> = {
  birthdays: Cake,
  anniversaries: Heart,
  payments: CreditCard,
  installments: Landmark,
  appointments: CalendarClock,
  offers: Tag,
  documents: IdCard,
  contracts: FileClock,
  healthcare: Activity,
  employees: Users,
  custom: CalendarPlus,
};

export function CategoryIcon({ category, className }: { category: string; className?: string }) {
  const Icon = CATEGORY_ICON[category] ?? CalendarClock;
  return (
    <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600', className)}>
      <Icon className="size-[18px]" strokeWidth={1.5} />
    </span>
  );
}

export const RECURRENCE_LABEL: Record<ReminderRecurrence, string> = {
  none: 'Once, on each contact’s date',
  weekly: 'Every week',
  monthly: 'Every month, same day',
  quarterly: 'Every 3 months, same day',
  half_yearly: 'Every 6 months, same day',
  yearly: 'Every year, same date',
  custom_days: 'Every few days',
};

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

export function ruleText(r: ReminderRule): string {
  if (r.when === 'on') return 'On the date';
  return `${plural(r.value, r.unit)} ${r.when === 'before' ? 'before' : 'after'}`;
}

/** "before-1-day" from the log, in words. */
export function ruleIdText(id: string | null): string {
  if (!id || id === 'on') return 'On the date';
  const [when, value, unit] = id.split('-');
  return ruleText({ when: when as ReminderRule['when'], value: Number(value), unit: unit as ReminderRule['unit'] });
}

export function recurrenceText(s: Pick<ReminderSetup, 'recurrence' | 'everyDays'>): string {
  return s.recurrence === 'custom_days' ? `Every ${plural(s.everyDays, 'day')}` : RECURRENCE_LABEL[s.recurrence];
}

export function timeText(time: string): string {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "1 day before, on the date at 10:00 AM" */
export function scheduleText(s: Pick<ReminderSetup, 'rules' | 'sendTime'>): string {
  if (!s.rules.length) return 'No timing yet';
  const list = s.rules.map((r, i) => (i ? ruleText(r).replace('On', 'on') : ruleText(r))).join(', ');
  const timed = s.rules.some((r) => r.when === 'on' || r.unit === 'day' || r.unit === 'week');
  return timed ? `${list}, at ${timeText(s.sendTime)}` : list;
}

export function dateTime(value: string | null, timeZone: string): string {
  if (!value) return 'Not scheduled';
  return new Date(value).toLocaleString('en-IN', { timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "2026-12-01" or "2026-12-01T14:30" */
export function occurrenceText(value: string | null): string {
  if (!value) return '';
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d)).toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  return value.length > 10 ? `${date}, ${timeText(value.slice(11))}` : date;
}

export const money = (paise: number, currency: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: paise % 100 ? 2 : 0 }).format(paise / 100);

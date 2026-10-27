import type { SheetCampaign, SheetRowState } from '../../lib/api';
import { cn } from '../../components/ui';

export const SheetsLogo = ({ className }: { className?: string }) => (
  <span className={cn('inline-flex rounded-xl bg-emerald-50 p-2 ring-1 ring-emerald-100', className)}>
    <img src="/integrations/googlesheets.svg" alt="Google Sheets" className="size-6" />
  </span>
);

const STATE_STYLE: Record<SheetCampaign['state'], { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  paused: { label: 'Paused', className: 'bg-amber-50 text-amber-700 ring-amber-200' },
  error: { label: 'Error', className: 'bg-red-50 text-red-700 ring-red-200' },
  draft: { label: 'Setup incomplete', className: 'bg-slate-100 text-slate-600 ring-slate-200' },
};

export function StateBadge({ state }: { state: SheetCampaign['state'] }) {
  const s = STATE_STYLE[state];
  return <span className={cn('inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1', s.className)}>{s.label}</span>;
}

const CATEGORY_STYLE: Record<string, string> = {
  UTILITY: 'bg-sky-50 text-sky-700 ring-sky-200',
  MARKETING: 'bg-violet-50 text-violet-700 ring-violet-200',
  AUTHENTICATION: 'bg-amber-50 text-amber-700 ring-amber-200',
};

export function CategoryBadge({ category }: { category: string }) {
  return (
    <span className={cn('inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ring-1', CATEGORY_STYLE[category] ?? 'bg-slate-100 text-slate-600 ring-slate-200')}>
      {category.toLowerCase()}
    </span>
  );
}

const ROW_STYLE: Record<SheetRowState, { label: string; className: string; message: string }> = {
  skipped: { label: 'Skipped', className: 'bg-slate-100 text-slate-600 ring-slate-200', message: 'Was in the sheet before going live' },
  waiting: { label: 'Waiting', className: 'bg-slate-100 text-slate-600 ring-slate-200', message: 'Waiting for empty cells' },
  queued: { label: 'Queued', className: 'bg-amber-50 text-amber-700 ring-amber-200', message: 'Waiting to be sent' },
  sent: { label: 'Sent', className: 'bg-slate-100 text-slate-700 ring-slate-300', message: 'Sent on WhatsApp' },
  delivered: { label: 'Delivered', className: 'bg-emerald-50 text-emerald-700 ring-emerald-200', message: 'Delivered on WhatsApp' },
  read: { label: 'Read', className: 'bg-sky-50 text-sky-700 ring-sky-200', message: 'Read on WhatsApp' },
  failed: { label: 'Failed', className: 'bg-red-50 text-red-700 ring-red-200', message: 'Not delivered' },
};

export const rowStyle = (s: SheetRowState) => ROW_STYLE[s];

export function RowBadge({ state }: { state: SheetRowState }) {
  const s = ROW_STYLE[state];
  return <span className={cn('inline-flex rounded-md px-2 py-0.5 text-xs font-medium ring-1', s.className)}>{s.label}</span>;
}

export const DELAY_OPTIONS = [
  { value: 0, label: 'Instant' },
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 180, label: '3 hours' },
  { value: 24 * 60, label: '1 day' },
];

export function delayLabel(minutes: number) {
  if (!minutes) return 'Instant';
  return DELAY_OPTIONS.find((o) => o.value === minutes)?.label ?? (minutes % 60 ? `${minutes} min` : `${minutes / 60} h`);
}

/** "27 Oct 26", as the list shows it. */
export const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });

/** "19 Oct 26, 18:11". */
export const shortDateTime = (iso: string) =>
  `${shortDate(iso)}, ${new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;

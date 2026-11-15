import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Select, cn } from '../../components/ui';
import { api, type AppointmentStatus, type FlowStatus, type FlowSummary } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';

/** How flow statuses are worded across the module. */
export const FLOW_STATUS: Record<FlowStatus, { label: string; tone: 'gray' | 'green' | 'amber'; badge: string }> = {
  draft: { label: 'Draft', tone: 'gray', badge: 'draft' },
  active: { label: 'Active', tone: 'green', badge: 'active' },
  inactive: { label: 'Paused', tone: 'amber', badge: 'paused' },
};

export function useFlows() {
  const { workspace } = useWorkspace();
  return useQuery({ queryKey: ['flows', workspace.id], queryFn: () => api.get<{ flows: FlowSummary[] }>(`/workspaces/${workspace.id}/flows`) });
}

export type RangeKey = '7d' | '30d' | '90d' | '365d';
export const RANGES: { key: RangeKey; label: string; days: number }[] = [
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
  { key: '365d', label: 'Last 12 months', days: 365 },
];

/** ISO bounds for a range, cut to the start of the day so query keys stay stable. */
export function rangeBounds(key: RangeKey): { from: string; to: string; days: number } {
  const days = RANGES.find((r) => r.key === key)!.days;
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end.getTime() - days * 86_400_000 + 1);
  return { from: start.toISOString(), to: end.toISOString(), days };
}

export function RangeSelect({ value, onChange }: { value: RangeKey; onChange: (v: RangeKey) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as RangeKey)} className="w-40" aria-label="Date range">
      {RANGES.map((r) => (
        <option key={r.key} value={r.key}>
          {r.label}
        </option>
      ))}
    </Select>
  );
}

export function FlowSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const flows = useFlows();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-48" aria-label="Automation">
      <option value="">All automations</option>
      {flows.data?.flows.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </Select>
  );
}

export function StatCard({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: string; icon?: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        {icon && <span className="rounded-lg bg-brand-50 p-1.5 text-brand-700">{icon}</span>}
      </div>
      <p className="mt-2 text-2xl font-semibold text-ink tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  const btn = 'rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40';
  return (
    <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
      <button className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      Page {page} of {pages}
      <button className={btn} disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  );
}

export const th = 'px-4 py-2.5 text-left text-xs font-medium whitespace-nowrap text-slate-500';
export const td = (extra?: string) => cn('px-4 py-3 align-middle', extra);

/** Appointment statuses as the Flow Builder module words them. */
export const FLOW_APPT_STATUS: Record<AppointmentStatus, { label: string; badge: string }> = {
  scheduled: { label: 'Booked', badge: 'booked' },
  confirmed: { label: 'Confirmed', badge: 'confirmed' },
  completed: { label: 'Completed', badge: 'completed' },
  cancelled: { label: 'Cancelled', badge: 'cancelled' },
  no_show: { label: 'No-show', badge: 'failed' },
};

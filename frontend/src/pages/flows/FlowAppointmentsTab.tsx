import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, CalendarDays, Download, Search, Table2 } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { SkeletonRows, StatusBadge, useToast } from '../../components/feedback';
import { Alert, Button, Card, EmptyState, Input, Select, cn, errorMessage } from '../../components/ui';
import { api, type Appointment, type AppointmentStatus } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { MonthCalendar } from '../audience/AppointmentsPage';
import { FLOW_APPT_STATUS, td, th } from './shared';

type When = 'all' | 'upcoming' | 'today' | 'week' | 'month' | 'past';
const WHEN: Record<When, string> = { all: 'All dates', upcoming: 'Upcoming', today: 'Today', week: 'This week', month: 'This month', past: 'Past' };

function bounds(when: When): { from?: string; to?: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = 86_400_000;
  if (when === 'upcoming') return { from: now.toISOString() };
  if (when === 'past') return { to: now.toISOString() };
  if (when === 'today') return { from: start.toISOString(), to: new Date(start.getTime() + day - 1).toISOString() };
  if (when === 'week') {
    const monday = new Date(start.getTime() - ((start.getDay() + 6) % 7) * day);
    return { from: monday.toISOString(), to: new Date(monday.getTime() + 7 * day - 1).toISOString() };
  }
  if (when === 'month') return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to: new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, -1).toISOString() };
  return {};
}

/** Appointments booked by the Book Appt. step. */
export function FlowAppointmentsTab() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const toast = useToast();
  const editable = can('contacts:manage') && workspace.status !== 'suspended';
  const [q, setQ] = useState('');
  const search = useDeferredValue(q.trim());
  const [status, setStatus] = useState('');
  const [when, setWhen] = useState<When>('all');
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));

  const params = new URLSearchParams({ source: 'flow', sort: 'newest', limit: '500' });
  if (search) params.set('q', search);
  if (status) params.set('status', status);
  // The calendar always shows its month; the list follows the date filter.
  const range = view === 'calendar' ? { from: month.toISOString(), to: new Date(month.getFullYear(), month.getMonth() + 1, 1, 0, 0, 0, -1).toISOString() } : bounds(when);
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const list = useQuery({
    queryKey: ['appointments', workspace.id, params.toString()],
    queryFn: () => api.get<{ appointments: Appointment[]; total: number }>(`/workspaces/${workspace.id}/appointments?${params}`),
    placeholderData: keepPreviousData,
  });
  const change = useMutation({
    mutationFn: (p: { id: string; status: AppointmentStatus }) => api.patch(`/workspaces/${workspace.id}/appointments/${p.id}`, { status: p.status }),
    onSuccess: () => {
      toast.success('Appointment updated');
      void queryClient.invalidateQueries({ queryKey: ['appointments', workspace.id] });
    },
    onError: (err) => toast.error(err),
  });
  const exportCsv = useMutation({ mutationFn: () => api.download(`/workspaces/${workspace.id}/appointments/export?${params}`, 'flow-appointments.csv'), onError: (err) => toast.error(err) });
  const items = list.data?.appointments ?? [];

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink">Appointments</h1>
          <p className="mt-1 text-sm text-slate-500">Bookings customers made inside your automations.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-sm font-medium">
            {(
              [
                ['list', 'List', Table2],
                ['calendar', 'Calendar', CalendarDays],
              ] as const
            ).map(([key, label, Icon]) => (
              <button key={key} type="button" onClick={() => setView(key)} aria-pressed={view === key} className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5', view === key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>
                <Icon className="size-4" /> {label}
              </button>
            ))}
          </div>
          <Button variant="secondary" loading={exportCsv.isPending} disabled={!items.length} onClick={() => exportCsv.mutate()}>
            <Download className="size-4" /> Export
          </Button>
        </div>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <div className="relative min-w-48 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, number or service" className="pl-9" aria-label="Search appointments" />
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label="Status">
            <option value="">All statuses</option>
            {Object.entries(FLOW_APPT_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
          {view === 'list' && (
            <Select value={when} onChange={(e) => setWhen(e.target.value as When)} className="w-36" aria-label="Date">
              {Object.entries(WHEN).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          )}
          {list.data && <span className="ml-auto text-xs text-slate-500">{list.data.total.toLocaleString()} appointments</span>}
        </div>
        {list.isPending ? (
          <SkeletonRows rows={6} />
        ) : list.error ? (
          <div className="p-4">
            <Alert>{errorMessage(list.error)}</Alert>
          </div>
        ) : view === 'calendar' ? (
          <div className="px-3 pb-3">
            <MonthCalendar month={month} onMonth={setMonth} items={items} onOpen={() => setView('list')} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<CalendarCheck className="size-5" />} title="No appointments booked by flows yet">
            Add a Book Appt. step to an automation and customers can pick a date and time on WhatsApp.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={th}>Date</th>
                  <th className={th}>Time</th>
                  <th className={th}>Contact</th>
                  <th className={th}>Service</th>
                  <th className={th}>Status</th>
                  {editable && <th className={th}>Change status</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((a) => {
                  const at = new Date(a.startAt);
                  const s = FLOW_APPT_STATUS[a.status];
                  return (
                    <tr key={a.id} className="hover:bg-slate-50">
                      <td className={td('whitespace-nowrap font-medium text-slate-800')}>{at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</td>
                      <td className={td('whitespace-nowrap tabular-nums')}>
                        {at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                        <span className="text-xs text-slate-400"> · {a.durationMinutes} min</span>
                      </td>
                      <td className={td()}>
                        <p className="text-slate-800">{a.contact?.name ?? 'Deleted contact'}</p>
                        {a.contact && <p className="text-xs text-slate-500">+{a.contact.phone.replace(/^\+/, '')}</p>}
                      </td>
                      <td className={td('max-w-56 truncate text-slate-700')}>{a.service}</td>
                      <td className={td()}>
                        <StatusBadge status={s.badge} label={s.label} />
                      </td>
                      {editable && (
                        <td className={td()}>
                          <Select value={a.status} onChange={(e) => change.mutate({ id: a.id, status: e.target.value as AppointmentStatus })} className="w-36 py-1 text-xs" aria-label={`Status for ${a.contact?.name ?? 'appointment'}`}>
                            {Object.entries(FLOW_APPT_STATUS).map(([k, v]) => (
                              <option key={k} value={k}>
                                {v.label}
                              </option>
                            ))}
                          </Select>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

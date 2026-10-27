import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpDown, CalendarCheck, CalendarDays, CalendarPlus, CheckCircle2, ChevronLeft, ChevronRight, Download, MoreHorizontal, RefreshCw, Search, Table2, XCircle } from 'lucide-react';
import { useDeferredValue, useState, type ReactNode } from 'react';
import { ContactPicker, type PickedContact } from '../../components/ContactPicker';
import { Dialog } from '../../components/Dialog';
import { Alert, Button, EmptyState, Input, Select, Spinner, cn, errorMessage, fieldError } from '../../components/ui';
import { api, type Appointment, type AppointmentSource, type AppointmentStatus } from '../../lib/api';
import { useMembers } from '../../lib/hooks';
import { DIAL_CODES } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { Popover, avatarTone, initials } from './shared';

const SOURCE_LABEL: Record<AppointmentSource, string> = { ai_assistant: 'AI assistant', flow: 'Flow', manual: 'Added by team', api: 'API' };
const STATUS: Record<AppointmentStatus, { label: string; tone: string }> = {
  scheduled: { label: 'Scheduled', tone: 'bg-sky-50 text-sky-700 ring-sky-200' },
  completed: { label: 'Done', tone: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  cancelled: { label: 'Cancelled', tone: 'bg-red-50 text-red-700 ring-red-200' },
  no_show: { label: 'No-show', tone: 'bg-amber-50 text-amber-800 ring-amber-200' },
};
type DateRange = 'all' | 'upcoming' | 'today' | 'week' | 'month' | 'past';
const RANGE_LABEL: Record<DateRange, string> = { all: 'All dates', upcoming: 'Upcoming', today: 'Today', week: 'This week', month: 'This month', past: 'Past' };

function rangeBounds(range: DateRange): { from?: string; to?: string } {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  switch (range) {
    case 'upcoming':
      return { from: now.toISOString() };
    case 'past':
      return { to: now.toISOString() };
    case 'today':
      return { from: start.toISOString(), to: new Date(start.getTime() + day - 1).toISOString() };
    case 'week': {
      const monday = new Date(start.getTime() - ((start.getDay() + 6) % 7) * day);
      return { from: monday.toISOString(), to: new Date(monday.getTime() + 7 * day - 1).toISOString() };
    }
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to: new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, -1).toISOString() };
    default:
      return {};
  }
}

const dateTime = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Appointments booked by customers (AI assistant, flows) or added by the team. */
export function AppointmentsPage() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const editable = can('contacts:manage') && workspace.status !== 'suspended';
  const [q, setQ] = useState('');
  const deferredQ = useDeferredValue(q.trim());
  const [source, setSource] = useState('');
  const [range, setRange] = useState<DateRange>('all');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [view, setView] = useState<'table' | 'calendar'>('table');
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [editing, setEditing] = useState<Appointment | 'new' | null>(null);
  const [newAt, setNewAt] = useState<Date | null>(null);
  const [rangeAnchor, setRangeAnchor] = useState<HTMLButtonElement | null>(null);
  const [rangeOpen, setRangeOpen] = useState(false);

  const params = new URLSearchParams({ sort, limit: '500' });
  if (deferredQ) params.set('q', deferredQ);
  if (source) params.set('source', source);
  // The calendar always shows its month; the table follows the date filter.
  const bounds =
    view === 'calendar'
      ? { from: new Date(month.getFullYear(), month.getMonth(), 1).toISOString(), to: new Date(month.getFullYear(), month.getMonth() + 1, 1, 0, 0, 0, -1).toISOString() }
      : rangeBounds(range);
  if (bounds.from) params.set('from', bounds.from);
  if (bounds.to) params.set('to', bounds.to);
  const list = useQuery({
    queryKey: ['appointments', workspace.id, params.toString()],
    queryFn: () => api.get<{ appointments: Appointment[]; total: number; stats: { upcoming: number; doneThisMonth: number; cancelled: number } }>(`/workspaces/${workspace.id}/appointments?${params}`),
    placeholderData: keepPreviousData,
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['appointments', workspace.id] });
  const setStatus = useMutation({ mutationFn: (p: { id: string; status: AppointmentStatus }) => api.patch(`/workspaces/${workspace.id}/appointments/${p.id}`, { status: p.status }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/workspaces/${workspace.id}/appointments/${id}`), onSuccess: invalidate });
  const exportCsv = useMutation({ mutationFn: () => api.download(`/workspaces/${workspace.id}/appointments/export?${params}`, 'appointments.csv') });
  const stats = list.data?.stats;
  const items = list.data?.appointments ?? [];
  const error = list.error ?? setStatus.error ?? remove.error ?? exportCsv.error;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Appointments</h1>
          <p className="mt-0.5 text-sm text-slate-500">All appointments booked by customers through your AI assistant, flows or your team</p>
        </div>
        {editable && (
          <Button onClick={() => (setNewAt(null), setEditing('new'))} className="bg-slate-700 hover:bg-slate-800">
            <CalendarPlus className="size-4" /> New appointment
          </Button>
        )}
      </div>

      <div className="mt-5 grid overflow-hidden rounded-xl border border-slate-200 bg-white sm:grid-cols-3">
        <Stat icon={<CalendarDays className="size-5" />} tone="bg-sky-50 text-sky-600" label="Coming Up" value={stats?.upcoming} />
        <Stat icon={<CheckCircle2 className="size-5" />} tone="bg-emerald-50 text-emerald-600" label="Done This Month" value={stats?.doneThisMonth} />
        <Stat icon={<XCircle className="size-5" />} tone="bg-red-50 text-red-500" label="Cancelled" value={stats?.cancelled} />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
          <Input aria-label="Search appointments" placeholder="Search by name, phone, or service" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <div className="w-40">
          <Select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">All sources</option>
            {(Object.keys(SOURCE_LABEL) as AppointmentSource[]).map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
        {view === 'table' && (
          <>
            <Button ref={setRangeAnchor} variant="secondary" onClick={() => setRangeOpen(!rangeOpen)}>
              <CalendarDays className="size-4" /> {RANGE_LABEL[range]}
            </Button>
            <Popover anchor={rangeAnchor} open={rangeOpen} onClose={() => setRangeOpen(false)} width={170}>
              {(Object.keys(RANGE_LABEL) as DateRange[]).map((r) => (
                <button key={r} type="button" onClick={() => (setRange(r), setRangeOpen(false))} className={cn('flex w-full rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-slate-50', range === r && 'font-medium text-ink')}>
                  {RANGE_LABEL[r]}
                </button>
              ))}
            </Popover>
            <Button variant="secondary" onClick={() => setSort(sort === 'newest' ? 'oldest' : 'newest')}>
              <ArrowUpDown className="size-4" /> Date ({sort === 'newest' ? 'newest first' : 'oldest first'})
            </Button>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
            {(
              [
                ['table', 'Table', Table2],
                ['calendar', 'Calendar', CalendarDays],
              ] as const
            ).map(([v, label, Icon]) => (
              <button key={v} type="button" onClick={() => setView(v)} className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm', view === v ? 'bg-slate-100 font-medium text-ink' : 'text-slate-500')}>
                <Icon className="size-4" /> {label}
              </button>
            ))}
          </div>
          <Button variant="secondary" onClick={() => exportCsv.mutate()} loading={exportCsv.isPending} disabled={!items.length}>
            {!exportCsv.isPending && <Download className="size-4" />} Export
          </Button>
          <Button variant="secondary" onClick={invalidate}>
            <RefreshCw className={cn('size-4', list.isFetching && 'animate-spin')} /> Refresh
          </Button>
        </div>
      </div>

      {error != null && (
        <div className="mt-3">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      )}

      {view === 'calendar' ? (
        <MonthCalendar month={month} onMonth={setMonth} items={items} onOpen={(a) => setEditing(a)} onDay={editable ? (d) => (setNewAt(d), setEditing('new')) : undefined} />
      ) : (
        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 font-medium">Service</th>
                  <th className="px-4 py-3 font-medium">Date &amp; Time</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              {!list.isPending && items.length > 0 && (
                <tbody className="divide-y divide-slate-100">
                  {items.map((a) => (
                    <tr key={a.id} className="hover:bg-slate-50/60">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold', avatarTone(a.id))}>{initials(a.contact?.name ?? '?')}</span>
                          <div>
                            <p className="font-medium text-slate-800">{a.contact?.name ?? 'Deleted customer'}</p>
                            <p className="font-mono text-xs text-slate-500">{a.contact?.phone}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {a.service}
                        <span className="block text-xs text-slate-400">{a.durationMinutes} min</span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-700">{dateTime(a.startAt)}</td>
                      <td className="px-4 py-3 text-slate-600">{SOURCE_LABEL[a.source]}</td>
                      <td className="px-4 py-3">
                        <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', STATUS[a.status].tone)}>{STATUS[a.status].label}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end">
                          <RowActions
                            appointment={a}
                            editable={editable}
                            onEdit={() => setEditing(a)}
                            onStatus={(status) => setStatus.mutate({ id: a.id, status })}
                            onDelete={() => window.confirm('Delete this appointment?') && remove.mutate(a.id)}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>
          {list.isPending ? (
            <Spinner />
          ) : (
            items.length === 0 && (
              <EmptyState icon={<CalendarCheck className="size-5" />} title={deferredQ || source || range !== 'all' ? 'No appointments match' : 'No appointments yet'}>
                {deferredQ || source || range !== 'all' ? 'Try another filter.' : 'Appointments booked by customers through your AI assistant, or added by your team, will appear here.'}
              </EmptyState>
            )
          )}
        </div>
      )}

      {editing && <AppointmentDialog appointment={editing === 'new' ? null : editing} defaultAt={newAt} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Stat({ icon, tone, label, value }: { icon: ReactNode; tone: string; label: string; value?: number }) {
  return (
    <div className="flex items-center gap-4 border-slate-200 p-5 sm:border-r sm:last:border-r-0">
      <span className={cn('rounded-xl p-2.5', tone)}>{icon}</span>
      <div>
        <p className="text-sm text-slate-500">{label}</p>
        <p className="text-2xl font-semibold text-ink">{value ?? '—'}</p>
      </div>
    </div>
  );
}

function RowActions({ appointment: a, editable, onEdit, onStatus, onDelete }: { appointment: Appointment; editable: boolean; onEdit: () => void; onStatus: (s: AppointmentStatus) => void; onDelete: () => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const item = (label: string, onClick: () => void, danger = false) => (
    <button type="button" onClick={() => (setOpen(false), onClick())} className={cn('flex w-full rounded-lg px-2.5 py-1.5 text-left text-sm', danger ? 'text-red-600 hover:bg-red-50' : 'hover:bg-slate-50')}>
      {label}
    </button>
  );
  return (
    <>
      <button ref={setAnchor} type="button" onClick={() => setOpen(!open)} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Appointment actions">
        <MoreHorizontal className="size-4" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={180} align="right">
        {item(editable ? 'View / edit' : 'View', onEdit)}
        {editable && a.status !== 'completed' && item('Mark as done', () => onStatus('completed'))}
        {editable && a.status === 'scheduled' && item('Mark no-show', () => onStatus('no_show'))}
        {editable && a.status !== 'scheduled' && item('Reopen', () => onStatus('scheduled'))}
        {editable && a.status !== 'cancelled' && item('Cancel', () => onStatus('cancelled'), true)}
        {editable && item('Delete', onDelete, true)}
      </Popover>
    </>
  );
}

function MonthCalendar({ month, onMonth, items, onOpen, onDay }: { month: Date; onMonth: (d: Date) => void; items: Appointment[]; onOpen: (a: Appointment) => void; onDay?: (d: Date) => void }) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7; // weeks start on Monday
  const days = Array.from({ length: 42 }, (_, i) => new Date(month.getFullYear(), month.getMonth(), 1 - offset + i));
  const todayKey = new Date().toDateString();
  const byDay = new Map<string, Appointment[]>();
  for (const a of items) {
    const key = new Date(a.startAt).toDateString();
    byDay.set(key, [...(byDay.get(key) ?? []), a]);
  }
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <Button variant="ghost" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">
          <ChevronLeft className="size-4" />
        </Button>
        <p className="font-semibold text-ink">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</p>
        <Button variant="ghost" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">
          <ChevronRight className="size-4" />
        </Button>
      </div>
      <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-xs font-medium text-slate-500">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="py-2">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const inMonth = d.getMonth() === month.getMonth();
          const list = (byDay.get(d.toDateString()) ?? []).sort((a, b) => a.startAt.localeCompare(b.startAt));
          return (
            <div
              key={d.toISOString()}
              onDoubleClick={() => onDay?.(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10))}
              className={cn('min-h-24 border-r border-b border-slate-100 p-1.5 text-xs [&:nth-child(7n)]:border-r-0', !inMonth && 'bg-slate-50/60 text-slate-400')}
              title={onDay ? 'Double-click to book' : undefined}
            >
              <p className={cn('mb-1 flex size-6 items-center justify-center rounded-full', d.toDateString() === todayKey && 'bg-slate-700 font-semibold text-white')}>{d.getDate()}</p>
              <div className="space-y-0.5">
                {list.slice(0, 3).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => onOpen(a)}
                    className={cn('block w-full truncate rounded px-1.5 py-0.5 text-left ring-1 ring-inset', STATUS[a.status].tone)}
                    title={`${a.service} · ${a.contact?.name ?? ''}`}
                  >
                    {new Date(a.startAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} {a.contact?.name ?? a.service}
                  </button>
                ))}
                {list.length > 3 && <p className="px-1 text-slate-500">+{list.length - 3} more</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function AppointmentDialog({ appointment, defaultAt, onClose }: { appointment: Appointment | null; defaultAt: Date | null; onClose: () => void }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const editable = can('contacts:manage') && workspace.status !== 'suspended';
  const members = useMembers(workspace.id, can('members:read'));
  const fallback = new Date(Date.now() + 86_400_000);
  fallback.setHours(10, 0, 0, 0);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [contact, setContact] = useState<PickedContact | null>(appointment?.contact ?? null);
  const [country, setCountry] = useState(DIAL_CODES.some((c) => c.iso === workspace.country) ? workspace.country : 'IN');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [service, setService] = useState(appointment?.service ?? '');
  const [at, setAt] = useState(toLocalInput(appointment ? new Date(appointment.startAt) : (defaultAt ?? fallback)));
  const [duration, setDuration] = useState(appointment?.durationMinutes ?? 30);
  const [assigneeId, setAssigneeId] = useState(appointment?.assignee?.id ?? '');
  const [notes, setNotes] = useState(appointment?.notes ?? '');
  const [status, setStatus] = useState<AppointmentStatus>(appointment?.status ?? 'scheduled');
  const dial = DIAL_CODES.find((c) => c.iso === country)?.dial ?? '';

  const save = useMutation({
    mutationFn: () => {
      const common = { service, startAt: new Date(at).toISOString(), durationMinutes: duration, notes, assigneeId: assigneeId || null };
      if (appointment) return api.patch(`/workspaces/${workspace.id}/appointments/${appointment.id}`, { ...common, status });
      return api.post(`/workspaces/${workspace.id}/appointments`, {
        ...common,
        ...(mode === 'existing' && contact ? { contactId: contact.id } : { phone: phone.trim().startsWith('+') ? phone : `+${dial}${phone.replace(/\D/g, '').replace(/^0+/, '')}`, name: name || undefined }),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['appointments', workspace.id] });
      onClose();
    },
  });
  const err = save.error;
  const label = 'mb-1.5 block text-sm font-medium text-slate-600';

  return (
    <Dialog
      icon={<CalendarCheck className="size-4" />}
      title={appointment ? 'Appointment' : 'New appointment'}
      subtitle={appointment ? `${SOURCE_LABEL[appointment.source]} · booked ${new Date(appointment.createdAt).toLocaleDateString()}` : 'Book a customer in. They are added to your audience if new.'}
      onClose={onClose}
      width="max-w-lg"
      footer={
        editable && (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!service.trim() || !at} className="bg-slate-700 hover:bg-slate-800">
              {appointment ? 'Save changes' : 'Book appointment'}
            </Button>
          </>
        )
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {err != null && <Alert>{fieldError(err, 'phone') ?? fieldError(err, 'service') ?? errorMessage(err)}</Alert>}
        {appointment ? (
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <span className="font-medium text-slate-800">{appointment.contact?.name ?? 'Deleted customer'}</span> <span className="font-mono text-xs text-slate-500">{appointment.contact?.phone}</span>
          </div>
        ) : (
          <div>
            <div className="mb-2 inline-flex rounded-lg bg-slate-100 p-1 text-sm">
              {(
                [
                  ['existing', 'Existing customer'],
                  ['new', 'New number'],
                ] as const
              ).map(([m, l]) => (
                <button key={m} type="button" onClick={() => setMode(m)} className={cn('rounded-md px-3 py-1', mode === m ? 'bg-white font-medium shadow-sm' : 'text-slate-600')}>
                  {l}
                </button>
              ))}
            </div>
            {mode === 'existing' ? (
              <ContactPicker value={contact} onChange={setContact} />
            ) : (
              <div className="grid gap-2 sm:grid-cols-[8rem_1fr_1fr]">
                <Select aria-label="Country code" value={country} onChange={(e) => setCountry(e.target.value)}>
                  {DIAL_CODES.map((c) => (
                    <option key={c.iso} value={c.iso}>
                      {c.iso} +{c.dial}
                    </option>
                  ))}
                </Select>
                <Input aria-label="WhatsApp number" type="tel" placeholder="9876543210" value={phone} onChange={(e) => setPhone(e.target.value)} />
                <Input aria-label="Customer name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
          </div>
        )}
        <div>
          <label htmlFor="ap-service" className={label}>
            Service
          </label>
          <Input id="ap-service" disabled={!editable} maxLength={120} placeholder="e.g. Teeth cleaning, Consultation" value={service} onChange={(e) => setService(e.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="ap-at" className={label}>
              Date &amp; time
            </label>
            <Input id="ap-at" type="datetime-local" disabled={!editable} value={at} onChange={(e) => setAt(e.target.value)} />
          </div>
          <div>
            <label htmlFor="ap-duration" className={label}>
              Duration
            </label>
            <Select id="ap-duration" disabled={!editable} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {[15, 30, 45, 60, 90, 120].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="ap-assignee" className={label}>
              With
            </label>
            <Select id="ap-assignee" disabled={!editable || !members.data} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Anyone</option>
              {(members.data ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
          {appointment && (
            <div>
              <label htmlFor="ap-status" className={label}>
                Status
              </label>
              <Select id="ap-status" disabled={!editable} value={status} onChange={(e) => setStatus(e.target.value as AppointmentStatus)}>
                {(Object.keys(STATUS) as AppointmentStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS[s].label}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
        <div>
          <label htmlFor="ap-notes" className={label}>
            Notes
          </label>
          <textarea
            id="ap-notes"
            disabled={!editable}
            rows={3}
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/40 focus:outline-none disabled:bg-slate-50"
          />
        </div>
      </form>
    </Dialog>
  );
}

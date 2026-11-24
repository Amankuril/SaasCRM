import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, ScrollText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SkeletonRows, StatusBadge, useToast } from '../../components/feedback';
import { Ticks, type TickStatus } from '../../components/Ticks';
import { Button, Card, EmptyState, LoadError, cn } from '../../components/ui';
import { api, type ReminderCounts, type ReminderLog } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { Pager } from './Pager';
import { dateTime, occurrenceText, ruleIdText } from './shared';

type Filter = '' | 'upcoming' | 'sent' | 'pending' | 'failed' | 'skipped';
const EMPTY: Record<Filter, string> = {
  '': 'Reminders appear here once they are due.',
  upcoming: 'Nothing is scheduled. Activate the reminder and add contacts with dates ahead.',
  sent: 'Nothing has been sent yet.',
  pending: 'Nothing is waiting to be sent.',
  failed: 'No failures.',
  skipped: 'Nothing was skipped.',
};

export function ReminderLogTab({ url, timezone, canManage, live }: { url: string; timezone: string; canManage: boolean; live: boolean }) {
  const { workspace } = useWorkspace();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('');
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [filter]);
  const query = useQuery({
    queryKey: ['reminders', workspace.id, 'log', url, { filter, page }],
    queryFn: () => api.get<{ logs: ReminderLog[]; total: number; pages: number; counts: ReminderCounts & { upcoming: number } }>(`${url}/logs?page=${page}${filter ? `&status=${filter}` : ''}`),
    placeholderData: (prev) => prev,
    // Delivery ticks arrive after the send.
    refetchInterval: 20_000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`${url}/logs/${id}/retry`),
    onSuccess: () => {
      toast.success('Queued again. It goes out within a minute.');
      void queryClient.invalidateQueries({ queryKey: ['reminders', workspace.id] });
    },
    onError: (e) => toast.error(e),
  });
  const c = query.data?.counts;
  const filters: { value: Filter; label: string; count?: number }[] = [
    { value: '', label: 'All' },
    { value: 'upcoming', label: 'Upcoming', count: c?.upcoming },
    { value: 'sent', label: 'Sent', count: c?.sent },
    { value: 'pending', label: 'Pending', count: c?.pending },
    { value: 'failed', label: 'Failed', count: c?.failed },
    { value: 'skipped', label: 'Skipped', count: c?.skipped },
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-1" role="group" aria-label="Filter">
        {filters.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={cn('flex h-8 items-center gap-2 rounded-lg px-3 text-sm transition-colors', filter === f.value ? 'bg-white font-medium text-ink ring-1 ring-slate-300' : 'text-slate-600 hover:bg-slate-200/50')}
          >
            {f.label}
            {f.count !== undefined && <span className="text-xs text-slate-400 tabular-nums">{f.count}</span>}
          </button>
        ))}
      </div>
      <Card className="overflow-hidden">
        {query.error ? (
          <LoadError error={query.error} what="the log" onRetry={() => void query.refetch()} />
        ) : query.isPending ? (
          <SkeletonRows />
        ) : query.data!.logs.length === 0 ? (
          <EmptyState icon={<ScrollText className="size-5" strokeWidth={1.5} />} title={filter === 'failed' ? 'All good' : 'Nothing here yet'}>
            {EMPTY[filter]}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-4 py-2.5 font-normal">Contact</th>
                  <th className="px-4 py-2.5 font-normal">Event date</th>
                  <th className="px-4 py-2.5 font-normal">Reminder</th>
                  <th className="px-4 py-2.5 font-normal">Scheduled</th>
                  <th className="px-4 py-2.5 font-normal">Status</th>
                  <th className="px-4 py-2.5 font-normal">Details</th>
                  <th className="w-28" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {query.data!.logs.map((l) => (
                  <tr key={l.id} className="transition-colors hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <span className="block font-medium text-ink">{l.name || 'No name'}</span>
                      <span className="block text-xs text-slate-500">{l.phone}</span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-700">{occurrenceText(l.occurrence)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-700">{ruleIdText(l.ruleId)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-700">{dateTime(l.scheduledFor, timezone)}</td>
                    <td className="px-4 py-3">
                      {l.status === 'sent' ? (
                        <Ticks status={(l.delivery ?? 'queued') as TickStatus} withLabel className="text-slate-700" />
                      ) : (
                        <StatusBadge status={l.status === 'upcoming' ? 'scheduled' : l.status === 'skipped' ? 'archived' : l.status} label={l.status.replace(/^./, (x) => x.toUpperCase())} />
                      )}
                    </td>
                    <td className="max-w-72 px-4 py-3 text-slate-600">
                      {l.error ?? (l.sentAt ? `Sent ${dateTime(l.sentAt, timezone)}` : '')}
                      {l.nextAttemptAt && l.error && <span className="block text-xs text-slate-500">Next try {dateTime(l.nextAttemptAt, timezone)}</span>}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {canManage && l.retryable && (
                        <Button variant="ghost" disabled={!live} title={live ? undefined : 'Resume this reminder first'} loading={retry.isPending && retry.variables === l.id} onClick={() => retry.mutate(l.id)}>
                          <RotateCcw className="size-4" strokeWidth={1.5} /> Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {query.data && query.data.total > 0 && <Pager page={page} pages={query.data.pages} total={query.data.total} noun="reminder" onChange={setPage} />}
      </Card>
    </>
  );
}

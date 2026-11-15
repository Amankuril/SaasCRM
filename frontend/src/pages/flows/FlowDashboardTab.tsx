import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarCheck, Database, MessageSquareReply, Play, Workflow, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Skeleton, StatusBadge } from '../../components/feedback';
import { TrendChart } from '../../components/TrendChart';
import { Alert, Button, Card, EmptyState, cn, errorMessage } from '../../components/ui';
import { api, type FlowAnalytics } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { FLOW_STATUS, RangeSelect, StatCard, rangeBounds, td, th, type RangeKey } from './shared';

type Bucket = 'daily' | 'weekly' | 'monthly';
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Fills the gaps in the daily series, then rolls it up into weeks (Monday) or months. */
function bucketed(series: FlowAnalytics['series'], from: string, to: string, bucket: Bucket) {
  const byDay = new Map(series.map((s) => [s.date, s]));
  const out = new Map<string, { runs: number; replies: number }>();
  const end = new Date(to);
  for (const d = new Date(from); d <= end; d.setDate(d.getDate() + 1)) {
    const day = iso(d);
    const start = new Date(d);
    if (bucket === 'weekly') start.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    if (bucket === 'monthly') start.setDate(1);
    const key = iso(start);
    const row = out.get(key) ?? { runs: 0, replies: 0 };
    row.runs += byDay.get(day)?.runs ?? 0;
    row.replies += byDay.get(day)?.replies ?? 0;
    out.set(key, row);
  }
  return [...out.entries()].map(([date, v]) => ({ date, ...v }));
}

export function FlowDashboardTab() {
  const { workspace } = useWorkspace();
  const [range, setRange] = useState<RangeKey>('30d');
  const [bucket, setBucket] = useState<Bucket>('daily');
  const { from, to } = useMemo(() => rangeBounds(range), [range]);
  const query = useQuery({
    queryKey: ['flow-analytics', workspace.id, range],
    queryFn: () => api.get<FlowAnalytics>(`/workspaces/${workspace.id}/flows/insights/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    placeholderData: keepPreviousData,
  });
  const a = query.data;
  const points = useMemo(() => (a ? bucketed(a.series, from, to, bucket) : []), [a, from, to, bucket]);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink">Flow dashboard</h1>
          <p className="mt-1 text-sm text-slate-500">How your automations are performing.</p>
        </div>
        <RangeSelect value={range} onChange={setRange} />
      </div>

      {query.error ? (
        <Alert>
          {errorMessage(query.error)}{' '}
          <button className="font-medium underline" onClick={() => query.refetch()}>
            Try again
          </button>
        </Alert>
      ) : !a ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Total flows" value={a.totals.flows} icon={<Workflow className="size-4" />} />
            <StatCard label="Active flows" value={a.totals.activeFlows} icon={<Zap className="size-4" />} />
            <StatCard label="Total runs" value={a.totals.runs.toLocaleString()} hint={`${a.totals.runsInRange.toLocaleString()} in this period`} icon={<Play className="size-4" />} />
            <StatCard label="Replies sent by flows" value={a.totals.replies.toLocaleString()} hint="In this period" icon={<MessageSquareReply className="size-4" />} />
            <StatCard label="Appointments booked" value={a.totals.appointments.toLocaleString()} hint="In this period" icon={<CalendarCheck className="size-4" />} />
            <StatCard label="Data entries collected" value={a.totals.dataEntries.toLocaleString()} hint="In this period" icon={<Database className="size-4" />} />
          </div>

          <Card className="p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-ink">Replies sent by flows</h2>
              <div className="inline-flex rounded-lg border border-slate-200 p-0.5 text-xs font-medium">
                {(['daily', 'weekly', 'monthly'] as const).map((b) => (
                  <button key={b} type="button" onClick={() => setBucket(b)} className={cn('rounded-md px-2.5 py-1 capitalize', bucket === b ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>
                    {b}
                  </button>
                ))}
              </div>
            </div>
            <TrendChart
              title="Replies sent by flows"
              days={points.map((p) => p.date)}
              series={[
                { key: 'replies', label: 'Replies sent', color: '#2a78d6', values: points.map((p) => p.replies) },
                { key: 'runs', label: 'Runs started', color: '#eb6834', values: points.map((p) => p.runs) },
              ]}
            />
          </Card>

          <Card>
            <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-ink">Performance by flow</h2>
            {a.flows.length === 0 ? (
              <EmptyState icon={<Workflow className="size-5" />} title="No automations yet">
                <p>Create your first automation to see its numbers here.</p>
                <Link to={`/w/${workspace.id}/flows`} className="mt-3 inline-block">
                  <Button>Open Flow Builder</Button>
                </Link>
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={th}>Flow</th>
                      <th className={th}>Status</th>
                      <th className={cn(th, 'text-right')}>Runs</th>
                      <th className={cn(th, 'text-right')}>Replies sent</th>
                      <th className={cn(th, 'text-right')}>Completion rate</th>
                      <th className={cn(th, 'text-right')}>Drop-off</th>
                      <th className={th}>Last run</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {a.flows.map((f) => (
                      <tr key={f.id} className="hover:bg-slate-50">
                        <td className={td()}>
                          <Link to={`/w/${workspace.id}/flows/${f.id}`} className="font-medium text-slate-800 hover:text-brand-700">
                            {f.name}
                          </Link>
                        </td>
                        <td className={td()}>
                          <StatusBadge status={FLOW_STATUS[f.status].badge} label={FLOW_STATUS[f.status].label} />
                        </td>
                        <td className={td('text-right tabular-nums')}>{f.runs.toLocaleString()}</td>
                        <td className={td('text-right tabular-nums')}>{f.replies.toLocaleString()}</td>
                        <td className={td('text-right tabular-nums')}>{f.completionRate === null ? '—' : `${f.completionRate}%`}</td>
                        <td className={td('text-right tabular-nums')}>{f.dropOffRate === null ? '—' : `${f.dropOffRate}%`}</td>
                        <td className={td('whitespace-nowrap text-slate-500')}>{f.lastRunAt ? formatDate(f.lastRunAt, true) : 'Never'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

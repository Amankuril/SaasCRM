import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Headset, MessagesSquare, Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Link } from 'react-router';
import { SkeletonRows, StatusBadge } from '../../components/feedback';
import { NODE_META } from '../../components/flow/meta';
import { Badge, Card, EmptyState, Input, Select, cn, LoadError } from '../../components/ui';
import { api, type FlowNodeType, type FlowRun } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { FlowSelect, Pager, td, th } from './shared';

const RUN_STATUS: Record<FlowRun['status'], { badge: string; label: string }> = {
  running: { badge: 'running', label: 'Running' },
  waiting: { badge: 'pending', label: 'Waiting for reply' },
  completed: { badge: 'completed', label: 'Completed' },
  exited: { badge: 'cancelled', label: 'Dropped off' },
  failed: { badge: 'failed', label: 'Failed' },
};
const stepLabel = (type: string | null) => (type && type in NODE_META ? NODE_META[type as FlowNodeType].label : (type ?? '—'));

/** Conversations handled by flows: which flow ran, steps reached, drop-off and handover to an agent. */
export function FlowRunsTab() {
  const { workspace } = useWorkspace();
  const [flowId, setFlowId] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const search = useDeferredValue(q.trim());
  const params = new URLSearchParams({ page: String(page), limit: '25', ...(flowId ? { flowId } : {}), ...(status ? { status } : {}), ...(search ? { q: search } : {}) });
  const query = useQuery({
    queryKey: ['flow-runs', workspace.id, params.toString()],
    queryFn: () => api.get<{ runs: FlowRun[]; total: number; pages: number }>(`/workspaces/${workspace.id}/flows/insights/runs?${params}`),
    placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => (set(v), setPage(1));

  return (
    <>
      <div className="mb-5">
        <h1 className="text-2xl leading-8 font-medium text-ink">Conversations</h1>
        <p className="mt-1 text-sm text-slate-500">Every conversation an automation handled: how far the customer got and where it was handed to your team.</p>
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <div className="relative min-w-48 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <Input value={q} onChange={(e) => reset(setQ)(e.target.value)} placeholder="Search name or number" className="pl-9" aria-label="Search customers" />
          </div>
          <FlowSelect value={flowId} onChange={reset(setFlowId)} />
          <Select value={status} onChange={(e) => reset(setStatus)(e.target.value)} className="w-44" aria-label="Status">
            <option value="">All statuses</option>
            {Object.entries(RUN_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
          {query.data && <span className="ml-auto text-xs text-slate-500">{query.data.total.toLocaleString()} conversations</span>}
        </div>
        {query.isPending ? (
          <SkeletonRows rows={6} />
        ) : query.error ? (
            <LoadError error={query.error} what="this list" onRetry={() => void query.refetch()} />
          ) : query.data.runs.length === 0 ? (
          <EmptyState icon={<MessagesSquare className="size-5" />} title="No flow conversations yet">
            When an active automation replies to a customer, the conversation shows up here.
          </EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={th}>Customer</th>
                    <th className={th}>Flow</th>
                    <th className={th}>Status</th>
                    <th className={cn(th, 'text-right')}>Steps reached</th>
                    <th className={th}>Last step</th>
                    <th className={th}>Handover</th>
                    <th className={th}>Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {query.data.runs.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className={td()}>
                        <p className="font-medium text-slate-800">{r.contact?.name ?? 'Deleted contact'}</p>
                        {r.contact && <p className="text-xs text-slate-500">+{r.contact.phone.replace(/^\+/, '')}</p>}
                      </td>
                      <td className={td()}>
                        <Link to={`/w/${workspace.id}/flows/${r.flow.id}`} className="text-slate-700 hover:text-brand-700">
                          {r.flow.name}
                        </Link>
                      </td>
                      <td className={td()}>
                        <StatusBadge status={RUN_STATUS[r.status].badge} label={RUN_STATUS[r.status].label} />
                      </td>
                      <td className={td('text-right tabular-nums')}>{r.steps}</td>
                      <td className={td()}>
                        <p className="text-slate-700">{stepLabel(r.lastStep?.type ?? null)}</p>
                        {(r.droppedOff || r.error) && <p className="max-w-56 truncate text-xs text-red-600" title={r.error ?? r.exitReason ?? ''}>{r.error ?? `Dropped off here${r.exitReason ? ` (${r.exitReason.replace(/_/g, ' ')})` : ''}`}</p>}
                      </td>
                      <td className={td()}>
                        {r.handedOff ? (
                          <Badge tone="blue">
                            <Headset className="mr-1 size-3" /> To agent
                          </Badge>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className={td('whitespace-nowrap text-slate-500')}>{formatDate(r.startedAt, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pages={query.data.pages} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

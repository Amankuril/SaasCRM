import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Database, Download, Search } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { SkeletonRows, useToast } from '../../components/feedback';
import { Alert, Button, Card, EmptyState, Input, errorMessage } from '../../components/ui';
import { api, type FlowDataRow } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { FlowSelect, Pager, RangeSelect, rangeBounds, td, th, type RangeKey } from './shared';

const heading = (key: string) => key.replace(/^form_/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Answers captured by Question, Form and Custom Field steps, one row per run. */
export function FlowDataTab() {
  const { workspace } = useWorkspace();
  const toast = useToast();
  const [flowId, setFlowId] = useState('');
  const [range, setRange] = useState<RangeKey>('90d');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const search = useDeferredValue(q.trim());
  const { from, to } = useMemo(() => rangeBounds(range), [range]);
  const filters = new URLSearchParams({ from, to, ...(flowId ? { flowId } : {}), ...(search ? { q: search } : {}) });
  const base = `/workspaces/${workspace.id}/flows/insights/collected-data`;
  const query = useQuery({
    queryKey: ['flow-data', workspace.id, filters.toString(), page],
    queryFn: () => api.get<{ rows: FlowDataRow[]; columns: string[]; total: number; pages: number }>(`${base}?${filters}&page=${page}&limit=25`),
    placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => (set(v), setPage(1));

  async function exportCsv() {
    setExporting(true);
    try {
      await api.download(`${base}?${filters}&format=csv`, 'flow-data.csv');
      toast.success('Export downloaded. The CSV opens in Excel and Google Sheets.');
    } catch (err) {
      toast.error(err);
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink">Collected Data</h1>
          <p className="mt-1 text-sm text-slate-500">Answers customers gave inside your automations.</p>
        </div>
        <Button variant="secondary" loading={exporting} disabled={!query.data?.rows.length} onClick={exportCsv}>
          <Download className="size-4" /> Export CSV / Excel
        </Button>
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <div className="relative min-w-48 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <Input value={q} onChange={(e) => reset(setQ)(e.target.value)} placeholder="Search name or number" className="pl-9" aria-label="Search customers" />
          </div>
          <FlowSelect value={flowId} onChange={reset(setFlowId)} />
          <RangeSelect value={range} onChange={reset(setRange)} />
        </div>
        {query.isPending ? (
          <SkeletonRows rows={6} />
        ) : query.error ? (
          <div className="p-4">
            <Alert>{errorMessage(query.error)}</Alert>
          </div>
        ) : query.data.rows.length === 0 ? (
          <EmptyState icon={<Database className="size-5" />} title="No data collected yet">
            Add a Question, Form or Custom Field step to an automation. Every answer is saved here.
          </EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={th}>Customer</th>
                    <th className={th}>Flow</th>
                    {query.data.columns.map((c) => (
                      <th key={c} className={th}>
                        {heading(c)}
                      </th>
                    ))}
                    <th className={th}>Collected</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {query.data.rows.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className={td()}>
                        <p className="font-medium text-slate-800">{r.contact?.name ?? 'Deleted contact'}</p>
                        {r.contact && <p className="text-xs text-slate-500">+{r.contact.phone.replace(/^\+/, '')}</p>}
                      </td>
                      <td className={td('text-slate-700')}>{r.flow.name}</td>
                      {query.data.columns.map((c) => (
                        <td key={c} className={td('max-w-64 truncate text-slate-700')} title={r.data[c]}>
                          {r.data[c] ?? <span className="text-slate-300">—</span>}
                        </td>
                      ))}
                      <td className={td('whitespace-nowrap text-slate-500')}>{formatDate(r.collectedAt, true)}</td>
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

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Clock, Copy, Database, Download, ExternalLink, Eye, Info, RefreshCw, Search, Send, XCircle } from 'lucide-react';
import { Fragment, useDeferredValue, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, EmptyState, Input, Select, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type SheetCampaign, type SheetCounts, type SheetRowState, type SheetSyncResult } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { CategoryBadge, RowBadge, StateBadge, rowStyle, shortDate, shortDateTime } from './sheetUi';

interface RowItem {
  id: string;
  rowNumber: number;
  phone: string;
  values: Record<string, string>;
  state: SheetRowState;
  error: string | null;
  dueAt: string | null;
  updatedAt: string;
}
interface RowPage {
  rows: RowItem[];
  total: number;
  pages: number;
  counts: SheetCounts | null;
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

export function SheetDataPage() {
  const { campaignId } = useParams();
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const base = `/workspaces/${workspace.id}/integrations/google-sheets/${campaignId}`;
  const campaign = useQuery({ queryKey: ['sheet-campaign', workspace.id, campaignId], queryFn: () => api.get<{ campaign: SheetCampaign }>(base), refetchInterval: 15_000 });
  const [q, setQ] = useState('');
  const term = useDeferredValue(q.trim());
  const [state, setState] = useState<'' | SheetRowState>('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = useQuery({
    queryKey: ['sheet-rows', workspace.id, campaignId, term, state, page],
    queryFn: () => api.get<RowPage>(`${base}/rows?${new URLSearchParams({ q: term, state, page: String(page) })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const sync = useMutation({
    mutationFn: () => api.post<{ campaign: SheetCampaign; sync: SheetSyncResult }>(`${base}/sync`),
    onSuccess: ({ campaign: c, sync: s }) => {
      queryClient.setQueryData(['sheet-campaign', workspace.id, campaignId], { campaign: c });
      void queryClient.invalidateQueries({ queryKey: ['sheet-rows', workspace.id, campaignId] });
      const parts = [`${s.rows} row(s) read`, s.added && `${s.added} new`, s.sent && `${s.sent} sent`, s.waiting && `${s.waiting} waiting for empty cells`, s.invalid && `${s.invalid} with an unreadable phone`].filter(Boolean);
      setNotice(c.lastError ? null : `Synced: ${parts.join(' · ')}.`);
    },
  });
  const exportCsv = useMutation({ mutationFn: () => api.download(`${base}/rows/export`, 'sheet-rows.csv') });

  if (campaign.isPending) return <Spinner />;
  if (campaign.error) return <Alert>{errorMessage(campaign.error)}</Alert>;
  const c = campaign.data.campaign;
  const n = rows.data?.counts ?? c.counts ?? ({ skipped: 0, waiting: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, messages: 0 } as SheetCounts);
  const messages = n.sent + n.delivered + n.read + n.failed;
  const reached = n.delivered + n.read;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link to={`/w/${workspace.id}/integrations/google-sheets`} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
          <ArrowLeft className="size-4" /> Back to Campaigns
        </Link>
        <div className="min-w-0 flex-1 text-center">
          <h1 className="flex items-center justify-center gap-2 text-xl font-semibold text-ink">
            <span className="truncate">{c.name}</span> <StateBadge state={c.state} />
          </h1>
          <p className="text-xs text-slate-500">
            {c.tab?.title} · Last synced {c.lastSyncAt ? shortDate(c.lastSyncAt) : 'never'} ·{' '}
            <a href={c.sheetUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-slate-700 hover:underline">
              Open Sheet <ExternalLink className="size-3" />
            </a>
          </p>
        </div>
        <Button variant="ghost" loading={exportCsv.isPending} onClick={() => exportCsv.mutate()}>
          <Download className="size-4" /> Export
        </Button>
        {can('campaigns:manage') && (
          <Button loading={sync.isPending} onClick={() => sync.mutate()} className="bg-slate-700 hover:bg-slate-800">
            <RefreshCw className="size-4" /> Sync Data
          </Button>
        )}
      </div>

      <div className="mb-4 space-y-2">
        {c.lastError && <Alert>{c.lastError}</Alert>}
        {(sync.error ?? exportCsv.error) != null && <Alert>{errorMessage(sync.error ?? exportCsv.error)}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        {c.status === 'paused' && <Alert tone="info">This campaign is paused: new rows are not checked or sent until you resume it.</Alert>}
        {(c.waitingRows > 0 || c.invalidRows > 0) && (
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <Info className="size-3.5" />
            {c.waitingRows > 0 && `${c.waitingRows} new row(s) are waiting for empty cells to be filled. `}
            {c.invalidRows > 0 && `${c.invalidRows} row(s) have a phone number that can't be read — include the country code.`}
          </p>
        )}
      </div>

      <div className="mb-6 grid overflow-hidden rounded-2xl border border-slate-200 bg-white sm:grid-cols-3 xl:grid-cols-6 xl:divide-x xl:divide-slate-200">
        <Stat icon={<Database className="size-5" />} tone="bg-sky-50 text-sky-600" label="Total Leads" value={c.rowCount} hint="From spreadsheet" />
        <Stat icon={<Clock className="size-5" />} tone="bg-amber-50 text-amber-600" label="Queued" value={n.queued} hint={n.queued ? 'Waiting for the send delay' : 'All processed'} />
        <Stat icon={<Send className="size-5" />} tone="bg-slate-100 text-slate-600" label="Sent" value={n.sent} hint={n.sent ? 'Awaiting delivery receipt' : 'No messages awaiting receipt'} />
        <Stat icon={<CheckCircle2 className="size-5" />} tone="bg-emerald-50 text-emerald-600" label="Delivered" value={n.delivered} valueTone="text-emerald-700" hint={messages ? `${pct(reached, messages)}% reached the handset` : 'No messages yet'} />
        <Stat icon={<Eye className="size-5" />} tone="bg-sky-50 text-sky-600" label="Read" value={n.read} valueTone="text-sky-700" hint={messages ? `${pct(n.read, messages)}% opened the message` : 'No messages yet'} />
        <Stat icon={<XCircle className="size-5" />} tone="bg-slate-100 text-slate-500" label="Failed" value={n.failed} valueTone={n.failed ? 'text-red-600' : undefined} hint={n.failed ? 'Open a row for the reason' : 'No failures'} />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
          <Input
            aria-label="Search by phone number"
            placeholder="Search by phone number..."
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            className="pl-9"
          />
        </div>
        <div className="w-full sm:w-40">
          <Select
            aria-label="Filter by status"
            value={state}
            onChange={(e) => {
              setState(e.target.value as typeof state);
              setPage(1);
            }}
          >
            <option value="">All Statuses</option>
            <option value="queued">Queued</option>
            <option value="sent">Sent</option>
            <option value="delivered">Delivered</option>
            <option value="read">Read</option>
            <option value="failed">Failed</option>
            <option value="skipped">Skipped</option>
          </Select>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {rows.isPending ? (
          <Spinner />
        ) : rows.error ? (
          <div className="p-4">
            <Alert>{errorMessage(rows.error)}</Alert>
          </div>
        ) : !rows.data.rows.length ? (
          <EmptyState icon={<Database className="size-5" />} title={term || state ? 'No rows match' : 'No rows yet'}>
            {term || state ? 'Try another search or status.' : 'Add a row with a phone number to your sheet; it shows up here within a minute, or click Sync Data.'}
          </EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500">
                  <tr>
                    <th className="px-4 py-3">#</th>
                    <th className="px-4 py-3">Phone Number</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Message</th>
                    <th className="px-4 py-3">Template</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Last Update</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.data.rows.map((r, i) => (
                    <Fragment key={r.id}>
                      <tr className="hover:bg-slate-50/60">
                        <td className="px-4 py-3 text-slate-500">{(page - 1) * 50 + i + 1}</td>
                        <td className="px-4 py-3 font-mono font-semibold text-ink">{r.phone.replace(/^\+91/, '')}</td>
                        <td className="px-4 py-3">
                          <RowBadge state={r.state} />
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5 text-slate-700">
                            <WaDot state={r.state} />
                            <span className={cn(r.state === 'failed' && 'text-red-600')}>{r.state === 'queued' && r.dueAt ? `Sends ${shortDateTime(r.dueAt)}` : r.state === 'failed' && r.error ? r.error : rowStyle(r.state).message}</span>
                            <CopyButton text={r.phone} />
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-700">{c.template?.name ?? '—'}</td>
                        <td className="px-4 py-3">{c.template ? <CategoryBadge category={c.template.category} /> : '—'}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-slate-600">{shortDateTime(r.updatedAt)}</td>
                        <td className="px-4 py-3 text-right">
                          <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100" aria-expanded={open === r.id}>
                            Row {r.rowNumber} <ChevronDown className={cn('size-3.5 transition-transform', open === r.id && 'rotate-180')} />
                          </button>
                        </td>
                      </tr>
                      {open === r.id && (
                        <tr className="bg-slate-50/70">
                          <td />
                          <td colSpan={7} className="px-4 py-3">
                            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                              {Object.entries(r.values).map(([k, v]) => (
                                <div key={k} className="flex gap-2">
                                  <dt className="shrink-0 text-slate-500">{k}:</dt>
                                  <dd className="truncate text-slate-800">{v || '—'}</dd>
                                </div>
                              ))}
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-3 text-sm text-slate-500">
              <span>
                Showing <b className="text-slate-700">{(page - 1) * 50 + 1}–{(page - 1) * 50 + rows.data.rows.length}</b> of <b className="text-slate-700">{rows.data.total}</b> rows
              </span>
              {rows.data.pages > 1 && (
                <div className="flex gap-2">
                  <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button variant="secondary" disabled={page >= rows.data.pages} onClick={() => setPage(page + 1)} aria-label="Next page">
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Stat({ icon, tone, label, value, hint, valueTone }: { icon: ReactNode; tone: string; label: string; value: number; hint: string; valueTone?: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-slate-200 p-4 xl:border-b-0">
      <span className={cn('rounded-xl p-2.5', tone)}>{icon}</span>
      <div className="min-w-0">
        <p className="text-sm text-slate-500">{label}</p>
        <p className={cn('text-2xl font-bold tabular-nums', valueTone ?? 'text-ink')}>{value}</p>
        <p className="text-xs text-slate-500">{hint}</p>
      </div>
    </div>
  );
}

/** WhatsApp-green dot for messages that went out, grey or red otherwise. */
function WaDot({ state }: { state: SheetRowState }) {
  const tone = state === 'failed' ? 'bg-red-500' : ['sent', 'delivered', 'read'].includes(state) ? 'bg-[#25D366]' : 'bg-slate-300';
  return (
    <span className={cn('flex size-4 items-center justify-center rounded-full text-white', tone)}>
      <svg viewBox="0 0 24 24" className="size-2.5" fill="currentColor" aria-hidden="true">
        <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2z" />
      </svg>
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="Copy phone number"
      aria-label="Copy phone number"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="rounded p-0.5 text-slate-400 hover:text-slate-700"
    >
      {done ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
    </button>
  );
}

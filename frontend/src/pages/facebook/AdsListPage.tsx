import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Building2, Code2, Copy, ExternalLink, Pause, Pencil, Play, Plus, RefreshCw, Search, Trash2, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { relativeTime } from '../../components/crm';
import { Dialog } from '../../components/Dialog';
import { ConfirmDialog, useToast } from '../../components/feedback';
import { Alert, Button, Card, EmptyState, Field, Input, LoadError, PageHeader, Select, Spinner, cn, errorMessage, fieldError } from '../../components/ui';
import { api, type FbKind, type FbRow } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { NewAdDialog, NewAudienceDialog, NewPixelDialog } from './AdsDialogs';
import { ENTITY_PAGES, FbStatus, adsManagerUrl, money, objectiveLabel, useAdsHome, words } from './shared';

const STATUSES = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'archived', label: 'Archived' },
  { value: 'deleted', label: 'Deleted' },
  { value: 'in_review', label: 'In review' },
  { value: 'rejected', label: 'Rejected' },
];

type Col = { label: string; className?: string; cell: (r: FbRow, currency: string | null) => ReactNode };
const budget = (r: FbRow, c: string | null) => (r.dailyBudget !== null ? `${money(r.dailyBudget, c)}/day` : r.lifetimeBudget !== null ? `${money(r.lifetimeBudget, c)} total` : <span className="text-slate-400">Ad set budget</span>);
const updated = { label: 'Updated', cell: (r: FbRow) => <span className="text-slate-500">{relativeTime(r.updatedAt)}</span> };

const COLUMNS: Record<FbKind, Col[]> = {
  campaign: [
    { label: 'Objective', cell: (r) => objectiveLabel(r.objective) },
    { label: 'Status', cell: (r) => <FbStatus value={r.effectiveStatus} deleted={r.deleted} /> },
    { label: 'Budget', cell: budget },
    updated,
  ],
  adset: [
    { label: 'Campaign', cell: (r) => r.campaign?.name ?? '—' },
    { label: 'Status', cell: (r) => <FbStatus value={r.effectiveStatus} deleted={r.deleted} /> },
    { label: 'Budget', cell: (r, c) => (r.dailyBudget === null && r.lifetimeBudget === null ? <span className="text-slate-400">Campaign budget</span> : budget(r, c)) },
    { label: 'Optimisation', cell: (r) => (r.optimizationGoal ? words(r.optimizationGoal) : '—') },
    { label: 'Targeting', className: 'max-w-56 truncate', cell: (r) => r.targetingSummary ?? '—' },
    updated,
  ],
  creative: [
    { label: 'Type', cell: (r) => (r.creativeType ? words(r.creativeType === 'SHARE' ? 'IMAGE' : r.creativeType) : '—') },
    { label: 'Headline', className: 'max-w-56 truncate', cell: (r) => r.headline ?? '—' },
    { label: 'Call to action', cell: (r) => (r.callToAction ? words(r.callToAction) : '—') },
    updated,
  ],
  ad: [
    { label: 'Ad set', cell: (r) => r.adset?.name ?? '—' },
    { label: 'Creative', cell: (r) => r.creative?.name ?? '—' },
    { label: 'Status', cell: (r) => <FbStatus value={r.effectiveStatus} deleted={r.deleted} /> },
    { label: 'Review', cell: (r) => <span className={cn(r.reviewStatus === 'Rejected' && 'font-medium text-red-600')}>{r.reviewStatus ?? '—'}</span> },
    updated,
  ],
  audience: [
    { label: 'Type', cell: (r) => (r.subtype ? words(r.subtype) : '—') },
    { label: 'Size', cell: (r) => (r.approxCount ? `≈ ${r.approxCount.toLocaleString('en-IN')}` : 'Not ready yet') },
    updated,
  ],
  pixel: [
    { label: 'ID', cell: (r) => <span className="font-mono text-xs">{r.id}</span> },
    { label: 'Last fired', cell: (r) => (r.lastFiredAt ? formatDate(r.lastFiredAt, true) : <span className="text-slate-400">Never</span>) },
  ],
};

const CREATE_PAGE: Partial<Record<FbKind, string>> = { campaign: 'campaigns/new', adset: 'adsets/new', creative: 'creatives/new' };
const STATUS_KINDS: FbKind[] = ['campaign', 'adset', 'ad'];

export function AdsListPage() {
  const { section } = useParams();
  const page = ENTITY_PAGES.find((p) => p.slug === section);
  if (!page) return <Navigate to=".." replace />;
  if (!page.kind) return <NextPhase title={page.title} icon={page.icon} />;
  return <EntityList key={page.kind} kind={page.kind} title={page.title} singular={page.singular} icon={page.icon} />;
}

function NextPhase({ title, icon: Icon }: { title: string; icon: LucideIcon }) {
  return (
    <>
      <BackLink />
      <PageHeader title={title} />
      <Card>
        <EmptyState icon={<Icon className="size-6" strokeWidth={1.5} />} title={`${title} arrive with Lead Ads`}>
          {title === 'Leads' ? 'Instant Form leads, AI-cleaned and scored, with their WhatsApp follow-up status.' : 'Reach, impressions, spend, clicks, CTR, CPC, leads and cost per lead by campaign, ad set and ad.'} This is the next phase of Facebook Ads.
        </EmptyState>
      </Card>
    </>
  );
}

const BackLink = () => (
  <Link to=".." relative="path" className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900">
    <ArrowLeft className="size-4" /> Back to Facebook Ads
  </Link>
);

function EntityList({ kind, title, singular, icon: Icon }: { kind: FbKind; title: string; singular: string; icon: LucideIcon }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const home = useAdsHome();
  const manage = can('ads:manage');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [pageNo, setPageNo] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<FbRow | null>(null);
  const [deleting, setDeleting] = useState<FbRow | null>(null);
  const [pixel, setPixel] = useState<FbRow | null>(null);
  const base = `/workspaces/${workspace.id}/facebook-ads`;
  const params = new URLSearchParams({ status, page: String(pageNo), ...(q.trim() ? { q: q.trim() } : {}) }).toString();
  const list = useQuery({ queryKey: ['fbads-list', workspace.id, kind, params], queryFn: () => api.get<{ rows: FbRow[]; total: number; page: number; pages: number }>(`${base}/entities/${kind}?${params}`), placeholderData: keepPreviousData });
  const conn = home.data?.connection;
  const blocked = conn?.status !== 'connected';
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['fbads-list', workspace.id] });
    void queryClient.invalidateQueries({ queryKey: ['fbads', workspace.id] });
  };

  const act = useMutation({
    mutationFn: ({ row, action }: { row: FbRow; action: 'pause' | 'activate' | 'duplicate' | 'delete' }) =>
      action === 'delete'
        ? api.delete(`${base}/entities/${kind}/${row.id}`)
        : action === 'duplicate'
          ? api.post(`${base}/entities/${kind}/${row.id}/duplicate`)
          : api.post(`${base}/entities/${kind}/${row.id}/status`, { status: action === 'pause' ? 'PAUSED' : 'ACTIVE' }),
    onSuccess: (_r, { action }) => {
      invalidate();
      setDeleting(null);
      toast.success({ pause: 'Paused on Facebook.', activate: 'Activated on Facebook.', duplicate: 'Copied (paused).', delete: 'Deleted on Facebook.' }[action]);
    },
    onError: (err) => {
      invalidate();
      toast.error(err);
    },
  });
  const sync = useMutation({ mutationFn: () => api.post(`${base}/sync`), onSuccess: () => (invalidate(), toast.success('Sync started.')), onError: (e) => toast.error(e) });

  if (home.data && !conn?.adAccountId) return <Navigate to=".." relative="path" replace />;
  const onCreate = () => (CREATE_PAGE[kind] ? navigate(`../${CREATE_PAGE[kind]}`, { relative: 'path' }) : setCreating(true));
  const cols = COLUMNS[kind];

  return (
    <>
      <BackLink />
      <PageHeader
        title={title}
        description={`${conn?.adAccountName ?? 'Ad account'} · ${list.data?.total ?? 0} total`}
        actions={
          manage && (
            <>
              <Button variant="secondary" onClick={() => navigate('..', { relative: 'path' })}>
                <Building2 className="size-4" /> Change ad account
              </Button>
              <Button variant="secondary" onClick={() => sync.mutate()} disabled={blocked || ['queued', 'running'].includes(conn?.sync.status ?? '')}>
                <RefreshCw className={cn('size-4', ['queued', 'running'].includes(conn?.sync.status ?? '') && 'animate-spin')} /> Sync
              </Button>
              <Button onClick={onCreate} disabled={blocked}>
                <Plus className="size-4" /> New {singular.toLowerCase()}
              </Button>
            </>
          )
        }
      />
      {blocked && <div className="mb-4"><Alert>The Facebook connection needs attention. Reconnect it on the Facebook Ads page to make changes.</Alert></div>}

      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <Input aria-label="Search by name" className="w-64 pl-9" placeholder="Search by name…" value={q} onChange={(e) => (setQ(e.target.value), setPageNo(1))} />
        </div>
        {kind !== 'creative' && kind !== 'audience' && kind !== 'pixel' && (
          <Select aria-label="Status" className="w-44" value={status} onChange={(e) => (setStatus(e.target.value), setPageNo(1))}>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        )}
      </div>

      {list.isPending ? (
        <Spinner />
      ) : list.error ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.rows.length === 0 ? (
        <Card>
          <EmptyState icon={<Icon className="size-6" strokeWidth={1.5} />} title={q || status !== 'all' ? `No ${title.toLowerCase()} match` : `No ${title.toLowerCase()} yet`}>
            {q || status !== 'all' ? 'Try another search or status.' : `Create your first ${singular.toLowerCase()} or sync to pull existing ones from Facebook.`}
            {manage && !q && status === 'all' && (
              <div className="mt-4 flex justify-center gap-2">
                <Button variant="secondary" onClick={() => sync.mutate()} disabled={blocked}>
                  <RefreshCw className="size-4" /> Sync
                </Button>
                <Button onClick={onCreate} disabled={blocked}>
                  <Plus className="size-4" /> New {singular.toLowerCase()}
                </Button>
              </div>
            )}
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  {cols.map((c) => (
                    <th key={c.label} className="px-4 py-2.5 font-medium">
                      {c.label}
                    </th>
                  ))}
                  <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.rows.map((r) => {
                  const paused = (r.status ?? '').includes('PAUSED');
                  return (
                    <tr key={r.id} className={cn(r.deleted && 'opacity-60')}>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          {kind === 'creative' && (r.thumbnailUrl ? <img src={r.thumbnailUrl} alt="" className="size-9 rounded-md object-cover ring-1 ring-slate-200" /> : <span className="size-9 rounded-md bg-slate-100" />)}
                          <span className="font-medium text-ink">{r.name || '(no name)'}</span>
                        </div>
                      </td>
                      {cols.map((c) => (
                        <td key={c.label} className={cn('px-4 py-2.5 text-slate-700', c.className)}>
                          {c.cell(r, conn?.currency ?? null)}
                        </td>
                      ))}
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end gap-0.5">
                          {manage && !r.deleted && !blocked && (
                            <>
                              {kind !== 'pixel' && <RowBtn icon={Pencil} label="Edit" onClick={() => setEditing(r)} />}
                              {STATUS_KINDS.includes(kind) && (paused ? <RowBtn icon={Play} label="Activate" onClick={() => act.mutate({ row: r, action: 'activate' })} /> : <RowBtn icon={Pause} label="Pause" onClick={() => act.mutate({ row: r, action: 'pause' })} />)}
                              {STATUS_KINDS.includes(kind) && <RowBtn icon={Copy} label="Duplicate" onClick={() => act.mutate({ row: r, action: 'duplicate' })} />}
                              {kind !== 'pixel' && <RowBtn icon={Trash2} label="Delete" onClick={() => setDeleting(r)} />}
                            </>
                          )}
                          {kind === 'pixel' && <RowBtn icon={Code2} label="Base code and events" onClick={() => setPixel(r)} />}
                          <a href={adsManagerUrl(conn?.adAccountId ?? null, kind, r.id)} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label="View on Facebook" title="View on Facebook">
                            <ExternalLink className="size-4" strokeWidth={1.5} />
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {list.data.pages > 1 && (
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
              <Button variant="ghost" className="min-h-7 px-2 text-xs" disabled={pageNo <= 1} onClick={() => setPageNo(pageNo - 1)}>
                Previous
              </Button>
              {pageNo} / {list.data.pages}
              <Button variant="ghost" className="min-h-7 px-2 text-xs" disabled={pageNo >= list.data.pages} onClick={() => setPageNo(pageNo + 1)}>
                Next
              </Button>
            </div>
          )}
        </Card>
      )}

      {creating && kind === 'ad' && <NewAdDialog onClose={() => setCreating(false)} onDone={invalidate} />}
      {creating && kind === 'audience' && <NewAudienceDialog onClose={() => setCreating(false)} onDone={invalidate} />}
      {creating && kind === 'pixel' && <NewPixelDialog onClose={() => setCreating(false)} onDone={invalidate} />}
      {editing && <EditDialog kind={kind} row={editing} currency={conn?.currency ?? null} onClose={() => setEditing(null)} onDone={invalidate} />}
      {pixel && <PixelDialog row={pixel} onClose={() => setPixel(null)} />}
      {deleting && (
        <ConfirmDialog title={`Delete "${deleting.name}"?`} confirmLabel="Delete on Facebook" loading={act.isPending} onConfirm={() => act.mutate({ row: deleting, action: 'delete' })} onClose={() => setDeleting(null)}>
          It is deleted in your Meta ad account and stops running. Zeta Connect keeps a record of it under "Deleted".
        </ConfirmDialog>
      )}
    </>
  );
}

function RowBtn({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label={label} title={label}>
      <Icon className="size-4" strokeWidth={1.5} />
    </button>
  );
}

function EditDialog({ kind, row, currency, onClose, onDone }: { kind: FbKind; row: FbRow; currency: string | null; onClose: () => void; onDone: () => void }) {
  const { workspace } = useWorkspace();
  const toast = useToast();
  const [name, setName] = useState(row.name);
  const hasBudget = (kind === 'campaign' || kind === 'adset') && (row.dailyBudget !== null || row.lifetimeBudget !== null);
  const daily = row.dailyBudget !== null;
  const [amount, setAmount] = useState(String(row.dailyBudget ?? row.lifetimeBudget ?? ''));
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/workspaces/${workspace.id}/facebook-ads/entities/${kind}/${row.id}`, {
        name: name.trim(),
        ...(hasBudget && Number(amount) > 0 ? (daily ? { dailyBudget: Number(amount) } : { lifetimeBudget: Number(amount) }) : {}),
      }),
    onSuccess: () => {
      onDone();
      toast.success('Saved on Facebook.');
      onClose();
    },
  });
  return (
    <Dialog
      icon={<Pencil className="size-5" strokeWidth={1.5} />}
      title="Edit"
      subtitle={row.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
        <Field label="Name" htmlFor="fb-edit-name" error={fieldError(save.error, 'name')}>
          <Input id="fb-edit-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </Field>
        {hasBudget && (
          <Field label={`${daily ? 'Daily' : 'Lifetime'} budget (${currency ?? 'INR'})`} htmlFor="fb-edit-budget">
            <Input id="fb-edit-budget" type="number" min={1} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        )}
        {kind === 'creative' && <p className="text-xs text-slate-500">Facebook only lets you rename a creative. To change its text or image, create a new one.</p>}
      </div>
    </Dialog>
  );
}

function PixelDialog({ row, onClose }: { row: FbRow; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const toast = useToast();
  const q = useQuery({ queryKey: ['fbads-pixel', row.id], queryFn: () => api.get<{ code: string; events: { event: string; count: number }[] }>(`/workspaces/${workspace.id}/facebook-ads/pixels/${row.id}`) });
  return (
    <Dialog icon={<Code2 className="size-5" strokeWidth={1.5} />} title={row.name} subtitle={`Pixel ${row.id}`} width="max-w-2xl" onClose={onClose}>
      {q.isPending ? (
        <Spinner />
      ) : q.error ? (
        <Alert>{errorMessage(q.error)}</Alert>
      ) : (
        <div className="space-y-4 text-sm">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="font-medium text-slate-800">Base code</p>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(q.data.code).then(() => toast.success('Copied.'));
                }}
                className="text-xs font-medium text-brand-700 hover:underline"
              >
                Copy
              </button>
            </div>
            <pre className="max-h-56 overflow-auto rounded-lg bg-slate-900 px-3 py-2.5 text-xs text-slate-100">{q.data.code}</pre>
            <p className="mt-1 text-xs text-slate-500">Paste it inside the &lt;head&gt; of every page of your website.</p>
          </div>
          <div>
            <p className="mb-1 font-medium text-slate-800">Events received</p>
            {q.data.events.length ? (
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {q.data.events.map((e) => (
                  <li key={e.event} className="flex justify-between px-3 py-1.5">
                    <span>{e.event}</span>
                    <span className="tabular-nums text-slate-600">{e.count.toLocaleString('en-IN')}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-slate-500">Nothing received yet.</p>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

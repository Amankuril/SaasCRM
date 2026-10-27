import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Database, Megaphone, Pause, Play, Plus, RefreshCw, Search, Send, Settings, Trash2, Zap } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, Button, EmptyState, Input, Select, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type SheetCampaign } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { CategoryBadge, SheetsLogo, StateBadge, delayLabel, shortDate } from './sheetUi';

export interface SheetCampaignList {
  campaigns: SheetCampaign[];
  stats: { total: number; active: number; paused: number; messages: number };
  google: { configured: boolean; accounts: { id: string; email: string }[] };
}

export function SheetCampaignsPage() {
  const { workspace, can } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canManage = can('campaigns:manage') && workspace.status !== 'suspended';
  const base = `/workspaces/${workspace.id}/integrations/google-sheets`;
  const list = useQuery({ queryKey: ['sheet-campaigns', workspace.id], queryFn: () => api.get<SheetCampaignList>(base), refetchInterval: 30_000 });
  const [q, setQ] = useState('');
  const [state, setState] = useState<'all' | SheetCampaign['state']>('all');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['sheet-campaigns', workspace.id] });
  const action = useMutation({
    mutationFn: ({ c, op }: { c: SheetCampaign; op: 'pause' | 'activate' | 'delete' }) => (op === 'delete' ? api.delete(`${base}/${c.id}`) : api.post(`${base}/${c.id}/${op}`)),
    onSettled: refresh,
  });

  const term = q.trim().toLowerCase();
  const rows = (list.data?.campaigns ?? []).filter((c) => (state === 'all' || c.state === state) && (!term || c.name.toLowerCase().includes(term) || c.tab?.title.toLowerCase().includes(term)));
  const stats = list.data?.stats;
  const setupUrl = (c: SheetCampaign) => `/w/${workspace.id}/integrations/google-sheets/${c.id}/setup`;
  const dataUrl = (c: SheetCampaign) => `/w/${workspace.id}/integrations/google-sheets/${c.id}/data`;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link to={`/w/${workspace.id}/integrations`} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
          <ArrowLeft className="size-4" /> Integrations
        </Link>
        <SheetsLogo />
        <div className="mr-auto">
          <h1 className="text-xl font-semibold text-ink">Google Sheets Campaigns</h1>
          <p className="text-sm text-slate-500">Manage your automated WhatsApp campaigns.</p>
        </div>
        {canManage && (
          <Button onClick={() => navigate(`/w/${workspace.id}/integrations/google-sheets/new`)} className="bg-slate-700 hover:bg-slate-800">
            <Plus className="size-4" /> Connect Google Sheet
          </Button>
        )}
      </div>

      <div className="mb-6 grid overflow-hidden rounded-2xl border border-slate-200 bg-white sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-slate-200">
        <Stat icon={<Database className="size-5" />} tone="bg-sky-50 text-sky-600" label="Total Campaigns" value={stats?.total} hint="Google Sheets connected" />
        <Stat icon={<Play className="size-5" />} tone="bg-emerald-50 text-emerald-600" label="Active" value={stats?.active} hint="Currently syncing" />
        <Stat icon={<Pause className="size-5" />} tone="bg-amber-50 text-amber-600" label="Paused" value={stats?.paused} hint="Temporarily stopped" />
        <Stat icon={<Send className="size-5" />} tone="bg-violet-50 text-violet-600" label="Total Messages" value={stats?.messages} hint="WhatsApp messages sent" />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
        <div className="relative w-full sm:w-96">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
          <Input aria-label="Search campaigns" placeholder="Search campaigns..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <div className="w-full sm:w-44">
          <Select aria-label="Filter by status" value={state} onChange={(e) => setState(e.target.value as typeof state)}>
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="error">Error</option>
            <option value="draft">Setup incomplete</option>
          </Select>
        </div>
      </div>

      {action.error != null && (
        <div className="mb-4">
          <Alert>{errorMessage(action.error)}</Alert>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <Alert>{errorMessage(list.error)}</Alert>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Database className="size-5" />} title={list.data.campaigns.length ? 'No campaigns match' : 'No Google Sheets connected yet'}>
            {list.data.campaigns.length ? 'Try another search or status.' : 'Connect a sheet and every new row will get your WhatsApp template automatically.'}
          </EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500">
                  <tr>
                    <th className="px-3 py-3">#</th>
                    <th className="px-3 py-3">Campaign</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3 text-right">Synced</th>
                    <th className="px-3 py-3">Created</th>
                    <th className="px-3 py-3">Last Sync</th>
                    <th className="px-3 py-3">Template</th>
                    <th className="px-3 py-3">Category</th>
                    <th className="px-3 py-3 whitespace-nowrap">Send Delay</th>
                    <th className="px-3 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((c, i) => (
                    <tr key={c.id} className="hover:bg-slate-50/60">
                      <td className="px-3 py-3 text-slate-500">{i + 1}</td>
                      <td className="px-3 py-3">
                        <Link to={c.status === 'draft' ? setupUrl(c) : dataUrl(c)} className="flex items-center gap-2.5">
                          <span className="rounded-lg bg-emerald-50 p-1.5 text-emerald-600">
                            <Megaphone className="size-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="block max-w-56 truncate font-semibold text-ink hover:text-brand-700">{c.name}</span>
                            <span className="block text-xs text-slate-500">{c.tab?.title ?? 'No tab chosen'}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-3 py-3">
                        <span title={c.lastError ?? undefined}>
                          <StateBadge state={c.state} />
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right font-semibold text-ink tabular-nums">{c.rowCount}</td>
                      <td className="px-3 py-3 whitespace-nowrap text-slate-600">{shortDate(c.createdAt)}</td>
                      <td className="px-3 py-3 whitespace-nowrap text-slate-600">{c.lastSyncAt ? shortDate(c.lastSyncAt) : '—'}</td>
                      <td className="max-w-44 px-3 py-3">
                        {c.template ? (
                          <span className="line-clamp-2 text-slate-700">{c.template.name}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 whitespace-nowrap text-amber-600">
                            <AlertTriangle className="size-3.5" /> Not configured
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3">{c.template ? <CategoryBadge category={c.template.category} /> : <span className="text-slate-400">—</span>}</td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 text-amber-600">
                          <Zap className="size-3.5" /> {delayLabel(c.sendDelayMinutes)}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-0.5">
                          {canManage &&
                            (c.status === 'active' ? (
                              <RowIcon label="Pause" onClick={() => action.mutate({ c, op: 'pause' })}>
                                <Pause className="size-4" />
                              </RowIcon>
                            ) : (
                              <RowIcon label={c.status === 'draft' ? 'Finish setup' : 'Resume'} onClick={() => (c.status === 'draft' ? navigate(setupUrl(c)) : action.mutate({ c, op: 'activate' }))}>
                                <Play className="size-4" />
                              </RowIcon>
                            ))}
                          <RowIcon label="Sync data" onClick={() => navigate(c.status === 'draft' ? setupUrl(c) : dataUrl(c))}>
                            <RefreshCw className="size-4" />
                          </RowIcon>
                          {canManage && (
                            <>
                              <RowIcon label="Settings" onClick={() => navigate(setupUrl(c))}>
                                <Settings className="size-4" />
                              </RowIcon>
                              <span className="mx-1 h-5 w-px bg-slate-200" />
                              <RowIcon label="Delete" danger onClick={() => window.confirm(`Delete "${c.name}"? Messages already sent stay in the inbox.`) && action.mutate({ c, op: 'delete' })}>
                                <Trash2 className="size-4" />
                              </RowIcon>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 text-sm text-slate-500">
              Showing <b className="text-slate-700">1–{rows.length}</b> of <b className="text-slate-700">{rows.length}</b> campaigns
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Stat({ icon, tone, label, value, hint }: { icon: ReactNode; tone: string; label: string; value?: number; hint: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-slate-200 p-5 last:border-b-0 lg:border-b-0">
      <span className={cn('rounded-xl p-2.5', tone)}>{icon}</span>
      <div>
        <p className="text-sm text-slate-500">{label}</p>
        <p className="text-3xl font-bold text-ink tabular-nums">{value ?? '–'}</p>
        <p className="text-sm text-slate-500">{hint}</p>
      </div>
    </div>
  );
}

function RowIcon({ label, danger, onClick, children }: { label: string; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={cn('rounded-md p-1.5 text-slate-500 hover:bg-slate-100', danger ? 'hover:text-red-600' : 'hover:text-ink')}>
      {children}
    </button>
  );
}

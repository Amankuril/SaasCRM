import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Code2, Copy, Eye, FileText, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Share2, Star, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Modal } from '../../components/crm';
import { TemplatePreview } from '../../components/TemplatePreview';
import { Alert, Button, EmptyState, Input, Select, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type MessageTemplate, type TemplatePage } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { CATEGORY_LABEL, TYPE_INFO, languageLabel } from './templateForm';
import { NotConnectedAlert, StatusPill, TemplatesHeader, TypePill, useConnection } from './shared';

const TABS: { key: string; label: string }[] = [
  { key: '', label: 'All Templates' },
  { key: 'FAVORITES', label: 'Favorites' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'PAUSED', label: 'Paused' },
  { key: 'DRAFT', label: 'Draft' },
  { key: 'DISABLED', label: 'Disabled' },
  { key: 'PENDING_DELETION', label: 'Pending Deletion' },
];

/** Meta lets you edit approved, rejected and paused templates; drafts are edited locally. */
export const isEditable = (t: MessageTemplate) => ['APPROVED', 'REJECTED', 'PAUSED', 'DRAFT'].includes(t.status);

export function AllTemplatesPage() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const canManage = can('templates:manage') && workspace.status !== 'suspended';
  const connection = useConnection();

  const [tab, setTab] = useState('');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [viewing, setViewing] = useState<MessageTemplate | null>(null);
  const [coding, setCoding] = useState<MessageTemplate | null>(null);
  const [deleting, setDeleting] = useState<MessageTemplate | null>(null);
  const [flash, setFlash] = useState<string | null>((location.state as { flash?: string } | null)?.flash ?? null);

  // Show a message passed from the builder once, then forget it.
  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);
  useEffect(() => setPage(1), [tab, q, category, type, limit]);

  const key = ['templates', workspace.id, 'page', { tab, q, category, type, page, limit }];
  const list = useQuery({
    queryKey: key,
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (tab === 'FAVORITES') params.set('favorite', 'true');
      else if (tab) params.set('status', tab);
      if (q.trim()) params.set('q', q.trim());
      if (category) params.set('category', category);
      if (type) params.set('type', type);
      return api.get<TemplatePage>(`/workspaces/${workspace.id}/templates?${params}`);
    },
    placeholderData: (prev) => prev,
    // Reviews finish via webhook; poll gently while any are pending.
    refetchInterval: (query) => (query.state.data?.templates.some((t) => t.status === 'PENDING') ? 5_000 : false),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['templates', workspace.id] });

  const sync = useMutation({
    mutationFn: () => api.post<{ synced: number; removed: number }>(`/workspaces/${workspace.id}/templates/sync`),
    onSuccess: (r) => {
      setFlash(`Synced ${r.synced} template(s) from WhatsApp${r.removed ? `, removed ${r.removed} deleted there` : ''}.`);
      void invalidate();
    },
  });
  const favorite = useMutation({
    mutationFn: (t: MessageTemplate) => api.post(`/workspaces/${workspace.id}/templates/${t.id}/favorite`, { favorite: !t.isFavorite }),
    onSuccess: () => void invalidate(),
  });
  const duplicate = useMutation({
    mutationFn: (t: MessageTemplate) => api.post<{ template: MessageTemplate }>(`/workspaces/${workspace.id}/templates/${t.id}/duplicate`),
    onSuccess: ({ template }) => {
      setFlash(`Copied as draft "${template.name}".`);
      void invalidate();
    },
  });
  const contribute = useMutation({
    mutationFn: (t: MessageTemplate) => api.post(`/workspaces/${workspace.id}/templates/${t.id}/contribute`),
    onSuccess: () => setFlash('Shared with the Community Library. Thank you!'),
  });
  const actionError = sync.error ?? duplicate.error ?? contribute.error ?? favorite.error;

  const data = list.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;
  const filtered = !!(tab || q || category || type);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <TemplatesHeader
        title="All Templates"
        description="View, search and manage all your WhatsApp message templates"
        actions={
          canManage && (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => sync.mutate()} loading={sync.isPending} disabled={!connection.connected} title="Sync from WhatsApp" aria-label="Sync from WhatsApp">
                {!sync.isPending && <RefreshCw className="size-4" />}
              </Button>
              <Button onClick={() => navigate('new')} className="bg-slate-700 hover:bg-slate-800">
                <Plus className="size-4" /> New Template
              </Button>
            </div>
          )
        }
      />

      <div className="space-y-3 px-4 py-4 sm:px-6">
        {connection.loaded && !connection.connected && <NotConnectedAlert />}
        {flash && (
          <Alert tone="success">
            <span className="flex items-center justify-between gap-2">
              {flash}
              <button className="text-xs underline" onClick={() => setFlash(null)}>
                Dismiss
              </button>
            </span>
          </Alert>
        )}
        {actionError != null && <Alert>{errorMessage(actionError)}</Alert>}

        <div className="flex gap-2 overflow-x-auto pb-1" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'shrink-0 rounded-full border px-3 py-1 text-sm transition-colors',
                tab === t.key ? 'border-slate-300 bg-slate-100 font-medium text-ink' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <Input aria-label="Search templates" placeholder="Search templates..." value={q} onChange={(e) => setQ(e.target.value)} className="rounded-full pl-9" />
          </div>
          <Select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className="w-40!">
            <option value="">All Categories</option>
            {Object.entries(CATEGORY_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className="w-40!">
            <option value="">All Types</option>
            {TYPE_INFO.map((t) => (
              <option key={t.type} value={t.type}>
                {t.type === 'CUSTOM' ? 'Custom' : t.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {list.isPending ? (
            <Spinner />
          ) : list.error ? (
            <div className="p-4">
              <Alert>{errorMessage(list.error)}</Alert>
            </div>
          ) : data!.templates.length === 0 ? (
            <EmptyState icon={<FileText className="size-5" />} title={filtered ? 'No templates match these filters' : 'No templates yet'}>
              {filtered ? 'Try another tab or search.' : connection.connected ? 'Sync your existing templates from WhatsApp or create a new one.' : 'Templates appear here once WhatsApp is connected.'}
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase">
                    <th className="px-4 py-3">Name</th>
                    <th className="px-3 py-3">Category</th>
                    <th className="px-3 py-3">Language</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Type</th>
                    <th className="px-3 py-3">Created</th>
                    <th className="px-3 py-3">Updated</th>
                    <th className="px-3 py-3">Used in</th>
                    <th className="px-3 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data!.templates.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-50/70">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => favorite.mutate(t)}
                            className={cn('rounded p-0.5', t.isFavorite ? 'text-amber-400' : 'text-slate-300 hover:text-slate-500')}
                            aria-label={t.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                          >
                            <Star className={cn('size-4', t.isFavorite && 'fill-current')} />
                          </button>
                          <button onClick={() => setViewing(t)} className="max-w-56 truncate text-left font-medium text-slate-800 hover:underline" title={t.name}>
                            {t.name}
                          </button>
                        </div>
                        {t.rejectedReason && <p className="mt-0.5 ml-7 text-xs text-red-600">{t.rejectedReason.replace(/_/g, ' ').toLowerCase()}</p>}
                      </td>
                      <td className="px-3 py-3 text-slate-600">{CATEGORY_LABEL[t.category] ?? t.category}</td>
                      <td className="px-3 py-3 text-slate-600">{t.language}</td>
                      <td className="px-3 py-3">
                        <StatusPill status={t.status} />
                      </td>
                      <td className="px-3 py-3">
                        <TypePill type={t.type} />
                      </td>
                      <td className="px-3 py-3">
                        <DateBy date={t.createdAt} by={t.createdBy} />
                      </td>
                      <td className="px-3 py-3">
                        <DateBy date={t.updatedAt} by={t.updatedBy} />
                      </td>
                      <td className="px-3 py-3">
                        <UsedIn usage={t.usage} />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-0.5 text-slate-500">
                          <IconButton label="Preview" onClick={() => setViewing(t)}>
                            <Eye className="size-4" />
                          </IconButton>
                          <IconButton label="API code" onClick={() => setCoding(t)}>
                            <Code2 className="size-4" />
                          </IconButton>
                          {canManage && (
                            <IconButton
                              label={isEditable(t) ? 'Edit' : `${t.status.toLowerCase().replace(/_/g, ' ')} templates cannot be edited`}
                              disabled={!isEditable(t)}
                              onClick={() => navigate(`${t.id}/edit`)}
                            >
                              <Pencil className="size-4" />
                            </IconButton>
                          )}
                          {canManage && (
                            <RowMenu
                              template={t}
                              onDuplicate={() => duplicate.mutate(t)}
                              onContribute={() => contribute.mutate(t)}
                              onDelete={() => setDeleting(t)}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data && data.total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
              <div className="flex items-center gap-3">
                <span>
                  Showing {(page - 1) * limit + 1}–{Math.min(page * limit, data.total)} of {data.total} templates
                </span>
                <Select aria-label="Rows per page" value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="w-28! py-1">
                  {[10, 25, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      Show {n}
                    </option>
                  ))}
                </Select>
              </div>
              <Pager page={page} totalPages={totalPages} onChange={setPage} />
            </div>
          )}
        </div>
      </div>

      {viewing && <ViewModal template={viewing} onClose={() => setViewing(null)} />}
      {coding && <CodeModal template={coding} onClose={() => setCoding(null)} />}
      {deleting && (
        <DeleteModal
          template={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setFlash(`Deleted "${deleting.name}".`);
            setDeleting(null);
            void invalidate();
          }}
        />
      )}
    </div>
  );
}

function DateBy({ date, by }: { date: string; by: string | null }) {
  return (
    <div className="whitespace-nowrap">
      <p className="text-slate-700">{formatDate(date, true)}</p>
      {by && <p className="text-xs text-slate-400">by {by}</p>}
    </div>
  );
}

function UsedIn({ usage }: { usage: MessageTemplate['usage'] }) {
  if (!usage || (!usage.campaigns && !usage.flows)) return <span className="text-slate-400">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {usage.campaigns > 0 && (
        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-indigo-700 ring-1 ring-indigo-200">
          {usage.campaigns} campaign{usage.campaigns > 1 ? 's' : ''}
        </span>
      )}
      {usage.flows > 0 && (
        <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-violet-700 ring-1 ring-violet-200">
          {usage.flows} flow{usage.flows > 1 ? 's' : ''}
        </span>
      )}
    </div>
  );
}

function IconButton({ label, children, ...props }: { label: string; children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button {...props} title={label} aria-label={label} className="rounded-md p-1.5 hover:bg-slate-100 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent">
      {children}
    </button>
  );
}

function RowMenu({ template, onDuplicate, onContribute, onDelete }: { template: MessageTemplate; onDuplicate: () => void; onContribute: () => void; onDelete: () => void }) {
  // Fixed-positioned so the table's horizontal scroll container cannot clip it.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node) && setPos(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setPos(null);
    const dismiss = () => setPos(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [pos]);
  const toggle = () => {
    if (pos) return setPos(null);
    const rect = ref.current!.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  };
  const item = (label: string, Icon: typeof Copy, onClick: () => void, opts: { danger?: boolean; disabled?: string } = {}) => (
    <button
      role="menuitem"
      disabled={!!opts.disabled}
      title={opts.disabled}
      onClick={() => {
        setPos(null);
        onClick();
      }}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40',
        opts.danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-700 hover:bg-slate-100',
      )}
    >
      <Icon className="size-4" /> {label}
    </button>
  );
  return (
    <div ref={ref}>
      <IconButton label="More actions" onClick={toggle}>
        <MoreHorizontal className="size-4" />
      </IconButton>
      {pos && (
        <div ref={menu} role="menu" style={{ top: pos.top, right: pos.right }} className="fixed z-40 w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
          {item('Duplicate', Copy, onDuplicate)}
          {item('Contribute to library', Share2, onContribute, { disabled: template.status === 'APPROVED' ? undefined : 'Only approved templates can be shared' })}
          {item('Delete', Trash2, onDelete, { danger: true })}
        </div>
      )}
    </div>
  );
}

function Pager({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  // First, last, and a window around the current page.
  const pages = [...new Set([1, page - 1, page, page + 1, totalPages])].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const btn = 'flex size-8 items-center justify-center rounded-full text-sm disabled:opacity-40';
  return (
    <div className="flex items-center gap-1">
      <button className={cn(btn, 'border border-slate-200 hover:bg-slate-50')} disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page">
        <ChevronLeft className="size-4" />
      </button>
      {pages.map((p, i) => (
        <span key={p} className="flex items-center gap-1">
          {i > 0 && p - pages[i - 1]! > 1 && <span className="px-1 text-slate-400">…</span>}
          <button
            className={cn(btn, p === page ? 'bg-slate-700 font-medium text-white' : 'border border-slate-200 hover:bg-slate-50')}
            onClick={() => onChange(p)}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </button>
        </span>
      ))}
      <button className={cn(btn, 'border border-slate-200 hover:bg-slate-50')} disabled={page >= totalPages} onClick={() => onChange(page + 1)} aria-label="Next page">
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

function ViewModal({ template: t, onClose }: { template: MessageTemplate; onClose: () => void }) {
  const { workspace } = useWorkspace();
  return (
    <Modal title={t.name} onClose={onClose} wide>
      <div className="grid gap-5 sm:grid-cols-2">
        <dl className="space-y-3 text-sm">
          <Row label="Status">
            <StatusPill status={t.status} />
          </Row>
          {t.rejectedReason && (
            <Row label="Rejection reason">
              <span className="text-red-600">{t.rejectedReason}</span>
            </Row>
          )}
          <Row label="Type">
            <TypePill type={t.type} />
          </Row>
          <Row label="Category">{CATEGORY_LABEL[t.category] ?? t.category}</Row>
          <Row label="Language">{languageLabel(t.language)}</Row>
          {t.variables.header + t.variables.body > 0 && (
            <Row label="Variables">
              {t.variables.header ? `${t.variables.header} in header, ` : ''}
              {t.variables.body} in body
            </Row>
          )}
          {t.libraryTemplateName && <Row label="From Meta library">{t.libraryTemplateName}</Row>}
          {t.providerTemplateId && <Row label="WhatsApp template ID">{t.providerTemplateId}</Row>}
          {t.syncedAt && <Row label="Last synced">{formatDate(t.syncedAt, true)}</Row>}
          {t.status === 'APPROVED' && (
            <Link to={`/w/${workspace.id}/campaigns`} className="inline-block pt-2 text-sm font-medium text-brand-700 hover:underline">
              Use in a broadcast →
            </Link>
          )}
        </dl>
        <TemplatePreview components={t.components} />
      </div>
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-slate-800">{children}</dd>
    </div>
  );
}

function CodeModal({ template: t, onClose }: { template: MessageTemplate; onClose: () => void }) {
  const [view, setView] = useState<'api' | 'json'>('api');
  const [copied, setCopied] = useState(false);
  const sample = {
    to: '+919876543210',
    type: 'template',
    template: { name: t.name, language: t.language },
    ...(t.variables.header ? { header_params: ['Value'] } : {}),
    ...(t.variables.body ? { body_params: Array.from({ length: t.variables.body }, (_, i) => `value_${i + 1}`) } : {}),
  };
  const code =
    view === 'api'
      ? `curl -X POST ${window.location.origin}/api/v1/messages \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: $(uuidgen)" \\\n  -d '${JSON.stringify(sample, null, 2)}'`
      : JSON.stringify({ name: t.name, language: t.language, category: t.category, components: t.components }, null, 2);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the code is still selectable.
    }
  };
  return (
    <Modal title={`Code · ${t.name}`} onClose={onClose} wide>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
          {(['api', 'json'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cn('rounded-md px-3 py-1', view === v ? 'bg-white font-medium shadow-sm' : 'text-slate-600')}>
              {v === 'api' ? 'Send via API' : 'Template JSON'}
            </button>
          ))}
        </div>
        <Button variant="secondary" onClick={copy}>
          <Copy className="size-4" /> {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="max-h-[60vh] overflow-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">{code}</pre>
      {view === 'api' && (
        <p className="mt-2 text-xs text-slate-500">
          Create an API key with the <code>messages:send</code> scope under Developers. Only approved templates can be sent.
        </p>
      )}
    </Modal>
  );
}

function DeleteModal({ template: t, onClose, onDeleted }: { template: MessageTemplate; onClose: () => void; onDeleted: () => void }) {
  const { workspace } = useWorkspace();
  const del = useMutation({ mutationFn: () => api.delete(`/workspaces/${workspace.id}/templates/${t.id}`), onSuccess: onDeleted });
  const used = (t.usage?.campaigns ?? 0) + (t.usage?.flows ?? 0);
  return (
    <Modal title="Delete template?" onClose={onClose}>
      <div className="space-y-3 text-sm text-slate-600">
        <p>
          <strong className="text-slate-800">{t.name}</strong> ({t.language}) will be deleted
          {t.providerTemplateId ? ' from WhatsApp as well. Meta does not let you reuse this name for 30 days.' : '.'}
        </p>
        {used > 0 && <Alert>This template is used in {used} campaign(s)/flow(s). Those will fail to send until you pick another template.</Alert>}
        {del.error != null && <Alert>{errorMessage(del.error)}</Alert>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => del.mutate()} loading={del.isPending}>
            <Trash2 className="size-4" /> Delete
          </Button>
        </div>
      </div>
    </Modal>
  );
}


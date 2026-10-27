import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, ClipboardList, Code2, Download, FileJson, FilePlus2, Pencil, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Dialog } from '../../components/Dialog';
import { Alert, Badge, Button, EmptyState, Field, Input, Select, Spinner, cn, errorMessage, fieldError } from '../../components/ui';
import { FORM_CATEGORIES, api, type FormCategory, type WaForm } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { CATEGORY_LABEL, FORM_STATUS, FlowJsonDialog, SubmissionsDialog, fetchFlowJson, saveJson } from './shared';

type StatusFilter = 'all' | WaForm['status'];

export function FormsListPage() {
  const { workspace, can } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canManage = can('forms:manage') && workspace.status !== 'suspended';
  const list = useQuery({ queryKey: ['forms', workspace.id], queryFn: () => api.get<{ forms: WaForm[] }>(`/workspaces/${workspace.id}/forms`) });
  const [status, setStatus] = useState<StatusFilter>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'asc' | 'desc' | null>(null);
  const [creating, setCreating] = useState<'blank' | 'json' | null>(null);
  const [code, setCode] = useState<WaForm | null>(null);
  const [data, setData] = useState<WaForm | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['forms', workspace.id] });
  const sync = useMutation({
    mutationFn: () => api.post<{ imported: number; total: number }>(`/workspaces/${workspace.id}/forms/sync`),
    onSuccess: ({ imported, total }) => {
      setNotice(imported ? `Imported ${imported} new form(s) from your WhatsApp account.` : `Everything is up to date (${total} form(s) on your WhatsApp account).`);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/workspaces/${workspace.id}/forms/${id}`),
    onSettled: refresh,
  });
  const download = useMutation({
    mutationFn: async (f: WaForm) => {
      const json = await fetchFlowJson(workspace.id, f.id);
      saveJson(f.name, json.published ?? json.draft);
    },
  });

  const forms = list.data?.forms ?? [];
  const recent = forms.filter((f) => f.status === 'published').slice(0, 4);
  const term = q.trim().toLowerCase();
  const rows = forms
    .filter((f) => (status === 'all' || f.status === status) && (!term || f.name.toLowerCase().includes(term) || f.providerFlowId?.includes(term)))
    .sort((a, b) => (sort ? (sort === 'asc' ? 1 : -1) * a.name.localeCompare(b.name) : 0));
  const error = sync.error ?? remove.error ?? download.error;
  const SortIcon = sort === 'asc' ? ArrowUp : sort === 'desc' ? ArrowDown : ArrowUpDown;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-3">
        <span className="rounded-xl bg-emerald-50 p-2.5 text-emerald-600 ring-1 ring-emerald-100">
          <ClipboardList className="size-5" />
        </span>
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-ink">WhatsApp Form Builder</h1>
          <p className="text-sm text-slate-500">Native forms that open inside WhatsApp: sign-ups, bookings, lead capture, surveys.</p>
        </div>
        {canManage && (
          <Button variant="secondary" loading={sync.isPending} onClick={() => sync.mutate()} title="Import forms made in Meta's Flow Builder and refresh statuses">
            <RefreshCw className="size-4" /> Sync
          </Button>
        )}
      </div>

      <div className="mb-4 space-y-2">
        {error != null && <Alert>{errorMessage(error)}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
      </div>

      {canManage && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold text-ink">Create New WhatsApp Forms</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <StartCard icon={<FilePlus2 className="size-6" />} title="Blank Form" hint="Start from scratch" onClick={() => setCreating('blank')} />
            <StartCard icon={<FileJson className="size-6" />} title="Paste Flow JSON" hint="Bring a flow from elsewhere" onClick={() => setCreating('json')} />
            {recent.map((f) => (
              <div key={f.id} className="group relative flex h-32 flex-col rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:border-emerald-300 hover:shadow">
                <Link to={`/w/${workspace.id}/forms/${f.id}`} className="absolute inset-0 rounded-xl" aria-label={`Open ${f.name}`} />
                <Badge tone="green">PUBLISHED</Badge>
                <p className="mt-2 line-clamp-2 text-sm font-medium text-slate-800">{f.name}</p>
                <p className="mt-auto text-xs text-slate-500">{CATEGORY_LABEL[f.category]}</p>
                <button type="button" onClick={() => setCode(f)} className="absolute right-2 bottom-2 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="View Flow JSON" title="View Flow JSON">
                  <Code2 className="size-4" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-sm font-semibold text-ink">All WhatsApp Forms</h2>
          <div className="w-full sm:w-52">
            <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="all">Filter by Status: All</option>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="failed">Publish failed</option>
            </Select>
          </div>
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <Input aria-label="Search forms" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
        </div>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {list.isPending ? (
            <Spinner />
          ) : list.error ? (
            <div className="p-4">
              <Alert>{errorMessage(list.error)}</Alert>
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={<ClipboardList className="size-5" />} title={forms.length ? 'No forms match' : 'No forms yet'}>
              {forms.length ? 'Try another status or search.' : 'Create a blank form or paste Flow JSON, publish it to WhatsApp, then send it from a flow, a campaign template or here.'}
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">
                      <button type="button" onClick={() => setSort(sort === 'asc' ? 'desc' : sort === 'desc' ? null : 'asc')} className="inline-flex items-center gap-1 hover:text-ink">
                        Form Name <SortIcon className="size-3.5" />
                      </button>
                    </th>
                    <th className="px-4 py-3 font-medium">Submission Data</th>
                    <th className="px-4 py-3 font-medium">Last Updated On</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Flow ID</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((f) => (
                    <tr key={f.id} className="hover:bg-slate-50/60">
                      <td className="px-4 py-3">
                        <Link to={`/w/${workspace.id}/forms/${f.id}`} className="font-medium text-slate-800 hover:text-brand-700">
                          {f.name}
                        </Link>
                        <p className="text-xs text-slate-500">
                          {CATEGORY_LABEL[f.category]} · {f.rawFlowJson ? 'Flow JSON' : `${f.screens.length} screen(s)`}
                          {f.status === 'published' && f.hasUnpublishedChanges && <span className="text-amber-600"> · unpublished changes</span>}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <button type="button" onClick={() => setData(f)} className="font-medium text-brand-700 hover:underline">
                          View Data
                        </button>
                        <span className="ml-1.5 text-xs text-slate-400">({f.submissions ?? 0})</span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600">{formatDate(f.updatedAt, true)}</td>
                      <td className="px-4 py-3">
                        <Badge tone={FORM_STATUS[f.status].tone}>
                          {FORM_STATUS[f.status].label}
                          {f.version > 0 && ` · v${f.version}`}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">{f.providerFlowId ?? '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-0.5">
                          <IconButton label="Edit" onClick={() => navigate(`/w/${workspace.id}/forms/${f.id}`)}>
                            <Pencil className="size-4" />
                          </IconButton>
                          <IconButton label="Download Flow JSON" onClick={() => download.mutate(f)}>
                            <Download className="size-4" />
                          </IconButton>
                          <IconButton label="View Flow JSON" onClick={() => setCode(f)}>
                            <Code2 className="size-4" />
                          </IconButton>
                          {canManage && (
                            <IconButton label="Delete" danger onClick={() => window.confirm(`Delete "${f.name}"? Its submissions are kept.`) && remove.mutate(f.id)}>
                              <Trash2 className="size-4" />
                            </IconButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {creating && <CreateFormDialog mode={creating} onClose={() => setCreating(null)} />}
      {code && <FlowJsonDialog form={code} onClose={() => setCode(null)} />}
      {data && <SubmissionsDialog form={data} onClose={() => setData(null)} />}
    </>
  );
}

function StartCard({ icon, title, hint, onClick }: { icon: React.ReactNode; title: string; hint: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-32 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-white p-3 text-center transition hover:border-emerald-400 hover:bg-emerald-50/40">
      <span className="text-emerald-600">{icon}</span>
      <span className="text-sm font-medium text-slate-800">{title}</span>
      <span className="text-xs text-slate-500">{hint}</span>
    </button>
  );
}

function IconButton({ label, danger, onClick, children }: { label: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={cn('rounded-md p-1.5 text-slate-500 hover:bg-slate-100', danger ? 'hover:text-red-600' : 'hover:text-ink')}>
      {children}
    </button>
  );
}

function CreateFormDialog({ mode, onClose }: { mode: 'blank' | 'json'; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [category, setCategory] = useState<FormCategory | ''>('');
  const [json, setJson] = useState('');
  const create = useMutation({
    mutationFn: () =>
      mode === 'blank'
        ? api.post<{ form: WaForm }>(`/workspaces/${workspace.id}/forms`, { name: name.trim(), category })
        : api.post<{ form: WaForm; editable: boolean }>(`/workspaces/${workspace.id}/forms/import`, { name: name.trim(), category, flowJson: json }),
    onSuccess: ({ form }) => navigate(`/w/${workspace.id}/forms/${form.id}`),
  });
  const ready = name.trim() && category && (mode === 'blank' || json.trim());
  return (
    <Dialog
      icon={mode === 'blank' ? <FilePlus2 className="size-5" /> : <FileJson className="size-5" />}
      title={mode === 'blank' ? 'Create WhatsApp Form' : 'Paste Flow JSON'}
      subtitle={mode === 'blank' ? 'Name it and pick what it is for' : 'Import a flow built in Meta’s Flow Builder or another tool'}
      width={mode === 'blank' ? 'max-w-md' : 'max-w-2xl'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.isPending} disabled={!ready} onClick={() => create.mutate()}>
            {mode === 'blank' ? 'Create' : 'Import'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) create.mutate();
        }}
      >
        {create.error != null && !fieldError(create.error, 'flowJson') && <Alert>{errorMessage(create.error)}</Alert>}
        <Field label="Form Name" htmlFor="form-name" hint="Only you see this name.">
          <Input id="form-name" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Clinic appointment request" />
        </Field>
        <Field label="Select Category" htmlFor="form-category" hint="WhatsApp asks for the form's purpose when it is published.">
          <Select id="form-category" value={category} onChange={(e) => setCategory(e.target.value as FormCategory)}>
            <option value="" disabled>
              Select category
            </option>
            {FORM_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        {mode === 'json' && (
          <Field label="Flow JSON" htmlFor="form-json" error={fieldError(create.error, 'flowJson')} hint="Static forms become editable screens; forms using a data endpoint are kept as JSON.">
            <textarea
              id="form-json"
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={12}
              spellCheck={false}
              placeholder={'{\n  "version": "6.3",\n  "screens": [ ... ]\n}'}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
            />
          </Field>
        )}
      </form>
    </Dialog>
  );
}

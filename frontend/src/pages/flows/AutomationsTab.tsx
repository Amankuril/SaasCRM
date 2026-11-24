import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Copy, LayoutTemplate, Pencil, Plus, Search, TextCursorInput, Trash2, Workflow } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Dialog } from '../../components/Dialog';
import { ConfirmDialog, SkeletonRows, StatusBadge, useToast } from '../../components/feedback';
import { Button, Card, EmptyState, Field, Input, Select, cn, errorMessage, LoadError } from '../../components/ui';
import { api, type FlowDetail, type FlowSummary } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { FLOW_TEMPLATES, type FlowTemplate } from './flowTemplates';
import { FLOW_STATUS, td, th, useFlows } from './shared';

type StatusFilter = 'all' | 'active' | 'inactive' | 'draft';

export function AutomationsTab() {
  const { workspace, can } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const list = useFlows();
  const base = `/workspaces/${workspace.id}/flows`;
  const canManage = can('flows:manage') && workspace.status !== 'suspended';

  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [guide, setGuide] = useState(() => {
    try {
      return localStorage.getItem('zc.flows.guide') !== '0';
    } catch {
      return true;
    }
  });
  const [templates, setTemplates] = useState(false);
  const [renaming, setRenaming] = useState<FlowSummary | null>(null);
  const [deleting, setDeleting] = useState<FlowSummary | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['flows', workspace.id] });
  const patchList = (fn: (flows: FlowSummary[]) => FlowSummary[]) =>
    queryClient.setQueryData<{ flows: FlowSummary[] }>(['flows', workspace.id], (old) => (old ? { flows: fn(old.flows) } : old));
  const open = (id: string) => navigate(`/w/${workspace.id}/flows/${id}`);

  const create = useMutation({
    mutationFn: async (template?: FlowTemplate) => {
      const { flow } = await api.post<{ flow: FlowDetail }>(base, { name: template?.name ?? 'Untitled automation' });
      if (template) await api.patch(`${base}/${flow.id}`, { draftGraph: template.graph(), description: template.description });
      return flow;
    },
    onSuccess: (flow) => {
      void refresh();
      open(flow.id);
    },
    onError: (err) => toast.error(err),
  });
  const duplicate = useMutation({
    mutationFn: (f: FlowSummary) => api.post<{ flow: FlowDetail }>(`${base}/${f.id}/duplicate`),
    onSuccess: ({ flow }) => {
      void refresh();
      toast.success(`Created "${flow.name}" as a draft.`);
    },
    onError: (err) => toast.error(err),
  });
  const toggle = useMutation({
    mutationFn: (f: FlowSummary) => api.post<{ flow: FlowDetail }>(`${base}/${f.id}/${f.status === 'active' ? 'deactivate' : 'activate'}`),
    onSuccess: ({ flow }) => {
      patchList((flows) => flows.map((x) => (x.id === flow.id ? { ...x, status: flow.status } : x)));
      toast.success(flow.status === 'active' ? `"${flow.name}" is active.` : `"${flow.name}" is paused.`);
    },
    onError: (err) => toast.error(err),
  });
  const remove = useMutation({
    mutationFn: async (f: FlowSummary) => {
      // A live automation is stopped first, then deleted.
      if (f.status === 'active') await api.post(`${base}/${f.id}/deactivate`);
      await api.delete(`${base}/${f.id}`);
      return f;
    },
    onSuccess: (f) => {
      patchList((flows) => flows.filter((x) => x.id !== f.id));
      setDeleting(null);
      toast.success(`Deleted "${f.name}".`);
    },
    onError: (err) => {
      void refresh();
      toast.error(err);
    },
  });

  const flows = list.data?.flows ?? [];
  const needle = q.trim().toLowerCase();
  const shown = flows.filter((f) => (status === 'all' || f.status === status) && (!needle || f.name.toLowerCase().includes(needle)));
  const toggleGuide = () => {
    setGuide(!guide);
    try {
      localStorage.setItem('zc.flows.guide', guide ? '0' : '1');
    } catch {
      /* per-browser preference only */
    }
  };

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl leading-8 font-medium text-ink">Automations</h1>
          <p className="mt-1 text-sm text-slate-500">Chatbots and automations that reply, ask, tag and hand off for you.</p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setTemplates(true)}>
              <LayoutTemplate className="size-4" /> Browse templates
            </Button>
            <Button loading={create.isPending && !templates} onClick={() => create.mutate(undefined)}>
              <Plus className="size-4" /> New automation
            </Button>
          </div>
        )}
      </div>

      <Card className="mb-5">
        <button type="button" onClick={toggleGuide} aria-expanded={guide} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
          <span className="text-sm font-semibold text-ink">How automations work</span>
          <ChevronDown className={cn('size-4 text-slate-400 transition-transform', !guide && '-rotate-90')} />
        </button>
        {guide && (
          <ol className="grid gap-3 border-t border-slate-100 p-4 md:grid-cols-3">
            {[
              ['Choose a trigger', 'Pick what starts the automation: a keyword, any message, a new contact, a tag or a form.'],
              ['Add steps on the canvas', 'Drag in messages, questions, conditions and actions, and connect them in the order they should run.'],
              ['Publish and activate', 'Test it on your own number, publish, and it replies to customers 24x7. Pause it any time.'],
            ].map(([title, text], i) => (
              <li key={title} className="flex gap-3 rounded-lg bg-slate-50 p-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">{i + 1}</span>
                <div>
                  <p className="text-sm font-medium text-slate-800">{title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <div className="relative min-w-48 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search automations" className="pl-9" aria-label="Search automations" />
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="w-36" aria-label="Status">
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Paused</option>
            <option value="draft">Draft</option>
          </Select>
          <span className="ml-auto text-xs text-slate-500">
            {shown.length} of {flows.length}
          </span>
        </div>

        {list.isPending ? (
          <SkeletonRows rows={6} />
        ) : list.error ? (
            <LoadError error={list.error} what="this list" onRetry={() => void list.refetch()} />
          ) : flows.length === 0 ? (
          <EmptyState icon={<Workflow className="size-5" />} title="No automations yet">
            <p>Start from a template or build your own: a customer sends a keyword, the bot asks, answers and hands over to your team.</p>
            {canManage && (
              <div className="mt-4 flex justify-center gap-2">
                <Button variant="secondary" onClick={() => setTemplates(true)}>
                  Browse templates
                </Button>
                <Button loading={create.isPending} onClick={() => create.mutate(undefined)}>
                  <Plus className="size-4" /> New automation
                </Button>
              </div>
            )}
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState icon={<Search className="size-5" />} title="No automations match">
            Try another name or status.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={cn(th, 'w-12')}>#</th>
                  <th className={th}>Automation name</th>
                  <th className={th}>Status</th>
                  <th className={th}>Created</th>
                  <th className={th}>Last modified</th>
                  <th className={cn(th, 'text-right')}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((f, i) => (
                  <tr key={f.id} className="hover:bg-slate-50">
                    <td className={td('text-slate-400 tabular-nums')}>{i + 1}</td>
                    <td className={td()}>
                      <Link to={`/w/${workspace.id}/flows/${f.id}`} className="font-medium text-slate-800 hover:text-brand-700">
                        {f.name}
                      </Link>
                      {f.status !== 'draft' && f.hasUnpublishedChanges && <p className="text-xs text-amber-600">Unpublished changes</p>}
                    </td>
                    <td className={td()}>
                      <div className="flex items-center gap-2.5">
                        {canManage && (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={f.status === 'active'}
                            aria-label={f.status === 'active' ? `Pause ${f.name}` : `Activate ${f.name}`}
                            title={f.status === 'active' ? 'Pause' : f.publishedVersion ? 'Activate' : 'Publish it in the builder first'}
                            disabled={toggle.isPending && toggle.variables?.id === f.id}
                            onClick={() => (f.publishedVersion ? toggle.mutate(f) : (toast.info('Open the automation and publish it first.'), open(f.id)))}
                            className={cn('relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50', f.status === 'active' ? 'bg-brand-600' : 'bg-slate-300')}
                          >
                            <span className={cn('absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform', f.status === 'active' && 'translate-x-4')} />
                          </button>
                        )}
                        <StatusBadge status={FLOW_STATUS[f.status].badge} label={FLOW_STATUS[f.status].label} />
                      </div>
                    </td>
                    <td className={td('whitespace-nowrap text-slate-500')}>{formatDate(f.createdAt)}</td>
                    <td className={td('whitespace-nowrap text-slate-500')}>{formatDate(f.draftUpdatedAt, true)}</td>
                    <td className={td('text-right')}>
                      <div className="inline-flex items-center gap-0.5">
                        <RowAction label="Edit" onClick={() => open(f.id)}>
                          <Pencil className="size-4" />
                        </RowAction>
                        {canManage && (
                          <>
                            <RowAction label="Rename" onClick={() => setRenaming(f)}>
                              <TextCursorInput className="size-4" />
                            </RowAction>
                            <RowAction label="Duplicate" onClick={() => duplicate.mutate(f)} disabled={duplicate.isPending}>
                              <Copy className="size-4" />
                            </RowAction>
                            <RowAction label="Delete" danger onClick={() => setDeleting(f)}>
                              <Trash2 className="size-4" />
                            </RowAction>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {renaming && <RenameDialog flow={renaming} onClose={() => setRenaming(null)} onDone={(name) => patchList((flows) => flows.map((x) => (x.id === renaming.id ? { ...x, name } : x)))} />}
      {deleting && (
        <ConfirmDialog title={`Delete "${deleting.name}"?`} loading={remove.isPending} onConfirm={() => remove.mutate(deleting)} onClose={() => setDeleting(null)}>
          This automation will be permanently deleted, along with its run history.
          {deleting.status === 'active' && ' It is active right now: it will be stopped and customers in the middle of it will not get further replies.'}
        </ConfirmDialog>
      )}
      {templates && (
        <Dialog icon={<LayoutTemplate className="size-4" />} title="Browse templates" subtitle="Start from a ready-made automation and edit it" onClose={() => setTemplates(false)} width="max-w-2xl">
          <div className="grid gap-3 sm:grid-cols-2">
            {FLOW_TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                disabled={create.isPending}
                onClick={() => create.mutate(t)}
                className="rounded-xl border border-slate-200 p-4 text-left transition hover:border-brand-400 hover:bg-brand-50/40 disabled:opacity-60"
              >
                <span className="mb-2 inline-flex rounded-lg bg-brand-50 p-2 text-brand-700">
                  <t.icon className="size-4" />
                </span>
                <p className="text-sm font-semibold text-ink">{t.name}</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">{t.description}</p>
              </button>
            ))}
          </div>
        </Dialog>
      )}
    </>
  );
}

function RowAction({ label, danger, disabled, onClick, children }: { label: string; danger?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn('rounded-md p-1.5 transition disabled:opacity-40', danger ? 'text-red-500 hover:bg-red-50 hover:text-red-700' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800')}
    >
      {children}
    </button>
  );
}

function RenameDialog({ flow, onClose, onDone }: { flow: FlowSummary; onClose: () => void; onDone: (name: string) => void }) {
  const { workspace } = useWorkspace();
  const toast = useToast();
  const [name, setName] = useState(flow.name);
  const save = useMutation({
    mutationFn: () => api.patch<{ flow: FlowDetail }>(`/workspaces/${workspace.id}/flows/${flow.id}`, { name: name.trim() }),
    onSuccess: ({ flow: saved }) => {
      onDone(saved.name);
      toast.success('Automation renamed.');
      onClose();
    },
  });
  return (
    <Dialog
      icon={<TextCursorInput className="size-4" />}
      title="Rename automation"
      subtitle={flow.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!name.trim() || name.trim() === flow.name} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== flow.name) save.mutate();
        }}
      >
        <Field label="Automation name" htmlFor="flow-name" error={save.error ? errorMessage(save.error) : undefined}>
          <Input id="flow-name" autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

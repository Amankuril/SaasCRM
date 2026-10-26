import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FlaskConical, MessageSquare, Network, Pencil, Plus, Search, SlidersHorizontal, Trash2, X, Zap } from 'lucide-react';
import { useDeferredValue, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Dialog } from '../../components/Dialog';
import { Alert, Button, EmptyState, Input, Select, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type AutoReply, type FlowSummary, type MessageSource, type MessageTemplate, type TryResult, type WaForm } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { ActionPill, EVENT_LABEL, MATCH_LABEL, PhonePreview, SOURCE_LABEL, actionLabel, triggerText } from './shared';

/** Form / flow / template names for previews (all cached per workspace). */
export function useActionNames(action: AutoReply['action'] | undefined) {
  const { workspace } = useWorkspace();
  const type = action?.type;
  const forms = useQuery({ queryKey: ['forms', workspace.id], queryFn: () => api.get<{ forms: WaForm[] }>(`/workspaces/${workspace.id}/forms`), enabled: type === 'form' });
  const flows = useQuery({ queryKey: ['flows', workspace.id], queryFn: () => api.get<{ flows: FlowSummary[] }>(`/workspaces/${workspace.id}/flows`), enabled: type === 'chatbot' });
  const templates = useQuery({
    queryKey: ['templates', workspace.id, 'APPROVED'],
    queryFn: () => api.get<{ templates: MessageTemplate[] }>(`/workspaces/${workspace.id}/templates?status=APPROVED`),
    enabled: type === 'template',
  });
  const c = action?.config ?? {};
  return {
    form: forms.data?.forms.find((f) => f.id === c.formId)?.name,
    flow: flows.data?.flows.find((f) => f.id === c.flowId)?.name,
    template: templates.data?.templates.find((t) => t.id === c.templateId),
  };
}

/** Top tabs of the auto-reply area; only Keyword Triggers is live for now. */
function AreaTabs() {
  const tab = (icon: ReactNode, title: string, hint: string, active: boolean, tint: string) => (
    <div
      className={cn('flex items-center gap-3 rounded-xl border px-4 py-3', active ? 'border-slate-300 bg-slate-100' : 'cursor-not-allowed border-slate-200 bg-white opacity-70')}
      title={active ? undefined : 'Coming soon'}
      aria-disabled={!active}
    >
      <span className={cn('rounded-lg p-2', tint)}>{icon}</span>
      <span>
        <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          {title}
          {!active && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">Soon</span>}
        </span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
    </div>
  );
  return (
    <div className="mb-6 flex flex-wrap gap-3">
      {tab(<Zap className="size-4" />, 'Keyword Triggers', 'Reply when a keyword matches', true, 'bg-amber-50 text-amber-600')}
      {tab(<SlidersHorizontal className="size-4" />, 'Default Actions', 'Working hours & event replies', false, 'bg-sky-50 text-sky-600')}
      {tab(<Network className="size-4" />, 'Chat Distribution', 'Route chats to the right agent', false, 'bg-emerald-50 text-emerald-600')}
    </div>
  );
}

export function AutoRepliesPage() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canManage = can('flows:manage') && workspace.status !== 'suspended';
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const deferredQ = useDeferredValue(q.trim());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewing, setPreviewing] = useState<AutoReply | null>(null);
  const [trying, setTrying] = useState(false);

  const list = useQuery({
    queryKey: ['auto-replies', workspace.id, { status, deferredQ }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (deferredQ) params.set('q', deferredQ);
      return api.get<{ autoReplies: AutoReply[]; total: number }>(`/workspaces/${workspace.id}/auto-replies?${params}`);
    },
    placeholderData: (prev) => prev,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['auto-replies', workspace.id] });

  const toggle = useMutation({
    mutationFn: (r: AutoReply) => api.patch(`/workspaces/${workspace.id}/auto-replies/${r.id}/status`, { active: !r.active }),
    onSettled: () => void invalidate(),
  });
  const remove = useMutation({
    mutationFn: (r: AutoReply) => api.delete(`/workspaces/${workspace.id}/auto-replies/${r.id}`),
    onSuccess: () => void invalidate(),
  });
  const bulk = useMutation({
    mutationFn: (action: 'activate' | 'deactivate' | 'delete') =>
      api.post<{ updated: number; errors?: string[] }>(`/workspaces/${workspace.id}/auto-replies/bulk`, { ids: [...selected], action }),
    onSuccess: () => {
      setSelected(new Set());
      void invalidate();
    },
  });
  const error = toggle.error ?? remove.error ?? bulk.error;
  const rows = list.data?.autoReplies ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <>
      <AreaTabs />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Auto Reply</h1>
          <p className="mt-1 text-sm text-slate-600">
            Total: <strong>{list.data?.total ?? 0}</strong> auto replies
          </p>
          <p className="mt-0.5 max-w-xl text-sm text-slate-500">
            When more than one trigger matches, an exact match (Equals) wins over Contains, and Contains wins over event triggers (first / any message).
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setTrying(true)}>
            <FlaskConical className="size-4" /> Try a message
          </Button>
          {canManage && (
            <Button onClick={() => navigate('new')} className="bg-slate-700 hover:bg-slate-800">
              <Plus className="size-4" /> Create Keyword Trigger
            </Button>
          )}
        </div>
      </div>

      {error != null && (
        <div className="mb-3">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      )}
      {bulk.data?.errors?.length ? (
        <div className="mb-3">
          <Alert>{bulk.data.errors.join(' ')}</Alert>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-2">
        <div className="w-40">
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
        </div>
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
          <Input aria-label="Search keywords" placeholder="Search keywords..." value={q} onChange={(e) => setQ(e.target.value)} className="rounded-full pl-9" />
        </div>
      </div>

      {selected.size > 0 && canManage && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          <span className="font-medium text-slate-700">{selected.size} selected</span>
          <Button variant="secondary" onClick={() => bulk.mutate('activate')} loading={bulk.isPending && bulk.variables === 'activate'}>
            Turn on
          </Button>
          <Button variant="secondary" onClick={() => bulk.mutate('deactivate')} loading={bulk.isPending && bulk.variables === 'deactivate'}>
            Turn off
          </Button>
          <Button variant="danger" onClick={() => window.confirm(`Delete ${selected.size} auto replies?`) && bulk.mutate('delete')} loading={bulk.isPending && bulk.variables === 'delete'}>
            <Trash2 className="size-4" /> Delete
          </Button>
          <button className="ml-auto text-slate-500 hover:text-ink" onClick={() => setSelected(new Set())} aria-label="Clear selection">
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <Alert>{errorMessage(list.error)}</Alert>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Zap className="size-5" />} title={status || q ? 'No auto replies match' : 'No keyword triggers yet'}>
            {status || q ? 'Try another filter or search.' : 'Create one to answer common questions instantly, like “price list” or “timings”.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-600">
                  <th className="w-10 px-4 py-3">
                    <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} />
                  </th>
                  <th className="px-3 py-3 font-medium">Condition</th>
                  <th className="px-3 py-3 font-medium">Flow Name</th>
                  <th className="px-3 py-3 font-medium">Type</th>
                  <th className="px-3 py-3 font-medium">Created</th>
                  <th className="px-3 py-3 font-medium">Last Updated</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.name}`}
                        checked={selected.has(r.id)}
                        onChange={() => {
                          const next = new Set(selected);
                          if (next.has(r.id)) next.delete(r.id);
                          else next.add(r.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <p className="flex items-center gap-1.5 text-slate-500">
                        {r.match === 'event' ? 'On event' : 'If message'}
                        <span className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-indigo-200">{MATCH_LABEL[r.match]}</span>
                      </p>
                      <p className="mt-0.5 max-w-xs truncate font-medium text-slate-800" title={triggerText(r)}>
                        {triggerText(r)}
                      </p>
                      <p className="text-xs text-slate-400">
                        {r.firedCount ? `Fired ${r.firedCount}× · last ${formatDate(r.lastFiredAt!, true)}` : 'Not fired yet'}
                        {r.sources.length > 0 && ` · ${r.sources.map((s) => SOURCE_LABEL[s]).join(', ')}`}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-slate-700">{r.name}</td>
                    <td className="px-3 py-3">
                      <ActionPill type={r.action.type} />
                    </td>
                    <td className="px-3 py-3">
                      <p className="text-slate-700">{formatDate(r.createdAt)}</p>
                      {r.createdBy && <p className="text-xs text-slate-400">by {r.createdBy}</p>}
                    </td>
                    <td className="px-3 py-3">
                      <p className="text-slate-700">{formatDate(r.updatedAt)}</p>
                      {r.updatedBy && <p className="text-xs text-slate-400">by {r.updatedBy}</p>}
                    </td>
                    <td className="px-3 py-3">
                      <Toggle checked={r.active} disabled={!canManage || toggle.isPending} onChange={() => toggle.mutate(r)} label={`${r.active ? 'Turn off' : 'Turn on'} ${r.name}`} />
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end gap-1">
                        <button onClick={() => setPreviewing(r)} className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100" aria-label="Preview" title="Preview">
                          <Eye className="size-4" />
                        </button>
                        {canManage && (
                          <>
                            <Link to={r.id} className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100" aria-label="Edit" title="Edit">
                              <Pencil className="size-4" />
                            </Link>
                            <button
                              onClick={() => window.confirm(`Delete "${r.name}"?`) && remove.mutate(r)}
                              className="rounded-md p-1.5 text-red-500 hover:bg-red-50"
                              aria-label="Delete"
                              title="Delete"
                            >
                              <Trash2 className="size-4" />
                            </button>
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
      </div>

      {previewing && <PreviewModal rule={previewing} onClose={() => setPreviewing(null)} />}
      {trying && (
        <TryModal
          onClose={() => setTrying(false)}
          onPreview={(r) => {
            setTrying(false);
            setPreviewing(r);
          }}
        />
      )}
    </>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn('relative h-6 w-11 rounded-full transition-colors disabled:opacity-60', checked ? 'bg-emerald-500' : 'bg-slate-300')}
    >
      <span className={cn('absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')} />
    </button>
  );
}

function PreviewModal({ rule, onClose }: { rule: AutoReply; onClose: () => void }) {
  const names = useActionNames(rule.action);
  const sampleMessage = rule.match === 'event' ? (rule.event === 'first_message' ? 'Hi! 👋' : 'Hello') : (rule.keywords[0] ?? '');
  return (
    <Dialog
      icon={<MessageSquare className="size-4" />}
      title="Auto Reply Preview"
      subtitle={rule.match === 'event' ? `Event: ${EVENT_LABEL[rule.event ?? 'any_message']}` : `Keyword: ${rule.keywords.join(', ')}`}
      onClose={onClose}
    >
      <PhonePreview customerText={sampleMessage} trigger={rule.match === 'event' ? EVENT_LABEL[rule.event ?? 'any_message'] : sampleMessage} action={rule.action} names={names} />
      <p className="mt-4 flex items-center gap-2 text-xs text-slate-500">
        Reply type: <ActionPill type={rule.action.type} />
      </p>
    </Dialog>
  );
}

function TryModal({ onClose, onPreview }: { onClose: () => void; onPreview: (r: AutoReply) => void }) {
  const { workspace } = useWorkspace();
  const [kind, setKind] = useState<'typed' | 'button'>('typed');
  const [text, setText] = useState('');
  const [source, setSource] = useState<MessageSource>('direct');
  const [outsideHours, setOutsideHours] = useState(false);
  const [firstMessage, setFirstMessage] = useState(false);
  const run = useMutation({
    mutationFn: () => api.post<TryResult>(`/workspaces/${workspace.id}/auto-replies/try`, { text, source, outsideHours, firstMessage }),
  });
  const r = run.data;

  return (
    <Dialog
      icon={<FlaskConical className="size-4" />}
      title="Try a message"
      subtitle="See which trigger would answer. Nothing is sent."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => run.mutate()} loading={run.isPending} className="bg-slate-700 hover:bg-slate-800">
            Test
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="try-kind" className="mb-1.5 block text-sm font-medium text-slate-600">
            Message type
          </label>
          <Select id="try-kind" value={kind} onChange={(e) => setKind(e.target.value as 'typed' | 'button')}>
            <option value="typed">Typed message</option>
            <option value="button">Button tap (quick reply)</option>
          </Select>
        </div>
        <div>
          <label htmlFor="try-text" className="mb-1.5 block text-sm font-medium text-slate-600">
            {kind === 'button' ? 'Button title' : 'Message'}
          </label>
          <textarea
            id="try-text"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={kind === 'button' ? 'e.g. Book now' : 'e.g. price list'}
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/40 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="try-source" className="mb-1.5 block text-sm font-medium text-slate-600">
            Came from
          </label>
          <Select id="try-source" value={source} onChange={(e) => setSource(e.target.value as MessageSource)}>
            {(Object.keys(SOURCE_LABEL) as MessageSource[]).map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={outsideHours} onChange={(e) => setOutsideHours(e.target.checked)} /> Outside working hours
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={firstMessage} onChange={(e) => setFirstMessage(e.target.checked)} /> Customer's first message
        </label>
        <p className="text-xs text-slate-500">An active AI agent, a chatbot flow already running with this customer, a per-customer cooldown or a used-up monthly limit can change the result.</p>

        {run.error != null && <Alert>{errorMessage(run.error)}</Alert>}
        {r && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm" role="status">
            {r.outcome === 'auto_reply' && r.autoReply ? (
              <>
                <p className="font-medium text-ink">✅ “{r.autoReply.name}” would answer</p>
                <p className="mt-1 text-slate-600">
                  {r.matchedKeyword ? (
                    <>
                      Matched keyword <strong>{r.matchedKeyword}</strong> ({MATCH_LABEL[r.autoReply.match]})
                    </>
                  ) : (
                    <>Matched event: {EVENT_LABEL[r.autoReply.event ?? 'any_message']}</>
                  )}{' '}
                  · replies with {actionLabel(r.autoReply.action.type)}
                </p>
                <button className="mt-2 text-sm font-medium text-brand-700 hover:underline" onClick={() => onPreview(r.autoReply!)}>
                  Preview the reply →
                </button>
              </>
            ) : r.outcome === 'flow' && r.flow ? (
              <p>
                No auto reply matches. The Flow Builder flow <strong>“{r.flow.name}”</strong> would start ({r.matchedBy === 'keyword' ? 'keyword trigger' : r.matchedBy?.replace('_', ' ')}).
              </p>
            ) : r.outcome === 'ai' ? (
              <p>No trigger matches. Your AI agent would answer.</p>
            ) : (
              <p>Nothing would answer automatically. The message waits in Team Inbox.</p>
            )}
            {r.notes.map((n) => (
              <p key={n} className="mt-2 text-xs text-slate-500">
                {n}
              </p>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}


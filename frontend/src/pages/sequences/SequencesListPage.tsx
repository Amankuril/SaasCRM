import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  Check,
  Copy,
  Hand,
  ListOrdered,
  Pause,
  Pencil,
  Play,
  PencilLine,
  Presentation,
  RefreshCw,
  Rocket,
  RotateCcw,
  ShoppingCart,
  Cake,
  Users,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { relativeTime } from '../../components/crm';
import { Dialog } from '../../components/Dialog';
import { ConfirmDialog, useToast } from '../../components/feedback';
import { Button, Card, EmptyState, Field, Input, LoadError, PageHeader, Spinner, Tabs, cn, errorMessage, fieldError } from '../../components/ui';
import { api, type SequenceDetail, type SequenceSummary, type SequenceUsage, type StartingPoint } from '../../lib/api';
import { useStages, useTags } from '../../lib/hooks';
import { useWorkspace } from '../../layouts/workspaceContext';
import { StatusBadge, triggerSummary } from './shared';

const ICONS: Record<string, LucideIcon> = { rocket: Rocket, presentation: Presentation, hand: Hand, cake: Cake, rotate: RotateCcw, calendar: CalendarClock, cart: ShoppingCart };
const num = (n: number) => n.toLocaleString('en-IN');

export function SequencesListPage() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<SequenceSummary | null>(null);
  const base = `/workspaces/${workspace.id}/sequences`;
  const manage = can('sequences:manage');

  const query = useQuery({ queryKey: ['sequences', workspace.id, view], queryFn: () => api.get<{ sequences: SequenceSummary[]; usage: SequenceUsage; lastChangeAt: string | null }>(`${base}?view=${view}`) });
  const tags = useTags(workspace.id);
  const stages = useStages(workspace.id);

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' | 'archive' | 'restore' | 'duplicate' }) => api.post<{ sequence: SequenceDetail }>(`${base}/${id}/${action}`),
    onSuccess: (res, { action }) => {
      void queryClient.invalidateQueries({ queryKey: ['sequences', workspace.id] });
      setArchiving(null);
      const done = { pause: 'Sequence paused.', resume: 'Sequence resumed.', archive: 'Sequence archived. Everyone in it has left.', restore: 'Sequence restored.', duplicate: 'Copy created.' }[action];
      toast.success(done);
      if (action === 'duplicate') navigate(`/w/${workspace.id}/sequences/${res.sequence.id}`);
    },
    onError: (err) => toast.error(err),
  });

  const usage = query.data?.usage;
  const list = query.data?.sequences ?? [];

  return (
    <>
      <PageHeader
        title="Sequences"
        description="Send each contact a series of messages over time, on their own clock. It stops when they reply, reach the goal or ask to stop."
        actions={
          manage && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New sequence
            </Button>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs
          label="Sequences"
          value={view}
          onChange={setView}
          tabs={[
            { value: 'active', label: 'Active list' },
            { value: 'archived', label: 'Archived' },
          ]}
        />
        {usage && (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Users className="size-4 text-slate-400" strokeWidth={1.5} />
            <span>
              <strong className="font-semibold text-ink tabular-nums">{num(usage.used)}</strong> of {usage.limit === null ? 'unlimited' : <span className="tabular-nums">{num(usage.limit)}</span>} contacts this month
            </span>
            <button onClick={() => void query.refetch()} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Refresh">
              <RefreshCw className={cn('size-4', query.isFetching && 'animate-spin')} strokeWidth={1.5} />
            </button>
          </div>
        )}
      </div>

      {query.isPending ? (
        <Spinner />
      ) : query.error ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState icon={<ListOrdered className="size-6" strokeWidth={1.5} />} title={view === 'archived' ? 'Nothing archived' : 'No sequences yet'}>
            {view === 'archived' ? 'Archived sequences show up here and can be restored.' : 'Start from a ready-made sequence like appointment reminders or a welcome series.'}
            {view === 'active' && manage && (
              <div className="mt-4">
                <Button onClick={() => setCreating(true)}>
                  <Plus className="size-4" /> New sequence
                </Button>
              </div>
            )}
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Sequence</th>
                  <th className="px-4 py-2.5 font-medium">Joins when</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">In progress</th>
                  <th className="px-4 py-2.5 text-right font-medium">Replied</th>
                  <th className="px-4 py-2.5 text-right font-medium">Completed</th>
                  <th className="px-4 py-2.5 text-right font-medium">Stopped</th>
                  <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <Link to={`/w/${workspace.id}/sequences/${s.id}`} className="font-medium text-ink hover:underline">
                        {s.name}
                      </Link>
                      {s.published && (
                        <Link to={`/w/${workspace.id}/sequences/${s.id}/contacts`} className="ml-2 text-xs text-brand-700 hover:underline">
                          Contacts
                        </Link>
                      )}
                    </td>
                    <td className="max-w-64 truncate px-4 py-3 text-slate-600">{triggerSummary(s.trigger, { tags: tags.data, stages: stages.data })}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {num(s.counts?.inProgress ?? 0)}
                      {!!s.counts?.needsAttention && <span className="ml-1 text-xs text-amber-700" title="Needs attention">+{num(s.counts.needsAttention)}</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{num(s.counts?.replied ?? 0)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{num(s.counts?.completed ?? 0)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{num(s.counts?.stopped ?? 0)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-0.5">
                        {manage && s.status !== 'archived' && (
                          <>
                            <IconAction icon={Pencil} label="Edit" onClick={() => navigate(`/w/${workspace.id}/sequences/${s.id}`)} />
                            <IconAction icon={Copy} label="Duplicate" onClick={() => act.mutate({ id: s.id, action: 'duplicate' })} />
                            {s.status === 'active' && <IconAction icon={Pause} label="Pause" onClick={() => act.mutate({ id: s.id, action: 'pause' })} />}
                            {s.status === 'paused' && <IconAction icon={Play} label="Resume" onClick={() => act.mutate({ id: s.id, action: 'resume' })} />}
                            <IconAction icon={Archive} label="Archive" onClick={() => setArchiving(s)} />
                          </>
                        )}
                        {manage && s.status === 'archived' && <IconAction icon={ArchiveRestore} label="Restore" onClick={() => act.mutate({ id: s.id, action: 'restore' })} />}
                        {!manage && <span className="text-xs text-slate-400">View only</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-slate-200 px-4 py-2.5 text-xs text-slate-500">
            {list.length} sequence{list.length === 1 ? '' : 's'}
            {query.data?.lastChangeAt && ` · last change ${relativeTime(query.data.lastChangeAt)}`}
          </p>
        </Card>
      )}

      {creating && <NewSequenceDialog onClose={() => setCreating(false)} />}
      {archiving && (
        <ConfirmDialog title={`Archive "${archiving.name}"?`} confirmLabel="Archive" loading={act.isPending} onConfirm={() => act.mutate({ id: archiving.id, action: 'archive' })} onClose={() => setArchiving(null)}>
          Everyone still in it leaves (reason: archived) and gets no more messages. You can restore it later; it comes back paused.
        </ConfirmDialog>
      )}
    </>
  );
}

function IconAction({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label={label} title={label}>
      <Icon className="size-4" strokeWidth={1.5} />
    </button>
  );
}

function NewSequenceDialog({ onClose }: { onClose: () => void }) {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [point, setPoint] = useState<string | null>(null);
  const points = useQuery({ queryKey: ['sequence-starting-points'], queryFn: () => api.get<{ startingPoints: StartingPoint[] }>(`/workspaces/${workspace.id}/sequences/starting-points`), staleTime: Infinity });
  const create = useMutation({
    mutationFn: () => api.post<{ sequence: SequenceDetail }>(`/workspaces/${workspace.id}/sequences`, { name: name.trim() || 'Untitled sequence', startingPoint: point }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['sequences', workspace.id] });
      navigate(`/w/${workspace.id}/sequences/${res.sequence.id}`);
    },
  });
  const chosen = points.data?.startingPoints.find((p) => p.key === point) ?? null;

  return (
    <Dialog
      icon={<ListOrdered className="size-5" strokeWidth={1.5} />}
      title="New sequence"
      subtitle="Messages sent to each contact over time. Start from a ready-made one or a blank page."
      onClose={onClose}
      width="max-w-3xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.isPending} onClick={() => create.mutate()}>
            Create and continue
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {create.error != null && !fieldError(create.error, 'name') && <p className="text-sm text-red-600">{errorMessage(create.error)}</p>}
        <Field label="Name" htmlFor="seq-name" hint="Only you see this name. Your contacts never do." error={fieldError(create.error, 'name')}>
          <Input id="seq-name" autoFocus maxLength={120} placeholder="e.g. Welcome new patients" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create.mutate()} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,15rem)_1fr]">
          <div>
            <p className="mb-2 text-xs font-medium text-slate-500">Start from</p>
            <div className="space-y-1" role="listbox" aria-label="Start from">
              {(points.data?.startingPoints ?? []).map((p) => {
                const Icon = ICONS[p.icon] ?? ListOrdered;
                return <PointButton key={p.key} icon={Icon} label={p.name} selected={point === p.key} onClick={() => setPoint(p.key)} />;
              })}
              <PointButton icon={PencilLine} label="A blank sequence" selected={point === null} onClick={() => setPoint(null)} />
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            {chosen ? (
              <>
                <h3 className="font-medium text-ink">{chosen.name}</h3>
                <p className="mt-1 text-sm text-slate-600">{chosen.description}</p>
                <ul className="mt-3 space-y-1.5 text-sm text-slate-700">
                  {chosen.summary.map((line) => (
                    <li key={line} className="flex gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-brand-600" />
                      {line}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-slate-500">You pick your own approved templates for each message in the next step.</p>
              </>
            ) : (
              <>
                <h3 className="font-medium text-ink">A blank sequence</h3>
                <p className="mt-1 text-sm text-slate-600">Build it step by step: choose who joins, then add messages and waits.</p>
                <p className="mt-3 text-xs text-slate-500">Not sure where to start? The Guide tab has worked examples you can copy.</p>
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function PointButton({ icon: Icon, label, selected, onClick }: { icon: LucideIcon; label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cn('flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors', selected ? 'bg-brand-50 font-medium text-brand-800 ring-1 ring-brand-200' : 'text-slate-700 hover:bg-slate-100')}
    >
      <Icon className="size-4 shrink-0" strokeWidth={1.5} />
      <span className="flex-1">{label}</span>
      {selected && <Check className="size-4 text-brand-600" />}
    </button>
  );
}

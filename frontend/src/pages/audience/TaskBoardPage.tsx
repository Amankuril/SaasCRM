import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Check, ChevronDown, GripVertical, LayoutGrid, List, ListPlus, Plus, RefreshCw, Search, Settings2, Ticket, Trash2, UserRound, Users } from 'lucide-react';
import { useDeferredValue, useState, type ReactNode } from 'react';
import { ContactPicker, type PickedContact } from '../../components/ContactPicker';
import { STAGE_TONE } from '../../components/crm';
import { Dialog } from '../../components/Dialog';
import { Alert, Button, Input, Select, Spinner, cn, errorMessage, fieldError } from '../../components/ui';
import { api, type BoardTask, type StageColor, type TaskColumn, type TaskPriority, type TaskType } from '../../lib/api';
import { useMembers } from '../../lib/hooks';
import { useWorkspace } from '../../layouts/workspaceContext';
import { Popover, initials } from './shared';
import { timeAgo } from './PipelinePage';

const PRIORITY: Record<TaskPriority, { label: string; tone: string }> = {
  low: { label: 'Low', tone: 'bg-slate-100 text-slate-600' },
  medium: { label: 'Medium', tone: 'bg-sky-50 text-sky-700' },
  high: { label: 'High', tone: 'bg-orange-50 text-orange-700' },
  urgent: { label: 'Urgent', tone: 'bg-red-50 text-red-700' },
};

type CreatedRange = 'all' | '7' | '30' | '90';
const CREATED_LABEL: Record<CreatedRange, string> = { all: 'All time', '7': 'Last 7 days', '30': 'Last 30 days', '90': 'Last 90 days' };

function useColumns() {
  const { workspace } = useWorkspace();
  return useQuery({ queryKey: ['tasks', workspace.id, 'columns'], queryFn: () => api.get<{ columns: TaskColumn[] }>(`/workspaces/${workspace.id}/task-columns`), select: (d) => d.columns });
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Ticket / Task Board: tasks and customer tickets in columns; drag to change status. */
export function TaskBoardPage() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const editable = can('contacts:manage') && workspace.status !== 'suspended';
  const members = useMembers(workspace.id, can('members:read'));
  const columns = useColumns();
  const [view, setView] = useState<'board' | 'list'>('board');
  const [assignee, setAssignee] = useState('');
  const [created, setCreated] = useState<CreatedRange>('all');
  const [q, setQ] = useState('');
  const deferredQ = useDeferredValue(q.trim());
  const [editing, setEditing] = useState<BoardTask | 'new' | null>(null);
  const [newIn, setNewIn] = useState<string | undefined>();
  const [editingColumns, setEditingColumns] = useState(false);
  const [drag, setDrag] = useState<{ task: BoardTask } | null>(null);
  const [dropAt, setDropAt] = useState<{ status: string; beforeId: string | null } | null>(null);
  const [dragColumn, setDragColumn] = useState<string | null>(null);
  const [teamAnchor, setTeamAnchor] = useState<HTMLButtonElement | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const [rangeAnchor, setRangeAnchor] = useState<HTMLButtonElement | null>(null);
  const [rangeOpen, setRangeOpen] = useState(false);

  const params = new URLSearchParams();
  if (assignee) params.set('assignee', assignee);
  if (deferredQ) params.set('q', deferredQ);
  if (created !== 'all') params.set('from', new Date(Date.now() - Number(created) * 86_400_000).toISOString());
  const tasksKey = ['tasks', workspace.id, 'list', params.toString()];
  const tasks = useQuery({ queryKey: tasksKey, queryFn: () => api.get<{ tasks: BoardTask[] }>(`/workspaces/${workspace.id}/tasks?${params}`) });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['tasks', workspace.id] });

  const move = useMutation({
    mutationFn: (p: { task: BoardTask; status: string; orderedIds: string[] }) => api.post(`/workspaces/${workspace.id}/tasks/${p.task.id}/move`, { status: p.status, orderedIds: p.orderedIds }),
    onSettled: invalidate,
  });
  const patch = useMutation({ mutationFn: (p: { id: string; body: Record<string, unknown> }) => api.patch(`/workspaces/${workspace.id}/tasks/${p.id}`, p.body), onSettled: invalidate });
  const reorderColumns = useMutation({ mutationFn: (ids: string[]) => api.post(`/workspaces/${workspace.id}/task-columns/reorder`, { ids }), onSettled: invalidate });

  const all = tasks.data?.tasks ?? [];
  const byColumn = (key: string) => all.filter((t) => t.status === key).sort((a, b) => a.position - b.position || b.number - a.number);
  const cols = columns.data ?? [];

  const dropTask = (status: string) => {
    const target = dropAt?.status === status ? dropAt : { status, beforeId: null };
    setDropAt(null);
    if (!drag) return;
    const ids = byColumn(status)
      .map((t) => t.id)
      .filter((id) => id !== drag.task.id);
    const at = target.beforeId ? ids.indexOf(target.beforeId) : -1;
    ids.splice(at < 0 ? ids.length : at, 0, drag.task.id);
    // Show the move right away; the server confirms and renumbers.
    queryClient.setQueryData<{ tasks: BoardTask[] }>(tasksKey, (d) =>
      d ? { tasks: d.tasks.map((t) => (t.id === drag.task.id ? { ...t, status } : t)).map((t) => (t.status === status ? { ...t, position: ids.indexOf(t.id) } : t)) } : d,
    );
    move.mutate({ task: drag.task, status, orderedIds: ids });
    setDrag(null);
  };
  const dropColumn = (targetId: string) => {
    if (!dragColumn || dragColumn === targetId) return setDragColumn(null);
    const ids = cols.map((c) => c.id).filter((id) => id !== dragColumn);
    ids.splice(ids.indexOf(targetId), 0, dragColumn);
    queryClient.setQueryData(['tasks', workspace.id, 'columns'], { columns: ids.map((id, order) => ({ ...cols.find((c) => c.id === id)!, order })) });
    reorderColumns.mutate(ids);
    setDragColumn(null);
  };
  const assigneeLabel = assignee === '' ? 'All teammates' : assignee === 'me' ? 'Assigned to me' : assignee === 'unassigned' ? 'Unassigned' : (members.data?.find((m) => m.userId === assignee)?.name ?? 'Teammate');
  const error = tasks.error ?? move.error ?? patch.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-6">
        <div>
          <h1 className="text-xl font-semibold text-ink">Ticket / Task Board</h1>
          <p className="mt-0.5 text-sm text-slate-500">Manage tickets &amp; tasks together — drag to change stage, click to view details</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={invalidate} aria-label="Refresh" title="Refresh">
            <RefreshCw className={cn('size-4', tasks.isFetching && 'animate-spin')} />
          </Button>
          {editable && (
            <Button variant="secondary" onClick={() => setEditingColumns(true)} aria-label="Edit columns" title="Edit columns">
              <Settings2 className="size-4" />
            </Button>
          )}
          <Button ref={setTeamAnchor} variant="secondary" onClick={() => setTeamOpen(!teamOpen)}>
            <Users className="size-4" /> {assigneeLabel} <ChevronDown className="size-4 text-slate-400" />
          </Button>
          <Popover anchor={teamAnchor} open={teamOpen} onClose={() => setTeamOpen(false)} width={220}>
            {[
              ['', 'All teammates'],
              ['me', 'Assigned to me'],
              ['unassigned', 'Unassigned'],
              ...(members.data ?? []).map((m) => [m.userId, m.name]),
            ].map(([value, label]) => (
              <button key={value} type="button" onClick={() => (setAssignee(value!), setTeamOpen(false))} className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-slate-50">
                {label}
                {assignee === value && <Check className="ml-auto size-4" />}
              </button>
            ))}
          </Popover>
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
            {(
              [
                ['board', LayoutGrid],
                ['list', List],
              ] as const
            ).map(([v, Icon]) => (
              <button key={v} type="button" onClick={() => setView(v)} className={cn('rounded-md p-1.5', view === v ? 'bg-slate-100 text-ink' : 'text-slate-500')} aria-label={`${v} view`} title={v === 'board' ? 'Board' : 'List'}>
                <Icon className="size-4" />
              </button>
            ))}
          </div>
          {editable && (
            <Button onClick={() => (setNewIn(undefined), setEditing('new'))} className="bg-slate-700 hover:bg-slate-800">
              <ListPlus className="size-4" /> New Task
            </Button>
          )}
          <Button ref={setRangeAnchor} variant="secondary" onClick={() => setRangeOpen(!rangeOpen)}>
            <CalendarDays className="size-4 text-slate-500" /> <span className="text-slate-500">Created:</span> {CREATED_LABEL[created]} <ChevronDown className="size-4 text-slate-400" />
          </Button>
          <Popover anchor={rangeAnchor} open={rangeOpen} onClose={() => setRangeOpen(false)} width={180}>
            {(Object.keys(CREATED_LABEL) as CreatedRange[]).map((r) => (
              <button key={r} type="button" onClick={() => (setCreated(r), setRangeOpen(false))} className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-slate-50">
                {CREATED_LABEL[r]}
                {created === r && <Check className="ml-auto size-4" />}
              </button>
            ))}
          </Popover>
          <div className="relative w-56">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <Input aria-label="Search tickets and tasks" placeholder="Search tickets & tasks..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
        </div>
      </div>
      {error != null && (
        <div className="mx-4 mt-3 sm:mx-6">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      )}

      {columns.isPending || tasks.isPending ? (
        <Spinner />
      ) : view === 'board' ? (
        <div className="min-h-0 flex-1 overflow-x-auto px-4 py-4 sm:px-6">
          <div className="flex h-full items-start gap-4">
            {cols.map((col) => {
              const tone = STAGE_TONE[col.color] ?? STAGE_TONE.gray;
              const items = byColumn(col.key);
              return (
                <div key={col.id} className={cn('flex max-h-full w-72 shrink-0 flex-col', dragColumn === col.id && 'opacity-50')}>
                  {editable && (
                    <span draggable onDragStart={() => setDragColumn(col.id)} onDragEnd={() => setDragColumn(null)} className="mx-auto mb-1 cursor-grab text-slate-300 hover:text-slate-500" title="Drag to reorder" aria-label={`Reorder ${col.name}`}>
                      <GripVertical className="size-4 rotate-90" />
                    </span>
                  )}
                  <section
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (drag && dropAt?.status !== col.key) setDropAt({ status: col.key, beforeId: null });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragColumn) dropColumn(col.id);
                      else dropTask(col.key);
                    }}
                    className={cn('flex min-h-0 flex-col rounded-xl border bg-slate-50/70', dropAt?.status === col.key && drag ? 'border-slate-500 ring-2 ring-slate-300' : 'border-slate-200')}
                  >
                    <header className={cn('flex items-center gap-2 rounded-t-xl border-b border-slate-200/70 px-3 py-2.5', tone.soft)}>
                      <span className={cn('size-2 rounded-full', tone.dot)} />
                      <h2 className="flex-1 truncate text-sm font-semibold text-ink">{col.name}</h2>
                      {col.isDone && <Check className="size-3.5 text-emerald-600" aria-label="Counts as done" />}
                      <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">{items.length}</span>
                    </header>
                    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                      {items.map((t) => (
                        <TaskCard
                          key={t.id}
                          task={t}
                          editable={editable}
                          showDropLine={dropAt?.beforeId === t.id && drag?.task.id !== t.id}
                          onOpen={() => setEditing(t)}
                          onDragStart={() => setDrag({ task: t })}
                          onDragEnd={() => (setDrag(null), setDropAt(null))}
                          onDragOverCard={() => drag && setDropAt({ status: col.key, beforeId: t.id })}
                        />
                      ))}
                      {editable ? (
                        <button
                          type="button"
                          onClick={() => (setNewIn(col.key), setEditing('new'))}
                          className={cn('flex w-full flex-col items-center justify-center gap-1 rounded-lg text-sm text-slate-400 hover:bg-white/70 hover:text-slate-600', items.length ? 'py-2' : 'py-8')}
                        >
                          <span className="flex size-7 items-center justify-center rounded-full border border-slate-200 bg-white">
                            <Plus className="size-4" />
                          </span>
                          {items.length === 0 && 'No items'}
                        </button>
                      ) : (
                        items.length === 0 && <p className="py-8 text-center text-sm text-slate-400">No items</p>
                      )}
                    </div>
                  </section>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4 sm:px-6">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            {all.length === 0 ? (
              <p className="py-12 text-center text-sm text-slate-500">No tickets or tasks yet.</p>
            ) : (
              <table className="w-full min-w-[860px] text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2.5 font-medium">#</th>
                    <th className="px-3 py-2.5 font-medium">Title</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5 font-medium">Priority</th>
                    <th className="px-3 py-2.5 font-medium">Assignee</th>
                    <th className="px-3 py-2.5 font-medium">Customer</th>
                    <th className="px-3 py-2.5 font-medium">Due</th>
                    <th className="px-3 py-2.5 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {[...all]
                    .sort((a, b) => b.number - a.number)
                    .map((t) => (
                      <tr key={t.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setEditing(t)}>
                        <td className="px-3 py-2.5 text-xs text-slate-500">#{t.number}</td>
                        <td className="px-3 py-2.5">
                          <span className="font-medium text-slate-800">{t.title}</span> <TypeChip type={t.type} />
                        </td>
                        <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <Select aria-label="Status" disabled={!editable} value={t.status} onChange={(e) => patch.mutate({ id: t.id, body: { status: e.target.value } })} className="w-36 py-1 text-xs">
                            {cols.map((c) => (
                              <option key={c.key} value={c.key}>
                                {c.name}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={cn('rounded px-1.5 py-0.5 text-xs font-medium', PRIORITY[t.priority].tone)}>{PRIORITY[t.priority].label}</span>
                        </td>
                        <td className="px-3 py-2.5 text-slate-700">{t.assignee?.name ?? <span className="text-slate-400">—</span>}</td>
                        <td className="px-3 py-2.5 text-slate-700">{t.contact?.name ?? <span className="text-slate-400">—</span>}</td>
                        <td className="px-3 py-2.5">{t.dueAt ? <DueChip task={t} /> : <span className="text-slate-400">—</span>}</td>
                        <td className="px-3 py-2.5 text-xs text-slate-500">{timeAgo(t.createdAt)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {editing && <TaskDialog task={editing === 'new' ? null : editing} defaultStatus={newIn} columns={cols} onClose={() => setEditing(null)} />}
      {editingColumns && <EditColumnsDialog columns={cols} counts={Object.fromEntries(cols.map((c) => [c.key, byColumn(c.key).length]))} onClose={() => setEditingColumns(false)} />}
    </div>
  );
}

function TypeChip({ type }: { type: TaskType }) {
  return type === 'ticket' ? (
    <span className="ml-1 inline-flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-violet-700 uppercase">
      <Ticket className="size-3" /> Ticket
    </span>
  ) : (
    <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-slate-600 uppercase">Task</span>
  );
}

function DueChip({ task }: { task: BoardTask }) {
  const overdue = !task.completedAt && task.dueAt && new Date(task.dueAt).getTime() < Date.now();
  return <span className={cn('rounded px-1.5 py-0.5 text-xs', overdue ? 'bg-red-50 font-medium text-red-700' : 'bg-slate-100 text-slate-600')}>{shortDate(task.dueAt!)}</span>;
}

function TaskCard({
  task: t,
  editable,
  showDropLine,
  onOpen,
  onDragStart,
  onDragEnd,
  onDragOverCard,
}: {
  task: BoardTask;
  editable: boolean;
  showDropLine: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverCard: () => void;
}) {
  return (
    <>
      {showDropLine && <div className="h-1 rounded-full bg-slate-500" />}
      <article
        draggable={editable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDragOverCard();
        }}
        onClick={onOpen}
        className="cursor-pointer rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-slate-300 hover:shadow"
      >
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <span>#{t.number}</span>
          <TypeChip type={t.type} />
          <span className={cn('ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold', PRIORITY[t.priority].tone)}>{PRIORITY[t.priority].label}</span>
        </div>
        <p className={cn('mt-1.5 text-sm font-medium text-slate-800', t.completedAt && 'text-slate-500 line-through')}>{t.title}</p>
        {t.contact && (
          <p className="mt-1 flex items-center gap-1 truncate text-xs text-slate-500">
            <UserRound className="size-3" /> {t.contact.name}
          </p>
        )}
        <div className="mt-2.5 flex items-center justify-between">
          {t.dueAt ? <DueChip task={t} /> : <span className="text-xs text-slate-400">{timeAgo(t.createdAt)}</span>}
          {t.assignee ? (
            <span className="flex size-6 items-center justify-center rounded-full bg-slate-700 text-[10px] font-semibold text-white" title={t.assignee.name}>
              {initials(t.assignee.name)}
            </span>
          ) : (
            <span className="text-xs text-slate-400">Unassigned</span>
          )}
        </div>
      </article>
    </>
  );
}

function Field({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-600">
        {title}
      </label>
      {children}
    </div>
  );
}

const toLocalInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');

function TaskDialog({ task, defaultStatus, columns, onClose }: { task: BoardTask | null; defaultStatus?: string; columns: TaskColumn[]; onClose: () => void }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const editable = can('contacts:manage') && workspace.status !== 'suspended';
  const members = useMembers(workspace.id, can('members:read'));
  const [form, setForm] = useState({
    title: task?.title ?? '',
    description: task?.description ?? '',
    type: task?.type ?? ('task' as TaskType),
    status: task?.status ?? defaultStatus ?? columns[0]?.key ?? 'open',
    priority: task?.priority ?? ('medium' as TaskPriority),
    assigneeId: task?.assignee?.id ?? '',
    contact: (task?.contact ?? null) as PickedContact | null,
    due: toLocalInput(task?.dueAt ?? null),
  });
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['tasks', workspace.id] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: form.title,
        description: form.description,
        type: form.type,
        status: form.status,
        priority: form.priority,
        assigneeId: form.assigneeId || null,
        contactId: form.contact?.id ?? null,
        dueAt: form.due ? new Date(form.due).toISOString() : null,
      };
      return task ? api.patch(`/workspaces/${workspace.id}/tasks/${task.id}`, body) : api.post(`/workspaces/${workspace.id}/tasks`, body);
    },
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => api.delete(`/workspaces/${workspace.id}/tasks/${task!.id}`), onSuccess: done });
  const err = save.error ?? remove.error;

  return (
    <Dialog
      icon={form.type === 'ticket' ? <Ticket className="size-4" /> : <ListPlus className="size-4" />}
      title={task ? `#${task.number} ${task.type === 'ticket' ? 'Ticket' : 'Task'}` : 'New task'}
      subtitle={task ? `Created ${timeAgo(task.createdAt)}${task.createdBy ? ` by ${task.createdBy}` : ''}` : 'Track work for your team or a customer request.'}
      onClose={onClose}
      width="max-w-xl"
      footer={
        editable && (
          <>
            {task && (
              <Button variant="ghost" className="mr-auto text-red-600" onClick={() => window.confirm('Delete this task?') && remove.mutate()} loading={remove.isPending}>
                <Trash2 className="size-4" /> Delete
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} disabled={!form.title.trim()} loading={save.isPending} className="bg-slate-700 hover:bg-slate-800">
              {task ? 'Save changes' : 'Create task'}
            </Button>
          </>
        )
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (form.title.trim()) save.mutate();
        }}
      >
        {err != null && <Alert>{fieldError(err, 'title') ?? errorMessage(err)}</Alert>}
        <div className="inline-flex rounded-lg bg-slate-100 p-1 text-sm">
          {(['task', 'ticket'] as const).map((t) => (
            <button key={t} type="button" disabled={!editable} onClick={() => set({ type: t })} className={cn('rounded-md px-3 py-1', form.type === t ? 'bg-white font-medium shadow-sm' : 'text-slate-600')}>
              {t === 'task' ? 'Task' : 'Customer ticket'}
            </button>
          ))}
        </div>
        <Input aria-label="Title" autoFocus={!task} disabled={!editable} maxLength={200} placeholder="What needs to be done?" value={form.title} onChange={(e) => set({ title: e.target.value })} className="text-base font-medium" />
        <textarea
          aria-label="Description"
          disabled={!editable}
          rows={4}
          maxLength={5000}
          placeholder="Details, steps, links…"
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
          className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/40 focus:outline-none disabled:bg-slate-50"
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="t-status" title="Status">
            <Select id="t-status" disabled={!editable} value={form.status} onChange={(e) => set({ status: e.target.value })}>
              {columns.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="t-priority" title="Priority">
            <Select id="t-priority" disabled={!editable} value={form.priority} onChange={(e) => set({ priority: e.target.value as TaskPriority })}>
              {(Object.keys(PRIORITY) as TaskPriority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY[p].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="t-assignee" title="Assignee">
            <Select id="t-assignee" disabled={!editable || !members.data} value={form.assigneeId} onChange={(e) => set({ assigneeId: e.target.value })}>
              <option value="">Unassigned</option>
              {(members.data ?? [])
                .filter((m) => m.role !== 'analyst')
                .map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field id="t-due" title="Due">
            <Input id="t-due" type="datetime-local" disabled={!editable} value={form.due} onChange={(e) => set({ due: e.target.value })} />
          </Field>
        </div>
        <Field id="t-contact" title={form.type === 'ticket' ? 'Customer' : 'Customer (optional)'}>
          <ContactPicker id="t-contact" disabled={!editable} value={form.contact} onChange={(contact) => set({ contact })} />
        </Field>
      </form>
    </Dialog>
  );
}

const COLORS = Object.keys(STAGE_TONE) as StageColor[];

function EditColumnsDialog({ columns, counts, onClose }: { columns: TaskColumn[]; counts: Record<string, number>; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['tasks', workspace.id] });
  const add = useMutation({ mutationFn: () => api.post(`/workspaces/${workspace.id}/task-columns`, { name, color: COLORS[columns.length % COLORS.length] }), onSuccess: () => (setName(''), refresh()) });
  const update = useMutation({ mutationFn: (p: { id: string; body: Record<string, unknown> }) => api.patch(`/workspaces/${workspace.id}/task-columns/${p.id}`, p.body), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (p: { id: string; moveTo: string }) => api.delete(`/workspaces/${workspace.id}/task-columns/${p.id}?moveTo=${p.moveTo}`), onSuccess: refresh });
  const error = add.error ?? update.error ?? remove.error;
  return (
    <Dialog icon={<Settings2 className="size-4" />} title="Board columns" subtitle="Rename, recolour or remove columns. Drag the grip above a column on the board to reorder." onClose={onClose} width="max-w-lg">
      <div className="space-y-2">
        {error != null && <Alert>{errorMessage(error)}</Alert>}
        {columns.map((c) => (
          <ColumnRow key={c.id} column={c} columns={columns} count={counts[c.key] ?? 0} onUpdate={(body) => update.mutate({ id: c.id, body })} onDelete={(moveTo) => remove.mutate({ id: c.id, moveTo })} />
        ))}
        <form
          className="flex gap-2 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) add.mutate();
          }}
        >
          <Input aria-label="New column name" placeholder="New column, e.g. Review" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" disabled={!name.trim()} loading={add.isPending}>
            <Plus className="size-4" /> Add
          </Button>
        </form>
      </div>
    </Dialog>
  );
}

function ColumnRow({ column, columns, count, onUpdate, onDelete }: { column: TaskColumn; columns: TaskColumn[]; count: number; onUpdate: (b: Record<string, unknown>) => void; onDelete: (moveTo: string) => void }) {
  const [name, setName] = useState(column.name);
  const [deleting, setDeleting] = useState(false);
  const others = columns.filter((c) => c.key !== column.key);
  const [moveTo, setMoveTo] = useState(others[0]?.key ?? '');
  return (
    <div className="rounded-lg border border-slate-200 p-2">
      <div className="flex items-center gap-2">
        <span className={cn('size-2.5 shrink-0 rounded-full', STAGE_TONE[column.color].dot)} />
        <Input aria-label={`Column name ${column.name}`} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== column.name && onUpdate({ name: name.trim() })} className="py-1" />
        <label className="flex shrink-0 items-center gap-1 text-xs text-slate-600" title="Tasks moved here count as done">
          <input type="checkbox" checked={column.isDone} onChange={(e) => onUpdate({ isDone: e.target.checked })} /> Done
        </label>
        <button type="button" disabled={columns.length === 1} onClick={() => setDeleting(!deleting)} className="rounded p-1 text-slate-400 hover:text-red-600 disabled:opacity-30" aria-label={`Delete ${column.name}`}>
          <Trash2 className="size-4" />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1 pl-4">
        {COLORS.map((c) => (
          <button key={c} type="button" onClick={() => onUpdate({ color: c })} className={cn('size-5 rounded-full ring-offset-1', STAGE_TONE[c].dot, column.color === c && 'ring-2 ring-slate-500')} aria-label={`Colour ${c}`} />
        ))}
      </div>
      {deleting && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-red-50 p-2 text-xs text-red-800">
          Move its {count} item(s) to
          <div className="w-36">
            <Select aria-label="Move items to" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="py-1 text-xs">
              {others.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="danger" className="py-1 text-xs" onClick={() => onDelete(moveTo)}>
            Delete column
          </Button>
        </div>
      )}
    </div>
  );
}

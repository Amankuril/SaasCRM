import { useMutation, useQuery } from '@tanstack/react-query';
import { AlarmClock, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, EmptyState, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type FollowUp } from '../../lib/api';
import { useMembers } from '../../lib/hooks';
import { useWorkspace } from '../../layouts/workspaceContext';
import { FollowUpDialog, useInvalidateAudience } from './cells';

type Tab = 'overdue' | 'today' | 'upcoming' | 'done';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'done', label: 'Done' },
];

/** Every scheduled follow-up across customers, by due date. */
export function FollowUpsPage() {
  const { workspace, can } = useWorkspace();
  const editable = can('contacts:manage') && workspace.status !== 'suspended';
  const members = useMembers(workspace.id, can('members:read'));
  const invalidate = useInvalidateAudience();
  const [tab, setTab] = useState<Tab>('today');
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  const params = new URLSearchParams(tab === 'done' ? { status: 'done' } : { status: 'open', range: tab });
  if (mine) params.set('mine', 'true');
  const list = useQuery({ queryKey: ['follow-ups', workspace.id, tab, mine], queryFn: () => api.get<{ followUps: FollowUp[] }>(`/workspaces/${workspace.id}/follow-ups?${params}`) });
  const toggle = useMutation({ mutationFn: (f: FollowUp) => api.patch(`/workspaces/${workspace.id}/follow-ups/${f.id}`, { done: f.status === 'open' }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (f: FollowUp) => api.delete(`/workspaces/${workspace.id}/follow-ups/${f.id}`), onSuccess: invalidate });
  const memberName = (id: string | null) => (id ? members.data?.find((m) => m.userId === id)?.name : null);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
      <h1 className="text-xl font-semibold text-ink">Follow-ups</h1>
      <p className="mt-0.5 mb-4 text-sm text-slate-500">Reminders to get back to customers. Add them from the Follow-up column in Audience.</p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 rounded-xl bg-slate-100 p-1">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} className={cn('rounded-lg px-3 py-1.5 text-sm font-medium', tab === t.key ? 'bg-white text-ink shadow-sm' : 'text-slate-600')}>
              {t.label}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Assigned to me
        </label>
      </div>
      {(toggle.error ?? remove.error) != null && (
        <div className="mb-3">
          <Alert>{errorMessage(toggle.error ?? remove.error)}</Alert>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <Alert>{errorMessage(list.error)}</Alert>
          </div>
        ) : list.data.followUps.length === 0 ? (
          <EmptyState icon={<AlarmClock className="size-5" />} title={tab === 'overdue' ? 'Nothing overdue 🎉' : `No ${tab} follow-ups`} />
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data.followUps.map((f) => {
              const overdue = f.status === 'open' && new Date(f.dueAt).getTime() < Date.now();
              return (
                <li key={f.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <input type="checkbox" disabled={!editable} checked={f.status === 'done'} onChange={() => toggle.mutate(f)} aria-label="Done" />
                  <div className="min-w-0 flex-1">
                    <p className={cn('font-medium text-slate-800', f.status === 'done' && 'text-slate-400 line-through')}>{f.note || 'Follow up'}</p>
                    <button type="button" onClick={() => f.contact && setOpen({ id: f.contact.id, name: f.contact.name })} className="text-xs text-slate-500 hover:underline">
                      {f.contact?.name ?? 'Deleted contact'} · {f.contact?.phone}
                    </button>
                  </div>
                  <span className={cn('text-xs whitespace-nowrap', overdue ? 'font-medium text-red-600' : 'text-slate-500')}>{new Date(f.dueAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  <span className="hidden w-32 truncate text-xs text-slate-500 sm:block">{memberName(f.assigneeId) ?? 'Anyone'}</span>
                  {editable && (
                    <button onClick={() => remove.mutate(f)} className="rounded p-1 text-slate-400 hover:text-red-600" aria-label="Delete follow-up">
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {open && <FollowUpDialog contactId={open.id} contactName={open.name} onClose={() => (setOpen(null), void list.refetch())} />}
    </div>
  );
}

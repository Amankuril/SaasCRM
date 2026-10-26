import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, Check, ChevronDown, Plus, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import { TagChip } from '../../components/crm';
import { Dialog } from '../../components/Dialog';
import { Alert, Button, Input, Select, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type AudienceRow, type CustomFieldDef, type FollowUp } from '../../lib/api';
import { useMembers, useTags } from '../../lib/hooks';
import { useAuth } from '../../auth/AuthContext';
import { useWorkspace } from '../../layouts/workspaceContext';
import { Popover } from './shared';

export function useInvalidateAudience() {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['audience', workspace.id] });
    void queryClient.invalidateQueries({ queryKey: ['follow-ups', workspace.id] });
    void queryClient.invalidateQueries({ queryKey: ['contacts', workspace.id] });
  };
}

/** PATCH one contact and refresh the table. */
export function useContactPatch(contactId: string) {
  const { workspace } = useWorkspace();
  const invalidate = useInvalidateAudience();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/workspaces/${workspace.id}/contacts/${contactId}`, body),
    onSuccess: invalidate,
  });
}

export function TagsCell({ row, editable }: { row: AudienceRow; editable: boolean }) {
  const { workspace } = useWorkspace();
  const tags = useTags(workspace.id);
  const patch = useContactPatch(row.id);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const byId = new Map((tags.data ?? []).map((t) => [t.id, t]));
  const current = row.tags.map((id) => byId.get(id)).filter(Boolean);
  return (
    <div className="flex items-center gap-1 whitespace-nowrap">
      {current.slice(0, 2).map((t) => (
        <TagChip key={t!.id} tag={t!} />
      ))}
      {current.length > 2 && <span className="text-xs text-slate-400">+{current.length - 2}</span>}
      {editable && (
        <button ref={setAnchor} type="button" onClick={() => setOpen(!open)} className="rounded-full p-0.5 text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-slate-100 hover:text-ink focus:opacity-100" aria-label="Edit tags">
          <Plus className="size-3.5" />
        </button>
      )}
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={220}>
        {tags.data?.length ? (
          <div className="max-h-64 overflow-y-auto">
            {tags.data.map((t) => {
              const on = row.tags.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => patch.mutate({ tags: on ? row.tags.filter((x) => x !== t.id) : [...row.tags, t.id] })}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-slate-50"
                >
                  <TagChip tag={t} />
                  {on && <Check className="ml-auto size-4" />}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="p-2 text-xs text-slate-500">No tags yet. Create them from ⋯ → Manage tags.</p>
        )}
      </Popover>
    </div>
  );
}

export function OwnerCell({ row, editable }: { row: AudienceRow; editable: boolean }) {
  const { workspace, can } = useWorkspace();
  const members = useMembers(workspace.id, can('members:read'));
  const patch = useContactPatch(row.id);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        disabled={!editable || !members.data}
        onClick={() => setOpen(!open)}
        className={cn('inline-flex max-w-44 items-center gap-1 truncate text-left text-sm disabled:cursor-default', row.owner ? 'text-slate-700' : 'text-slate-400')}
      >
        <span className="truncate">{row.owner?.name ?? 'Unassigned'}</span>
        {editable && members.data && <ChevronDown className="size-3 shrink-0 text-slate-400" />}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={220}>
        {[{ userId: null, name: 'Unassigned' }, ...(members.data ?? []).filter((m) => m.role !== 'analyst')].map((m) => (
          <button
            key={m.userId ?? 'none'}
            type="button"
            onClick={() => {
              setOpen(false);
              patch.mutate({ ownerId: m.userId });
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-slate-50"
          >
            <UserRound className="size-3.5 text-slate-400" />
            <span className="flex-1 truncate">{m.name}</span>
            {(row.owner?.id ?? null) === m.userId && <Check className="size-4" />}
          </button>
        ))}
      </Popover>
    </>
  );
}

const dueLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `Today ${time}` : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
};

export function FollowUpCell({ row, editable }: { row: AudienceRow; editable: boolean }) {
  const [open, setOpen] = useState(false);
  const next = row.nextFollowUp;
  const overdue = next && new Date(next.dueAt).getTime() < Date.now();
  return (
    <>
      {next ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', overdue ? 'bg-red-50 text-red-700 ring-red-200' : 'bg-amber-50 text-amber-800 ring-amber-200')}
          title={next.note || undefined}
        >
          <AlarmClock className="size-3" /> {dueLabel(next.dueAt)}
          {row.openFollowUps > 1 && <span className="opacity-70">+{row.openFollowUps - 1}</span>}
        </button>
      ) : (
        <button
          type="button"
          disabled={!editable}
          onClick={() => setOpen(true)}
          className="flex size-7 items-center justify-center rounded-full border border-dashed border-slate-300 text-slate-400 hover:border-slate-400 hover:text-ink disabled:opacity-40"
          aria-label={`Add follow-up for ${row.displayName}`}
          title="Add follow-up"
        >
          <Plus className="size-3.5" />
        </button>
      )}
      {open && <FollowUpDialog contactId={row.id} contactName={row.displayName} onClose={() => setOpen(false)} />}
    </>
  );
}

function toLocalInput(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** A contact's follow-ups: schedule a new one, tick off or delete existing ones. */
export function FollowUpDialog({ contactId, contactName, onClose }: { contactId: string; contactName: string; onClose: () => void }) {
  const { workspace, can } = useWorkspace();
  const { user } = useAuth();
  const editable = can('contacts:manage') && workspace.status !== 'suspended';
  const members = useMembers(workspace.id, can('members:read'));
  const invalidate = useInvalidateAudience();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  tomorrow.setHours(10, 0, 0, 0);
  const [due, setDue] = useState(toLocalInput(tomorrow));
  const [note, setNote] = useState('');
  const [assigneeId, setAssigneeId] = useState(user?.id ?? '');
  const list = useQuery({
    queryKey: ['follow-ups', workspace.id, 'contact', contactId],
    queryFn: () => api.get<{ followUps: FollowUp[] }>(`/workspaces/${workspace.id}/follow-ups?contactId=${contactId}`),
  });
  const refresh = () => {
    invalidate();
    void list.refetch();
  };
  const create = useMutation({
    mutationFn: () => api.post(`/workspaces/${workspace.id}/follow-ups`, { contactId, dueAt: new Date(due).toISOString(), note, assigneeId: assigneeId || null }),
    onSuccess: () => {
      setNote('');
      refresh();
    },
  });
  const toggle = useMutation({ mutationFn: (f: FollowUp) => api.patch(`/workspaces/${workspace.id}/follow-ups/${f.id}`, { done: f.status === 'open' }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (f: FollowUp) => api.delete(`/workspaces/${workspace.id}/follow-ups/${f.id}`), onSuccess: refresh });
  const error = create.error ?? toggle.error ?? remove.error;
  const quick = (hours: number) => setDue(toLocalInput(new Date(Date.now() + hours * 3600_000)));

  return (
    <Dialog icon={<AlarmClock className="size-4" />} title="Follow-ups" subtitle={contactName} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        {error != null && <Alert>{errorMessage(error)}</Alert>}
        {editable && (
          <form
            className="space-y-3 rounded-xl border border-slate-200 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label="Due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="w-56" />
              {[
                ['1 hour', 1],
                ['Tomorrow', 24],
                ['3 days', 72],
                ['1 week', 168],
              ].map(([label, h]) => (
                <button key={label} type="button" onClick={() => quick(h as number)} className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50">
                  {label}
                </button>
              ))}
            </div>
            <Input aria-label="Note" placeholder="What to do, e.g. Send the price list" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex items-center gap-2">
              {members.data && (
                <div className="w-52">
                  <Select aria-label="Assign to" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                    <option value="">Anyone</option>
                    {members.data
                      .filter((m) => m.role !== 'analyst')
                      .map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.name}
                        </option>
                      ))}
                  </Select>
                </div>
              )}
              <Button type="submit" disabled={!due} loading={create.isPending} className="ml-auto bg-slate-700 hover:bg-slate-800">
                <Plus className="size-4" /> Add follow-up
              </Button>
            </div>
          </form>
        )}
        {list.isPending ? (
          <Spinner />
        ) : list.data!.followUps.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">No follow-ups yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {list.data!.followUps.map((f) => {
              const overdue = f.status === 'open' && new Date(f.dueAt).getTime() < Date.now();
              return (
                <li key={f.id} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                  <input type="checkbox" className="mt-1" disabled={!editable} checked={f.status === 'done'} onChange={() => toggle.mutate(f)} aria-label="Done" />
                  <div className="min-w-0 flex-1">
                    <p className={cn('text-slate-800', f.status === 'done' && 'text-slate-400 line-through')}>{f.note || 'Follow up'}</p>
                    <p className={cn('text-xs', overdue ? 'text-red-600' : 'text-slate-500')}>
                      {overdue ? 'Overdue · ' : ''}
                      {dueLabel(f.dueAt)}
                      {f.assigneeId && members.data ? ` · ${members.data.find((m) => m.userId === f.assigneeId)?.name ?? ''}` : ''}
                    </p>
                  </div>
                  {editable && (
                    <button type="button" onClick={() => remove.mutate(f)} className="rounded p-1 text-slate-400 hover:text-red-600" aria-label="Delete follow-up">
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** Click-to-edit value of a custom field. */
export function CustomCell({ row, field, editable }: { row: AudienceRow; field: CustomFieldDef; editable: boolean }) {
  const value = row.customFields[field.key] ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const patch = useContactPatch(row.id);
  if (editing) {
    return (
      <Input
        autoFocus
        aria-label={field.label}
        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft !== value) patch.mutate({ customFieldPatch: { [field.key]: draft || null } });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        className="w-36 py-1 text-sm"
      />
    );
  }
  return (
    <button
      type="button"
      disabled={!editable}
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      className={cn('max-w-44 truncate text-left text-sm', value ? 'text-slate-700' : 'text-slate-300')}
      title={editable ? 'Click to edit' : undefined}
    >
      {value || '—'}
    </button>
  );
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, GripVertical, Megaphone, MousePointerClick, Plus, Send, Settings2, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { STAGE_TONE } from '../../components/crm';
import { Dialog } from '../../components/Dialog';
import { Alert, Button, Input, Select, cn, errorMessage } from '../../components/ui';
import { api, type ChatSource, type PipelineStage, type StageColor } from '../../lib/api';
import { useStages } from '../../lib/hooks';
import { DIAL_CODES } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';

export const SOURCE_INFO: Record<ChatSource, { label: string; icon: typeof Send; tone: string }> = {
  broadcast: { label: 'Broadcast', icon: Send, tone: 'bg-violet-50 text-violet-700 ring-violet-200' },
  ad: { label: 'Ad', icon: MousePointerClick, tone: 'bg-sky-50 text-sky-700 ring-sky-200' },
  direct: { label: 'Direct', icon: Megaphone, tone: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
};

export function SourceBadge({ source }: { source: ChatSource }) {
  const s = SOURCE_INFO[source];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset', s.tone)}>
      <s.icon className="size-3" /> {s.label}
    </span>
  );
}

/** "+919812345678" → { iso: 'IN', digits: '919812345678' } (longest dial-code match). */
export function splitPhone(e164: string): { iso: string | null; digits: string } {
  const digits = e164.replace(/\D/g, '');
  const match = [...DIAL_CODES].sort((a, b) => b.dial.length - a.dial.length).find((c) => digits.startsWith(c.dial));
  // +1 is shared by the US and Canada; show the more common one.
  return { iso: match ? (match.dial === '1' ? 'US' : match.iso) : null, digits };
}

export function PhoneCell({ phone }: { phone: string }) {
  const { iso, digits } = splitPhone(phone);
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {iso && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 ring-1 ring-slate-200">{iso}</span>}
      <span className="font-mono text-[13px] text-slate-700">{digits}</span>
    </span>
  );
}

const AVATAR_TONES = ['bg-rose-50 text-rose-600', 'bg-violet-50 text-violet-600', 'bg-emerald-50 text-emerald-700', 'bg-sky-50 text-sky-600', 'bg-amber-50 text-amber-700', 'bg-indigo-50 text-indigo-600'];
export const avatarTone = (id: string) => AVATAR_TONES[parseInt(id.slice(-4), 16) % AVATAR_TONES.length]!;
export const initials = (name: string) =>
  name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

/** A small popover anchored to a button; rendered in a portal so table overflow never clips it. */
export function Popover({ anchor, open, onClose, children, width = 220, align = 'left' }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; children: ReactNode; width?: number; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const left = align === 'right' ? r.right - width : r.left;
      const below = r.bottom + 4;
      const height = ref.current?.offsetHeight ?? 0;
      setPos({ top: below + height > window.innerHeight - 8 && r.top > height ? r.top - height - 4 : below, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) });
    };
    place();
    const raf = requestAnimationFrame(place);
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', onClose);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('resize', onClose);
    };
  }, [open, anchor, onClose, width, align]);
  if (!open) return null;
  return createPortal(
    <div ref={ref} style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }} className="fixed z-50 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
      {children}
    </div>,
    document.body,
  );
}

/** The stage chip with its dropdown (and "Edit stages…" for managers). */
export function StageSelect({ value, onChange, disabled }: { value: string; onChange: (key: string) => void; disabled?: boolean }) {
  const { workspace, can } = useWorkspace();
  const stages = useStages(workspace.id);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const stage = stages.data?.find((s) => s.key === value);
  const tone = STAGE_TONE[stage?.color ?? 'gray'];
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className={cn('inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold tracking-wide uppercase shadow-sm disabled:cursor-default', tone.text)}
      >
        <span className={cn('size-1.5 rounded-full', tone.dot)} />
        <span className="max-w-32 truncate">{stage?.name ?? value}</span>
        {!disabled && <ChevronDown className="size-3 text-slate-400" />}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={210}>
        {(stages.data ?? []).map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => {
              setOpen(false);
              if (s.key !== value) onChange(s.key);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            <span className={cn('size-2 rounded-full', STAGE_TONE[s.color].dot)} />
            <span className="flex-1 truncate">{s.name}</span>
            {s.key === value && <Check className="size-4 text-slate-700" />}
          </button>
        ))}
        {can('contacts:manage') && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setEditing(true);
            }}
            className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-slate-100 px-2.5 py-1.5 text-left text-xs font-medium text-slate-500 hover:bg-slate-50"
          >
            <Settings2 className="size-3.5" /> Edit stages…
          </button>
        )}
      </Popover>
      {editing && <EditStagesDialog onClose={() => setEditing(false)} />}
    </>
  );
}

const COLORS = Object.keys(STAGE_TONE) as StageColor[];

/** Add, rename, recolour, reorder and delete pipeline stages. */
export function EditStagesDialog({ onClose }: { onClose: () => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const stages = useStages(workspace.id);
  const [newName, setNewName] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['pipeline-stages', workspace.id] });
    void queryClient.invalidateQueries({ queryKey: ['audience', workspace.id] });
  };
  const add = useMutation({
    mutationFn: () => api.post(`/workspaces/${workspace.id}/pipeline-stages`, { name: newName, color: COLORS[(stages.data?.length ?? 0) % COLORS.length] }),
    onSuccess: () => {
      setNewName('');
      refresh();
    },
  });
  const update = useMutation({ mutationFn: (p: { id: string; name?: string; color?: StageColor }) => api.patch(`/workspaces/${workspace.id}/pipeline-stages/${p.id}`, p), onSuccess: refresh });
  const reorder = useMutation({ mutationFn: (ids: string[]) => api.post(`/workspaces/${workspace.id}/pipeline-stages/reorder`, { ids }), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: (p: { id: string; moveTo: string }) => api.delete(`/workspaces/${workspace.id}/pipeline-stages/${p.id}?moveTo=${p.moveTo}`),
    onSuccess: refresh,
  });
  const error = add.error ?? update.error ?? reorder.error ?? remove.error;
  const list = stages.data ?? [];

  const drop = (target: PipelineStage) => {
    if (!dragId || dragId === target.id) return;
    const ids = list.map((s) => s.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(target.id), 0, dragId);
    reorder.mutate(ids);
    setDragId(null);
  };

  return (
    <Dialog icon={<Settings2 className="size-4" />} title="Edit stages" subtitle="Your sales pipeline, in order. Drag to reorder." onClose={onClose} width="max-w-lg">
      <div className="space-y-2">
        {error != null && <Alert>{errorMessage(error)}</Alert>}
        {list.map((s) => (
          <StageRow key={s.id} stage={s} stages={list} dragging={dragId === s.id} onDragStart={() => setDragId(s.id)} onDrop={() => drop(s)} onUpdate={(p) => update.mutate({ id: s.id, ...p })} onDelete={(moveTo) => remove.mutate({ id: s.id, moveTo })} />
        ))}
        <form
          className="flex gap-2 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) add.mutate();
          }}
        >
          <Input aria-label="New stage name" placeholder="New stage, e.g. Demo booked" maxLength={40} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button type="submit" disabled={!newName.trim()} loading={add.isPending}>
            <Plus className="size-4" /> Add
          </Button>
        </form>
      </div>
    </Dialog>
  );
}

function StageRow({
  stage,
  stages,
  dragging,
  onDragStart,
  onDrop,
  onUpdate,
  onDelete,
}: {
  stage: PipelineStage;
  stages: PipelineStage[];
  dragging: boolean;
  onDragStart: () => void;
  onDrop: () => void;
  onUpdate: (p: { name?: string; color?: StageColor }) => void;
  onDelete: (moveTo: string) => void;
}) {
  const [name, setName] = useState(stage.name);
  const [deleting, setDeleting] = useState(false);
  const [moveTo, setMoveTo] = useState('new');
  const entry = stage.key === 'new';
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className={cn('rounded-lg border border-slate-200 p-2', dragging && 'opacity-50')}
    >
      <div className="flex items-center gap-2">
        <GripVertical className="size-4 shrink-0 cursor-grab text-slate-400" />
        <span className={cn('size-2.5 shrink-0 rounded-full', STAGE_TONE[stage.color].dot)} />
        <Input
          aria-label={`Stage name ${stage.name}`}
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== stage.name && onUpdate({ name: name.trim() })}
          className="py-1"
        />
        <span className="w-10 shrink-0 text-right text-xs text-slate-400">{stage.count ?? ''}</span>
        <button
          type="button"
          onClick={() => setDeleting(!deleting)}
          disabled={entry}
          title={entry ? 'New contacts start here, so it can’t be deleted' : 'Delete stage'}
          className="rounded p-1 text-slate-400 hover:text-red-600 disabled:opacity-30"
          aria-label={`Delete ${stage.name}`}
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1 pl-6">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onUpdate({ color: c })}
            className={cn('size-5 rounded-full ring-offset-1', STAGE_TONE[c].dot, stage.color === c && 'ring-2 ring-slate-500')}
            aria-label={`Colour ${c}`}
          />
        ))}
      </div>
      {deleting && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-red-50 p-2 pl-6 text-xs text-red-800">
          Move its {stage.count ?? 0} contact(s) to
          <div className="w-40">
            <Select aria-label="Move contacts to" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="py-1 text-xs">
              {stages
                .filter((s) => s.key !== stage.key)
                .map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
            </Select>
          </div>
          <Button variant="danger" className="py-1 text-xs" onClick={() => onDelete(moveTo)}>
            Delete stage
          </Button>
          <button type="button" onClick={() => setDeleting(false)} aria-label="Cancel" className="ml-auto">
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Columns ----

export type ColumnId = 'customer' | 'phone' | 'source' | 'campaign' | 'stage' | 'tags' | 'followUp' | 'owner' | 'email' | 'lists' | 'added' | 'lastMessage' | 'subscription' | `custom:${string}`;

export const BASE_COLUMNS: { id: ColumnId; label: string; visible: boolean; locked?: boolean }[] = [
  { id: 'customer', label: 'Customer', visible: true, locked: true },
  { id: 'phone', label: 'Phone Number', visible: true },
  { id: 'source', label: 'Chat Source', visible: true },
  { id: 'campaign', label: 'Campaign Name', visible: true },
  { id: 'stage', label: 'Stage', visible: true },
  { id: 'tags', label: 'Tags', visible: true },
  { id: 'followUp', label: 'Follow-up', visible: true },
  { id: 'owner', label: 'Assigned To', visible: true },
  { id: 'email', label: 'Email', visible: false },
  { id: 'lists', label: 'Lists', visible: false },
  { id: 'subscription', label: 'Subscription', visible: false },
  { id: 'lastMessage', label: 'Last Message', visible: false },
  { id: 'added', label: 'Added On', visible: false },
];

export interface ColumnState {
  id: ColumnId;
  visible: boolean;
}

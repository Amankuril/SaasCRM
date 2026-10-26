import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, CalendarDays, Check, ChevronDown, Columns3, Eye, EyeOff, GripVertical, Plus, SlidersHorizontal, Trash2, UserPlus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { STAGE_TONE } from '../../components/crm';
import { Dialog } from '../../components/Dialog';
import { Alert, Button, Input, Select, cn, errorMessage, fieldError } from '../../components/ui';
import { api, type AudienceQuery, type Campaign, type ChatSource, type ConsentStatus, type Contact, type ContactList, type CustomFieldDef, type Segment } from '../../lib/api';
import { useMembers, useStages, useTags } from '../../lib/hooks';
import { DIAL_CODES } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { BASE_COLUMNS, Popover, SOURCE_INFO, type ColumnState } from './shared';

export type AudienceFilters = Omit<AudienceQuery, 'page' | 'limit' | 'sort' | 'dir'> & { addedPreset: AddedPreset };
export type AddedPreset = 'all' | 'today' | 'yesterday' | '7' | '30' | '90' | 'custom';

export const EMPTY_FILTERS: AudienceFilters = { filter: {}, addedPreset: 'all' };

/** How many filter groups are active (shown on the Filters button). */
export function activeFilterCount(f: AudienceFilters): number {
  const x = f.filter;
  return [x.stages?.length, x.tagsAny?.length, x.excludeTags?.length, x.sources?.length, x.campaignIds?.length, (x.ownerIds?.length ?? 0) + (x.unassigned ? 1 : 0), x.listsAny?.length, f.followUp, f.consent].filter(Boolean)
    .length;
}

const toggle = <T,>(list: T[] | undefined, v: T) => ((list ?? []).includes(v) ? (list ?? []).filter((x) => x !== v) : [...(list ?? []), v]);

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs', on ? 'border-slate-700 bg-slate-700 text-white' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}>
      {children}
    </button>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

/** Right-hand drawer with every filter; changes apply live. */
export function FiltersDrawer({ value, onChange, onClose }: { value: AudienceFilters; onChange: (f: AudienceFilters) => void; onClose: () => void }) {
  const { workspace, can } = useWorkspace();
  const stages = useStages(workspace.id);
  const tags = useTags(workspace.id);
  const members = useMembers(workspace.id, can('members:read'));
  const lists = useQuery({ queryKey: ['contact-lists', workspace.id, ''], queryFn: () => api.get<{ lists: ContactList[] }>(`/workspaces/${workspace.id}/contact-lists`) });
  const campaigns = useQuery({ queryKey: ['campaigns', workspace.id], queryFn: () => api.get<{ campaigns: Campaign[] }>(`/workspaces/${workspace.id}/campaigns`) });
  const f = value.filter;
  const setF = (patch: Partial<AudienceFilters['filter']>) => onChange({ ...value, filter: { ...f, ...patch } });

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/20" onClick={onClose}>
      <aside className="animate-slide-in-right flex h-full w-full max-w-sm flex-col bg-white shadow-xl" onClick={(e) => e.stopPropagation()} aria-label="Filters">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <p className="flex items-center gap-2 font-semibold text-ink">
            <SlidersHorizontal className="size-4" /> Filters
          </p>
          <button onClick={onClose} className="rounded-full p-1 text-slate-500 hover:bg-slate-100" aria-label="Close filters">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <Group title="Stage">
            {(stages.data ?? []).map((s) => (
              <Chip key={s.key} on={!!f.stages?.includes(s.key)} onClick={() => setF({ stages: toggle(f.stages, s.key) })}>
                <span className={cn('size-1.5 rounded-full', STAGE_TONE[s.color].dot)} /> {s.name}
              </Chip>
            ))}
          </Group>
          <Group title="Chat source">
            {(Object.keys(SOURCE_INFO) as ChatSource[]).map((s) => (
              <Chip key={s} on={!!f.sources?.includes(s)} onClick={() => setF({ sources: toggle(f.sources, s) })}>
                {SOURCE_INFO[s].label}
              </Chip>
            ))}
            <Chip on={!!f.sources?.includes('none')} onClick={() => setF({ sources: toggle(f.sources, 'none' as const) })}>
              Unknown
            </Chip>
          </Group>
          {(campaigns.data?.campaigns ?? []).some((c) => c.status !== 'draft') && (
            <Group title="Campaign">
              {campaigns
                .data!.campaigns.filter((c) => c.status !== 'draft')
                .map((c) => (
                  <Chip key={c.id} on={!!f.campaignIds?.includes(c.id)} onClick={() => setF({ campaignIds: toggle(f.campaignIds, c.id) })}>
                    {c.name}
                  </Chip>
                ))}
            </Group>
          )}
          {tags.data && tags.data.length > 0 && (
            <>
              <Group title="Has any of these tags">
                {tags.data.map((t) => (
                  <Chip key={t.id} on={!!f.tagsAny?.includes(t.id)} onClick={() => setF({ tagsAny: toggle(f.tagsAny, t.id) })}>
                    {t.name}
                  </Chip>
                ))}
              </Group>
              <Group title="Exclude tags">
                {tags.data.map((t) => (
                  <Chip key={t.id} on={!!f.excludeTags?.includes(t.id)} onClick={() => setF({ excludeTags: toggle(f.excludeTags, t.id) })}>
                    {t.name}
                  </Chip>
                ))}
              </Group>
            </>
          )}
          {members.data && (
            <Group title="Assigned to">
              <Chip on={!!f.unassigned} onClick={() => setF({ unassigned: !f.unassigned })}>
                Unassigned
              </Chip>
              {members.data
                .filter((m) => m.role !== 'analyst')
                .map((m) => (
                  <Chip key={m.userId} on={!!f.ownerIds?.includes(m.userId)} onClick={() => setF({ ownerIds: toggle(f.ownerIds, m.userId) })}>
                    {m.name}
                  </Chip>
                ))}
            </Group>
          )}
          {lists.data && lists.data.lists.length > 0 && (
            <Group title="In contact list">
              {lists.data.lists.map((l) => (
                <Chip key={l.id} on={!!f.listsAny?.includes(l.id)} onClick={() => setF({ listsAny: toggle(f.listsAny, l.id) })}>
                  {l.name}
                </Chip>
              ))}
            </Group>
          )}
          <Group title="Follow-up">
            {(
              [
                ['any', 'Has follow-up'],
                ['overdue', 'Overdue'],
                ['today', 'Due today'],
                ['upcoming', 'Upcoming'],
                ['none', 'None'],
              ] as const
            ).map(([v, label]) => (
              <Chip key={v} on={value.followUp === v} onClick={() => onChange({ ...value, followUp: value.followUp === v ? undefined : v })}>
                {label}
              </Chip>
            ))}
          </Group>
          <Group title="Broadcast subscription">
            {(
              [
                ['unknown', 'Subscribed'],
                ['opted_in', 'Opted in'],
                ['opted_out', 'Unsubscribed'],
              ] as [ConsentStatus, string][]
            ).map(([v, label]) => (
              <Chip key={v} on={value.consent === v} onClick={() => onChange({ ...value, consent: value.consent === v ? undefined : v })}>
                {label}
              </Chip>
            ))}
          </Group>
        </div>
        <div className="flex justify-between border-t border-slate-200 px-5 py-3">
          <Button variant="ghost" onClick={() => onChange({ ...EMPTY_FILTERS, q: value.q, addedPreset: value.addedPreset, addedFrom: value.addedFrom, addedTo: value.addedTo })}>
            Clear all
          </Button>
          <Button onClick={onClose} className="bg-slate-700 hover:bg-slate-800">
            Done
          </Button>
        </div>
      </aside>
    </div>
  );
}

const ADDED_LABEL: Record<AddedPreset, string> = { all: 'All time', today: 'Today', yesterday: 'Yesterday', '7': 'Last 7 days', '30': 'Last 30 days', '90': 'Last 90 days', custom: 'Custom range' };

/** Turns a preset into the created-at range the API understands. */
export function addedRange(preset: AddedPreset, from?: string, to?: string): { addedFrom?: string; addedTo?: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  switch (preset) {
    case 'today':
      return { addedFrom: start.toISOString() };
    case 'yesterday':
      return { addedFrom: new Date(start.getTime() - day).toISOString(), addedTo: new Date(start.getTime() - 1).toISOString() };
    case '7':
    case '30':
    case '90':
      return { addedFrom: new Date(Date.now() - Number(preset) * day).toISOString() };
    case 'custom':
      return { addedFrom: from, addedTo: to };
    default:
      return {};
  }
}

export function AddedMenu({ value, onChange }: { value: AudienceFilters; onChange: (f: AudienceFilters) => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value.addedFrom?.slice(0, 10) ?? '');
  const [to, setTo] = useState(value.addedTo?.slice(0, 10) ?? '');
  const pick = (preset: AddedPreset) => {
    onChange({ ...value, addedPreset: preset, ...addedRange(preset) });
    if (preset !== 'custom') setOpen(false);
  };
  return (
    <>
      <Button ref={setAnchor} variant="secondary" onClick={() => setOpen(!open)}>
        <CalendarDays className="size-4 text-slate-500" /> <span className="text-slate-500">Added:</span> {value.addedPreset === 'custom' && value.addedFrom ? `${from} → ${to || 'now'}` : ADDED_LABEL[value.addedPreset]}
        <ChevronDown className="size-4 text-slate-400" />
      </Button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={240}>
        {(Object.keys(ADDED_LABEL) as AddedPreset[]).map((p) => (
          <button key={p} type="button" onClick={() => pick(p)} className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-slate-50">
            {ADDED_LABEL[p]}
            {value.addedPreset === p && <Check className="ml-auto size-4" />}
          </button>
        ))}
        {value.addedPreset === 'custom' && (
          <div className="space-y-2 border-t border-slate-100 p-2">
            <Input aria-label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <Input aria-label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            <Button
              className="w-full"
              disabled={!from}
              onClick={() => {
                onChange({ ...value, addedPreset: 'custom', ...addedRange('custom', new Date(`${from}T00:00:00`).toISOString(), to ? new Date(`${to}T23:59:59`).toISOString() : undefined) });
                setOpen(false);
              }}
            >
              Apply
            </Button>
          </div>
        )}
      </Popover>
    </>
  );
}

/** Show/hide and reorder columns, and manage custom-field columns. */
export function ColumnsMenu({ columns, onChange, fields }: { columns: ColumnState[]; onChange: (c: ColumnState[]) => void; fields: CustomFieldDef[] }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<CustomFieldDef['type']>('text');
  const addField = useMutation({
    mutationFn: () => api.post<{ field: CustomFieldDef }>(`/workspaces/${workspace.id}/custom-fields`, { label, type }),
    onSuccess: ({ field }) => {
      setLabel('');
      onChange([...columns, { id: `custom:${field.key}`, visible: true }]);
      void queryClient.invalidateQueries({ queryKey: ['custom-fields', workspace.id] });
    },
  });
  const removeField = useMutation({
    mutationFn: (f: CustomFieldDef) => api.delete(`/workspaces/${workspace.id}/custom-fields/${f.id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['custom-fields', workspace.id] }),
  });
  const labelOf = (id: string) => BASE_COLUMNS.find((c) => c.id === id)?.label ?? fields.find((f) => `custom:${f.key}` === id)?.label ?? id;
  const drop = (target: string) => {
    if (!dragId || dragId === target) return;
    const next = columns.filter((c) => c.id !== dragId);
    next.splice(
      next.findIndex((c) => c.id === target),
      0,
      columns.find((c) => c.id === dragId)!,
    );
    onChange(next);
    setDragId(null);
  };

  return (
    <>
      <Button ref={setAnchor} variant="secondary" onClick={() => setOpen(!open)}>
        <Columns3 className="size-4" /> Columns
      </Button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={280} align="right">
        <p className="px-2.5 pt-1.5 pb-1 text-xs font-semibold text-slate-500">Drag to reorder · click the eye to show or hide</p>
        <div className="max-h-80 overflow-y-auto">
          {columns.map((c) => {
            const locked = BASE_COLUMNS.find((b) => b.id === c.id)?.locked;
            const field = fields.find((f) => `custom:${f.key}` === c.id);
            return (
              <div
                key={c.id}
                draggable
                onDragStart={() => setDragId(c.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => drop(c.id)}
                className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50', dragId === c.id && 'opacity-50')}
              >
                <GripVertical className="size-4 cursor-grab text-slate-400" />
                <span className={cn('flex-1 truncate', !c.visible && 'text-slate-400')}>
                  {labelOf(c.id)}
                  {field && <span className="ml-1 text-[10px] text-slate-400 uppercase">{field.type}</span>}
                </span>
                {field && can('contacts:manage') && (
                  <button
                    type="button"
                    onClick={() => window.confirm(`Remove the "${field.label}" column? Values stay on contacts.`) && removeField.mutate(field)}
                    className="rounded p-0.5 text-slate-400 hover:text-red-600"
                    aria-label={`Remove ${field.label}`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => onChange(columns.map((x) => (x.id === c.id ? { ...x, visible: !x.visible } : x)))}
                  className="rounded p-0.5 text-slate-500 hover:text-ink disabled:opacity-30"
                  aria-label={`${c.visible ? 'Hide' : 'Show'} ${labelOf(c.id)}`}
                >
                  {c.visible ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                </button>
              </div>
            );
          })}
        </div>
        {can('contacts:manage') && (
          <form
            className="mt-1 space-y-2 border-t border-slate-100 p-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (label.trim()) addField.mutate();
            }}
          >
            <p className="text-xs font-semibold text-slate-500">Add a custom column</p>
            <div className="flex gap-1.5">
              <Input aria-label="Column name" placeholder="e.g. City" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} className="py-1 text-sm" />
              <div className="w-24 shrink-0">
                <Select aria-label="Column type" value={type} onChange={(e) => setType(e.target.value as CustomFieldDef['type'])} className="py-1 text-sm">
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="date">Date</option>
                </Select>
              </div>
            </div>
            {addField.error != null && <p className="text-xs text-red-600">{errorMessage(addField.error)}</p>}
            <Button type="submit" className="w-full py-1.5" disabled={!label.trim()} loading={addField.isPending}>
              <Plus className="size-4" /> Add column
            </Button>
          </form>
        )}
      </Popover>
    </>
  );
}

/** Saves the current filters as a reusable segment (also usable as a campaign audience). */
export function CreateSegmentDialog({ value, onClose, onSaved }: { value: AudienceFilters; onClose: () => void; onSaved: (s: Segment) => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const days = ['7', '30', '90'].includes(value.addedPreset) ? Number(value.addedPreset) : null;
  const unsaved = [value.q && 'search text', value.followUp && 'follow-up', value.consent && 'subscription', ['today', 'yesterday', 'custom'].includes(value.addedPreset) && 'fixed date range'].filter(Boolean);
  const save = useMutation({
    mutationFn: () =>
      api.post<{ segment: Segment }>(`/workspaces/${workspace.id}/segments`, {
        name,
        filter: { tagsAny: [], excludeTags: [], stages: [], requireOptIn: false, ...value.filter, addedWithinDays: days },
      }),
    onSuccess: ({ segment }) => {
      void queryClient.invalidateQueries({ queryKey: ['segments', workspace.id] });
      onSaved(segment);
      onClose();
    },
  });
  return (
    <Dialog
      icon={<Bookmark className="size-4" />}
      title="Create Segment"
      subtitle="Save these filters to reuse them here and as a campaign audience."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim()} loading={save.isPending} className="bg-slate-700 hover:bg-slate-800">
            Save segment
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <Input aria-label="Segment name" autoFocus maxLength={80} placeholder="e.g. Hot leads from Indore broadcast" value={name} onChange={(e) => setName(e.target.value)} />
        {save.error != null && <Alert>{fieldError(save.error, 'name') ?? errorMessage(save.error)}</Alert>}
        <p className="text-xs text-slate-500">
          {activeFilterCount(value) || days ? `${activeFilterCount(value) + (days ? 1 : 0)} filter(s) will be saved.` : 'No filters are applied — the segment will include everyone.'}
          {unsaved.length > 0 && ` Not saved in segments: ${unsaved.join(', ')}.`}
        </p>
      </form>
    </Dialog>
  );
}

export function AddCustomerDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Contact) => void }) {
  const { workspace } = useWorkspace();
  const stages = useStages(workspace.id);
  const [country, setCountry] = useState(DIAL_CODES.some((c) => c.iso === workspace.country) ? workspace.country : 'IN');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [stage, setStage] = useState('new');
  const dial = DIAL_CODES.find((c) => c.iso === country)?.dial ?? '';
  const create = useMutation({
    mutationFn: () =>
      api.post<{ contact: Contact }>(`/workspaces/${workspace.id}/contacts`, {
        phone: phone.trim().startsWith('+') ? phone : `+${dial}${phone.replace(/\D/g, '').replace(/^0+/, '')}`,
        name: name || null,
        email,
        lifecycleStage: stage,
      }),
    onSuccess: ({ contact }) => {
      onCreated(contact);
      onClose();
    },
  });
  const err = create.error;
  const label = 'mb-1.5 block text-sm font-medium text-slate-600';
  return (
    <Dialog
      icon={<UserPlus className="size-4" />}
      title="Add Customer"
      subtitle="Adds a contact to your audience."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!phone.trim()} loading={create.isPending} className="bg-slate-700 hover:bg-slate-800">
            Save Customer
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {err != null && !fieldError(err, 'phone') && !fieldError(err, 'email') && <Alert>{errorMessage(err)}</Alert>}
        <div className="grid gap-3 sm:grid-cols-[11rem_1fr]">
          <div>
            <label htmlFor="ac-country" className={label}>
              Country code
            </label>
            <Select id="ac-country" value={country} onChange={(e) => setCountry(e.target.value)}>
              {DIAL_CODES.map((c) => (
                <option key={c.iso} value={c.iso}>
                  {c.iso} (+{c.dial})
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="ac-phone" className={label}>
              WhatsApp number
            </label>
            <Input id="ac-phone" type="tel" placeholder="9876543210" value={phone} onChange={(e) => setPhone(e.target.value)} invalid={!!fieldError(err, 'phone')} />
            {fieldError(err, 'phone') && <p className="mt-1 text-xs text-red-600">{fieldError(err, 'phone')}</p>}
          </div>
        </div>
        <div>
          <label htmlFor="ac-name" className={label}>
            Customer name
          </label>
          <Input id="ac-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="ac-email" className={label}>
              Email (optional)
            </label>
            <Input id="ac-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} invalid={!!fieldError(err, 'email')} />
          </div>
          <div>
            <label htmlFor="ac-stage" className={label}>
              Stage
            </label>
            <Select id="ac-stage" value={stage} onChange={(e) => setStage(e.target.value)}>
              {(stages.data ?? []).map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

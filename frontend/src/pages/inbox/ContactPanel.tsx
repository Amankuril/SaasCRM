import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  History,
  Info,
  Phone,
  PhoneCall,
  Plus,
  Route,
  StickyNote,
  Tag as TagIcon,
  Ticket,
  TrendingUp,
  UserPlus,
  UserRound,
  UserRoundCog,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ContactDetails } from '../../components/ContactDetails';
import { Dialog } from '../../components/Dialog';
import { STAGE_TONE, TagChip, initials } from '../../components/crm';
import { Alert, Button, Input, Select, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type BoardTask, type Contact, type ContactJourney, type ConversationSummary, type FollowUp, type TimelineItem } from '../../lib/api';
import { useStages, useTags } from '../../lib/hooks';
import { useAuth } from '../../auth/AuthContext';
import { useWorkspace } from '../../layouts/workspaceContext';
import { Popover } from '../audience/shared';
import { useTeam } from './shared';

type Update = (body: Record<string, unknown>) => void;

const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'border-sky-200 bg-sky-50 text-sky-700' },
  pending: { label: 'Pending', cls: 'border-amber-200 bg-amber-50 text-amber-700' },
  resolved: { label: 'Resolved', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
};

export function StatusPill({ status }: { status: string }) {
  const s = STATUS_PILL[status] ?? STATUS_PILL.open!;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium', s.cls)}>
      {status === 'resolved' ? <Check className="size-3" /> : <CircleDashed className="size-3" />} {s.label}
    </span>
  );
}

/** "+91 98765 43210" with a flag for Indian numbers. */
export function prettyPhone(e164: string) {
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `🇮🇳 +91 ${m[1]} ${m[2]}` : e164;
}

/** Right-hand "Contact Info" card: quick actions, and every detail about the customer. */
export function ContactPanel({ conv, contact, writable, onUpdate, onClose }: { conv: ConversationSummary; contact: Contact; writable: boolean; onUpdate: Update; onClose: () => void }) {
  const [tab, setTab] = useState<'actions' | 'details'>('actions');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-5 pt-5 pb-3">
        <h2 className="font-semibold text-ink">Contact Info</h2>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close contact info">
          <X className="size-5" />
        </button>
      </div>
      <div className="mx-4 mb-3 grid grid-cols-2 rounded-xl bg-slate-100 p-1 text-sm">
        {(['actions', 'details'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={cn('rounded-lg py-1.5 font-medium capitalize', tab === t ? 'bg-white text-ink shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
            {t}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
        {tab === 'actions' ? <ActionsTab conv={conv} contact={contact} writable={writable} onUpdate={onUpdate} /> : <DetailsTab conv={conv} contact={contact} />}
      </div>
    </div>
  );
}

// ---- Actions tab ----

function useContactSave(contactId: string) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/workspaces/${workspace.id}/contacts/${contactId}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['contact-journey', workspace.id, contactId] });
      void queryClient.invalidateQueries({ queryKey: ['contacts', workspace.id] });
    },
  });
}

function StageSelect({ contact, disabled, className }: { contact: Contact; disabled: boolean; className?: string }) {
  const { workspace } = useWorkspace();
  const stages = useStages(workspace.id);
  const save = useContactSave(contact.id);
  const current = stages.data?.find((s) => s.key === contact.lifecycleStage);
  const dot = STAGE_TONE[current?.color ?? 'gray']?.dot ?? 'bg-slate-400';
  return (
    <div className={cn('relative', className)}>
      <span className={cn('pointer-events-none absolute top-1/2 left-3 size-2 -translate-y-1/2 rounded-full', dot)} />
      <Select aria-label="Lifecycle stage" value={contact.lifecycleStage} disabled={disabled || save.isPending} onChange={(e) => save.mutate({ lifecycleStage: e.target.value })} className="pl-7">
        {(stages.data ?? []).map((s) => (
          <option key={s.key} value={s.key}>
            {s.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

function ActionsTab({ conv, contact, writable, onUpdate }: { conv: ConversationSummary; contact: Contact; writable: boolean; onUpdate: Update }) {
  const { can } = useWorkspace();
  const { user } = useAuth();
  const team = useTeam();
  const [assignAnchor, setAssignAnchor] = useState<HTMLElement | null>(null);
  const [dialog, setDialog] = useState<'ticket' | 'followup' | null>(null);
  const canAssignOthers = can('conversations:assign');
  const name = conv.contact?.name ?? contact.displayName;

  const assignTo = (assigneeId: string | null) => {
    setAssignAnchor(null);
    onUpdate({ assigneeId });
  };

  return (
    <>
      <section className="rounded-2xl border border-slate-200">
        <div className="flex items-center gap-3 p-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-emerald-100 font-semibold text-emerald-700">{initials(name)}</span>
          <div className="min-w-0">
            <p className="truncate font-semibold text-ink" title={name}>
              {name}
            </p>
            <p className="truncate text-sm text-slate-600">{prettyPhone(contact.phone)}</p>
            <div className="mt-1">
              <StatusPill status={conv.status} />
            </div>
          </div>
        </div>
        <div className="space-y-2.5 border-t border-slate-100 p-4">
          <div className="flex gap-2">
            <StageSelect contact={contact} disabled={!can('contacts:manage')} className="min-w-0 flex-1" />
            {writable &&
              (conv.status === 'resolved' ? (
                <Button variant="secondary" onClick={() => onUpdate({ status: 'open' })}>
                  Reopen
                </Button>
              ) : (
                <button type="button" onClick={() => onUpdate({ status: 'resolved' })} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-100">
                  <Check className="size-4" /> Resolve
                </button>
              ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <ActionTile icon={<UserPlus className="size-4" />} label="Assign Chat" disabled={!writable} onClick={(el) => setAssignAnchor(el)} />
            <ActionTile icon={<Ticket className="size-4" />} label="Create Ticket" disabled={!can('contacts:manage')} onClick={() => setDialog('ticket')} />
            <ActionTile icon={<CalendarClock className="size-4" />} label="Follow-up" disabled={!can('contacts:manage')} onClick={() => setDialog('followup')} />
          </div>
          <div className="flex justify-center">
            <span className="inline-flex cursor-not-allowed items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700" title="WhatsApp calling is coming soon">
              <PhoneCall className="size-3.5" /> Enable calling · soon
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3 border-t border-slate-100 p-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sky-100 text-xs font-semibold text-sky-700">{conv.assignee ? initials(conv.assignee.name) : <UserRound className="size-4" />}</span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Assigned to</p>
            <p className="truncate text-sm font-semibold text-ink">{conv.assignee?.name ?? 'Nobody yet'}</p>
          </div>
          {writable && (
            <button type="button" onClick={(e) => setAssignAnchor(e.currentTarget)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <UserRoundCog className="size-3.5" /> {conv.assignee ? 'Reassign' : 'Assign'}
            </button>
          )}
        </div>
      </section>

      <AiCard conv={conv} writable={writable} onUpdate={onUpdate} />

      <Popover anchor={assignAnchor} open={!!assignAnchor} onClose={() => setAssignAnchor(null)} width={230} align="right">
        <div className="max-h-72 overflow-y-auto p-1 text-sm">
          {canAssignOthers ? (
            <>
              <button type="button" className="block w-full rounded-md px-3 py-2 text-left text-slate-600 hover:bg-slate-50" onClick={() => assignTo(null)}>
                Unassigned
              </button>
              {team.data?.map((m) => (
                <button key={m.id} type="button" className={cn('flex w-full items-center justify-between rounded-md px-3 py-2 text-left hover:bg-slate-50', conv.assignee?.id === m.id && 'font-semibold')} onClick={() => assignTo(m.id)}>
                  <span className="truncate">{m.name}</span>
                  {conv.assignee?.id === m.id && <Check className="size-4 text-brand-600" />}
                </button>
              ))}
            </>
          ) : conv.assignee?.id === user?.id ? (
            <button type="button" className="block w-full rounded-md px-3 py-2 text-left hover:bg-slate-50" onClick={() => assignTo(null)}>
              Unassign me
            </button>
          ) : (
            <button type="button" disabled={!!conv.assignee} className="block w-full rounded-md px-3 py-2 text-left hover:bg-slate-50 disabled:text-slate-400" onClick={() => assignTo(user!.id)}>
              {conv.assignee ? 'Only managers can reassign' : 'Assign to me'}
            </button>
          )}
        </div>
      </Popover>
      {dialog === 'ticket' && <TicketDialog contact={contact} onClose={() => setDialog(null)} />}
      {dialog === 'followup' && <FollowUpDialog contact={contact} onClose={() => setDialog(null)} />}
    </>
  );
}

function ActionTile({ icon, label, disabled, onClick }: { icon: ReactNode; label: string; disabled?: boolean; onClick: (el: HTMLElement) => void }) {
  return (
    <button type="button" disabled={disabled} onClick={(e) => onClick(e.currentTarget)} className="flex flex-col items-center gap-1 rounded-xl border border-slate-200 px-1 py-2.5 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50">
      <span className="text-slate-500">{icon}</span>
      <span className="text-center leading-tight">{label}</span>
    </button>
  );
}

const AI_MODES = [
  { key: 'auto', label: 'Auto', hint: 'AI handles conversations fully' },
  { key: 'copilot', label: 'Copilot', hint: 'AI only suggests replies for your team' },
  { key: 'off', label: 'Off', hint: 'No AI in this chat' },
] as const;

function AiCard({ conv, writable, onUpdate }: { conv: ConversationSummary; writable: boolean; onUpdate: Update }) {
  const mode = AI_MODES.find((m) => m.key === conv.aiMode) ?? AI_MODES[0];
  const paused = conv.botPaused && conv.aiMode === 'auto';
  return (
    <section className="rounded-2xl border border-slate-200 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Bot className="size-4 text-slate-500" />
        <span className="font-semibold text-ink">AI Agent</span>
        <span title="Your workspace's AI agent (set it up in AI Agent). This switch applies to this chat only.">
          <Info className="size-3.5 text-slate-400" />
        </span>
        <span className={cn('ml-auto inline-flex items-center gap-1.5 text-xs font-medium', conv.aiMode === 'off' ? 'text-slate-400' : paused ? 'text-amber-600' : 'text-emerald-600')}>
          <span className={cn('size-1.5 rounded-full', conv.aiMode === 'off' ? 'bg-slate-300' : paused ? 'bg-amber-500' : 'bg-emerald-500')} />
          {conv.aiMode === 'off' ? 'Off' : paused ? 'Handed over' : 'Active'}
        </span>
      </div>
      <div className="grid grid-cols-3 rounded-xl bg-slate-100 p-1 text-sm">
        {AI_MODES.map((m) => (
          <button key={m.key} type="button" disabled={!writable} onClick={() => onUpdate({ aiMode: m.key })} className={cn('rounded-lg py-1.5 font-medium', conv.aiMode === m.key ? 'bg-white text-ink shadow-sm' : 'text-slate-500 hover:text-slate-700 disabled:hover:text-slate-500')}>
            {m.label}
          </button>
        ))}
      </div>
      <p className="mt-2.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-center text-xs font-medium text-emerald-700">{mode.hint}</p>
      {paused && writable && (
        <button type="button" onClick={() => onUpdate({ botPaused: false })} className="mt-2 w-full text-center text-xs font-medium text-brand-700 hover:underline">
          The chat was handed to your team. Let the AI and automations answer again
        </button>
      )}
    </section>
  );
}

function TicketDialog({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');
  const create = useMutation({
    mutationFn: () => api.post(`/workspaces/${workspace.id}/tasks`, { title, description, priority, type: 'ticket', contactId: contact.id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['contact-tickets', workspace.id, contact.id] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['contact-journey', workspace.id, contact.id] });
      onClose();
    },
  });
  return (
    <Dialog
      icon={<Ticket className="size-5" />}
      title="Create ticket"
      subtitle={`For ${contact.displayName} · shows on the Ticket / Task Board`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.isPending} disabled={!title.trim()} onClick={() => create.mutate()}>
            Create ticket
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {create.error != null && <Alert>{errorMessage(create.error)}</Alert>}
        <label className="block space-y-1.5">
          <span className="font-medium text-slate-700">Title</span>
          <Input autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Refund for cancelled appointment" />
        </label>
        <label className="block space-y-1.5">
          <span className="font-medium text-slate-700">Details (optional)</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none" />
        </label>
        <label className="block space-y-1.5">
          <span className="font-medium text-slate-700">Priority</span>
          <Select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Select>
        </label>
      </div>
    </Dialog>
  );
}

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function FollowUpDialog({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);
  const [dueAt, setDueAt] = useState(localInput(tomorrow));
  const [note, setNote] = useState('');
  const create = useMutation({
    mutationFn: () => api.post(`/workspaces/${workspace.id}/follow-ups`, { contactId: contact.id, dueAt: new Date(dueAt).toISOString(), note }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['contact-followups', workspace.id, contact.id] });
      void queryClient.invalidateQueries({ queryKey: ['follow-ups', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['contact-journey', workspace.id, contact.id] });
      onClose();
    },
  });
  return (
    <Dialog
      icon={<CalendarClock className="size-5" />}
      title="Schedule a follow-up"
      subtitle={`Reminder to get back to ${contact.displayName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.isPending} disabled={!dueAt} onClick={() => create.mutate()}>
            Save follow-up
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {create.error != null && <Alert>{errorMessage(create.error)}</Alert>}
        <label className="block space-y-1.5">
          <span className="font-medium text-slate-700">When</span>
          <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </label>
        <label className="block space-y-1.5">
          <span className="font-medium text-slate-700">Note (optional)</span>
          <textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="e.g. Share the treatment estimate" className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none" />
        </label>
      </div>
    </Dialog>
  );
}

// ---- Details tab ----

const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function DetailsTab({ conv, contact }: { conv: ConversationSummary; contact: Contact }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const stages = useStages(workspace.id);
  const tags = useTags(workspace.id);
  const save = useContactSave(contact.id);
  const [dialog, setDialog] = useState<'ticket' | 'followup' | 'journey' | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const canEdit = can('contacts:manage') && workspace.status !== 'suspended';

  const journey = useQuery({ queryKey: ['contact-journey', workspace.id, contact.id], queryFn: () => api.get<ContactJourney>(`/workspaces/${workspace.id}/contacts/${contact.id}/journey`) });
  const tickets = useQuery({ queryKey: ['contact-tickets', workspace.id, contact.id], queryFn: () => api.get<{ tasks: BoardTask[] }>(`/workspaces/${workspace.id}/tasks?contactId=${contact.id}`) });
  const followUps = useQuery({ queryKey: ['contact-followups', workspace.id, contact.id], queryFn: () => api.get<{ followUps: FollowUp[] }>(`/workspaces/${workspace.id}/follow-ups?contactId=${contact.id}`) });
  const notes = useQuery({
    queryKey: ['contact-notes', workspace.id, conv.id],
    queryFn: () => api.get<{ items: TimelineItem[] }>(`/workspaces/${workspace.id}/conversations/${conv.id}/timeline?limit=100`),
    select: (d) => d.items.filter((i): i is Extract<TimelineItem, { kind: 'note' }> => i.kind === 'note').reverse(),
  });
  const markDone = useMutation({
    mutationFn: (id: string) => api.patch(`/workspaces/${workspace.id}/follow-ups/${id}`, { done: true }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['contact-followups', workspace.id, contact.id] }),
  });
  const addNote = useMutation({
    mutationFn: () => api.post(`/workspaces/${workspace.id}/conversations/${conv.id}/notes`, { body: noteText }),
    onSuccess: () => {
      setNoteText('');
      void queryClient.invalidateQueries({ queryKey: ['contact-notes', workspace.id, conv.id] });
      void queryClient.invalidateQueries({ queryKey: ['timeline', workspace.id, conv.id] });
    },
  });

  const stage = stages.data?.find((s) => s.key === contact.lifecycleStage);
  const lastChange = journey.data?.stageHistory[0];
  const tagById = new Map((tags.data ?? []).map((t) => [t.id, t]));
  const unusedTags = (tags.data ?? []).filter((t) => !contact.tags.includes(t.id));
  const openFollowUps = (followUps.data?.followUps ?? []).filter((f) => f.status === 'open');

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200">
      <Section icon={<TrendingUp className="size-4" />} title="Lifecycle Stage" defaultOpen>
        <div className="rounded-xl bg-slate-50 px-3 py-2.5">
          <p className="flex items-center gap-2 font-semibold text-ink">
            <span className={cn('size-2 rounded-full', STAGE_TONE[stage?.color ?? 'gray']?.dot ?? 'bg-slate-400')} />
            {stage?.name ?? contact.lifecycleStage}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">{lastChange ? `${lastChange.by ? `by ${lastChange.by} · ` : ''}${fmt(lastChange.at)}` : `since ${fmt(contact.createdAt)}`}</p>
        </div>
        {(journey.data?.stageHistory.length ?? 0) > 0 && (
          <div className="mt-2">
            <button type="button" onClick={() => setHistoryOpen(!historyOpen)} className="flex w-full items-center justify-between py-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              History ({journey.data!.stageHistory.length}) <ChevronDown className={cn('size-3.5 transition-transform', !historyOpen && '-rotate-90')} />
            </button>
            {historyOpen && (
              <ol className="mt-1 space-y-1.5 border-l-2 border-slate-100 pl-3 text-xs text-slate-600">
                {journey.data!.stageHistory.map((h, i) => (
                  <li key={i}>
                    <span className="font-medium text-slate-700">
                      {h.fromName} → {h.toName}
                    </span>
                    <span className="block text-slate-400">
                      {h.by ? `${h.by} · ` : ''}
                      {fmt(h.at)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        <p className="mt-3 mb-1.5 text-xs font-medium text-slate-500">Change stage</p>
        <StageSelect contact={contact} disabled={!canEdit} />
      </Section>

      <Section icon={<Ticket className="size-4" />} title="Support Tickets" count={tickets.data?.tasks.length}>
        {tickets.isPending ? (
          <Spinner />
        ) : tickets.data?.tasks.length ? (
          <ul className="space-y-1.5">
            {tickets.data.tasks.map((t) => (
              <li key={t.id} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                <span className="font-mono text-xs text-slate-400">#{t.number}</span>
                <span className={cn('min-w-0 flex-1', t.completedAt && 'text-slate-400 line-through')}>{t.title}</span>
                <span className="shrink-0 text-xs text-slate-500 capitalize">{t.status.replace(/_/g, ' ')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">No tickets yet.</p>
        )}
        {canEdit && <AddLink label="Create ticket" onClick={() => setDialog('ticket')} />}
      </Section>

      <Section icon={<CalendarClock className="size-4" />} title="Follow-ups" count={openFollowUps.length}>
        {followUps.isPending ? (
          <Spinner />
        ) : followUps.data?.followUps.length ? (
          <ul className="space-y-1.5">
            {followUps.data.followUps.map((f) => {
              const overdue = f.status === 'open' && new Date(f.dueAt) < new Date();
              return (
                <li key={f.id} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <button type="button" disabled={f.status === 'done' || !canEdit} onClick={() => markDone.mutate(f.id)} className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border', f.status === 'done' ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 hover:border-emerald-500')} aria-label="Mark done">
                    {f.status === 'done' && <Check className="size-3" />}
                  </button>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-xs font-medium', overdue ? 'text-red-600' : 'text-slate-600', f.status === 'done' && 'text-slate-400')}>
                      {new Date(f.dueAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                      {overdue && ' · overdue'}
                    </span>
                    {f.note && <span className={cn('block', f.status === 'done' && 'text-slate-400 line-through')}>{f.note}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">No follow-ups scheduled.</p>
        )}
        {canEdit && <AddLink label="Add follow-up" onClick={() => setDialog('followup')} />}
      </Section>

      <Section icon={<TagIcon className="size-4" />} title="Tags" count={contact.tags.length}>
        <div className="flex flex-wrap gap-1.5">
          {contact.tags.length === 0 && <span className="text-sm text-slate-500">No tags.</span>}
          {contact.tags.map((id) => {
            const tag = tagById.get(id);
            if (!tag) return null;
            return (
              <span key={id} className="inline-flex items-center gap-0.5">
                <TagChip tag={tag} />
                {canEdit && (
                  <button type="button" onClick={() => save.mutate({ tags: contact.tags.filter((t) => t !== id) })} className="rounded p-0.5 text-slate-400 hover:text-red-600" aria-label={`Remove ${tag.name}`}>
                    <X className="size-3" />
                  </button>
                )}
              </span>
            );
          })}
        </div>
        {canEdit && unusedTags.length > 0 && (
          <Select aria-label="Add a tag" className="mt-2" value="" onChange={(e) => e.target.value && save.mutate({ tags: [...contact.tags, e.target.value] })}>
            <option value="">+ Add a tag</option>
            {unusedTags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        )}
      </Section>

      <Section icon={<UserRound className="size-4" />} title="Customer Details">
        <ContactDetails contact={contact} compact />
      </Section>

      <Section icon={<StickyNote className="size-4" />} title="User Notes" count={notes.data?.length}>
        {notes.data?.length ? (
          <ul className="space-y-1.5">
            {notes.data.map((n) => (
              <li key={n.id} className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <p className="break-words whitespace-pre-wrap">{n.body}</p>
                <p className="mt-0.5 text-[11px] text-amber-700">
                  {n.author} · {fmt(n.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">No notes yet. Only your team sees notes.</p>
        )}
        {canEdit && (
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (noteText.trim()) addNote.mutate();
            }}
          >
            <Input aria-label="New note" placeholder="Write a note…" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
            <Button type="submit" variant="secondary" loading={addNote.isPending} disabled={!noteText.trim()}>
              Add
            </Button>
          </form>
        )}
      </Section>

      <Section icon={<Phone className="size-4" />} title="Call History">
        <p className="text-sm text-slate-500">WhatsApp calling is coming soon; calls with this customer will be listed here.</p>
      </Section>

      <div className="flex items-center gap-3 border-t border-slate-100 px-4 py-3.5">
        <Ban className="size-4 text-slate-500" />
        <span className="flex-1 text-sm font-medium text-slate-700">Block User</span>
        <button
          type="button"
          role="switch"
          aria-checked={contact.blocked}
          aria-label="Block user"
          disabled={!canEdit || save.isPending}
          onClick={() => {
            if (contact.blocked || window.confirm(`Block ${contact.displayName}? Their messages won't alert your team or trigger automations, and nothing can be sent to them.`)) save.mutate({ blocked: !contact.blocked });
          }}
          className={cn('relative h-6 w-11 rounded-full transition', contact.blocked ? 'bg-red-500' : 'bg-slate-200')}
        >
          <span className={cn('absolute top-0.5 size-5 rounded-full bg-white shadow transition-all', contact.blocked ? 'left-[22px]' : 'left-0.5')} />
        </button>
      </div>
      {save.error != null && (
        <div className="px-4 pb-3">
          <Alert>{errorMessage(save.error)}</Alert>
        </div>
      )}

      <button type="button" onClick={() => setDialog('journey')} className="flex w-full items-center gap-3 border-t border-slate-100 px-4 py-3.5 text-left text-sm font-medium text-slate-700 hover:bg-slate-50">
        <History className="size-4 text-slate-500" />
        <span className="flex-1">View Chat Journey</span>
        <ChevronRight className="size-4 text-slate-400" />
      </button>

      {dialog === 'ticket' && <TicketDialog contact={contact} onClose={() => setDialog(null)} />}
      {dialog === 'followup' && <FollowUpDialog contact={contact} onClose={() => setDialog(null)} />}
      {dialog === 'journey' && <JourneyDialog contact={contact} journey={journey.data} loading={journey.isPending} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Section({ icon, title, count, defaultOpen = false, children }: { icon: ReactNode; title: string; count?: number; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm font-medium text-slate-700 hover:bg-slate-50">
        <span className="text-slate-500">{icon}</span>
        <span className="flex-1">{title}</span>
        {!!count && <span className="rounded-full bg-slate-100 px-1.5 text-[11px] font-semibold text-slate-500">{count}</span>}
        <ChevronDown className={cn('size-4 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

const AddLink = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" onClick={onClick} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
    <Plus className="size-3.5" /> {label}
  </button>
);

function JourneyDialog({ contact, journey, loading, onClose }: { contact: Contact; journey?: ContactJourney; loading: boolean; onClose: () => void }) {
  return (
    <Dialog icon={<Route className="size-5" />} title="Chat journey" subtitle={contact.displayName} width="max-w-lg" onClose={onClose}>
      {loading ? (
        <Spinner />
      ) : !journey?.items.length ? (
        <p className="py-6 text-center text-sm text-slate-500">Nothing yet.</p>
      ) : (
        <ol className="relative space-y-4 border-l-2 border-slate-100 pl-5">
          {journey.items.map((i, k) => (
            <li key={k} className="relative">
              <span className="absolute top-1 -left-[27px] size-3 rounded-full border-2 border-white bg-brand-500 ring-2 ring-brand-100" />
              <p className="text-sm font-medium text-ink">{i.title}</p>
              <p className="text-xs text-slate-500">
                {new Date(i.at).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                {i.detail && ` · ${i.detail}`}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}

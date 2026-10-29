import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, AlertCircle, ArrowLeft, Bot, Check, Clock, Command, EllipsisVertical, Hourglass, Keyboard, Lock, PanelLeft, PanelRight, PlayCircle, RotateCcw, Search, Star, StickyNote, UserCheck, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Modal, initials } from '../../components/crm';
import { Alert, Button, Field, Input, Spinner, cn, errorMessage, fieldError } from '../../components/ui';
import { ApiError, api, type Contact, type ConversationSummary } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { useWorkspace } from '../../layouts/workspaceContext';
import { Popover } from '../audience/shared';
import { CANNED_EVENT, COMPOSE_EVENT, Composer } from './Composer';
import { ContactPanel, StatusPill } from './ContactPanel';
import { PanelResizeHandle } from './PanelResizeHandle';
import { snoozeLabel, snoozeOptions, useInboxRefresh } from './shared';
import { Timeline } from './Timeline';

interface ConversationDetail {
  conversation: ConversationSummary;
  contact: Contact | null;
  canReply: boolean;
}

/** "+" in the chat list: open a chat with any number (creates the contact if new). */
export function NewChatModal({ onClose, onStarted }: { onClose: () => void; onStarted: (conversationId: string) => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const start = useMutation({
    mutationFn: () => api.post<{ conversation: ConversationSummary }>(`/workspaces/${workspace.id}/conversations`, { phone, name: name.trim() || undefined }),
    onSuccess: ({ conversation }) => {
      void queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['conversation-counts', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['contacts', workspace.id] });
      onStarted(conversation.id);
    },
  });
  const err = start.error;
  return (
    <Modal title="New chat" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          start.mutate();
        }}
      >
        {err != null && !(err instanceof ApiError && err.code === 'VALIDATION_ERROR') && <Alert>{errorMessage(err)}</Alert>}
        <Field label="WhatsApp number" htmlFor="nc-phone" error={fieldError(err, 'phone')} hint={`With country code, e.g. +91 98765 43210. Numbers without one are read as ${workspace.country}.`}>
          <Input id="nc-phone" type="tel" autoFocus value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" />
        </Field>
        <Field label="Name (optional)" htmlFor="nc-name" error={fieldError(err, 'name')}>
          <Input id="nc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name" />
        </Field>
        <p className="text-xs text-slate-500">If this customer hasn&apos;t messaged you in the last 24 hours, WhatsApp only allows an approved template as the first message.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={start.isPending} disabled={phone.trim().length < 5}>
            Start chat
          </Button>
        </div>
      </form>
    </Modal>
  );
}


/** "15h 58m" left in the 24-hour window, refreshed every minute. */
function useWindowLeft(endsAt: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - now;
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export interface ChatLayout {
  listHidden: boolean;
  onToggleList: () => void;
  contactOpen: boolean;
  onToggleContact: () => void;
  contactWidth: number | null;
  onContactWidth: (w: number | null) => void;
  onShortcuts: () => void;
}

/**
 * An open chat: the conversation card and, beside it, the resizable Contact Info card.
 * Header buttons hide the chat list (left) or the contact card (right).
 */
export function ConversationPanel({ id, onBack, layout }: { id: string; onBack: () => void; layout: ChatLayout }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const refresh = useInboxRefresh();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [palette, setPalette] = useState(false);

  const detail = useQuery({
    queryKey: ['conversation', workspace.id, id],
    queryFn: () => api.get<ConversationDetail>(`/workspaces/${workspace.id}/conversations/${id}`),
  });
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/workspaces/${workspace.id}/conversations/${id}`, body),
    onSuccess: () => refresh(id),
  });
  const star = useMutation({
    mutationFn: (starred: boolean) => api.post(`/workspaces/${workspace.id}/conversations/${id}/star`, { starred }),
    onSettled: () => refresh(id),
  });

  const conversation = detail.data?.conversation;
  const writable = workspace.status !== 'suspended' && !!detail.data?.canReply;
  const windowLeft = useWindowLeft(conversation?.serviceWindowEndsAt ?? null);

  // Esc closes, e resolves, s stars, r / n start a reply or a note, Ctrl/Cmd+K opens all actions.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]') || e.metaKey || e.ctrlKey || e.altKey || !conversation) return;
      if (e.key === 'Escape') onBack();
      else if (e.key === 's') star.mutate(!conversation.starred);
      else if (e.key === 'e' && writable && conversation.status !== 'resolved') update.mutate({ status: 'resolved' });
      else if ((e.key === 'r' || e.key === 'n') && writable) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: e.key === 'r' ? 'reply' : 'note' }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [conversation, writable, onBack, star, update]);

  // Opening an unread conversation marks it read.
  const unread = conversation?.unreadCount ?? 0;
  useEffect(() => {
    if (unread > 0) {
      void api.post(`/workspaces/${workspace.id}/conversations/${id}/read`).then(() => {
        void queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] });
        void queryClient.invalidateQueries({ queryKey: ['conversation', workspace.id, id] });
      });
    }
  }, [unread, id, workspace.id, queryClient]);

  const card = 'min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white';
  if (detail.isPending || detail.error) {
    return (
      <section className={cn(card, 'flex flex-1')}>
        {detail.error ? (
          <div className="p-6">
            <Alert>{errorMessage(detail.error)}</Alert>
          </div>
        ) : (
          <Spinner />
        )}
      </section>
    );
  }

  const { conversation: conv, contact } = detail.data;
  const name = conv.contact?.name ?? '?';
  const iconBtn = 'shrink-0 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 @sm:p-2';

  return (
    <>
      <section className={cn(card, '@container flex flex-1 md:min-w-[260px]')}>
        <header className="flex items-center gap-1.5 border-b border-slate-200 px-2.5 py-2.5 @sm:gap-2 @md:gap-3 @md:px-4">
          <button type="button" onClick={onBack} className={cn(iconBtn, 'md:hidden')} aria-label="Back to chats">
            <ArrowLeft className="size-5" />
          </button>
          <button type="button" onClick={layout.onToggleList} className={cn(iconBtn, 'hidden md:block', layout.listHidden && 'bg-slate-100 text-ink')} aria-label={layout.listHidden ? 'Show chat list' : 'Hide chat list'} title={layout.listHidden ? 'Show chat list' : 'Hide chat list'}>
            <PanelLeft className="size-5" />
          </button>
          <span className="relative hidden shrink-0 @sm:block">
            <span className="flex size-10 items-center justify-center rounded-full bg-emerald-100 text-sm font-semibold text-emerald-700">{initials(name)}</span>
            {conv.serviceWindowOpen && <span className="absolute right-0 bottom-0 size-3 rounded-full bg-emerald-500 ring-2 ring-white" title="Customer service window is open" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <p className="max-w-full truncate font-semibold text-ink" title={name}>
                {name}
              </p>
              <span className="hidden @lg:inline-flex">
                <StatusPill status={conv.status} />
              </span>
              {conv.starred && <Star className="size-4 fill-amber-400 text-amber-400" aria-label="Starred" />}
            </div>
            <p className="truncate text-xs text-slate-500">{conv.contact?.phone.replace(/^\+/, '')}</p>
          </div>
          <div className="hidden shrink-0 items-center gap-1.5 @2xl:flex">
            {conv.awaitingHuman && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700" title={`Handed over by ${conv.handoffSource === 'ai' ? 'the AI agent' : 'a flow'}; no one has replied yet`}>
                <Hourglass className="size-3.5" /> Waiting
              </span>
            )}
            {conv.snoozedUntil && (
              <button type="button" onClick={() => update.mutate({ snoozedUntil: null })} className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-100" title="Snoozed. Click to bring it back now">
                <AlarmClock className="size-3.5" /> {snoozeLabel(conv.snoozedUntil)}
              </button>
            )}
          </div>
          <span
            className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-xs font-semibold @sm:px-2.5', windowLeft ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700')}
            title={windowLeft ? 'Time left to reply freely (24-hour customer service window)' : 'The 24-hour window has closed: only approved templates can be sent'}
          >
            {windowLeft ? <Clock className="size-3.5" /> : <Lock className="size-3.5" />}
            <span className={cn('hidden', windowLeft ? '@sm:inline' : '@md:inline')}>{windowLeft ?? 'Templates only'}</span>
          </span>
          <button type="button" onClick={(e) => setMenuAnchor(e.currentTarget)} className={iconBtn} aria-label="More actions" title="More actions">
            <EllipsisVertical className="size-5" />
          </button>
          {contact && (
            <button type="button" onClick={layout.onToggleContact} className={cn(iconBtn, layout.contactOpen && 'bg-slate-100 text-ink')} aria-label={layout.contactOpen ? 'Hide contact info' : 'Show contact info'} title={layout.contactOpen ? 'Hide contact info' : 'Show contact info'}>
              <PanelRight className="size-5" />
            </button>
          )}
        </header>
        {update.error != null && (
          <div className="px-4 pt-3">
            <Alert>{errorMessage(update.error)}</Alert>
          </div>
        )}
        {contact?.blocked && <p className="bg-red-50 px-4 py-2 text-center text-xs font-medium text-red-700">This contact is blocked. Unblock them in Contact Info to message them again.</p>}

        <Timeline id={id} contactName={name} />
        {writable ? (
          <Composer id={id} windowOpen={conv.serviceWindowOpen} contactName={name} aiMode={conv.aiMode} onOpenActions={() => setPalette(true)} />
        ) : (
          <div className="m-4 flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
            <Lock className="size-4" />
            {workspace.status === 'suspended' ? 'This workspace is suspended.' : 'Read-only: this chat is assigned to someone else.'}
          </div>
        )}

        <ChatMenu anchor={menuAnchor} onClose={() => setMenuAnchor(null)} conv={conv} writable={writable} onUpdate={(b) => update.mutate(b)} onStar={() => star.mutate(!conv.starred)} onShortcuts={layout.onShortcuts} />
        {palette && (
          <ActionsPalette
            onClose={() => setPalette(false)}
            actions={[
              ...(writable
                ? [
                    { label: 'Insert a canned reply', hint: '/', icon: <Zap className="size-4" />, run: () => window.dispatchEvent(new Event(CANNED_EVENT)) },
                    { label: 'Write an internal note', hint: 'n', icon: <StickyNote className="size-4" />, run: () => window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: 'note' })) },
                    conv.status === 'resolved'
                      ? { label: 'Reopen chat', icon: <RotateCcw className="size-4" />, run: () => update.mutate({ status: 'open' }) }
                      : { label: 'Resolve chat', hint: 'e', icon: <Check className="size-4" />, run: () => update.mutate({ status: 'resolved' }) },
                    ...snoozeOptions().slice(0, 3).map((o) => ({ label: `Snooze: ${o.label}`, icon: <AlarmClock className="size-4" />, run: () => update.mutate({ snoozedUntil: o.until.toISOString() }) })),
                    { label: conv.priority === 'high' ? 'Remove high priority' : 'Mark high priority', icon: <AlertCircle className="size-4" />, run: () => update.mutate({ priority: conv.priority === 'high' ? 'normal' : 'high' }) },
                  ]
                : []),
              { label: conv.starred ? 'Unstar' : 'Star', hint: 's', icon: <Star className="size-4" />, run: () => star.mutate(!conv.starred) },
              { label: layout.contactOpen ? 'Hide contact info' : 'Show contact info', icon: <PanelRight className="size-4" />, run: layout.onToggleContact },
              { label: layout.listHidden ? 'Show chat list' : 'Hide chat list', icon: <PanelLeft className="size-4" />, run: layout.onToggleList },
              { label: 'Keyboard shortcuts', hint: '?', icon: <Keyboard className="size-4" />, run: layout.onShortcuts },
            ]}
          />
        )}
      </section>

      {contact && layout.contactOpen && (
        <>
          {/* Below xl the card floats over the chat instead of squeezing it. */}
          <div className="fixed inset-0 z-30 bg-slate-900/20 xl:hidden" onClick={layout.onToggleContact} />
          <PanelResizeHandle side="right" width={layout.contactWidth} min={300} max={520} fallback={360} onChange={layout.onContactWidth} label="Resize contact info" />
          <aside
            aria-label="Contact info"
            className="fixed inset-y-3 right-3 z-40 flex w-[min(360px,calc(100vw-1.5rem))] shrink-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl xl:static xl:z-auto xl:w-(--contact-w) xl:min-w-[260px] xl:shrink xl:shadow-none"
            style={{ '--contact-w': `${layout.contactWidth ?? 360}px` } as CSSProperties}
          >
            <ContactPanel conv={conv} contact={contact} writable={writable} onUpdate={(b) => update.mutate(b)} onClose={layout.onToggleContact} />
          </aside>
        </>
      )}
    </>
  );
}

function ChatMenu({ anchor, onClose, conv, writable, onUpdate, onStar, onShortcuts }: { anchor: HTMLElement | null; onClose: () => void; conv: ConversationSummary; writable: boolean; onUpdate: (b: Record<string, unknown>) => void; onStar: () => void; onShortcuts: () => void }) {
  const { user } = useAuth();
  const [snoozing, setSnoozing] = useState(false);
  const item = (icon: ReactNode, label: string, run: () => void, cls = '') => (
    <button type="button" onClick={() => (run(), onClose(), setSnoozing(false))} className={cn('flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left hover:bg-slate-50', cls)}>
      <span className="text-slate-500">{icon}</span>
      {label}
    </button>
  );
  return (
    <Popover anchor={anchor} open={!!anchor} onClose={() => (onClose(), setSnoozing(false))} width={240} align="right">
      <div className="p-1 text-sm">
        {snoozing ? (
          <>
            <p className="px-3 pt-2 pb-1 text-xs font-semibold text-slate-500">Snooze until</p>
            {snoozeOptions().map((o) => item(<AlarmClock className="size-4" />, o.label, () => onUpdate({ snoozedUntil: o.until.toISOString() })))}
            <p className="px-3 pt-1 pb-2 text-[11px] text-slate-400">A new customer message brings it back early.</p>
          </>
        ) : (
          <>
            {item(<Star className={cn('size-4', conv.starred && 'fill-amber-400 text-amber-400')} />, conv.starred ? 'Unstar' : 'Star', onStar)}
            {writable && (
              <>
                {conv.status === 'resolved'
                  ? item(<RotateCcw className="size-4" />, 'Reopen', () => onUpdate({ status: 'open' }))
                  : conv.status === 'pending'
                    ? item(<PlayCircle className="size-4" />, 'Mark as open', () => onUpdate({ status: 'open' }))
                    : item(<Clock className="size-4" />, 'Mark as pending', () => onUpdate({ status: 'pending' }))}
                {conv.status !== 'resolved' &&
                  (conv.snoozedUntil ? (
                    item(<AlarmClock className="size-4" />, 'Unsnooze', () => onUpdate({ snoozedUntil: null }))
                  ) : (
                    <button type="button" onClick={() => setSnoozing(true)} className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left hover:bg-slate-50">
                      <AlarmClock className="size-4 text-slate-500" /> Snooze…
                    </button>
                  ))}
                {item(<AlertCircle className={cn('size-4', conv.priority === 'high' && 'text-red-600')} />, conv.priority === 'high' ? 'Remove high priority' : 'Mark high priority', () => onUpdate({ priority: conv.priority === 'high' ? 'normal' : 'high' }))}
                {!conv.assignee && item(<UserCheck className="size-4" />, 'Assign to me', () => onUpdate({ assigneeId: user!.id }))}
                {conv.botPaused && item(<Bot className="size-4" />, 'Resume automations', () => onUpdate({ botPaused: false }))}
              </>
            )}
            <div className="my-1 border-t border-slate-100" />
            {item(<Keyboard className="size-4" />, 'Keyboard shortcuts', onShortcuts)}
          </>
        )}
      </div>
    </Popover>
  );
}

interface PaletteAction {
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

/** Ctrl/Cmd+K: search and run any chat action from the keyboard. */
function ActionsPalette({ actions, onClose }: { actions: PaletteAction[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => actions.filter((a) => a.label.toLowerCase().includes(q.trim().toLowerCase())), [actions, q]);
  const run = (a: PaletteAction | undefined) => {
    if (!a) return;
    onClose();
    setTimeout(a.run, 0);
  };
  useEffect(() => input.current?.focus(), []);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-[15vh]" onClick={onClose}>
      <div role="dialog" aria-label="Chat actions" className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-slate-100 px-4">
          <Search className="size-4 text-slate-400" />
          <input
            ref={input}
            value={q}
            onChange={(e) => (setQ(e.target.value), setHl(0))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setHl((h) => (list.length ? (h + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length : 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(list[hl]);
              } else if (e.key === 'Escape') onClose();
            }}
            placeholder="Search actions…"
            aria-label="Search actions"
            className="w-full py-3.5 text-sm focus:outline-none"
          />
          <kbd className="inline-flex items-center gap-0.5 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400">
            <Command className="size-3" />K
          </kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto p-1.5">
          {list.length === 0 && <li className="px-3 py-4 text-center text-sm text-slate-500">No matching action.</li>}
          {list.map((a, i) => (
            <li key={a.label}>
              <button type="button" onMouseEnter={() => setHl(i)} onClick={() => run(a)} className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm', i === hl ? 'bg-slate-100 text-ink' : 'text-slate-700')}>
                <span className="text-slate-500">{a.icon}</span>
                <span className="flex-1">{a.label}</span>
                {a.hint && <kbd className="rounded border border-slate-200 px-1.5 font-mono text-[11px] text-slate-400">{a.hint}</kbd>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

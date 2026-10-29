import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { AlarmClock, Bot, Check, CheckCheck, Filter, Hourglass, Plus, Search, Star, UserPlus, X } from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { initials, relativeTime } from '../../components/crm';
import { Alert, Button, EmptyState, Select, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type ConversationStatus, type ConversationSummary } from '../../lib/api';
import { useTags } from '../../lib/hooks';
import { useWorkspace } from '../../layouts/workspaceContext';
import { Popover } from '../audience/shared';
import { NewChatModal } from './ConversationPanel';
import { NAV_LISTS, type NavList } from './navLists';
import { snoozeLabel, snoozeOptions, useInboxCounts, useInboxRefresh, useTeam } from './shared';

type WindowTab = 'active' | 'rolling';
type AiTab = 'all' | 'active' | 'escalated' | 'resolved';

interface Filters {
  status: ConversationStatus | 'snoozed' | 'all';
  assignee: string;
  priority: '' | 'high';
  unread: boolean;
  tag: string;
}

const AVATAR_TONES = ['bg-emerald-100 text-emerald-700', 'bg-lime-100 text-lime-700', 'bg-violet-100 text-violet-700', 'bg-rose-100 text-rose-700', 'bg-fuchsia-100 text-fuchsia-700', 'bg-sky-100 text-sky-700', 'bg-amber-100 text-amber-700'];
const toneOf = (s: string) => AVATAR_TONES[[...s].reduce((n, ch) => n + ch.charCodeAt(0), 0) % AVATAR_TONES.length]!;

export function ChatList({ list, selected, onSelect }: { list: NavList; selected: string | null; onSelect: (id: string | null) => void }) {
  const { workspace, can } = useWorkspace();
  const nav = NAV_LISTS[list];
  const isAi = list === 'ai';
  const [q, setQ] = useState('');
  const term = useDeferredValue(q.trim());
  const [tab, setTab] = useState<WindowTab | 'any'>(list === 'open' ? 'active' : 'any');
  const [aiTab, setAiTab] = useState<AiTab>('all');
  const defaults: Filters = { status: nav.status, assignee: '', priority: '', unread: false, tag: '' };
  const [filters, setFilters] = useState<Filters>(defaults);
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const counts = useInboxCounts();
  const refresh = useInboxRefresh();
  const filtered = filters.status !== nav.status || filters.assignee || filters.priority || filters.unread || filters.tag;

  const query = useInfiniteQuery({
    queryKey: ['conversations', workspace.id, { list, term, tab, aiTab, filters }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ view: nav.view, status: filters.status });
      if (isAi) p.set('ai', aiTab);
      else if (tab !== 'any') p.set('window', tab);
      if (term) p.set('q', term);
      if (filters.assignee) p.set('assignee', filters.assignee);
      if (filters.priority) p.set('priority', filters.priority);
      if (filters.unread) p.set('unread', 'true');
      if (filters.tag) p.set('tag', filters.tag);
      if (pageParam) p.set('before', pageParam);
      return api.get<{ conversations: ConversationSummary[]; nextBefore: string | null }>(`/workspaces/${workspace.id}/conversations?${p}`);
    },
    getNextPageParam: (last) => last.nextBefore,
  });
  const conversations = query.data?.pages.flatMap((p) => p.conversations) ?? [];
  const canStart = can('contacts:manage') && can('messages:send') && workspace.status !== 'suspended';

  // j / k move through the list.
  const listRef = useRef(conversations);
  listRef.current = conversations;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const items = listRef.current;
      if (!items.length) return;
      const i = items.findIndex((c) => c.id === selected);
      const next = e.key === 'j' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      onSelect(items[i < 0 ? 0 : next]!.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, onSelect]);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <div className="space-y-3 px-4 pt-4">
        <div className="flex items-center gap-2">
          <MobileViewPicker list={list} />
          <h1 className="hidden flex-1 text-lg font-semibold text-ink md:block">
            {isAi ? nav.label : 'Chats'}
            {isAi && counts.data && <span className="ml-2 rounded-md bg-slate-100 px-1.5 py-0.5 align-middle text-xs font-medium text-slate-500">{counts.data.ai.all}</span>}
          </h1>
          {canStart && !isAi && (
            <button onClick={() => setStarting(true)} className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900" aria-label="New chat" title="New chat">
              <Plus className="size-5" />
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              aria-label="Search chats"
              placeholder="Search for a chat..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="block w-full rounded-xl border border-slate-200 py-2 pr-9 pl-3.5 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none"
            />
            <Search className="pointer-events-none absolute top-2.5 right-3 size-4 text-slate-500" />
          </div>
          <button
            type="button"
            onClick={(e) => setFilterAnchor(filterAnchor ? null : e.currentTarget)}
            className="relative rounded-xl border border-slate-200 px-2.5 text-slate-600 hover:bg-slate-50"
            aria-label="Filters"
            title="Filters"
          >
            <Filter className="size-4" />
            {filtered && <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-brand-600 ring-2 ring-white" />}
          </button>
          <FilterPopover anchor={filterAnchor} onClose={() => setFilterAnchor(null)} value={filters} defaults={defaults} onChange={setFilters} showStatus={!isAi} />
        </div>
        {isAi ? (
          <div className="flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 text-sm">
            {(
              [
                ['all', 'All', counts.data?.ai.all],
                ['active', 'AI Active', counts.data?.ai.active],
                ['escalated', 'Escalated', counts.data?.ai.escalated],
                ['resolved', 'Resolved', undefined],
              ] as const
            ).map(([k, label, n]) => (
              <button key={k} type="button" onClick={() => setAiTab(k)} className={cn('flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium whitespace-nowrap', aiTab === k ? 'bg-white text-ink shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
                {label}
                {n !== undefined && <span className="rounded-md bg-slate-200/70 px-1.5 text-[11px]">{n}</span>}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex overflow-x-auto border-b border-slate-200 text-sm [scrollbar-width:none]">
            {(
              [
                ['active', 'Active', 'Customer wrote in the last 24 hours: reply freely'],
                ['rolling', 'Rolling Over', 'Older than 24 hours: only templates can be sent'],
                ['any', 'Everything', 'All chats in this list'],
              ] as const
            ).map(([k, label, hint]) => (
              <button key={k} type="button" title={hint} onClick={() => setTab(k)} className={cn('-mb-px shrink-0 border-b-2 px-3 py-2 font-medium whitespace-nowrap', tab === k ? 'border-ink text-ink' : 'border-transparent text-slate-500 hover:text-slate-700')}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {checked.size > 0 && <BulkBar ids={[...checked]} onDone={() => (setChecked(new Set()), refresh())} onClear={() => setChecked(new Set())} />}

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {query.isPending ? (
          <Spinner />
        ) : query.error ? (
          <div className="p-3">
            <Alert>{errorMessage(query.error)}</Alert>
          </div>
        ) : conversations.length === 0 ? (
          <EmptyState icon={<CheckCheck className="size-5" />} title={term || filtered ? 'No chats match' : emptyTitle(list, tab)}>
            {term || filtered ? 'Try another search or clear the filters.' : emptyHint(list, tab)}
          </EmptyState>
        ) : (
          <ul className="space-y-0.5">
            {conversations.map((c) => (
              <ChatRow key={c.id} c={c} active={selected === c.id} checked={checked.has(c.id)} selecting={checked.size > 0} onToggle={() => toggle(c.id)} onOpen={() => onSelect(c.id)} ai={isAi} />
            ))}
          </ul>
        )}
        {query.hasNextPage && (
          <div className="p-3 text-center">
            <Button variant="ghost" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}
      </div>

      {starting && (
        <NewChatModal
          onClose={() => setStarting(false)}
          onStarted={(id) => {
            setStarting(false);
            onSelect(id);
          }}
        />
      )}
    </>
  );
}

const emptyTitle = (list: NavList, tab: WindowTab | 'any') =>
  list === 'mentions' ? 'No mentions' : list === 'starred' ? 'Nothing starred' : list === 'waiting' ? 'Nobody is waiting' : list === 'ai' ? 'No AI chats yet' : tab === 'rolling' ? 'No rolled-over chats' : 'All caught up';
const emptyHint = (list: NavList, tab: WindowTab | 'any') =>
  list === 'mentions'
    ? 'When a teammate @mentions you in an internal note, the chat shows up here.'
    : list === 'starred'
      ? 'Star a chat to keep it handy. Stars are just for you.'
      : list === 'waiting'
        ? 'Chats the AI agent or a flow hands to your team wait here until someone replies.'
        : list === 'ai'
          ? 'Chats the AI agent answers appear here. Turn it on in AI Agent.'
          : tab === 'rolling'
            ? 'Chats whose 24-hour window has closed appear here; reopen them with a template.'
            : 'New customer messages appear here in real time.';

function ChatRow({ c, active, checked, selecting, onToggle, onOpen, ai }: { c: ConversationSummary; active: boolean; checked: boolean; selecting: boolean; onToggle: () => void; onOpen: () => void; ai: boolean }) {
  const name = c.contact?.name ?? '?';
  return (
    <li className={cn('group relative flex gap-3 rounded-xl px-2.5 py-3 transition', active ? 'bg-slate-100' : 'hover:bg-slate-50', checked && 'bg-brand-50/60')}>
      <button
        type="button"
        onClick={onToggle}
        aria-label={checked ? `Unselect ${name}` : `Select ${name}`}
        className={cn('relative flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold', checked ? 'bg-brand-600 text-white' : toneOf(name))}
      >
        {checked ? <Check className="size-5" /> : <span className={cn(selecting ? 'hidden' : 'group-hover:hidden')}>{initials(name)}</span>}
        {!checked && <span className={cn('size-5 rounded-md border-2 border-slate-300 bg-white', selecting ? 'block' : 'hidden group-hover:block')} />}
        {ai && !checked && (
          <span className="absolute -right-0.5 -bottom-0.5 flex size-5 items-center justify-center rounded-full bg-emerald-500 text-white ring-2 ring-white">
            <Bot className="size-3" />
          </span>
        )}
      </button>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn('truncate text-sm', c.unreadCount ? 'font-bold text-ink' : 'font-semibold text-slate-800')}>{name}</span>
          <span className={cn('shrink-0 text-xs', c.unreadCount ? 'font-semibold text-brand-700' : 'text-slate-400')}>{relativeTime(c.lastMessageAt)}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className={cn('truncate text-[13px]', c.unreadCount ? 'text-slate-700' : 'text-slate-500')}>
            {c.lastMessageDirection === 'outbound' && <span className="text-slate-400">You: </span>}
            {c.lastMessagePreview}
          </span>
          {c.unreadCount > 0 && <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold text-white">{c.unreadCount}</span>}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {ai ? (
            <Chip tone={c.handoffSource === 'ai' && c.botPaused ? 'amber' : c.status === 'resolved' ? 'slate' : 'emerald'}>
              {c.handoffSource === 'ai' && c.botPaused ? 'Escalated' : c.status === 'resolved' ? 'Resolved' : 'AI Active'}
            </Chip>
          ) : (
            <Chip tone="slate">{c.assignee ? c.assignee.name : 'Unassigned'}</Chip>
          )}
          {c.awaitingHuman && (
            <Chip tone="amber">
              <Hourglass className="size-3" /> Waiting
            </Chip>
          )}
          {c.snoozedUntil && (
            <Chip tone="violet">
              <AlarmClock className="size-3" /> {snoozeLabel(c.snoozedUntil)}
            </Chip>
          )}
          {c.priority === 'high' && <Chip tone="red">High</Chip>}
          {c.status !== 'open' && !ai && <Chip tone="slate">{c.status === 'pending' ? 'Pending' : 'Resolved'}</Chip>}
          {c.starred && <Star className="size-3.5 fill-amber-400 text-amber-400" aria-label="Starred" />}
        </span>
      </button>
    </li>
  );
}

const CHIP: Record<string, string> = {
  slate: 'bg-slate-100 text-slate-600',
  emerald: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-700',
  violet: 'bg-violet-50 text-violet-700',
  red: 'bg-red-50 text-red-600',
};
function Chip({ tone, children }: { tone: keyof typeof CHIP; children: React.ReactNode }) {
  return <span className={cn('inline-flex max-w-36 items-center gap-1 truncate rounded-md px-2 py-0.5 text-[11px] font-medium', CHIP[tone])}>{children}</span>;
}

function FilterPopover({ anchor, onClose, value, defaults, onChange, showStatus }: { anchor: HTMLElement | null; onClose: () => void; value: Filters; defaults: Filters; onChange: (f: Filters) => void; showStatus: boolean }) {
  const { workspace, can } = useWorkspace();
  const team = useTeam();
  const tags = useTags(workspace.id);
  const set = (patch: Partial<Filters>) => onChange({ ...value, ...patch });
  return (
    <Popover anchor={anchor} open={!!anchor} onClose={onClose} width={260} align="right">
      <div className="space-y-3 p-3 text-sm">
        <div className="flex items-center justify-between">
          <p className="font-semibold text-ink">Filters</p>
          <button type="button" onClick={() => onChange(defaults)} className="text-xs font-medium text-brand-700 hover:underline">
            Reset
          </button>
        </div>
        {showStatus && (
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-500">Status</span>
            <Select value={value.status} onChange={(e) => set({ status: e.target.value as Filters['status'] })}>
              <option value="open">Open</option>
              <option value="pending">Pending</option>
              <option value="snoozed">Snoozed</option>
              <option value="resolved">Resolved</option>
              <option value="all">Any status</option>
            </Select>
          </label>
        )}
        {can('conversations:view_all') && (
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-500">Assigned to</span>
            <Select value={value.assignee} onChange={(e) => set({ assignee: e.target.value })}>
              <option value="">Anyone</option>
              <option value="none">Unassigned</option>
              {team.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        {(tags.data?.length ?? 0) > 0 && (
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-500">Contact tag</span>
            <Select value={value.tag} onChange={(e) => set({ tag: e.target.value })}>
              <option value="">Any tag</option>
              {tags.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-emerald-600" checked={value.unread} onChange={(e) => set({ unread: e.target.checked })} /> Unread only
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-emerald-600" checked={value.priority === 'high'} onChange={(e) => set({ priority: e.target.checked ? 'high' : '' })} /> High priority only
        </label>
      </div>
    </Popover>
  );
}

function BulkBar({ ids, onDone, onClear }: { ids: string[]; onDone: () => void; onClear: () => void }) {
  const { workspace, can } = useWorkspace();
  const team = useTeam();
  const [snoozeAnchor, setSnoozeAnchor] = useState<HTMLElement | null>(null);
  const [assignAnchor, setAssignAnchor] = useState<HTMLElement | null>(null);
  const run = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ updated: number; skipped: number }>(`/workspaces/${workspace.id}/conversations/bulk`, { ids, ...body }),
    onSuccess: onDone,
  });
  const btn = 'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-700 hover:bg-white';
  return (
    <div className="mx-3 mt-2 rounded-xl bg-brand-50 px-2 py-1.5 ring-1 ring-brand-100">
      <div className="flex flex-wrap items-center gap-1">
        <span className="px-1 text-xs font-semibold text-brand-800">{ids.length} selected</span>
        {can('conversations:assign') && (
          <button type="button" className={btn} onClick={(e) => setAssignAnchor(e.currentTarget)}>
            <UserPlus className="size-3.5" /> Assign
          </button>
        )}
        <button type="button" className={btn} onClick={() => run.mutate({ action: 'resolve' })}>
          <CheckCheck className="size-3.5" /> Resolve
        </button>
        <button type="button" className={btn} onClick={(e) => setSnoozeAnchor(e.currentTarget)}>
          <AlarmClock className="size-3.5" /> Snooze
        </button>
        <button type="button" className={btn} onClick={() => run.mutate({ action: 'star' })}>
          <Star className="size-3.5" /> Star
        </button>
        <button type="button" onClick={onClear} className="ml-auto rounded-md p-1 text-slate-500 hover:bg-white" aria-label="Clear selection">
          <X className="size-3.5" />
        </button>
      </div>
      {run.error != null && <p className="px-1 pt-1 text-xs text-red-600">{errorMessage(run.error)}</p>}
      <Popover anchor={assignAnchor} open={!!assignAnchor} onClose={() => setAssignAnchor(null)} width={220}>
        <div className="max-h-64 overflow-y-auto p-1 text-sm">
          <button type="button" className="block w-full rounded-md px-3 py-2 text-left hover:bg-slate-50" onClick={() => (setAssignAnchor(null), run.mutate({ action: 'assign', assigneeId: null }))}>
            Unassigned
          </button>
          {team.data?.map((m) => (
            <button key={m.id} type="button" className="block w-full truncate rounded-md px-3 py-2 text-left hover:bg-slate-50" onClick={() => (setAssignAnchor(null), run.mutate({ action: 'assign', assigneeId: m.id }))}>
              {m.name}
            </button>
          ))}
        </div>
      </Popover>
      <Popover anchor={snoozeAnchor} open={!!snoozeAnchor} onClose={() => setSnoozeAnchor(null)} width={220}>
        <div className="p-1 text-sm">
          {snoozeOptions().map((o) => (
            <button key={o.label} type="button" className="block w-full rounded-md px-3 py-2 text-left hover:bg-slate-50" onClick={() => (setSnoozeAnchor(null), run.mutate({ action: 'snooze', snoozedUntil: o.until.toISOString() }))}>
              {o.label}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

/** Phones have no inbox menu column, so the list title switches lists. */
function MobileViewPicker({ list }: { list: NavList }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  return (
    <div className="flex-1 md:hidden">
      <Select
        aria-label="Inbox list"
        value={list}
        onChange={(e) => {
          const next = new URLSearchParams(params);
          next.delete('c');
          if (e.target.value === 'open') next.delete('v');
          else next.set('v', e.target.value);
          navigate({ search: next.toString() });
        }}
      >
        {(Object.keys(NAV_LISTS) as NavList[]).map((k) => (
          <option key={k} value={k}>
            {NAV_LISTS[k].label}
          </option>
        ))}
        <option value="tools">Chat Tools</option>
      </Select>
    </div>
  );
}

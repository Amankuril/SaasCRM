import { Bot, ChevronDown, Inbox, MessageSquare, PanelLeftClose, PanelLeftOpen, Phone, Users, Wrench } from 'lucide-react';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { cn } from '../../components/ui';
import { CallLogsDialog, ComingSoonPanel, InstagramIcon } from './ComingSoon';
import { ChatList } from './ChatList';
import { ChatTools } from './ChatTools';
import { ConversationPanel } from './ConversationPanel';
import { PanelResizeHandle } from './PanelResizeHandle';
import { InboxHome } from './InboxHome';
import { ShortcutsDialog } from './Shortcuts';
import { NAV_LISTS, type NavList } from './navLists';
import { useInboxCounts } from './shared';

type Section = NavList | 'tools' | 'groups' | 'instagram';

const NAV_KEY = 'zc.inbox.navCollapsed';
const LIST_WIDTH_KEY = 'zc.inbox.listWidth';
const CONTACT_WIDTH_KEY = 'zc.inbox.contactWidth';
const CONTACT_OPEN_KEY = 'zc.inbox.contactOpen';
const LIST_HIDDEN_KEY = 'zc.inbox.listHidden';
/** The chat list can be dragged between these widths (px). */
const LIST_MIN = 280;
const LIST_MAX = 560;

/** A per-browser UI preference kept in localStorage (private windows just don't remember it). */
function usePref<T>(key: string, parse: (raw: string | null) => T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return parse(localStorage.getItem(key));
    } catch {
      return parse(null);
    }
  });
  const save = (v: T) => {
    setValue(v);
    try {
      if (v === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(v));
    } catch {
      /* per-browser preference only */
    }
  };
  return [value, save];
}
const widthPref = (min: number, max: number) => (raw: string | null) => (raw && Number(raw) ? Math.min(max, Math.max(min, Number(raw))) : null);

export function InboxPage() {
  const [params, setParams] = useSearchParams();
  const section = (params.get('v') ?? 'open') as Section;
  const selected = params.get('c');
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(NAV_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [callLogs, setCallLogs] = useState(false);
  // Widths are null until the user drags: the cards then keep their default responsive widths.
  const [listWidth, saveListWidth] = usePref(LIST_WIDTH_KEY, widthPref(LIST_MIN, LIST_MAX));
  const [contactWidth, saveContactWidth] = usePref(CONTACT_WIDTH_KEY, widthPref(300, 520));
  // Contact Info starts open where it fits beside the chat.
  const [contactOpen, saveContactOpen] = usePref(CONTACT_OPEN_KEY, (raw) => (raw === null ? window.matchMedia('(min-width: 1280px)').matches : raw === 'true'));
  const [listHidden, saveListHidden] = usePref(LIST_HIDDEN_KEY, (raw) => raw === 'true');
  // With a chat open, smaller screens keep the menu as icons so the conversation has room.
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1600px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1600px)');
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const [shortcuts, setShortcuts] = useState(false);

  const go = (v: Section) => setParams(v === 'open' ? {} : { v }, { replace: false });
  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('c', id);
    else next.delete('c');
    setParams(next, { replace: true });
  };
  // With a chat open on smaller screens the menu starts as icons; its button still expands it.
  const [chatNavCollapsed, setChatNavCollapsed] = useState(true);
  const autoCompact = !!selected && !wide;
  const navCollapsed = autoCompact ? chatNavCollapsed : collapsed;
  const toggleNav = () => {
    if (autoCompact) return setChatNavCollapsed(!chatNavCollapsed);
    setCollapsed(!collapsed);
    try {
      localStorage.setItem(NAV_KEY, collapsed ? '0' : '1');
    } catch {
      /* per-browser preference only */
    }
  };

  // "?" anywhere outside a text field shows the shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === '?') setShortcuts(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const list = section in NAV_LISTS ? (section as NavList) : null;

  return (
    <div className="flex h-full min-h-0 gap-3 bg-slate-100 p-3">
      <InboxNav section={section} collapsed={navCollapsed} onToggle={toggleNav} onGo={go} onCallLogs={() => setCallLogs(true)} />

      {list ? (
        <>
          {/* The chat header's left button hides the list while a chat is open. */}
          {!(selected && listHidden) && (
            <>
              <section
                className={cn('flex w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white md:min-w-[220px] md:shrink', listWidth ? 'md:w-(--list-w)' : 'md:w-80 2xl:w-96', selected && 'hidden md:flex')}
                style={listWidth ? ({ '--list-w': `${listWidth}px` } as CSSProperties) : undefined}
              >
                <ChatList key={list} list={list} selected={selected} onSelect={select} />
              </section>
              <PanelResizeHandle side="left" width={listWidth} min={LIST_MIN} max={LIST_MAX} fallback={320} onChange={saveListWidth} label="Resize chat list" />
            </>
          )}
          {selected ? (
            <ConversationPanel
              key={selected}
              id={selected}
              onBack={() => select(null)}
              layout={{
                listHidden,
                onToggleList: () => saveListHidden(!listHidden),
                contactOpen,
                onToggleContact: () => saveContactOpen(!contactOpen),
                contactWidth,
                onContactWidth: saveContactWidth,
                onShortcuts: () => setShortcuts(true),
              }}
            />
          ) : (
            <section className="hidden min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white md:flex">
              <InboxHome ai={list === 'ai'} onShortcuts={() => setShortcuts(true)} />
            </section>
          )}
        </>
      ) : section === 'tools' ? (
        <section className="min-w-0 flex-1 overflow-y-auto rounded-2xl border border-slate-200 bg-white">
          <ChatTools />
        </section>
      ) : (
        <section className="min-w-0 flex-1 overflow-y-auto rounded-2xl border border-slate-200 bg-white">
          <ComingSoonPanel kind={section === 'instagram' ? 'instagram' : 'groups'} />
        </section>
      )}

      {callLogs && <CallLogsDialog onClose={() => setCallLogs(false)} />}
      {shortcuts && <ShortcutsDialog onClose={() => setShortcuts(false)} />}
    </div>
  );
}

function InboxNav({ section, collapsed, onToggle, onGo, onCallLogs }: { section: Section; collapsed: boolean; onToggle: () => void; onGo: (s: Section) => void; onCallLogs: () => void }) {
  const counts = useInboxCounts();
  const [inboxOpen, setInboxOpen] = useState(true);
  const n = counts.data;
  const count: Partial<Record<NavList, number | undefined>> = { open: n?.all, mine: n?.mine, mentions: n?.mentions, unassigned: n?.unassigned, starred: n?.starred, waiting: n?.waiting, ai: n?.ai.active };

  const item = (key: Section, label: string, Icon: typeof Inbox, opts: { sub?: boolean; badge?: ReactNode; onClick?: () => void } = {}) => (
    <button
      key={key}
      type="button"
      onClick={opts.onClick ?? (() => onGo(key))}
      title={collapsed ? label : undefined}
      aria-current={section === key ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg text-left text-sm transition',
        collapsed ? 'justify-center px-0 py-2' : opts.sub ? 'py-1.5 pr-2 pl-7' : 'px-2.5 py-2',
        section === key ? 'bg-slate-100 font-semibold text-ink' : 'text-slate-600 hover:bg-slate-50 hover:text-ink',
      )}
    >
      <Icon className={cn('shrink-0', opts.sub ? 'size-4' : 'size-[18px]')} />
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && opts.badge}
    </button>
  );
  const countBadge = (k: NavList) => {
    const v = count[k];
    return v ? <span className={cn('rounded-full px-1.5 text-[11px] font-semibold', k === 'mentions' || k === 'waiting' ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-500')}>{v}</span> : null;
  };
  const soon = <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">Soon</span>;

  return (
    <nav aria-label="Inbox" className={cn('hidden shrink-0 flex-col overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2 transition-[width] md:flex', collapsed ? 'w-14' : 'w-60')}>
      <div className={cn('mb-2 flex items-center gap-2 border-b border-slate-100 pb-3', collapsed ? 'flex-col px-0 pt-1' : 'px-1.5 pt-1.5')}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-slate-800 text-white">
          <MessageSquare className="size-[18px]" />
        </span>
        {!collapsed && <span className="flex-1 font-semibold text-ink">Team Inbox</span>}
        <button type="button" onClick={onToggle} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label={collapsed ? 'Expand inbox menu' : 'Collapse inbox menu'}>
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      </div>

      <div className="space-y-0.5">
        {!collapsed ? (
          <button type="button" onClick={() => setInboxOpen(!inboxOpen)} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-semibold text-ink hover:bg-slate-50">
            <Inbox className="size-[18px]" /> <span className="flex-1 text-left">Your Inbox</span>
            <ChevronDown className={cn('size-4 text-slate-400 transition-transform', !inboxOpen && '-rotate-90')} />
          </button>
        ) : null}
        {(inboxOpen || collapsed) &&
          (['open', 'all', 'mine', 'mentions', 'unassigned', 'starred', 'waiting'] as const).map((k) => item(k, NAV_LISTS[k].label, NAV_LISTS[k].icon, { sub: !collapsed, badge: countBadge(k) }))}
      </div>
      <div className="my-2 border-t border-slate-100" />
      {item('groups', 'Groups', Users, { badge: soon })}
      <div className="my-2 border-t border-slate-100" />
      {item('instagram', 'Instagram Chats', InstagramIcon as typeof Inbox, { badge: soon })}
      {item('ai', NAV_LISTS.ai.label, Bot, { badge: countBadge('ai') })}
      <div className="my-2 border-t border-slate-100" />
      {item('tools', 'Chat Tools', Wrench)}
      {item('calls' as Section, 'Call Logs', Phone, { onClick: onCallLogs })}
    </nav>
  );
}


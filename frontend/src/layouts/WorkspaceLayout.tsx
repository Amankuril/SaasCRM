import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Bell,
  Blocks,
  Bot,
  CalendarClock,
  ChevronDown,
  ChevronsUpDown,
  ClipboardList,
  Code2,
  CreditCard,
  Contact,
  FileText,
  LayoutDashboard,
  ListOrdered,
  LogOut,
  Megaphone,
  Menu,
  MessageCircle,
  MessageSquare,
  Plus,
  ReceiptIndianRupee,
  ScrollText,
  Settings,
  ShieldCheck,
  UserRound,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Logo } from '../components/Logo';
import { LoadError, Spinner, cn } from '../components/ui';
import { ApiError, api, type AppNotification, type ConnectionPayload, type InboxCounts, type Permission, type WorkspaceContextPayload } from '../lib/api';
import { ROLE_INFO } from '../lib/options';
import { useRealtime } from '../lib/realtime';
import { NotFoundPage } from '../pages/NotFoundPage';
import { WorkspaceContext, useWorkspace, type WorkspaceContextValue } from './workspaceContext';

interface NavItem {
  to?: string;
  label: string;
  icon: LucideIcon;
  permission?: Permission;
  soon?: boolean;
  badge?: 'inbox';
  /** Other sections (path under the workspace) that also highlight this item. */
  alsoActive?: string[];
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Overview',
    items: [
      { to: '', label: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  {
    section: 'Conversations',
    items: [
      { to: 'inbox', label: 'Team inbox', icon: MessageSquare, badge: 'inbox' },
      { to: 'audience', label: 'Audience', icon: Contact, alsoActive: ['contacts'] },
    ],
  },
  {
    section: 'Marketing',
    items: [
      { to: 'broadcast', label: 'Broadcasts', icon: Megaphone, alsoActive: ['campaigns'] },
      { to: 'templates', label: 'Templates', icon: FileText },
    ],
  },
  {
    section: 'Automation',
    items: [
      { to: 'auto-replies', label: 'Keyword triggers', icon: Zap },
      { to: 'flows', label: 'Flow builder', icon: Workflow },
      { to: 'sequences', label: 'Sequences', icon: ListOrdered },
      { to: 'reminders', label: 'Date reminders', icon: CalendarClock },
      { to: 'forms', label: 'Forms', icon: ClipboardList },
      { to: 'ai', label: 'AI agent', icon: Bot },
      { to: 'integrations', label: 'Integrations', icon: Blocks },
    ],
  },
  {
    section: 'Insights',
    items: [
      { to: 'analytics', label: 'Analytics', icon: BarChart3, permission: 'conversations:view_all' },
      { to: 'reports/message-pricing', label: 'Message pricing', icon: ReceiptIndianRupee, permission: 'conversations:view_all' },
    ],
  },
  {
    section: 'Workspace',
    items: [
      { to: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
      { to: 'developer', label: 'Developers', icon: Code2, permission: 'developer:manage' },
      { to: 'billing', label: 'Billing & usage', icon: CreditCard },
      { to: 'settings', label: 'Settings', icon: Settings },
      { to: 'audit', label: 'Audit log', icon: ScrollText, permission: 'audit:read' },
    ],
  },
];

export function WorkspaceLayout() {
  const { workspaceId } = useParams();
  const [mobileOpen, setMobileOpen] = useState(false);
  // The inbox, flow builder and templates use the full height/width instead of the padded page container.
  const inboxRoute = useMatch('/w/:workspaceId/inbox');
  const builderRoute = useMatch('/w/:workspaceId/flows/:flowId');
  const formBuilderRoute = useMatch('/w/:workspaceId/forms/:formId');
  const templatesRoute = useMatch('/w/:workspaceId/templates/*');
  const broadcastRoute = useMatch('/w/:workspaceId/broadcast/*');
  const audienceRoute = useMatch('/w/:workspaceId/audience/*');
  const sequencesRoute = useMatch('/w/:workspaceId/sequences/*');
  const fullBleed = inboxRoute || builderRoute || formBuilderRoute || templatesRoute || broadcastRoute || audienceRoute || sequencesRoute;
  const { pathname } = useLocation();
  useRealtime(workspaceId!);

  const query = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => api.get<WorkspaceContextPayload>(`/workspaces/${workspaceId}`),
  });

  const value = useMemo<WorkspaceContextValue | null>(
    () => (query.data ? { ...query.data, can: (p) => query.data.membership.permissions.includes(p) } : null),
    [query.data],
  );

  if (query.isPending) return <Spinner />;
  if (query.error) {
    if (query.error instanceof ApiError && query.error.status === 404) return <NotFoundPage message="This workspace doesn't exist or you are not a member of it." />;
    return (
      <LoadError error={query.error} what="this workspace" onRetry={() => void query.refetch()} />
    );
  }

  return (
    <WorkspaceContext.Provider value={value}>
      <div className="flex h-full">
        {/* Mobile backdrop */}
        {mobileOpen && <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={() => setMobileOpen(false)} />}
        <Sidebar open={mobileOpen} onNavigate={() => setMobileOpen(false)} />

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar onMenu={() => setMobileOpen(true)} />

          <main className={cn('flex-1', fullBleed ? 'flex min-h-0 flex-col overflow-hidden' : 'overflow-y-auto')}>
            <SupportBanner />
            <AnnouncementBanner />
            <PlanBanner />
            {value!.workspace.status === 'suspended' && (
              <div className="border-b border-red-200 bg-red-50 px-6 py-2.5 text-sm text-red-700">
                This workspace is suspended and read-only. Contact support to restore access.
              </div>
            )}
            {fullBleed ? (
              <div className="min-h-0 flex-1">
                <ErrorBoundary resetKey={pathname}>
                  <Outlet />
                </ErrorBoundary>
              </div>
            ) : (
              <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
                <ErrorBoundary resetKey={pathname}>
                  <Outlet />
                </ErrorBoundary>
              </div>
            )}
          </main>
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}

/** A platform admin working inside a customer's workspace: make it impossible to forget. */
function SupportBanner() {
  const { workspace, supportAccess } = useWorkspace();
  if (!supportAccess) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900 px-6 py-2 text-sm text-white">
      <ShieldCheck className="size-4" />
      <span>
        Support access: you are inside <strong>{workspace.name}</strong> as owner. Every change is logged under your account.
      </span>
      <Link to={`/admin/workspaces/${workspace.id}`} className="ml-auto font-semibold underline">
        Back to Super Admin
      </Link>
    </div>
  );
}

const ANNOUNCEMENT_TONE = { info: 'border-sky-200 bg-sky-50 text-sky-800', warning: 'border-amber-200 bg-amber-50 text-amber-800', critical: 'border-red-200 bg-red-50 text-red-700' } as const;

/** Platform-wide message set from the Super Admin panel. */
function AnnouncementBanner() {
  const q = useQuery({
    queryKey: ['announcement'],
    queryFn: () => api.get<{ announcement: { text: string; tone: keyof typeof ANNOUNCEMENT_TONE } | null }>('/auth/announcement'),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const a = q.data?.announcement;
  if (!a) return null;
  return <div className={cn('border-b px-6 py-2.5 text-sm', ANNOUNCEMENT_TONE[a.tone])}>{a.text}</div>;
}

/** App-wide notice for trials ending, failed payments and read-only plans. */
function PlanBanner() {
  const { workspace, subscription: s, can } = useWorkspace();
  const billing = <Link to={`/w/${workspace.id}/billing`} className="font-semibold underline">{can('billing:manage') ? 'Choose a plan' : 'Billing'}</Link>;
  const daysLeft = (d: string | null) => (d ? Math.max(0, Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000)) : 0);
  let tone = '';
  let text: ReactNode = null;
  if (s.status === 'trialing' && daysLeft(s.trialEndsAt) <= 5) {
    tone = 'border-amber-200 bg-amber-50 text-amber-800';
    text = <>Your free trial ends in {daysLeft(s.trialEndsAt)} day(s). {billing} to keep sending.</>;
  } else if (s.status === 'past_due') {
    tone = 'border-amber-200 bg-amber-50 text-amber-800';
    text = <>Your last payment failed. Everything keeps working until {new Date(s.graceEndsAt!).toLocaleDateString()}. {billing}</>;
  } else if (!s.access) {
    tone = 'border-red-200 bg-red-50 text-red-700';
    const why = s.status === 'expired' ? 'Your free trial has ended' : s.status === 'suspended' ? 'Your subscription payment is overdue' : 'Your subscription has ended';
    text = <>{why}: sending, broadcasts and automations are paused. Your data is safe and exportable. {billing}</>;
  }
  if (!text) return null;
  return <div className={cn('border-b px-6 py-2.5 text-sm', tone)}>{text}</div>;
}

function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { user } = useAuth();
  const { workspace, membership } = useWorkspace();
  const can = (p?: Permission) => !p || membership.permissions.includes(p);
  const { pathname } = useLocation();
  const alsoActive = (item: NavItem) => (item.alsoActive ?? []).some((section) => pathname.startsWith(`/w/${workspace.id}/${section}`));

  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-slate-200 bg-slate-50 transition-transform lg:static lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <Logo />
        <button className="rounded-md p-1 text-slate-500 hover:bg-slate-100 lg:hidden" onClick={onNavigate} aria-label="Close menu">
          <X className="size-5" />
        </button>
      </div>

      <div className="px-3 pb-2">
        <WorkspaceSwitcher onNavigate={onNavigate} />
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pt-2 pb-6" aria-label="Main">
        {NAV.map((group) => {
          const items = group.items.filter((i) => can(i.permission));
          if (items.length === 0) return null;
          return (
            <div key={group.section}>
              <p className="px-2.5 pb-2 text-xs text-slate-400">{group.section}</p>
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <li key={item.label}>
                    {item.soon ? (
                      <span className="flex cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-slate-400" title="Coming in a later phase">
                        <item.icon className="size-4" />
                        {item.label}
                        <span className="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">Soon</span>
                      </span>
                    ) : (
                      <NavLink
                        to={`/w/${workspace.id}${item.to ? `/${item.to}` : ''}`}
                        end={!item.to}
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          cn(
                            'group flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors',
                            isActive || alsoActive(item)
                              ? 'bg-white font-medium text-ink ring-1 ring-slate-200 [&>svg]:text-brand-600'
                              : 'text-slate-600 hover:bg-slate-200/50 hover:text-ink [&>svg]:text-slate-400',
                          )
                        }
                      >
                        <item.icon className="size-4 shrink-0" strokeWidth={1.5} />
                        {item.label}
                        {item.badge === 'inbox' && <InboxBadge />}
                      </NavLink>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}

        {user?.isPlatformAdmin && (
          <div>
            <p className="px-2.5 pb-2 text-xs text-slate-400">Platform</p>
            <Link to="/admin" className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm text-slate-600 hover:bg-slate-200/50 hover:text-ink">
              <ShieldCheck className="size-4 text-slate-400" strokeWidth={1.5} />
              Super Admin
            </Link>
          </div>
        )}
      </nav>

    </aside>
  );
}

/** Closes a dropdown on Escape. */
function useEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);
}

/** App-wide header: business name, WhatsApp number status, notifications and the profile menu. */
function TopBar({ onMenu }: { onMenu: () => void }) {
  const { workspace, can } = useWorkspace();
  const whatsapp = useQuery({
    queryKey: ['whatsapp', workspace.id],
    queryFn: () => api.get<ConnectionPayload>(`/workspaces/${workspace.id}/whatsapp/connection`),
    staleTime: 60_000,
  });
  const conn = whatsapp.data?.connection;
  const state = whatsapp.isPending ? 'loading' : !conn ? 'none' : conn.status === 'error' ? 'error' : 'ok';
  const STATE = {
    loading: { dot: 'bg-slate-300', text: 'Checking WhatsApp…', className: 'border-slate-200 text-slate-500' },
    none: { dot: 'bg-amber-500', text: can('provider:manage') ? 'Connect WhatsApp' : 'WhatsApp not connected', className: 'border-amber-200 bg-amber-50 text-amber-800' },
    error: { dot: 'bg-red-500', text: 'WhatsApp disconnected', className: 'border-red-200 bg-red-50 text-red-700' },
    ok: { dot: 'bg-brand-500', text: conn?.displayPhoneNumber ?? 'WhatsApp connected', className: 'border-slate-200 text-slate-700 hover:bg-slate-50' },
  }[state];

  return (
    <header className="z-20 flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:gap-3 sm:px-5">
      <button className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={onMenu} aria-label="Open menu">
        <Menu className="size-5" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink">{workspace.name}</p>
        {conn?.verifiedName && conn.verifiedName !== workspace.name && <p className="hidden truncate text-xs text-slate-500 sm:block">WhatsApp name: {conn.verifiedName}</p>}
      </div>

      <Link
        to={`/w/${workspace.id}/whatsapp`}
        className={cn('inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium', STATE.className)}
        title={state === 'ok' ? `WhatsApp number connected${conn?.qualityRating ? ` · quality ${conn.qualityRating.toLowerCase()}` : ''}` : (conn?.lastError ?? STATE.text)}
      >
        <span className={cn('size-2 rounded-full', STATE.dot, state === 'ok' && 'ring-2 ring-brand-100')} />
        <MessageCircle className="size-3.5 sm:hidden" />
        <span className="hidden sm:inline">{STATE.text}</span>
      </Link>

      <NotificationBell />
      <ProfileMenu />
    </header>
  );
}

const SEEN_KEY = 'zc.notifications.seen';
const NOTE_DOT = { red: 'bg-red-500', amber: 'bg-amber-500', blue: 'bg-sky-500' } as const;

function NotificationBell() {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  useEscape(open, () => setOpen(false));
  const query = useQuery({
    queryKey: ['notifications', workspace.id],
    queryFn: () => api.get<{ notifications: AppNotification[] }>(`/workspaces/${workspace.id}/dashboard/notifications`),
    select: (d) => d.notifications,
    refetchInterval: 60_000,
  });
  // Which alerts this browser has already opened the bell for.
  const [seen, setSeen] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(`${SEEN_KEY}.${workspace.id}`) ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  const items = query.data ?? [];
  const unseen = items.filter((n) => !seen.includes(n.id)).length;
  const toggle = () => {
    setOpen(!open);
    if (open || !unseen) return;
    const ids = items.map((n) => n.id);
    setSeen(ids);
    try {
      localStorage.setItem(`${SEEN_KEY}.${workspace.id}`, JSON.stringify(ids));
    } catch {
      /* per-browser preference only */
    }
  };

  return (
    <div className="relative">
      <button onClick={toggle} className="relative rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800" aria-label={unseen ? `Notifications, ${unseen} new` : 'Notifications'} aria-expanded={open}>
        <Bell className="size-5" />
        {unseen > 0 && <span className="absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] leading-4 font-semibold text-white">{unseen}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-2 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
            <p className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-ink">Notifications</p>
            {query.isPending ? (
              <p className="px-4 py-6 text-center text-sm text-slate-500">Loading…</p>
            ) : query.error ? (
              <p className="px-4 py-6 text-center text-sm text-red-600">Could not load notifications.</p>
            ) : items.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <Bell className="mx-auto size-6 text-slate-300" />
                <p className="mt-2 text-sm font-medium text-slate-700">You&apos;re all caught up</p>
                <p className="text-xs text-slate-500">Alerts about your number, plan, chats and broadcasts show up here.</p>
              </div>
            ) : (
              <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      className="flex w-full gap-3 px-4 py-3 text-left hover:bg-slate-50"
                      onClick={() => {
                        setOpen(false);
                        navigate(`/w/${workspace.id}${n.path ? `/${n.path}` : ''}`);
                      }}
                    >
                      <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', NOTE_DOT[n.tone])} />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-800">{n.title}</span>
                        <span className="block text-xs text-slate-500">{n.detail}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ProfileMenu() {
  const { user, logout } = useAuth();
  const { workspace, membership } = useWorkspace();
  const [open, setOpen] = useState(false);
  useEscape(open, () => setOpen(false));
  const item = 'flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50';
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 rounded-full p-1 hover:bg-slate-100 sm:pr-2" aria-label="Profile menu" aria-expanded={open}>
        <span className="flex size-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">{initials(user?.name ?? '')}</span>
        <span className="hidden max-w-32 truncate text-sm font-medium text-slate-700 md:block">{user?.name}</span>
        <ChevronDown className="hidden size-4 text-slate-400 md:block" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-2 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl" onClick={() => setOpen(false)}>
            <div className="border-b border-slate-100 px-4 py-3">
              <p className="truncate text-sm font-semibold text-ink">{user?.name}</p>
              <p className="truncate text-xs text-slate-500">{user?.email}</p>
              <p className="mt-1 text-xs text-slate-500">{ROLE_INFO[membership.role].label}</p>
            </div>
            <Link to={`/w/${workspace.id}/settings`} className={item}>
              <UserRound className="size-4 text-slate-400" /> Profile &amp; settings
            </Link>
            <Link to={`/w/${workspace.id}/billing`} className={item}>
              <CreditCard className="size-4 text-slate-400" /> Billing &amp; usage
            </Link>
            {user?.isPlatformAdmin && (
              <Link to="/admin" className={item}>
                <ShieldCheck className="size-4 text-slate-400" /> Super Admin
              </Link>
            )}
            <div className="my-1 border-t border-slate-100" />
            <button onClick={() => void logout()} className={cn(item, 'text-red-600 hover:bg-red-50')}>
              <LogOut className="size-4" /> Log out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function WorkspaceSwitcher({ onNavigate }: { onNavigate: () => void }) {
  const { workspaces } = useAuth();
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-left transition-colors hover:border-slate-300"
        aria-expanded={open}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-slate-200 text-xs font-medium text-slate-700">
          {initials(workspace.name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{workspace.name}</span>
        <ChevronsUpDown className="size-4 text-slate-400" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 z-20 mt-1 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                onClick={() => {
                  setOpen(false);
                  onNavigate();
                  navigate(`/w/${ws.id}`);
                }}
                className={cn('flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50', ws.id === workspace.id && 'font-medium text-brand-700')}
              >
                <span className="truncate">{ws.name}</span>
                <span className="ml-2 text-xs text-slate-400">{ROLE_INFO[ws.role].label}</span>
              </button>
            ))}
            <div className="my-1 border-t border-slate-100" />
            <Link to="/onboarding" className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
              <Plus className="size-4" /> Create workspace
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function InboxBadge() {
  const { workspace } = useWorkspace();
  const counts = useQuery({
    queryKey: ['conversation-counts', workspace.id],
    queryFn: () => api.get<InboxCounts>(`/workspaces/${workspace.id}/conversations/counts`),
  });
  // Chats with unread messages: drops the moment a chat is opened.
  const n = counts.data?.unread.chats ?? 0;
  return n > 0 ? <span className="ml-auto text-xs font-medium text-brand-700 tabular-nums">{n}</span> : null;
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('') || '?'
  );
}

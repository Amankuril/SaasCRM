import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Bot,
  ChevronsUpDown,
  ClipboardList,
  Code2,
  CreditCard,
  Contact,
  FileText,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  MessageCircle,
  MessageSquare,
  Plus,
  ScrollText,
  Settings,
  ShieldCheck,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Logo';
import { Alert, Spinner, cn } from '../components/ui';
import { ApiError, api, type Permission, type WorkspaceContextPayload } from '../lib/api';
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
      { to: 'analytics', label: 'Analytics', icon: BarChart3, permission: 'conversations:view_all' },
    ],
  },
  {
    section: 'Conversations',
    items: [
      { to: 'inbox', label: 'Team Inbox', icon: MessageSquare, badge: 'inbox' },
      { to: 'contacts', label: 'Contacts', icon: Contact },
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
      { to: 'auto-replies', label: 'Keyword Trigger', icon: Zap },
      { to: 'flows', label: 'Flow Builder', icon: Workflow },
      { to: 'forms', label: 'Forms', icon: ClipboardList },
      { to: 'ai', label: 'AI Agent', icon: Bot },
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
  const templatesRoute = useMatch('/w/:workspaceId/templates/*');
  const broadcastRoute = useMatch('/w/:workspaceId/broadcast/*');
  const campaignsRoute = useMatch('/w/:workspaceId/campaigns/*');
  const fullBleed = inboxRoute || builderRoute || templatesRoute || broadcastRoute || campaignsRoute;
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
      <div className="p-6">
        <Alert>Could not load this workspace. Please refresh the page.</Alert>
      </div>
    );
  }

  return (
    <WorkspaceContext.Provider value={value}>
      <div className="flex h-full">
        {/* Mobile backdrop */}
        {mobileOpen && <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={() => setMobileOpen(false)} />}
        <Sidebar open={mobileOpen} onNavigate={() => setMobileOpen(false)} />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
            <button className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100" onClick={() => setMobileOpen(true)} aria-label="Open menu">
              <Menu className="size-5" />
            </button>
            <span className="truncate text-sm font-semibold text-ink">{value!.workspace.name}</span>
          </header>

          <main className={cn('flex-1', fullBleed ? 'flex min-h-0 flex-col overflow-hidden' : 'overflow-y-auto')}>
            <PlanBanner />
            {value!.workspace.status === 'suspended' && (
              <div className="border-b border-red-200 bg-red-50 px-6 py-2.5 text-sm text-red-700">
                This workspace is suspended and read-only. Contact support to restore access.
              </div>
            )}
            {fullBleed ? (
              <div className="min-h-0 flex-1">
                <Outlet />
              </div>
            ) : (
              <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
                <Outlet />
              </div>
            )}
          </main>
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
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
  const { user, logout } = useAuth();
  const { workspace, membership } = useWorkspace();
  const can = (p?: Permission) => !p || membership.permissions.includes(p);
  const { pathname } = useLocation();
  const alsoActive = (item: NavItem) => (item.alsoActive ?? []).some((section) => pathname.startsWith(`/w/${workspace.id}/${section}`));

  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform lg:static lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <Logo />
        <button className="rounded-md p-1 text-slate-500 hover:bg-slate-100 lg:hidden" onClick={onNavigate} aria-label="Close menu">
          <X className="size-5" />
        </button>
      </div>

      <div className="px-3 pb-2">
        <WorkspaceSwitcher onNavigate={onNavigate} />
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {NAV.map((group) => {
          const items = group.items.filter((i) => can(i.permission));
          if (items.length === 0) return null;
          return (
            <div key={group.section}>
              <p className="px-2 pb-1 text-xs font-medium tracking-wide text-slate-400 uppercase">{group.section}</p>
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <li key={item.label}>
                    {item.soon ? (
                      <span className="flex cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-slate-400" title="Coming in a later phase">
                        <item.icon className="size-4" />
                        {item.label}
                        <span className="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">Soon</span>
                      </span>
                    ) : (
                      <NavLink
                        to={`/w/${workspace.id}${item.to ? `/${item.to}` : ''}`}
                        end={!item.to}
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          cn(
                            'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium',
                            isActive || alsoActive(item) ? 'bg-brand-50 text-brand-700' : 'text-slate-700 hover:bg-slate-100',
                          )
                        }
                      >
                        <item.icon className="size-4" />
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
            <p className="px-2 pb-1 text-xs font-medium tracking-wide text-slate-400 uppercase">Platform</p>
            <Link to="/admin" className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
              <ShieldCheck className="size-4" />
              Super Admin
            </Link>
          </div>
        )}
      </nav>

      <div className="flex items-center gap-3 border-t border-slate-200 p-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
          {initials(user?.name ?? '')}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-800">{user?.name}</p>
          <p className="truncate text-xs text-slate-500">{ROLE_INFO[membership.role].label}</p>
        </div>
        <button onClick={() => void logout()} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700" aria-label="Log out" title="Log out">
          <LogOut className="size-4" />
        </button>
      </div>
    </aside>
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
        className="flex w-full items-center gap-2.5 rounded-lg border border-slate-200 px-2.5 py-2 text-left hover:bg-slate-50"
        aria-expanded={open}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-slate-800 text-xs font-semibold text-white">
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
    queryFn: () => api.get<{ all: number; mine: number; unassigned: number }>(`/workspaces/${workspace.id}/conversations/counts`),
  });
  const n = counts.data ? counts.data.mine + counts.data.unassigned : 0;
  return n > 0 ? <span className="ml-auto rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold text-white">{n}</span> : null;
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

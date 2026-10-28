import { Activity, ArrowLeftRight, Building2, History, LayoutDashboard, Layers, LogOut, Menu, Settings2, Users, X, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { initials } from '../components/crm';
import { Logo } from '../components/Logo';
import { cn } from '../components/ui';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Other paths under /admin that also highlight this item. */
  alsoActive?: string[];
}

const NAV: { section: string; items: NavItem[] }[] = [
  { section: 'Overview', items: [{ to: '', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    section: 'Customers',
    items: [
      { to: 'businesses', label: 'Businesses', icon: Building2, alsoActive: ['workspaces'] },
      { to: 'users', label: 'Users', icon: Users },
    ],
  },
  { section: 'Billing', items: [{ to: 'plans', label: 'Plans', icon: Layers }] },
  {
    section: 'Platform',
    items: [
      { to: 'operations', label: 'Operations', icon: Activity },
      { to: 'activity', label: 'Activity & audit', icon: History },
      { to: 'settings', label: 'Platform settings', icon: Settings2 },
    ],
  },
];

/** Super Admin shell: same structure as the business app, with a dark sidebar. */
export function AdminLayout() {
  const { user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  if (!user?.isPlatformAdmin) return <Navigate to="/" replace />;

  return (
    <div className="flex h-full">
      {mobileOpen && <div className="fixed inset-0 z-30 bg-slate-900/60 lg:hidden" onClick={() => setMobileOpen(false)} />}
      <Sidebar open={mobileOpen} onNavigate={() => setMobileOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-800 bg-slate-900 px-4 py-3 lg:hidden">
          <button className="rounded-md p-1.5 text-slate-300 hover:bg-slate-800" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <span className="truncate text-sm font-semibold text-white">Super Admin</span>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { user, workspaces, logout } = useAuth();
  const { pathname } = useLocation();
  const alsoActive = (item: NavItem) => (item.alsoActive ?? []).some((p) => pathname.startsWith(`/admin/${p}`));

  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-800 bg-slate-900 transition-transform lg:static lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <Logo light />
        <button className="rounded-md p-1 text-slate-400 hover:bg-slate-800 lg:hidden" onClick={onNavigate} aria-label="Close menu">
          <X className="size-5" />
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2.5 rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-emerald-500 text-xs font-bold text-slate-900">SA</span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">Super Admin</p>
            <p className="truncate text-[11px] text-slate-400">Platform control</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {NAV.map((group) => (
          <div key={group.section}>
            <p className="px-2 pb-1 text-xs font-medium tracking-wide text-slate-500 uppercase">{group.section}</p>
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.label}>
                  <NavLink
                    to={`/admin${item.to ? `/${item.to}` : ''}`}
                    end={!item.to}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium',
                        isActive || alsoActive(item) ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800/70 hover:text-white',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon className={cn('size-4', isActive || alsoActive(item) ? 'text-emerald-400' : 'text-slate-400')} />
                        {item.label}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}

        {/* An admin without a business has no app to go back to ("/" leads here). */}
        {workspaces.length > 0 && (
          <div>
            <p className="px-2 pb-1 text-xs font-medium tracking-wide text-slate-500 uppercase">Your app</p>
            <Link to="/" onClick={onNavigate} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium text-slate-300 hover:bg-slate-800/70 hover:text-white">
              <ArrowLeftRight className="size-4 text-slate-400" />
              Back to my business
            </Link>
          </div>
        )}
      </nav>

      <div className="flex items-center gap-3 border-t border-slate-800 p-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-700 text-sm font-semibold text-white">{initials(user?.name ?? '')}</div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{user?.name}</p>
          <p className="truncate text-xs text-slate-400">Platform admin</p>
        </div>
        <button onClick={() => void logout('/admin/login')} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Log out" title="Log out">
          <LogOut className="size-4" />
        </button>
      </div>
    </aside>
  );
}

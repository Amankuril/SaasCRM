import { BookOpen, ChevronLeft, ChevronRight, ListChecks, Megaphone, Radio, Repeat, Users, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet, useMatch } from 'react-router';
import { cn } from '../../components/ui';
import { useWorkspace } from '../../layouts/workspaceContext';

const COLLAPSE_KEY = 'broadcast.navCollapsed';

/** Broadcast area: contact lists and campaigns, with a secondary nav like Templates. */
export function BroadcastLayout() {
  const { workspace, can } = useWorkspace();
  // Create Campaign and Campaign List are separate pages: each one highlights only itself.
  const onCreate = useMatch('/w/:workspaceId/broadcast/campaigns/new');
  const onList = useMatch('/w/:workspaceId/broadcast/campaigns');
  const onCampaign = useMatch('/w/:workspaceId/broadcast/campaigns/:campaignId');
  const onRetarget = useMatch('/w/:workspaceId/broadcast/retarget');
  const onGuide = useMatch('/w/:workspaceId/broadcast/guide');
  const onReport = !!onCampaign && !onCreate;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setCollapsed(!collapsed);
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '0' : '1');
    } catch {
      // Remembering the choice is a nicety only.
    }
  };

  const canCreate = can('campaigns:manage') && workspace.status !== 'suspended';

  const item = (opts: { to?: string; label: string; icon: LucideIcon; end?: boolean; onClick?: () => void; soon?: boolean; active?: boolean }) => {
    const className = (active: boolean) =>
      cn(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
        active ? 'bg-white text-ink shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white/70',
        collapsed && 'justify-center px-0',
        opts.soon && 'cursor-not-allowed opacity-60 hover:bg-transparent',
      );
    const content = (
      <>
        <opts.icon className="size-4 shrink-0" />
        {!collapsed && <span className="flex-1 text-left">{opts.label}</span>}
        {!collapsed && opts.soon && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500">Soon</span>}
      </>
    );
    if (opts.to) {
      return (
        <NavLink key={opts.label} to={opts.to} end={opts.end} title={collapsed ? opts.label : undefined} className={({ isActive }) => className(isActive || !!opts.active)}>
          {content}
        </NavLink>
      );
    }
    return (
      <button key={opts.label} type="button" disabled={opts.soon} onClick={opts.onClick} title={opts.soon ? 'Coming soon' : collapsed ? opts.label : undefined} className={className(false)}>
        {content}
      </button>
    );
  };

  const base = `/w/${workspace.id}`;
  const crumb = onCreate ? 'Create Campaign' : onList || onReport ? 'Campaign List' : onRetarget ? 'Retarget Campaign' : onGuide ? 'User Guide' : 'Contacts List';
  const items = [
    item({ to: `${base}/broadcast`, label: 'Contacts List', icon: Users, end: true }),
    ...(canCreate ? [item({ to: `${base}/broadcast/campaigns/new`, label: 'Create Campaign', icon: Megaphone, end: true })] : []),
    item({ to: `${base}/broadcast/campaigns`, label: 'Campaign List', icon: ListChecks, end: true, active: onReport }),
    item({ to: `${base}/broadcast/retarget`, label: 'Retarget Campaign', icon: Repeat }),
    item({ to: `${base}/broadcast/guide`, label: 'User Guide', icon: BookOpen }),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 md:hidden" aria-label="Broadcast">
        {items}
      </nav>
      <aside className={cn('relative hidden shrink-0 border-r border-slate-200 bg-slate-50 transition-[width] md:block', collapsed ? 'w-16' : 'w-56')}>
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-4">
          <span className="rounded-full bg-indigo-50 p-2 text-indigo-600 ring-1 ring-indigo-100">
            <Radio className="size-4" />
          </span>
          {!collapsed && (
            <div>
              <p className="text-sm font-semibold text-ink">Broadcast</p>
              <p className="text-xs text-slate-500">Campaigns &amp; contacts</p>
            </div>
          )}
        </div>
        <button
          onClick={toggle}
          className="absolute top-16 -right-3 z-10 rounded-full border border-slate-200 bg-white p-0.5 text-slate-500 shadow-sm hover:text-ink"
          aria-label={collapsed ? 'Expand broadcast menu' : 'Collapse broadcast menu'}
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
        </button>
        <div className="space-y-1 p-3">{items}</div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <nav aria-label="Breadcrumb" className="flex shrink-0 items-center gap-1.5 border-b border-slate-200 bg-white px-4 py-2 text-xs text-slate-500 sm:px-6">
          <Link to={`${base}/broadcast`} className="hover:text-ink">
            Broadcast
          </Link>
          <ChevronRight className="size-3.5 text-slate-300" />
          <span className="font-medium text-ink" aria-current="page">
            {crumb}
          </span>
        </nav>
        {onCampaign ? (
          // A campaign page manages its own scrolling (the builder has a sticky action bar).
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Outlet />
          </div>
        ) : (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
              <Outlet />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

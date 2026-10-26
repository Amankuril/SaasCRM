import { useMutation } from '@tanstack/react-query';
import { BookOpen, ChevronLeft, ChevronRight, ListChecks, Loader2, Megaphone, Radio, Repeat, Users, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useMatch, useNavigate } from 'react-router';
import { cn } from '../../components/ui';
import { api, type Campaign } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';

const COLLAPSE_KEY = 'broadcast.navCollapsed';

/** Broadcast area: contact lists and campaigns, with a secondary nav like Templates. */
export function BroadcastLayout() {
  const { workspace, can } = useWorkspace();
  const navigate = useNavigate();
  const onCampaign = useMatch('/w/:workspaceId/campaigns/:campaignId');
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

  const create = useMutation({
    mutationFn: () => api.post<{ campaign: Campaign }>(`/workspaces/${workspace.id}/campaigns`, { name: 'Untitled campaign' }),
    onSuccess: ({ campaign }) => navigate(`/w/${workspace.id}/campaigns/${campaign.id}`),
  });
  const canCreate = can('campaigns:manage') && workspace.status !== 'suspended';

  const item = (opts: { to?: string; label: string; icon: LucideIcon; end?: boolean; onClick?: () => void; soon?: boolean; active?: boolean; busy?: boolean }) => {
    const className = (active: boolean) =>
      cn(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
        active ? 'bg-white text-ink shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white/70',
        collapsed && 'justify-center px-0',
        opts.soon && 'cursor-not-allowed opacity-60 hover:bg-transparent',
      );
    const content = (
      <>
        {opts.busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <opts.icon className="size-4 shrink-0" />}
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
      <button key={opts.label} type="button" disabled={opts.soon || opts.busy} onClick={opts.onClick} title={opts.soon ? 'Coming soon' : collapsed ? opts.label : undefined} className={className(false)}>
        {content}
      </button>
    );
  };

  const base = `/w/${workspace.id}`;
  const items = [
    item({ to: `${base}/broadcast`, label: 'Contacts List', icon: Users, end: true }),
    ...(canCreate ? [item({ label: 'Create Campaign', icon: Megaphone, onClick: () => create.mutate(), busy: create.isPending })] : []),
    item({ to: `${base}/campaigns`, label: 'Campaign List', icon: ListChecks, active: !!onCampaign }),
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
        {create.error != null && !collapsed && <p className="px-4 text-xs text-red-600">Could not create the campaign. Try again.</p>}
      </aside>
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
  );
}

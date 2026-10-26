import { AlarmClock, BarChart3, Bookmark, CalendarCheck, ChevronLeft, ChevronRight, Columns3, KanbanSquare, LineChart, Users, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { cn } from '../../components/ui';
import { useWorkspace } from '../../layouts/workspaceContext';

interface Item {
  to?: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  end?: boolean;
  child?: boolean;
}

const SECTIONS: { title: string; items: Item[] }[] = [
  {
    title: 'Workspace',
    items: [
      { to: '', label: 'Audience', hint: 'All customers', icon: Users, end: true },
      { to: 'segments', label: 'Segments', hint: 'Saved filters', icon: Bookmark, child: true },
      { label: 'Sales Pipeline', hint: 'Lifecycle stages', icon: Columns3 },
      { label: 'Ticket / Task Board', hint: 'Tasks & tickets', icon: KanbanSquare },
      { to: 'follow-ups', label: 'Follow-ups', hint: 'Scheduled follow-ups', icon: AlarmClock },
      { label: 'Appointments', hint: 'AI-booked appointments', icon: CalendarCheck },
    ],
  },
  {
    title: 'Insights',
    items: [
      { label: 'Task Analytics', hint: 'Team performance', icon: BarChart3 },
      { label: 'Sales Analytics', hint: 'Pipeline & Conversions', icon: LineChart },
    ],
  },
];

const COLLAPSE_KEY = 'audience.navCollapsed';

/** Audience area: a secondary nav beside the customer pages. Items without a page yet show "Soon". */
export function AudienceLayout() {
  const { workspace } = useWorkspace();
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
  const base = `/w/${workspace.id}/audience`;

  const render = (item: Item) => {
    const body = (
      <>
        <item.icon className="mt-0.5 size-4 shrink-0 text-slate-600" />
        {!collapsed && (
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
              {item.label}
              {item.to === undefined && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">Soon</span>}
            </span>
            <span className="block text-xs text-slate-500">{item.hint}</span>
          </span>
        )}
      </>
    );
    const cls = cn('flex items-start gap-3 rounded-lg px-2.5 py-2', collapsed && 'justify-center', item.child && !collapsed && 'ml-5 border-l border-slate-200 pl-3');
    if (item.to === undefined) {
      return (
        <div key={item.label} className={cn(cls, 'cursor-not-allowed opacity-60')} title={collapsed ? `${item.label} (soon)` : 'Coming soon'}>
          {body}
        </div>
      );
    }
    return (
      <NavLink key={item.label} to={item.to ? `${base}/${item.to}` : base} end={item.end} title={collapsed ? item.label : undefined} className={({ isActive }) => cn(cls, isActive ? 'bg-slate-100' : 'hover:bg-slate-50')}>
        {body}
      </NavLink>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 md:hidden" aria-label="Audience">
        {SECTIONS.flatMap((s) => s.items)
          .filter((i) => i.to !== undefined)
          .map((i) => (
            <NavLink key={i.label} to={i.to ? `${base}/${i.to}` : base} end={i.end} className={({ isActive }) => cn('shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium', isActive ? 'bg-slate-100 text-ink' : 'text-slate-500')}>
              {i.label}
            </NavLink>
          ))}
      </nav>
      <aside className={cn('relative hidden shrink-0 border-r border-slate-200 bg-white transition-[width] md:block', collapsed ? 'w-16' : 'w-60')}>
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-4">
          <span className="rounded-lg bg-slate-700 p-2 text-white">
            <Users className="size-4" />
          </span>
          {!collapsed && (
            <div>
              <p className="text-sm font-semibold text-ink">Audience</p>
              <p className="text-xs text-slate-500">Customer pipeline</p>
            </div>
          )}
        </div>
        <button
          onClick={toggle}
          className="absolute top-16 -right-3 z-10 rounded-full border border-slate-200 bg-white p-0.5 text-slate-500 shadow-sm hover:text-ink"
          aria-label={collapsed ? 'Expand audience menu' : 'Collapse audience menu'}
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
        </button>
        <nav className="space-y-5 overflow-y-auto p-3" aria-label="Audience">
          {SECTIONS.map((s) => (
            <div key={s.title}>
              {!collapsed && <p className="mb-1.5 px-2 text-xs font-semibold tracking-wider text-slate-400 uppercase">{s.title}</p>}
              <div className="space-y-0.5">{s.items.map(render)}</div>
            </div>
          ))}
        </nav>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-slate-50/50">
        <Outlet />
      </div>
    </div>
  );
}

import { BookOpen, ChevronLeft, ChevronRight, FileText, LayoutList, Library, SquarePlus, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { cn } from '../../components/ui';

const SECTIONS: { title: string; items: { to: string; label: string; hint: string; icon: LucideIcon; end?: boolean }[] }[] = [
  {
    title: 'Templates',
    items: [
      { to: '', label: 'All Templates', hint: 'Manage your templates', icon: LayoutList, end: true },
      { to: 'new', label: 'Create Template', hint: 'New message template', icon: SquarePlus },
    ],
  },
  {
    title: 'Libraries',
    items: [
      { to: 'library', label: 'Meta Library', hint: 'Meta official templates', icon: Library },
      { to: 'community', label: 'Community Library', hint: 'Community templates', icon: BookOpen },
    ],
  },
];

const COLLAPSE_KEY = 'templates.navCollapsed';

/** Templates area: a secondary nav (like Inbox) beside the current templates page. */
export function TemplatesLayout() {
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

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* Mobile: the sections as a scrollable tab strip. */}
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 md:hidden" aria-label="Templates">
        {SECTIONS.flatMap((s) => s.items).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => cn('shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium', isActive ? 'bg-slate-100 text-ink' : 'text-slate-500')}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <aside className={cn('relative hidden shrink-0 border-r border-slate-200 bg-white transition-[width] md:block', collapsed ? 'w-16' : 'w-56')}>
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-4">
          <span className="rounded-lg bg-slate-700 p-2 text-white">
            <FileText className="size-4" />
          </span>
          {!collapsed && (
            <div>
              <p className="text-sm font-semibold text-ink">Templates</p>
              <p className="text-xs text-slate-500">WhatsApp message templates</p>
            </div>
          )}
        </div>
        <button
          onClick={toggle}
          className="absolute top-16 -right-3 z-10 rounded-full border border-slate-200 bg-white p-0.5 text-slate-500 shadow-sm hover:text-ink"
          aria-label={collapsed ? 'Expand templates menu' : 'Collapse templates menu'}
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
        </button>
        <nav className="space-y-5 p-3" aria-label="Templates">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              {!collapsed && <p className="mb-1.5 px-2 text-xs font-semibold tracking-wider text-slate-400 uppercase">{section.title}</p>}
              <div className="space-y-1">
                {section.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      cn(
                        'flex items-start gap-3 rounded-lg px-2.5 py-2 transition-colors',
                        isActive ? 'bg-slate-100 shadow-[inset_2px_0_0] shadow-slate-700' : 'hover:bg-slate-50',
                        collapsed && 'justify-center',
                      )
                    }
                  >
                    <item.icon className="mt-0.5 size-4 shrink-0 text-slate-600" />
                    {!collapsed && (
                      <span>
                        <span className="block text-sm font-medium text-slate-800">{item.label}</span>
                        <span className="block text-xs text-slate-500">{item.hint}</span>
                      </span>
                    )}
                  </NavLink>
                ))}
              </div>
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

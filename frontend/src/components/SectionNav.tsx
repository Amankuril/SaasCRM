import type { LucideIcon } from 'lucide-react';
import { NavLink } from 'react-router';
import { cn } from './ui';

export interface SectionItem {
  /** Full path; leave out for sections that are not available yet. */
  to?: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Also highlighted on pages outside its own path. */
  active?: boolean;
  onSelect?: () => void;
}

const itemClass = (active: boolean, soon = false) =>
  cn(
    '-mb-px flex h-11 shrink-0 items-center gap-2 border-b-2 text-sm font-medium transition-colors',
    active ? 'border-brand-600 text-ink' : 'border-transparent text-slate-500',
    soon ? 'cursor-not-allowed text-slate-400' : !active && 'hover:text-ink',
  );

/** The one secondary navigation of the app: a tab row under the top bar, the same in every area. */
export function SectionNav({ label, items, className }: { label: string; items: SectionItem[]; className?: string }) {
  return (
    <nav aria-label={label} className={cn('no-scrollbar flex shrink-0 gap-6 overflow-x-auto overflow-y-hidden border-b border-slate-200 bg-white px-4 sm:px-6', className)}>
      {items.map((item) => {
        const body = (
          <>
            <item.icon className="size-4 shrink-0" strokeWidth={1.5} />
            {item.label}
          </>
        );
        if (item.onSelect) {
          return (
            <button key={item.label} type="button" onClick={item.onSelect} aria-current={item.active ? 'page' : undefined} className={itemClass(!!item.active)}>
              {body}
            </button>
          );
        }
        if (!item.to) {
          return (
            <span key={item.label} className={itemClass(false, true)} title="Not available yet" aria-disabled>
              {body} <span className="text-xs font-normal">Soon</span>
            </span>
          );
        }
        return (
          <NavLink key={item.label} to={item.to} end={item.end} className={({ isActive }) => itemClass(isActive || !!item.active)}>
            {body}
          </NavLink>
        );
      })}
    </nav>
  );
}

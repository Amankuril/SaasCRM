import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './ui';

/** Modal with an icon header, scrollable body and an optional footer bar. */
export function Dialog({ icon, title, subtitle, onClose, children, footer, width = 'max-w-md' }: { icon: ReactNode; title: string; subtitle: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:items-center" onClick={onClose}>
      <div className={cn('w-full overflow-hidden rounded-2xl bg-white shadow-xl', width)} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-start gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4">
          <span className="rounded-lg bg-white p-2 text-emerald-600 ring-1 ring-slate-200">{icon}</span>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-ink">{title}</h2>
            <p className="truncate text-xs text-slate-500">{subtitle}</p>
          </div>
          <button onClick={onClose} className="rounded-full p-1 text-slate-500 ring-1 ring-slate-300 hover:bg-white" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

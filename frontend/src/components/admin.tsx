import { AlertTriangle, Loader2, MoreHorizontal, X, type LucideIcon } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from './ui';

// Super Admin UI kit: quieter, denser controls than the business app.

type Variant = 'primary' | 'outline' | 'subtle' | 'danger' | 'danger-outline';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-slate-900 text-white shadow-sm hover:bg-slate-800 active:bg-slate-950',
  outline: 'bg-white text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.06)] ring-1 ring-inset ring-slate-200 hover:bg-slate-50 hover:text-slate-900 hover:ring-slate-300',
  subtle: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700',
  'danger-outline': 'bg-white text-red-600 shadow-[0_1px_2px_rgba(15,23,42,0.06)] ring-1 ring-inset ring-red-200 hover:bg-red-50',
};
const SIZE: Record<Size, string> = { sm: 'h-8 gap-1.5 px-2.5 text-[13px]', md: 'h-9 gap-2 px-3.5 text-sm' };

export function AButton({
  variant = 'outline',
  size = 'md',
  icon: Icon,
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: LucideIcon; loading?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:pointer-events-none disabled:opacity-50',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : Icon && <Icon className="size-4 shrink-0" aria-hidden />}
      {children}
    </button>
  );
}

/** Same look as AButton, for navigation. */
export function ALink({ to, variant = 'outline', size = 'md', icon: Icon, className, children }: { to: string; variant?: Variant; size?: Size; icon?: LucideIcon; className?: string; children: ReactNode }) {
  return (
    <Link to={to} className={cn('inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors', VARIANT[variant], SIZE[size], className)}>
      {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
      {children}
    </Link>
  );
}

export function IconButton({ icon: Icon, label, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={cn('inline-flex size-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40', className)} {...props}>
      <Icon className="size-4" />
    </button>
  );
}

// ---- Row actions menu ----

export type MenuItem =
  | { label: string; icon?: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | { label: string; icon?: LucideIcon; to: string }
  | 'separator';

export function ActionMenu({ items, label = 'More actions' }: { items: MenuItem[]; label?: string }) {
  // Fixed position from the trigger, so tables with overflow never clip the menu.
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = pos !== null;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setPos(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPos(null);
    const close = () => setPos(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);
  const toggle = () => {
    if (open) return setPos(null);
    const r = ref.current!.getBoundingClientRect();
    const right = window.innerWidth - r.right;
    // Open upwards when there is not enough room below.
    setPos(window.innerHeight - r.bottom < 260 ? { bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right });
  };

  const itemClass = 'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px]';
  return (
    <div ref={ref} className="inline-block text-left">
      <IconButton icon={MoreHorizontal} label={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle} className={open ? 'bg-slate-100 text-slate-900' : undefined} />
      {pos && (
        <div ref={menuRef} role="menu" style={{ top: pos.top, bottom: pos.bottom, right: pos.right }} className="fixed z-50 w-56 rounded-xl border border-slate-200 bg-white p-1 shadow-lg shadow-slate-900/10">
          {items.map((item, i) =>
            item === 'separator' ? (
              <div key={i} className="my-1 border-t border-slate-100" />
            ) : 'to' in item ? (
              <Link key={i} role="menuitem" to={item.to} onClick={() => setPos(null)} className={cn(itemClass, 'text-slate-700 hover:bg-slate-50 hover:text-slate-900')}>
                {item.icon && <item.icon className="size-4 text-slate-400" />}
                {item.label}
              </Link>
            ) : (
              <button
                key={i}
                role="menuitem"
                disabled={item.disabled}
                title={item.hint}
                onClick={() => {
                  setPos(null);
                  item.onSelect();
                }}
                className={cn(itemClass, 'disabled:cursor-not-allowed disabled:opacity-40', item.danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-700 hover:bg-slate-50 hover:text-slate-900')}
              >
                {item.icon && <item.icon className={cn('size-4', item.danger ? 'text-red-500' : 'text-slate-400')} />}
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ---- Layout pieces ----

export function AdminHeader({ title, description, eyebrow, actions }: { title: ReactNode; description?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs font-medium tracking-wide text-slate-500 uppercase">{eyebrow}</div>}
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ title, description, actions, children, className, flush = false }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cn('overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? undefined : 'p-5'}>{children}</div>
    </section>
  );
}

/** Pill-shaped tab switch. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-[13px]" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('rounded-md px-3 py-1.5 font-medium transition-colors', value === o.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled, tone = 'emerald' }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; tone?: 'emerald' | 'red' }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', checked ? (tone === 'red' ? 'bg-red-600' : 'bg-emerald-600') : 'bg-slate-300')}
    >
      <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

/** Small key/value list used in detail panels. */
export function DetailList({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-slate-100 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 px-5 py-2.5">
          <dt className="shrink-0 text-slate-500">{k}</dt>
          <dd className="min-w-0 text-right break-words text-slate-800">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---- Confirm / prompt dialogs (replace window.confirm / window.prompt) ----

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  tone?: 'default' | 'danger';
  /** Ask for text. With `match`, the confirm button stays disabled until it is typed exactly. */
  input?: { label: string; placeholder?: string; initial?: string; required?: boolean; match?: string; type?: string };
}
type Pending = ConfirmOptions & { resolve: (v: string | null) => void };

const ConfirmContext = createContext<((o: ConfirmOptions) => Promise<string | null>) | null>(null);

/** `await confirm({...})` resolves to the typed text ('' without an input), or null when cancelled. */
export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm needs <ConfirmProvider>');
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [text, setText] = useState('');
  const ask = useCallback((o: ConfirmOptions) => new Promise<string | null>((resolve) => {
    setText(o.input?.initial ?? '');
    setPending({ ...o, resolve });
  }), []);
  const close = (v: string | null) => {
    pending?.resolve(v);
    setPending(null);
  };
  const danger = pending?.tone === 'danger';
  const blocked = !!pending?.input && ((pending.input.required && !text.trim()) || (pending.input.match !== undefined && text !== pending.input.match));

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {pending && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center bg-slate-900/50 p-4 backdrop-blur-[2px] sm:items-center" onMouseDown={() => close(null)}>
          <form
            role="alertdialog"
            aria-modal="true"
            aria-label={pending.title}
            className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === 'Escape' && close(null)}
            onSubmit={(e) => {
              e.preventDefault();
              if (!blocked) close(pending.input ? text : '');
            }}
          >
            <div className="flex gap-4 p-6">
              <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-full', danger ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-700')}>
                <AlertTriangle className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-base font-semibold text-ink">{pending.title}</h2>
                  <IconButton icon={X} label="Close" className="-mt-1 -mr-2" onClick={() => close(null)} />
                </div>
                {pending.message && <div className="mt-1.5 text-sm text-slate-600">{pending.message}</div>}
                {pending.input && (
                  <label className="mt-4 block">
                    <span className="mb-1.5 block text-[13px] font-medium text-slate-700">{pending.input.label}</span>
                    <input
                      autoFocus
                      type={pending.input.type ?? 'text'}
                      value={text}
                      placeholder={pending.input.placeholder}
                      onChange={(e) => setText(e.target.value)}
                      className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10 focus:outline-none"
                    />
                  </label>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/70 px-6 py-3">
              <AButton onClick={() => close(null)}>Cancel</AButton>
              <AButton type="submit" variant={danger ? 'danger' : 'primary'} disabled={blocked} autoFocus={!pending.input}>
                {pending.confirmLabel ?? 'Confirm'}
              </AButton>
            </div>
          </form>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

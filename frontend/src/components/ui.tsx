import { CircleAlert, Loader2, RefreshCw } from 'lucide-react';
import type { ButtonHTMLAttributes, Ref, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { ApiError } from '../lib/api';

export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700',
  secondary: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-ink',
  danger: 'border border-red-200 bg-white text-red-600 hover:bg-red-50',
};

export function Button({
  variant = 'primary',
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      className={cn(
        'inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-[color,background-color,border-color,transform] active:scale-[0.98]',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
        buttonStyles[variant],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/** Full width unless the caller gives a width. */
const fieldWidth = (className?: string) => (/(^|\s)w-/.test(className ?? '') ? '' : 'w-full');

const fieldBase =
  'block min-h-9 rounded-lg border bg-white px-3 py-1.5 text-sm text-slate-900 transition-[border-color,box-shadow] placeholder:text-slate-400 ' +
  'hover:border-slate-400 focus:border-brand-600 focus:ring-3 focus:ring-brand-600/15 focus:outline-none disabled:bg-slate-100 disabled:text-slate-500';

export function Input({ className, invalid, ...props }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={cn(fieldBase, fieldWidth(className), invalid ? 'border-red-400' : 'border-slate-300', className)} {...props} />;
}

export function Select({
  className,
  invalid,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select className={cn(fieldBase, 'zc-select', fieldWidth(className), invalid ? 'border-red-400' : 'border-slate-300', className)} {...props}>
      {children}
    </select>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : (
        hint && <p className="text-xs text-slate-500">{hint}</p>
      )}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-xl border border-slate-200 bg-white', className)}>{children}</div>;
}

type BadgeTone = 'gray' | 'green' | 'amber' | 'red' | 'blue';
const badgeTones: Record<BadgeTone, string> = {
  gray: 'bg-slate-100 text-slate-700',
  green: 'bg-brand-50 text-brand-700 ring-brand-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  red: 'bg-red-50 text-red-700 ring-red-600/20',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/20',
};

export function Badge({ tone = 'gray', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-slate-500/10 ring-inset', badgeTones[tone])}>
      {children}
    </span>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500" role="status">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info'; children: ReactNode }) {
  const styles = {
    error: 'border-red-200 bg-red-50 text-red-700',
    success: 'border-emerald-200 bg-brand-50 text-emerald-800',
    info: 'border-sky-200 bg-sky-50 text-sky-800',
  }[tone];
  return (
    <div className={cn('rounded-lg border px-3.5 py-2.5 text-sm', styles)} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-2xl leading-8 font-medium text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      {icon && <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-500">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-1 flex max-w-md flex-col items-center gap-4 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

/** A failed load: what happened, and a way to try again. */
export function LoadError({ error, onRetry, what = 'this page' }: { error: unknown; onRetry?: () => void; what?: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center" role="alert">
      <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-red-200 bg-red-50 text-red-600">
        <CircleAlert className="size-5" strokeWidth={1.5} />
      </div>
      <p className="text-sm font-medium text-ink">Could not load {what}</p>
      <p className="mt-1 max-w-md text-sm text-slate-500">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="secondary" className="mt-4" onClick={onRetry}>
          <RefreshCw className="size-4" /> Try again
        </Button>
      )}
    </div>
  );
}

/** On/off control used in lists and settings. */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? 'bg-brand-600' : 'bg-slate-300 hover:bg-slate-400')}
    >
      <span className={cn('absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform', checked && 'translate-x-4')} />
    </button>
  );
}

/** Underlined tabs with optional counts. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { value: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="no-scrollbar flex gap-5 overflow-x-auto border-b border-slate-200" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cn('-mb-px flex shrink-0 items-center gap-2 border-b-2 py-2.5 text-sm font-medium transition-colors', value === t.value ? 'border-brand-600 text-ink' : 'border-transparent text-slate-500 hover:text-ink')}
        >
          {t.label}
          {t.count !== undefined && <span className="text-xs text-slate-400 tabular-nums">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Please check your connection and try again.';
}

export function fieldError(err: unknown, field: string): string | undefined {
  return err instanceof ApiError ? err.details?.[field]?.[0] : undefined;
}

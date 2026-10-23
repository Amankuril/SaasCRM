import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { ApiError } from '../lib/api';

export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm',
  secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 shadow-sm',
  ghost: 'text-slate-600 hover:bg-slate-100',
  danger: 'bg-white text-red-600 border border-red-200 hover:bg-red-50',
};

export function Button({
  variant = 'primary',
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
        'disabled:cursor-not-allowed disabled:opacity-60',
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

const fieldBase =
  'block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 ' +
  'focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 disabled:bg-slate-100 disabled:text-slate-500';

export function Input({ className, invalid, ...props }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={cn(fieldBase, invalid ? 'border-red-400' : 'border-slate-300', className)} {...props} />;
}

export function Select({
  className,
  invalid,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select className={cn(fieldBase, invalid ? 'border-red-400' : 'border-slate-300', className)} {...props}>
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
  return <div className={cn('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>{children}</div>;
}

type BadgeTone = 'gray' | 'green' | 'amber' | 'red' | 'blue';
const badgeTones: Record<BadgeTone, string> = {
  gray: 'bg-slate-100 text-slate-700',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  red: 'bg-red-50 text-red-700 ring-red-600/20',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/20',
};

export function Badge({ tone = 'gray', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-slate-500/10', badgeTones[tone])}>
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
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
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
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && <div className="mb-3 rounded-full bg-slate-100 p-3 text-slate-500">{icon}</div>}
      <p className="text-sm font-medium text-slate-800">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-slate-500">{children}</div>}
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

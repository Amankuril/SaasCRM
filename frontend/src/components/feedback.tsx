import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog } from './Dialog';
import { Badge, Button, cn, errorMessage } from './ui';

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}
interface ToastApi {
  success: (message: string) => void;
  error: (message: unknown) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TOAST_STYLE: Record<ToastTone, { icon: typeof Info; className: string }> = {
  success: { icon: CheckCircle2, className: 'text-emerald-600' },
  error: { icon: XCircle, className: 'text-red-600' },
  info: { icon: Info, className: 'text-sky-600' },
};

/** Short success/error messages in the corner of the screen. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current++;
      setToasts((all) => [...all.slice(-3), { id, tone, message }]);
      window.setTimeout(() => dismiss(id), tone === 'error' ? 6000 : 3500);
    },
    [dismiss],
  );
  const value = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      error: (m) => push('error', typeof m === 'string' ? m : errorMessage(m)),
      info: (m) => push('info', m),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[70] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => {
          const { icon: Icon, className } = TOAST_STYLE[t.tone];
          return (
            <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className="toast-in pointer-events-auto flex items-start gap-2.5 rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm text-slate-800 shadow-lg">
              <Icon className={cn('mt-0.5 size-4 shrink-0', className)} />
              <p className="min-w-0 flex-1">{t.message}</p>
              <button type="button" onClick={() => dismiss(t.id)} className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Dismiss">
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

/** "Are you sure?" popup for deletes and other actions that can't be undone. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  danger = true,
  loading,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      icon={<AlertTriangle className={cn('size-4', danger ? 'text-red-600' : 'text-amber-600')} />}
      title={title}
      subtitle={danger ? 'This cannot be undone' : 'Please confirm'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button loading={loading} onClick={onConfirm} className={danger ? 'bg-red-600 hover:bg-red-700' : undefined}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-slate-600">{children}</div>
    </Dialog>
  );
}

/** Grey placeholder shown while content loads. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-slate-200/70', className)} aria-hidden />;
}

/** Placeholder rows for a table or list that is still loading. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('divide-y divide-slate-100', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3.5">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-2.5 w-1/4" />
          </div>
          <Skeleton className="h-5 w-16" />
          <Skeleton className="hidden h-3 w-24 sm:block" />
        </div>
      ))}
    </div>
  );
}

type Tone = 'gray' | 'green' | 'amber' | 'red' | 'blue';
/** One colour per status word, so "Active" or "Failed" looks the same on every page. */
const STATUS_TONE: Record<string, Tone> = {
  active: 'green',
  connected: 'green',
  completed: 'green',
  approved: 'green',
  confirmed: 'green',
  paid: 'green',
  resolved: 'green',
  paused: 'amber',
  pending: 'amber',
  trialing: 'amber',
  past_due: 'amber',
  booked: 'blue',
  scheduled: 'blue',
  running: 'blue',
  sending: 'blue',
  open: 'blue',
  failed: 'red',
  rejected: 'red',
  suspended: 'red',
  disconnected: 'red',
  error: 'red',
  draft: 'gray',
  cancelled: 'gray',
  canceled: 'gray',
  archived: 'gray',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const text = label ?? status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const tone = STATUS_TONE[status.toLowerCase()] ?? 'gray';
  const dot = { gray: 'bg-slate-400', green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500', blue: 'bg-sky-500' }[tone];
  return (
    <Badge tone={tone}>
      <span className={cn('mr-1.5 size-1.5 rounded-full', dot)} />
      {text}
    </Badge>
  );
}

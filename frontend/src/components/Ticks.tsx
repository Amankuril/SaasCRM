import { Check, CheckCheck, CircleAlert, Clock3 } from 'lucide-react';
import { cn } from './ui';

export type TickStatus = 'queued' | 'submitted' | 'sent' | 'delivered' | 'read' | 'failed';

const LABEL: Record<TickStatus, string> = { queued: 'Queued', submitted: 'Sent', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed' };

/**
 * The product's signature: message progress is always drawn the way WhatsApp draws it.
 * One tick is sent, two are delivered, two blue ones are read.
 */
export function Ticks({ status, withLabel = false, className }: { status: TickStatus; withLabel?: boolean; className?: string }) {
  const Icon = status === 'queued' ? Clock3 : status === 'failed' ? CircleAlert : status === 'sent' || status === 'submitted' ? Check : CheckCheck;
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)} title={withLabel ? undefined : LABEL[status]}>
      <Icon className={cn('size-4 shrink-0', status === 'read' ? 'text-read' : status === 'failed' ? 'text-red-600' : 'text-slate-400')} strokeWidth={1.75} aria-hidden={withLabel} aria-label={withLabel ? undefined : LABEL[status]} />
      {withLabel && LABEL[status]}
    </span>
  );
}

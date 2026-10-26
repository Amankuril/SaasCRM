import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, cn } from '../../components/ui';
import { api, type ConnectionPayload, type TemplateType } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { typeInfo } from './templateForm';

export function TemplatesHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-white px-4 py-4 sm:px-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">{title}</h1>
        <p className="mt-1 text-xs text-slate-500">{description}</p>
      </div>
      {actions}
    </div>
  );
}

/** The WhatsApp connection, which every template call to Meta needs. */
export function useConnection() {
  const { workspace } = useWorkspace();
  const query = useQuery({
    queryKey: ['whatsapp', workspace.id],
    queryFn: () => api.get<ConnectionPayload>(`/workspaces/${workspace.id}/whatsapp/connection`),
  });
  return { ...query, connected: query.data?.connection?.status === 'connected', loaded: !!query.data };
}

export function NotConnectedAlert() {
  const { workspace } = useWorkspace();
  return (
    <Alert tone="info">
      Connect a WhatsApp number to create and sync templates.{' '}
      <Link to={`/w/${workspace.id}/whatsapp`} className="font-medium underline">
        Go to WhatsApp setup
      </Link>
    </Alert>
  );
}

const STATUS_STYLE: Record<string, string> = {
  APPROVED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/30',
  PENDING: 'bg-amber-50 text-amber-700 ring-amber-600/30',
  IN_APPEAL: 'bg-amber-50 text-amber-700 ring-amber-600/30',
  REJECTED: 'bg-red-50 text-red-700 ring-red-600/30',
  PAUSED: 'bg-slate-100 text-slate-600 ring-slate-500/30',
  DISABLED: 'bg-slate-100 text-slate-600 ring-slate-500/30',
  DRAFT: 'bg-sky-50 text-sky-700 ring-sky-600/30',
  PENDING_DELETION: 'bg-red-50 text-red-700 ring-red-600/30',
};
const STATUS_DOT: Record<string, string> = { APPROVED: 'bg-emerald-500', PENDING: 'bg-amber-500', REJECTED: 'bg-red-500', DRAFT: 'bg-sky-500', PENDING_DELETION: 'bg-red-500' };

export function StatusPill({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-2 rounded-full', STATUS_DOT[status] ?? 'bg-slate-400')} />
      <span className={cn('rounded-md px-2 py-0.5 text-xs font-semibold tracking-wide ring-1 ring-inset', STATUS_STYLE[status] ?? STATUS_STYLE.PAUSED)}>
        {status.replace(/_/g, ' ')}
      </span>
    </span>
  );
}

export function TypePill({ type }: { type: TemplateType }) {
  const info = typeInfo(type);
  return <span className={cn('rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap', info.tint)}>{type === 'CUSTOM' ? 'Custom' : info.label}</span>;
}

export const humanize = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');

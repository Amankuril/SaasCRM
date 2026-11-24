import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { StatusBadge } from '../../components/feedback';
import { Alert } from '../../components/ui';
import { api, type ConnectionPayload, type TemplateType } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { typeInfo } from './templateForm';

export function TemplatesHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-6 pb-2 sm:px-6">
      <div>
        <h1 className="text-2xl leading-8 font-medium text-ink">{title}</h1>
        <p className="mt-1 text-sm text-slate-500">{description}</p>
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

/** Every status Meta can return keeps its own name; only APPROVED is green. */
const STATUS_BADGE: Record<string, string> = {
  APPROVED: 'approved',
  PENDING: 'pending',
  IN_APPEAL: 'pending',
  REJECTED: 'rejected',
  PAUSED: 'paused',
  LIMIT_EXCEEDED: 'paused',
  LOCKED: 'paused',
  DISABLED: 'failed',
  PENDING_DELETION: 'failed',
  DELETED: 'failed',
};

export function StatusPill({ status }: { status: string }) {
  return <StatusBadge status={STATUS_BADGE[status] ?? 'draft'} label={humanize(status)} />;
}

export function TypePill({ type }: { type: TemplateType }) {
  return <span className="whitespace-nowrap text-slate-600">{type === 'CUSTOM' ? 'Custom' : typeInfo(type).label}</span>;
}

export const humanize = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');

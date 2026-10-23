import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { Alert, Button, Card, EmptyState, PageHeader, Spinner, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';

interface AuditItem {
  id: string;
  action: string;
  metadata: Record<string, unknown>;
  actor: { name: string; email: string } | null;
  createdAt: string;
}

interface AuditPage {
  items: AuditItem[];
  nextCursor: string | null;
}

function describe(item: AuditItem): string {
  const m = item.metadata as Record<string, string | undefined>;
  switch (item.action) {
    case 'workspace.created':
      return 'created the workspace';
    case 'workspace.updated':
      return `updated workspace settings (${Object.keys((item.metadata.after as object) ?? {}).join(', ')})`;
    case 'member.invited':
      return `invited ${m.email} as ${m.role}`;
    case 'invitation.revoked':
      return `revoked the invitation for ${m.email}`;
    case 'invitation.accepted':
      return `joined the workspace as ${m.role}`;
    case 'member.role_changed':
      return `changed a member's role from ${m.from} to ${m.to}`;
    case 'member.removed':
      return `removed a ${m.role} from the workspace`;
    case 'member.left':
      return 'left the workspace';
    case 'admin.workspace_status_changed':
      return `(platform admin) changed workspace status from ${m.from} to ${m.to}`;
    default:
      return item.action;
  }
}

export function AuditLogPage() {
  const { workspace } = useWorkspace();
  const query = useInfiniteQuery({
    queryKey: ['audit', workspace.id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<AuditPage>(`/workspaces/${workspace.id}/audit-logs${pageParam ? `?before=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextCursor,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader title="Audit log" description="A record of sensitive changes in this workspace." />
      <Card>
        {query.isPending ? (
          <Spinner />
        ) : query.error ? (
          <div className="p-5">
            <Alert>{errorMessage(query.error)}</Alert>
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<ScrollText className="size-5" />} title="No activity yet" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-slate-800">{item.actor?.name ?? 'System'}</span>{' '}
                  <span className="text-slate-600">{describe(item)}</span>
                </span>
                <time className="text-xs text-slate-500" dateTime={item.createdAt}>
                  {formatDate(item.createdAt, true)}
                </time>
              </li>
            ))}
          </ul>
        )}
        {query.hasNextPage && (
          <div className="border-t border-slate-100 p-3 text-center">
            <Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}

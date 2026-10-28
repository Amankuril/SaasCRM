import { useInfiniteQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Alert, Badge, Button, Card, EmptyState, Input, Spinner, cn, errorMessage } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/options';

export interface LogItem {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  metadata: Record<string, unknown>;
  actor: { name: string; email: string; isPlatformAdmin?: boolean } | null;
  ip: string | null;
  createdAt: string;
}

type Source = 'admin' | 'audit';

/** Two feeds: what platform admins did from this panel, and every business's audit log. */
export function ActivityTab() {
  const [source, setSource] = useState<Source>('admin');
  const [action, setAction] = useState('');
  const [actorEmail, setActorEmail] = useState('');
  const feed = useInfiniteQuery({
    queryKey: ['admin', 'feed', source, action, actorEmail],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (pageParam) p.set('before', pageParam);
      if (action.trim()) p.set('action', action.trim());
      if (source === 'audit' && actorEmail.trim()) p.set('actorEmail', actorEmail.trim());
      return api.get<{ items: LogItem[]; nextCursor: string | null }>(`/admin/${source === 'admin' ? 'activity' : 'audit-logs'}?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
        <div className="flex rounded-lg border border-slate-200 p-0.5 text-sm">
          {(
            [
              ['admin', 'Admin actions'],
              ['audit', 'All business audit logs'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} onClick={() => setSource(id)} className={cn('rounded-md px-3 py-1.5 font-medium', source === id ? 'bg-brand-50 text-brand-700' : 'text-slate-500 hover:text-slate-700')}>
              {label}
            </button>
          ))}
        </div>
        <Input aria-label="Filter by action" placeholder="Filter action, e.g. member" value={action} onChange={(e) => setAction(e.target.value)} className="max-w-56" />
        {source === 'audit' && <Input aria-label="Filter by actor email" placeholder="Actor email" value={actorEmail} onChange={(e) => setActorEmail(e.target.value)} className="max-w-56" />}
      </div>
      {feed.isPending ? (
        <Spinner />
      ) : feed.error ? (
        <div className="p-4"><Alert>{errorMessage(feed.error)}</Alert></div>
      ) : items.length === 0 ? (
        <EmptyState icon={<History className="size-5" />} title="Nothing logged yet" />
      ) : (
        <>
          <LogList items={items} showWorkspace />
          {feed.hasNextPage && (
            <div className="border-t border-slate-100 p-3 text-center">
              <Button variant="secondary" loading={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>Load more</Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function LogList({ items, showWorkspace = false }: { items: LogItem[]; showWorkspace?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {items.map((r) => {
        const support = r.metadata?.supportAccess === true;
        const hasMeta = r.metadata && Object.keys(r.metadata).length > 0;
        return (
          <li key={r.id} className="px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-xs text-slate-800">{r.action}</span>
              {(support || r.action.startsWith('admin.')) && <Badge tone="blue">{support ? 'support access' : 'super admin'}</Badge>}
              {showWorkspace && r.workspaceName && (
                r.workspaceId ? <Link to={`/admin/workspaces/${r.workspaceId}`} className="text-xs font-medium text-brand-700 hover:underline">{r.workspaceName}</Link> : <span className="text-xs text-slate-500">{r.workspaceName}</span>
              )}
              <span className="ml-auto text-xs text-slate-400">{formatDate(r.createdAt, true)}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
              <span>{r.actor ? `${r.actor.name} <${r.actor.email}>` : 'System'}</span>
              {r.ip && <span>{r.ip}</span>}
              {hasMeta && (
                <button className="text-brand-700 hover:underline" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {open === r.id ? 'Hide details' : 'Details'}
                </button>
              )}
            </div>
            {open === r.id && <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-50 p-2 text-[11px] text-slate-700">{JSON.stringify(r.metadata, null, 2)}</pre>}
          </li>
        );
      })}
    </ul>
  );
}

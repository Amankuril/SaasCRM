import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Building2 } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Logo';
import { Alert, Badge, Button, Card, EmptyState, Input, PageHeader, Select, Spinner, errorMessage } from '../components/ui';
import { api, type Workspace, type WorkspaceStatus } from '../lib/api';
import { formatDate } from '../lib/options';

interface AdminWorkspace extends Workspace {
  memberCount: number;
  owners: (string | null)[];
  suspendedReason: string | null;
}

interface Stats {
  users: number;
  workspaces: Record<WorkspaceStatus, number>;
}

const STATUS_TONE = { setup: 'amber', active: 'green', suspended: 'red' } as const;

export function AdminPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'' | WorkspaceStatus>('');
  const [q, setQ] = useState('');

  const stats = useQuery({ queryKey: ['admin', 'stats'], queryFn: () => api.get<Stats>('/admin/stats'), enabled: !!user?.isPlatformAdmin });
  const list = useQuery({
    queryKey: ['admin', 'workspaces', status, q],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (q.trim()) params.set('q', q.trim());
      return api.get<{ workspaces: AdminWorkspace[] }>(`/admin/workspaces?${params}`);
    },
    enabled: !!user?.isPlatformAdmin,
  });

  const setWorkspaceStatus = useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: WorkspaceStatus; reason?: string }) =>
      api.patch(`/admin/workspaces/${id}`, { status, reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });

  if (!user?.isPlatformAdmin) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 flex items-center justify-between">
        <Logo />
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
          <ArrowLeft className="size-4" /> Back to app
        </Link>
      </div>
      <PageHeader title="Super Admin" description="All businesses (tenants) on Zeta Connect." />

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Users" value={stats.data?.users} />
        <StatCard label="Active workspaces" value={stats.data?.workspaces.active} />
        <StatCard label="In setup" value={stats.data?.workspaces.setup} />
        <StatCard label="Suspended" value={stats.data?.workspaces.suspended} />
      </div>

      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
          <Input aria-label="Search workspaces" placeholder="Search by business name…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
          <div className="w-44">
            <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as '' | WorkspaceStatus)}>
              <option value="">All statuses</option>
              <option value="setup">Setup</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </Select>
          </div>
        </div>
        {setWorkspaceStatus.error && (
          <div className="px-4 pt-4">
            <Alert>{errorMessage(setWorkspaceStatus.error)}</Alert>
          </div>
        )}
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <Alert>{errorMessage(list.error)}</Alert>
          </div>
        ) : list.data.workspaces.length === 0 ? (
          <EmptyState icon={<Building2 className="size-5" />} title="No workspaces found" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Business</th>
                  <th className="px-4 py-2.5 font-medium">Owner</th>
                  <th className="px-4 py-2.5 font-medium">Members</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="hidden px-4 py-2.5 font-medium md:table-cell">Created</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.workspaces.map((ws) => (
                  <tr key={ws.id}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-800">{ws.name}</p>
                      <p className="text-xs text-slate-500">
                        {ws.industry ?? 'No industry'} · {ws.country}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{ws.owners.filter(Boolean).join(', ') || '—'}</td>
                    <td className="px-4 py-3 text-slate-600">{ws.memberCount}</td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[ws.status]}>{ws.status}</Badge>
                      {ws.suspendedReason && <p className="mt-1 text-xs text-slate-500">{ws.suspendedReason}</p>}
                    </td>
                    <td className="hidden px-4 py-3 text-slate-500 md:table-cell">{formatDate(ws.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {ws.status === 'suspended' ? (
                        <Button variant="secondary" disabled={setWorkspaceStatus.isPending} onClick={() => setWorkspaceStatus.mutate({ id: ws.id, status: 'active' })}>
                          Reactivate
                        </Button>
                      ) : (
                        <Button
                          variant="danger"
                          disabled={setWorkspaceStatus.isPending}
                          onClick={() => {
                            const reason = window.prompt(`Suspend ${ws.name}? Enter a reason (shown to admins):`);
                            if (reason !== null) setWorkspaceStatus.mutate({ id: ws.id, status: 'suspended', reason: reason || undefined });
                          }}
                        >
                          Suspend
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number | undefined }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink">{value ?? '—'}</p>
    </Card>
  );
}

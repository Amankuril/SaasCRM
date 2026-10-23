import { useMutation, useQuery } from '@tanstack/react-query';
import { Megaphone, Plus } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner, errorMessage } from '../components/ui';
import { api, type Campaign, type CampaignStatus } from '../lib/api';
import { formatInZone } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';

export const CAMPAIGN_STATUS: Record<CampaignStatus, { label: string; tone: 'gray' | 'blue' | 'amber' | 'green' | 'red' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  scheduled: { label: 'Scheduled', tone: 'blue' },
  running: { label: 'Sending', tone: 'blue' },
  paused: { label: 'Paused', tone: 'amber' },
  completed: { label: 'Completed', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
  failed: { label: 'Failed', tone: 'red' },
};

/** Recipients whose message reached at least this stage. */
export function funnel(stats: Campaign['stats']) {
  const n = (k: keyof Campaign['stats']) => stats[k] ?? 0;
  const read = n('read');
  const delivered = read + n('delivered');
  const sent = delivered + n('sent') + n('submitted');
  return { total: n('total'), sent, delivered, read, replied: n('replied'), failed: n('failed'), skipped: n('skipped'), pending: n('pending') + n('queued') };
}

export function CampaignsPage() {
  const { workspace, can } = useWorkspace();
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ['campaigns', workspace.id],
    queryFn: () => api.get<{ campaigns: Campaign[] }>(`/workspaces/${workspace.id}/campaigns`),
    refetchInterval: (q) => (q.state.data?.campaigns.some((c) => c.status === 'running' || c.status === 'scheduled') ? 5_000 : false),
  });
  const create = useMutation({
    mutationFn: () => api.post<{ campaign: Campaign }>(`/workspaces/${workspace.id}/campaigns`, { name: 'Untitled campaign' }),
    onSuccess: ({ campaign }) => navigate(`/w/${workspace.id}/campaigns/${campaign.id}`),
  });

  return (
    <>
      <PageHeader
        title="Broadcasts"
        description="Send an approved template to an audience, now or on a schedule."
        actions={
          can('campaigns:manage') &&
          workspace.status !== 'suspended' && (
            <Button loading={create.isPending} onClick={() => create.mutate()}>
              <Plus className="size-4" /> New broadcast
            </Button>
          )
        }
      />
      {create.error != null && (
        <div className="mb-4">
          <Alert>{errorMessage(create.error)}</Alert>
        </div>
      )}
      <Card>
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <Alert>{errorMessage(list.error)}</Alert>
          </div>
        ) : list.data.campaigns.length === 0 ? (
          <EmptyState icon={<Megaphone className="size-5" />} title="No broadcasts yet">
            Create one to send offers, reminders or updates to many contacts at once.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Broadcast</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="hidden px-4 py-2.5 text-right font-medium md:table-cell">Recipients</th>
                  <th className="hidden px-4 py-2.5 text-right font-medium md:table-cell">Delivered</th>
                  <th className="hidden px-4 py-2.5 text-right font-medium lg:table-cell">Read</th>
                  <th className="hidden px-4 py-2.5 text-right font-medium lg:table-cell">Replied</th>
                  <th className="hidden px-4 py-2.5 font-medium sm:table-cell">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.campaigns.map((c) => {
                  const f = funnel(c.stats);
                  const pct = (v: number) => (f.sent ? ` (${Math.round((v / f.sent) * 100)}%)` : '');
                  const when = c.scheduledAt ?? c.launchedAt ?? c.createdAt;
                  return (
                    <tr key={c.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <Link to={`/w/${workspace.id}/campaigns/${c.id}`} className="font-medium text-slate-800 hover:text-brand-700">
                          {c.name}
                        </Link>
                        {c.templateName && <p className="text-xs text-slate-500">{c.templateName}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={CAMPAIGN_STATUS[c.status].tone}>{CAMPAIGN_STATUS[c.status].label}</Badge>
                      </td>
                      <td className="hidden px-4 py-3 text-right text-slate-700 md:table-cell">{f.total || '—'}</td>
                      <td className="hidden px-4 py-3 text-right text-slate-700 md:table-cell">{c.status === 'draft' ? '—' : `${f.delivered}${pct(f.delivered)}`}</td>
                      <td className="hidden px-4 py-3 text-right text-slate-700 lg:table-cell">{c.status === 'draft' ? '—' : `${f.read}${pct(f.read)}`}</td>
                      <td className="hidden px-4 py-3 text-right text-slate-700 lg:table-cell">{c.status === 'draft' ? '—' : f.replied}</td>
                      <td className="hidden px-4 py-3 text-slate-500 sm:table-cell">
                        {c.status === 'scheduled' ? 'Sends ' : c.status === 'draft' ? 'Created ' : ''}
                        {formatInZone(when, workspace.timezone)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

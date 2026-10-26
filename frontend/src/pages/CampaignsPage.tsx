import { useMutation, useQuery } from '@tanstack/react-query';
import { BarChart3, Eye, FileText, Megaphone, Plus, Repeat } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner, errorMessage } from '../components/ui';
import { Dialog } from '../components/Dialog';
import { TemplatePreview } from '../components/TemplatePreview';
import { api, type Campaign, type CampaignStatus, type MessageTemplate } from '../lib/api';
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
  const [viewingTemplate, setViewingTemplate] = useState<Campaign | null>(null);
  const list = useQuery({
    queryKey: ['campaigns', workspace.id],
    queryFn: () => api.get<{ campaigns: Campaign[] }>(`/workspaces/${workspace.id}/campaigns`),
    refetchInterval: (q) => (q.state.data?.campaigns.some((c) => c.status === 'running' || c.status === 'scheduled') ? 5_000 : false),
  });
  const create = useMutation({
    mutationFn: () => api.post<{ campaign: Campaign }>(`/workspaces/${workspace.id}/campaigns`, { name: 'Untitled campaign' }),
    onSuccess: ({ campaign }) => navigate(`/w/${workspace.id}/campaigns/${campaign.id}`),
  });
  const totals = (list.data?.campaigns ?? []).reduce(
    (acc, c) => {
      const f = funnel(c.stats);
      return { sent: acc.sent + f.sent, delivered: acc.delivered + f.delivered, read: acc.read + f.read, failed: acc.failed + f.failed };
    },
    { sent: 0, delivered: 0, read: 0, failed: 0 },
  );
  const action = 'rounded-md p-1.5 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <>
      <PageHeader
        title="Campaign List"
        description="Track every broadcast and how it performed. Statuses update live from WhatsApp delivery receipts."
        actions={
          can('campaigns:manage') &&
          workspace.status !== 'suspended' && (
            <Button loading={create.isPending} onClick={() => create.mutate()} className="bg-slate-700 hover:bg-slate-800">
              <Plus className="size-4" /> Create Campaign
            </Button>
          )
        }
      />
      {create.error != null && (
        <div className="mb-4">
          <Alert>{errorMessage(create.error)}</Alert>
        </div>
      )}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(
          [
            ['Sent', totals.sent, 'Total messages sent', 'text-slate-700'],
            ['Delivered', totals.delivered, 'Successfully delivered', 'text-sky-700'],
            ['Read', totals.read, 'Opened by recipients', 'text-emerald-700'],
            ['Failed', totals.failed, 'Delivery failures', 'text-red-600'],
          ] as const
        ).map(([label, value, hint, tone]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs text-slate-500">{label}</p>
            <p className={`mt-1 text-2xl font-semibold ${tone}`}>{value}</p>
            <p className="text-xs text-slate-400">{hint}</p>
          </div>
        ))}
      </div>
      <Card>
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <Alert>{errorMessage(list.error)}</Alert>
          </div>
        ) : list.data.campaigns.length === 0 ? (
          <EmptyState icon={<Megaphone className="size-5" />} title="No campaigns yet">
            Create one to send offers, reminders or updates to your contact lists at once.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Campaign</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Sent</th>
                  <th className="px-4 py-2.5 text-right font-medium">Delivered</th>
                  <th className="px-4 py-2.5 text-right font-medium">Read</th>
                  <th className="px-4 py-2.5 text-right font-medium">Failed</th>
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.campaigns.map((c) => {
                  const f = funnel(c.stats);
                  const draft = c.status === 'draft';
                  const pct = (v: number) => (f.sent ? <span className="text-xs text-slate-400"> {Math.round((v / f.sent) * 100)}%</span> : null);
                  const when = c.scheduledAt ?? c.launchedAt ?? c.createdAt;
                  const href = `/w/${workspace.id}/campaigns/${c.id}`;
                  return (
                    <tr key={c.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <Link to={href} className="font-medium text-slate-800 hover:text-brand-700">
                          {c.name}
                        </Link>
                        <p className="text-xs text-slate-500">
                          {c.audience.type === 'retarget' && <span className="mr-1 rounded bg-indigo-50 px-1 text-indigo-700">Retarget</span>}
                          {c.templateName ?? (draft ? 'Draft — not sent yet' : '')}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={CAMPAIGN_STATUS[c.status].tone}>{CAMPAIGN_STATUS[c.status].label}</Badge>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-700">{draft ? '—' : f.sent}</td>
                      <td className="px-4 py-3 text-right text-slate-700">{draft ? '—' : <>{f.delivered}{pct(f.delivered)}</>}</td>
                      <td className="px-4 py-3 text-right text-slate-700">{draft ? '—' : <>{f.read}{pct(f.read)}</>}</td>
                      <td className="px-4 py-3 text-right text-slate-700">{draft ? '—' : f.failed}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-500">
                        {c.status === 'scheduled' ? 'Sends ' : draft ? 'Created ' : ''}
                        {formatInZone(when, workspace.timezone)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-0.5">
                          <button className={action} disabled={!c.templateId} onClick={() => setViewingTemplate(c)} title="Template view" aria-label={`Template of ${c.name}`}>
                            <FileText className="size-4" />
                          </button>
                          <button className={action} disabled={draft} onClick={() => navigate(href)} title="View analytics" aria-label={`Analytics of ${c.name}`}>
                            <BarChart3 className="size-4" />
                          </button>
                          {can('campaigns:manage') && (
                            <button
                              className={action}
                              disabled={draft}
                              onClick={() => navigate(`/w/${workspace.id}/broadcast/retarget?campaign=${c.id}`)}
                              title="Retarget campaign"
                              aria-label={`Retarget ${c.name}`}
                            >
                              <Repeat className="size-4" />
                            </button>
                          )}
                          <button className={action} onClick={() => navigate(href)} title={draft ? 'Edit' : 'View'} aria-label={`View ${c.name}`}>
                            <Eye className="size-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {viewingTemplate && <TemplateDialog campaign={viewingTemplate} onClose={() => setViewingTemplate(null)} />}
    </>
  );
}

function TemplateDialog({ campaign, onClose }: { campaign: Campaign; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const templates = useQuery({ queryKey: ['templates', workspace.id, 'all'], queryFn: () => api.get<{ templates: MessageTemplate[] }>(`/workspaces/${workspace.id}/templates`) });
  const template = templates.data?.templates.find((t) => t.id === campaign.templateId);
  return (
    <Dialog icon={<FileText className="size-4" />} title={template?.name ?? campaign.templateName ?? 'Template'} subtitle={`Used by ${campaign.name}`} onClose={onClose}>
      {templates.isPending ? <Spinner /> : template ? <TemplatePreview components={template.components} /> : <p className="text-sm text-slate-500">This template no longer exists.</p>}
    </Dialog>
  );
}

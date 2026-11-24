import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Copy, FileText, Megaphone, Pause, Pencil, Play, Plus, Repeat, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Ticks } from '../components/Ticks';
import { Button, Card, EmptyState, PageHeader, Spinner, LoadError } from '../components/ui';
import { ConfirmDialog, SkeletonRows, StatusBadge, useToast } from '../components/feedback';
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
  const queryClient = useQueryClient();
  const toast = useToast();
  const base = `/workspaces/${workspace.id}/campaigns`;
  const manage = can('campaigns:manage') && workspace.status !== 'suspended';
  const campaigns = list.data?.campaigns ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['campaigns', workspace.id] });
  /** Drops deleted rows from the cached list right away, so they never flash back. */
  const dropFromList = (ids: string[]) =>
    queryClient.setQueryData<{ campaigns: Campaign[] }>(['campaigns', workspace.id], (old) => old && { campaigns: old.campaigns.filter((c) => !ids.includes(c.id)) });

  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Campaign[] | null>(null);
  const chosen = campaigns.filter((c) => selected.includes(c.id));
  const allSelected = campaigns.length > 0 && chosen.length === campaigns.length;

  const remove = useMutation({
    mutationFn: async (targets: Campaign[]) => {
      if (targets.length === 1) {
        await api.delete(`${base}/${targets[0]!.id}`);
        return { deleted: 1, skipped: [] as { id: string; name: string }[] };
      }
      return api.post<{ deleted: number; skipped: { id: string; name: string }[] }>(`${base}/bulk-delete`, { ids: targets.map((c) => c.id) });
    },
    onSuccess: ({ deleted, skipped }, targets) => {
      const gone = targets.map((c) => c.id).filter((id) => !skipped.some((x) => x.id === id));
      dropFromList(gone);
      setSelected((ids) => ids.filter((id) => !gone.includes(id)));
      setDeleting(null);
      if (deleted) toast.success(deleted === 1 ? 'Campaign deleted' : `${deleted} campaigns deleted`);
      if (skipped.length) toast.error(`${skipped.length} still sending — cancel ${skipped.length === 1 ? 'it' : 'them'} first, then delete.`);
      void refresh();
    },
    onError: (err) => toast.error(err),
  });
  const stop = useMutation({
    mutationFn: (targets: Campaign[]) => Promise.all(targets.map((c) => api.post(`${base}/${c.id}/cancel`))),
    onSuccess: () => {
      toast.success('Campaign stopped. You can delete it now.');
      void refresh();
    },
    onError: (err) => toast.error(err),
  });
  const duplicate = useMutation({
    mutationFn: (c: Campaign) => api.post<{ campaign: Campaign }>(`${base}/${c.id}/duplicate`),
    onSuccess: ({ campaign }) => {
      toast.success('Campaign duplicated as a new draft');
      void refresh();
      navigate(`/w/${workspace.id}/broadcast/campaigns/new?draft=${campaign.id}`);
    },
    onError: (err) => toast.error(err),
  });
  const setPaused = useMutation({
    mutationFn: ({ c, pause }: { c: Campaign; pause: boolean }) => api.post(`${base}/${c.id}/${pause ? 'pause' : 'resume'}`),
    onSuccess: (_d, { pause }) => {
      toast.success(pause ? 'Campaign paused' : 'Campaign resumed');
      void refresh();
    },
    onError: (err) => toast.error(err),
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
        title="Campaigns"
        description="Every broadcast and how it performed, updated live by WhatsApp delivery receipts"
        actions={
          manage && (
            <Button onClick={() => navigate(`/w/${workspace.id}/broadcast/campaigns/new`)}>
              <Plus className="size-4" /> Create campaign
            </Button>
          )
        }
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(
          [
            ['sent', totals.sent, 'Across all campaigns'],
            ['delivered', totals.delivered, 'Reached the phone'],
            ['read', totals.read, 'Opened by the customer'],
            ['failed', totals.failed, 'Open a campaign for the reason'],
          ] as const
        ).map(([status, value, hint]) => (
          <div key={status} className="rounded-xl border border-slate-200 bg-white p-4">
            <Ticks status={status} withLabel className="text-sm text-slate-500" />
            <p className="mt-2 text-2xl leading-8 font-medium text-ink tabular-nums">{value.toLocaleString('en-IN')}</p>
            <p className="text-xs text-slate-500">{hint}</p>
          </div>
        ))}
      </div>
      <Card>
        {manage && chosen.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-brand-50/60 px-4 py-2.5 text-sm">
            <span className="font-medium text-ink">{chosen.length} selected</span>
            <Button variant="danger" className="px-2.5 py-1.5" onClick={() => setDeleting(chosen)}>
              <Trash2 className="size-4" /> Delete selected
            </Button>
            <button type="button" className="text-xs text-slate-500 hover:text-ink hover:underline" onClick={() => setSelected([])}>
              Clear selection
            </button>
          </div>
        )}
        {list.isPending ? (
          <SkeletonRows rows={6} />
        ) : list.error ? (
          <LoadError error={list.error} what="campaigns" onRetry={() => void list.refetch()} />
        ) : list.data.campaigns.length === 0 ? (
          <EmptyState icon={<Megaphone className="size-5" />} title="No campaigns yet">
            Create one to send offers, reminders or updates to your contact lists at once.
            {manage && (
              <Button className="mt-4" onClick={() => navigate(`/w/${workspace.id}/broadcast/campaigns/new`)}>
                <Plus className="size-4" /> Create campaign
              </Button>
            )}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  {manage && (
                    <th className="w-10 py-2.5 pl-4">
                      <input type="checkbox" aria-label="Select all campaigns" checked={allSelected} onChange={() => setSelected(allSelected ? [] : campaigns.map((c) => c.id))} />
                    </th>
                  )}
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
                  const href = draft ? `/w/${workspace.id}/broadcast/campaigns/new?draft=${c.id}` : `/w/${workspace.id}/broadcast/campaigns/${c.id}`;
                  const picked = selected.includes(c.id);
                  return (
                    <tr key={c.id} className={picked ? 'bg-brand-50/40' : 'hover:bg-slate-50'}>
                      {manage && (
                        <td className="py-3 pl-4">
                          <input type="checkbox" aria-label={`Select ${c.name}`} checked={picked} onChange={() => setSelected(picked ? selected.filter((id) => id !== c.id) : [...selected, c.id])} />
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <Link to={href} className="font-medium text-slate-800 hover:text-brand-700">
                          {c.name}
                        </Link>
                        <p className="text-xs text-slate-500">
                          {c.audience.type === 'retarget' && <span className="mr-1 rounded bg-slate-100 px-1 text-slate-600">Retarget</span>}
                          {c.templateName ?? (draft ? 'Draft — not sent yet' : '')}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={c.status} label={CAMPAIGN_STATUS[c.status].label} />
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
                          {draft ? (
                            <button className={action} onClick={() => navigate(href)} title="Edit draft" aria-label={`Edit ${c.name}`}>
                              <Pencil className="size-4" />
                            </button>
                          ) : (
                            <button className={action} onClick={() => navigate(href)} title="View report" aria-label={`Report of ${c.name}`}>
                              <BarChart3 className="size-4" />
                            </button>
                          )}
                          {manage && (
                            <>
                              {(c.status === 'running' || c.status === 'scheduled') && (
                                <button className={action} disabled={setPaused.isPending} onClick={() => setPaused.mutate({ c, pause: true })} title="Pause" aria-label={`Pause ${c.name}`}>
                                  <Pause className="size-4" />
                                </button>
                              )}
                              {c.status === 'paused' && (
                                <button className={action} disabled={setPaused.isPending} onClick={() => setPaused.mutate({ c, pause: false })} title="Resume" aria-label={`Resume ${c.name}`}>
                                  <Play className="size-4" />
                                </button>
                              )}
                              <button className={action} disabled={draft} onClick={() => navigate(`/w/${workspace.id}/broadcast/retarget?campaign=${c.id}`)} title="Retarget campaign" aria-label={`Retarget ${c.name}`}>
                                <Repeat className="size-4" />
                              </button>
                              <button className={action} disabled={duplicate.isPending} onClick={() => duplicate.mutate(c)} title="Duplicate" aria-label={`Duplicate ${c.name}`}>
                                <Copy className="size-4" />
                              </button>
                              <button className={`${action} text-red-600 hover:bg-red-50`} onClick={() => setDeleting([c])} title="Delete" aria-label={`Delete ${c.name}`}>
                                <Trash2 className="size-4" />
                              </button>
                            </>
                          )}
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
      {deleting && <DeleteCampaigns targets={deleting.map((d) => campaigns.find((c) => c.id === d.id) ?? d)} busy={remove.isPending || stop.isPending} onStop={(t) => stop.mutate(t)} onDelete={(t) => remove.mutate(t)} onClose={() => setDeleting(null)} />}
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

const SENDING: CampaignStatus[] = ['running', 'scheduled', 'paused'];

/** Delete confirmation. A campaign that is still sending has to be stopped first. */
function DeleteCampaigns({ targets, busy, onStop, onDelete, onClose }: { targets: Campaign[]; busy: boolean; onStop: (t: Campaign[]) => void; onDelete: (t: Campaign[]) => void; onClose: () => void }) {
  const active = targets.filter((c) => SENDING.includes(c.status));
  const one = targets.length === 1;
  if (active.length > 0) {
    return (
      <ConfirmDialog title={one ? 'Stop this campaign first' : 'Stop sending campaigns first'} confirmLabel={active.length === 1 ? 'Stop campaign' : `Stop ${active.length} campaigns`} cancelLabel="Keep sending" loading={busy} onConfirm={() => onStop(active)} onClose={onClose}>
        <p>
          {one ? <><strong className="text-ink">{targets[0]!.name}</strong> is</> : <>{active.length} of the selected campaigns are</>} still sending or scheduled. Stop {active.length === 1 ? 'it' : 'them'} to delete — messages not sent yet will be cancelled.
        </p>
      </ConfirmDialog>
    );
  }
  return (
    <ConfirmDialog title={one ? 'Delete campaign?' : `Delete ${targets.length} campaigns?`} confirmLabel={one ? 'Delete campaign' : `Delete ${targets.length} campaigns`} loading={busy} onConfirm={() => onDelete(targets)} onClose={onClose}>
      <p>
        {one ? <>This campaign will be permanently deleted: <strong className="text-ink">{targets[0]!.name}</strong>.</> : <>These {targets.length} campaigns will be permanently deleted.</>} Its report and recipient history go with it. Messages already sent stay in the Team Inbox.
      </p>
    </ConfirmDialog>
  );
}

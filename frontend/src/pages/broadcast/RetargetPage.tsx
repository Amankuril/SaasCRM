import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleHelp, Repeat } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, EmptyState, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type Campaign, type RetargetOutcome } from '../../lib/api';
import { formatInZone } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { CAMPAIGN_STATUS, funnel } from '../CampaignsPage';
import { RETARGET_INFO } from './CampaignBuilder';

/** How many recipients each retarget choice would reach (same buckets as the server). */
function outcomeCounts(c: Campaign): Record<RetargetOutcome, number> {
  const f = funnel(c.stats);
  return { read: f.read, delivered: f.delivered - f.read, sent: f.sent + f.failed, failed: f.failed };
}

/** Retarget Campaign: pick a sent campaign and who to follow up with, then build it like any campaign. */
export function RetargetPage() {
  const { workspace, can } = useWorkspace();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [sourceId, setSourceId] = useState(params.get('campaign') ?? '');
  const [outcomes, setOutcomes] = useState<RetargetOutcome[]>(['delivered']);
  const list = useQuery({ queryKey: ['campaigns', workspace.id], queryFn: () => api.get<{ campaigns: Campaign[] }>(`/workspaces/${workspace.id}/campaigns`) });
  const sent = (list.data?.campaigns ?? []).filter((c) => c.status !== 'draft');
  const source = sent.find((c) => c.id === sourceId);
  const counts = source ? outcomeCounts(source) : null;

  const create = useMutation({
    mutationFn: () =>
      api.post<{ campaign: Campaign }>(`/workspaces/${workspace.id}/campaigns`, {
        name: `Retarget – ${source!.name}`.slice(0, 120),
        templateId: source!.templateId,
        audience: { type: 'retarget', segmentId: null, filter: { tagsAny: [], excludeTags: [], stages: [], requireOptIn: false }, retarget: { campaignId: source!.id, outcomes } },
      }),
    onSuccess: ({ campaign }) => navigate(`/w/${workspace.id}/campaigns/${campaign.id}`),
  });

  return (
    <>
      <div className="mb-6 flex items-start gap-3">
        <span className="rounded-xl bg-indigo-50 p-2.5 text-indigo-600 ring-1 ring-indigo-100">
          <Repeat className="size-5" />
        </span>
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-ink">
            Retarget Campaign
            <Link
              to={`/w/${workspace.id}/broadcast/guide#retarget`}
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              <CircleHelp className="size-3.5" /> How it works
            </Link>
          </h1>
          <p className="text-sm text-slate-500">Follow up with people based on what happened to an earlier campaign.</p>
        </div>
      </div>

      {list.isPending ? (
        <Spinner />
      ) : list.error ? (
        <Alert>{errorMessage(list.error)}</Alert>
      ) : sent.length === 0 ? (
        <EmptyState icon={<Repeat className="size-5" />} title="No sent campaigns yet">
          Send a campaign first; you can retarget its audience once WhatsApp reports how it went.
        </EmptyState>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <p className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-ink">1. Choose a previous campaign</p>
            <ul className="max-h-[28rem] divide-y divide-slate-100 overflow-y-auto">
              {sent.map((c) => {
                const f = funnel(c.stats);
                return (
                  <li key={c.id}>
                    <label className={cn('flex cursor-pointer items-center gap-3 px-4 py-3 text-sm hover:bg-slate-50', sourceId === c.id && 'bg-slate-50')}>
                      <input type="radio" name="source" checked={sourceId === c.id} onChange={() => setSourceId(c.id)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-slate-800">{c.name}</span>
                        <span className="text-xs text-slate-500">
                          {CAMPAIGN_STATUS[c.status].label} · {c.launchedAt ? formatInZone(c.launchedAt, workspace.timezone) : '—'}
                        </span>
                      </span>
                      <span className="hidden gap-3 text-xs text-slate-500 sm:flex">
                        <span>Sent {f.sent}</span>
                        <span>Read {f.read}</span>
                        <span>Failed {f.failed}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-sm font-semibold text-ink">2. Who to target</p>
            {!source ? (
              <p className="text-sm text-slate-500">Choose a campaign first.</p>
            ) : (
              <div className="space-y-2">
                {(Object.keys(RETARGET_INFO) as RetargetOutcome[]).map((o) => (
                  <label key={o} className={cn('block cursor-pointer rounded-xl border p-3 text-sm', outcomes.includes(o) ? 'border-slate-600 bg-slate-50' : 'border-slate-200')}>
                    <span className="flex items-center gap-2 font-medium text-slate-800">
                      <input type="checkbox" checked={outcomes.includes(o)} onChange={() => setOutcomes(outcomes.includes(o) ? outcomes.filter((x) => x !== o) : [...outcomes, o])} />
                      {RETARGET_INFO[o].label}
                      <span className="ml-auto text-xs text-slate-500">{counts![o]}</span>
                    </span>
                    <span className="mt-1 block text-xs text-slate-500">{RETARGET_INFO[o].hint}</span>
                  </label>
                ))}
              </div>
            )}
            <Alert tone="info">Best practice: wait 24–48 hours after the original campaign before retargeting.</Alert>
            {create.error != null && <Alert>{errorMessage(create.error)}</Alert>}
            {can('campaigns:manage') && (
              <Button className="w-full bg-slate-700 hover:bg-slate-800" disabled={!source || !outcomes.length} loading={create.isPending} onClick={() => create.mutate()}>
                Continue to Create Campaign
              </Button>
            )}
          </section>
        </div>
      )}
    </>
  );
}

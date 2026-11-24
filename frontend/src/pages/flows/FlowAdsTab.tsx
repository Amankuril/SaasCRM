import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ExternalLink, Megaphone, MessageSquareReply, Play, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Skeleton } from '../../components/feedback';
import { Alert, Badge, Card, EmptyState, cn, errorMessage } from '../../components/ui';
import { api, type FlowAdsReport } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { RangeSelect, StatCard, rangeBounds, td, th, type RangeKey } from './shared';

/** Click-to-WhatsApp ads: leads each ad brought in and the flow replies they got. */
export function FlowAdsTab() {
  const { workspace } = useWorkspace();
  const [range, setRange] = useState<RangeKey>('30d');
  const { from, to } = useMemo(() => rangeBounds(range), [range]);
  const query = useQuery({
    queryKey: ['flow-ads', workspace.id, range],
    queryFn: () => api.get<FlowAdsReport>(`/workspaces/${workspace.id}/flows/insights/ads?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    placeholderData: keepPreviousData,
  });
  const a = query.data;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl leading-8 font-medium text-ink">Ads</h1>
          <p className="mt-1 text-sm text-slate-500">Leads from your Click-to-WhatsApp ads and the automations that answered them.</p>
        </div>
        <RangeSelect value={range} onChange={setRange} />
      </div>
      {query.error ? (
        <Alert>{errorMessage(query.error)}</Alert>
      ) : !a ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Ads with leads" value={a.totals.ads} icon={<Megaphone className="size-4" />} />
            <StatCard label="Leads" value={a.totals.leads.toLocaleString()} icon={<Users className="size-4" />} />
            <StatCard label="Flows started" value={a.totals.flowRuns.toLocaleString()} icon={<Play className="size-4" />} />
            <StatCard label="Flow replies" value={a.totals.replies.toLocaleString()} icon={<MessageSquareReply className="size-4" />} />
          </div>
          <Card>
            {a.ads.length === 0 ? (
              <EmptyState icon={<Megaphone className="size-5" />} title="No ad leads in this period">
                When someone taps your Click-to-WhatsApp ad on Facebook or Instagram and messages you, the ad appears here. Use an &ldquo;Any message&rdquo; or keyword trigger so a flow answers those leads instantly.
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={th}>Ad</th>
                      <th className={cn(th, 'text-right')}>Leads</th>
                      <th className={cn(th, 'text-right')}>Messages</th>
                      <th className={cn(th, 'text-right')}>Flows started</th>
                      <th className={cn(th, 'text-right')}>Flow replies</th>
                      <th className={th}>Linked flows</th>
                      <th className={th}>Last lead</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {a.ads.map((ad) => (
                      <tr key={ad.id} className="hover:bg-slate-50">
                        <td className={td('max-w-72')}>
                          <p className="truncate font-medium text-slate-800">{ad.headline || ad.body || 'Untitled ad'}</p>
                          <p className="flex items-center gap-1.5 text-xs text-slate-500">
                            {ad.sourceType ?? 'ad'} · {ad.id}
                            {ad.sourceUrl && (
                              <a href={ad.sourceUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline" aria-label="Open ad">
                                <ExternalLink className="size-3" />
                              </a>
                            )}
                          </p>
                        </td>
                        <td className={td('text-right tabular-nums')}>{ad.leads}</td>
                        <td className={td('text-right tabular-nums')}>{ad.messages}</td>
                        <td className={td('text-right tabular-nums')}>{ad.flowRuns}</td>
                        <td className={td('text-right tabular-nums')}>{ad.replies}</td>
                        <td className={td()}>
                          {ad.flows.length ? (
                            <div className="flex flex-wrap gap-1">
                              {ad.flows.map((f) => (
                                <Badge key={f} tone="green">
                                  {f}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">No flow answered</span>
                          )}
                        </td>
                        <td className={td('whitespace-nowrap text-slate-500')}>{formatDate(ad.lastLeadAt, true)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

import { useQuery } from '@tanstack/react-query';
import { BarChart3, Boxes, Crosshair, Image as ImageIcon, Layers, Megaphone, Radio, UserRoundSearch, type LucideIcon } from 'lucide-react';
import { Badge } from '../../components/ui';
import { api, type FbAdsHome, type FbKind } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';

export function useAdsHome() {
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: ['fbads', workspace.id],
    queryFn: () => api.get<FbAdsHome>(`/workspaces/${workspace.id}/facebook-ads`),
    // While a sync runs, keep the counters fresh.
    refetchInterval: (q) => (['queued', 'running'].includes(q.state.data?.connection?.sync.status ?? '') ? 3000 : false),
  });
}

/** List pages by URL segment. Leads and Insights arrive with the Lead Ads phase. */
export const ENTITY_PAGES: { slug: string; kind: FbKind | null; title: string; singular: string; icon: LucideIcon; tone: string; description: string }[] = [
  { slug: 'campaigns', kind: 'campaign', title: 'Campaigns', singular: 'Campaign', icon: Megaphone, tone: 'bg-violet-50 text-violet-700', description: 'Objectives, budgets and status.' },
  { slug: 'adsets', kind: 'adset', title: 'Ad sets', singular: 'Ad set', icon: Layers, tone: 'bg-sky-50 text-sky-700', description: 'Audience targeting, optimisation and spend.' },
  { slug: 'creatives', kind: 'creative', title: 'Creatives', singular: 'Creative', icon: ImageIcon, tone: 'bg-pink-50 text-pink-700', description: 'Images, copy and calls to action.' },
  { slug: 'ads', kind: 'ad', title: 'Ads', singular: 'Ad', icon: Boxes, tone: 'bg-amber-50 text-amber-700', description: 'Attach creatives to ad sets to deliver.' },
  { slug: 'audiences', kind: 'audience', title: 'Audiences', singular: 'Audience', icon: UserRoundSearch, tone: 'bg-emerald-50 text-emerald-700', description: 'Retarget customers and find lookalikes.' },
  { slug: 'pixels', kind: 'pixel', title: 'Pixels', singular: 'Pixel', icon: Crosshair, tone: 'bg-orange-50 text-orange-700', description: 'Conversion tracking for your website.' },
  { slug: 'leads', kind: null, title: 'Leads', singular: 'Lead', icon: Radio, tone: 'bg-teal-50 text-teal-700', description: 'Instant Form leads with an AI WhatsApp follow-up.' },
  { slug: 'insights', kind: null, title: 'Insights', singular: 'Insight', icon: BarChart3, tone: 'bg-slate-100 text-slate-700', description: 'Reach, spend, clicks and cost per lead.' },
];

export const OBJECTIVES = [
  { value: 'OUTCOME_AWARENESS', label: 'Awareness', hint: 'Show ads to people most likely to remember them' },
  { value: 'OUTCOME_TRAFFIC', label: 'Traffic', hint: 'Send people to a website, app or WhatsApp' },
  { value: 'OUTCOME_ENGAGEMENT', label: 'Engagement', hint: 'More messages, video views or post engagement' },
  { value: 'OUTCOME_LEADS', label: 'Leads', hint: 'Collect leads with Instant Forms or chats' },
  { value: 'OUTCOME_APP_PROMOTION', label: 'App promotion', hint: 'Get people to install your app' },
  { value: 'OUTCOME_SALES', label: 'Sales', hint: 'Find people likely to buy' },
];
export const objectiveLabel = (v: string | null) => OBJECTIVES.find((o) => o.value === v)?.label ?? (v ? v.replace('OUTCOME_', '').toLowerCase() : '—');

const words = (v: string) => v.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Meta's effective_status as a badge. */
export function FbStatus({ value, deleted }: { value: string | null; deleted?: boolean }) {
  if (deleted || value === 'DELETED') return <Badge tone="gray">Deleted</Badge>;
  if (!value) return <Badge tone="gray">—</Badge>;
  const tone = value === 'ACTIVE' ? 'green' : value === 'DISAPPROVED' || value === 'WITH_ISSUES' ? 'red' : value.includes('PAUSED') ? 'amber' : value === 'PENDING_REVIEW' || value === 'IN_PROCESS' ? 'blue' : 'gray';
  const label = value === 'DISAPPROVED' ? 'Rejected' : value === 'PENDING_REVIEW' ? 'In review' : words(value);
  return <Badge tone={tone}>{label}</Badge>;
}

export { words };

export const money = (n: number | null, currency: string | null) => (n === null ? '—' : n.toLocaleString('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 2 }));

/** "View on Facebook": the object in Meta Ads Manager. */
export function adsManagerUrl(account: string | null, kind: FbKind, id: string): string {
  const act = (account ?? '').replace('act_', '');
  if (kind === 'campaign') return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${act}&selected_campaign_ids=${id}`;
  if (kind === 'adset') return `https://adsmanager.facebook.com/adsmanager/manage/adsets?act=${act}&selected_adset_ids=${id}`;
  if (kind === 'ad') return `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${act}&selected_ad_ids=${id}`;
  if (kind === 'audience') return `https://adsmanager.facebook.com/adsmanager/audiences?act=${act}&ids=${id}`;
  if (kind === 'pixel') return `https://business.facebook.com/events_manager2/list/pixel/${id}/overview`;
  return `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${act}`;
}

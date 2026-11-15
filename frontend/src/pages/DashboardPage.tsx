import { useQuery } from '@tanstack/react-query';
import {
  Blocks,
  CheckCheck,
  CheckCircle2,
  Circle,
  Megaphone,
  MessageSquare,
  MessagesSquare,
  RefreshCw,
  Send,
  ShieldCheck,
  Sheet,
  TriangleAlert,
  Users,
  Webhook,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Skeleton, StatusBadge } from '../components/feedback';
import { Alert, Button, Card, PageHeader, cn, errorMessage } from '../components/ui';
import { api, type DashboardData } from '../lib/api';
import { formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';

const num = (n: number) => n.toLocaleString('en-IN');
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');
/** "PENDING_REVIEW" -> "Pending review" */
const words = (v: string | null | undefined) => (v ? v.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : 'Not available');

const TIER_LABEL: Record<string, string> = { TIER_50: '50', TIER_250: '250', TIER_1K: '1K', TIER_10K: '10K', TIER_100K: '100K', TIER_UNLIMITED: 'Unlimited' };
const QUALITY: Record<string, { label: string; dot: string; text: string; help: string }> = {
  GREEN: { label: 'High', dot: 'bg-emerald-500', text: 'text-emerald-700', help: 'Customers are responding well to your messages.' },
  YELLOW: { label: 'Medium', dot: 'bg-amber-500', text: 'text-amber-700', help: 'Some customers are blocking or reporting messages. Review recent broadcasts.' },
  RED: { label: 'Low', dot: 'bg-red-500', text: 'text-red-700', help: 'Many customers are blocking or reporting messages. Your limit may be reduced.' },
};
/** Meta statuses mapped onto the shared badge colours. */
const REVIEW_BADGE: Record<string, string> = {
  verified: 'approved',
  APPROVED: 'approved',
  AVAILABLE_WITHOUT_REVIEW: 'approved',
  CONNECTED: 'connected',
  AVAILABLE: 'active',
  pending: 'pending',
  PENDING: 'pending',
  PENDING_REVIEW: 'pending',
  LIMITED: 'pending',
  not_verified: 'draft',
  NONE: 'draft',
  rejected: 'rejected',
  REJECTED: 'rejected',
  DECLINED: 'rejected',
  BLOCKED: 'failed',
  BANNED: 'failed',
  RESTRICTED: 'failed',
  FLAGGED: 'pending',
  DISCONNECTED: 'disconnected',
};
const reviewBadge = (value: string | null | undefined) => (value ? <StatusBadge status={REVIEW_BADGE[value] ?? 'draft'} label={words(value)} /> : <span className="text-slate-400">Not available</span>);

const CONNECTOR_ICON: Record<string, LucideIcon> = { google_sheets: Sheet, webhooks: Webhook, meta_ads: Megaphone, crm: Blocks };

export function DashboardPage() {
  const { user } = useAuth();
  const { workspace, can } = useWorkspace();
  const base = `/w/${workspace.id}`;
  // Always fresh: fetched again every time the dashboard opens.
  const query = useQuery({
    queryKey: ['dashboard', workspace.id],
    queryFn: () => api.get<DashboardData>(`/workspaces/${workspace.id}/dashboard`),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const d = query.data;

  return (
    <>
      <PageHeader
        title={`Welcome, ${user?.name.split(' ')[0] ?? ''}`}
        description={d ? `Live data for ${workspace.name} · updated ${formatDate(d.generatedAt, true)}` : `Live data for ${workspace.name}`}
        actions={
          <Button variant="secondary" loading={query.isFetching} onClick={() => void query.refetch()}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
        }
      />

      {query.error != null && (
        <div className="mb-4">
          <Alert>
            Could not load the dashboard: {errorMessage(query.error)}{' '}
            <button className="font-semibold underline" onClick={() => void query.refetch()}>
              Try again
            </button>
          </Alert>
        </div>
      )}
      {d?.metaError && (
        <div className="mb-4">
          <Alert>
            <strong>WhatsApp account data could not be refreshed.</strong> {d.metaError} The account widgets below show the last saved values.
          </Alert>
        </div>
      )}

      {!d ? (
        query.isPending && <DashboardSkeleton />
      ) : (
        <div className="space-y-6">
          {!d.waba && <SetupCard base={base} contacts={d.overview.contacts} canConnect={can('provider:manage')} />}

          {/* Overview */}
          <section aria-label="Overview" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat icon={Users} label="Total contacts" value={num(d.overview.contacts)} to={`${base}/audience`} />
            <Stat icon={MessageSquare} label="Conversations today" value={num(d.overview.conversationsToday)} hint={`${num(d.overview.conversationsWeek)} in the last 7 days`} to={`${base}/inbox`} />
            <Stat icon={Workflow} label="Active flows" value={num(d.overview.activeFlows)} to={`${base}/flows`} />
            <Stat icon={Megaphone} label="Campaigns running" value={num(d.overview.campaignsRunning)} to={`${base}/broadcast`} />
            <Stat icon={Send} label="Messages sent" value={num(d.overview.messages.sent)} hint="Last 7 days" />
            <Stat icon={CheckCheck} label="Delivered" value={num(d.overview.messages.delivered)} hint={`${pct(d.overview.messages.delivered, d.overview.messages.sent)} of sent`} />
            <Stat icon={CheckCheck} label="Read" value={num(d.overview.messages.read)} hint={`${pct(d.overview.messages.read, d.overview.messages.sent)} of sent`} accent="text-sky-600" />
            <Stat icon={MessagesSquare} label="Open chats" value={num(d.overview.openChats)} hint={d.overview.messages.failed ? `${num(d.overview.messages.failed)} message(s) failed this week` : undefined} to={`${base}/inbox`} />
          </section>

          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {/* My Profile */}
            <Widget title="My Profile" action={can('workspace:update') ? <WidgetLink to={`${base}/settings`}>Edit profile</WidgetLink> : undefined}>
              <div className="flex items-center gap-3">
                {d.profile.logoUrl ? (
                  <img src={d.profile.logoUrl} alt="" className="size-12 rounded-full border border-slate-200 object-cover" />
                ) : (
                  <span className="flex size-12 items-center justify-center rounded-full bg-brand-100 text-base font-semibold text-brand-700">{d.profile.businessName.slice(0, 2).toUpperCase()}</span>
                )}
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">{d.profile.businessName}</p>
                  <p className="truncate text-sm text-slate-500">{d.profile.phoneNumber ?? 'No WhatsApp number yet'}</p>
                </div>
              </div>
              <Rows>
                <Row label="WhatsApp display name">{d.profile.displayName ?? <span className="text-slate-400">Not connected</span>}</Row>
                <Row label="Phone number">{d.profile.phoneNumber ?? <span className="text-slate-400">Not connected</span>}</Row>
                <Row label="Plan">
                  <span className="inline-flex items-center gap-2">
                    {d.profile.plan.name} <StatusBadge status={d.profile.plan.status === 'expired' ? 'failed' : d.profile.plan.status} label={d.profile.plan.status === 'trialing' ? 'Trial' : words(d.profile.plan.status)} />
                  </span>
                </Row>
                <Row label={d.profile.plan.status === 'trialing' ? 'Trial ends' : 'Renews / ends'}>{formatDate(d.profile.plan.trialEndsAt ?? d.profile.plan.renewsAt)}</Row>
              </Rows>
            </Widget>

            {/* WABA Account Overall Status */}
            <Widget title="WABA Account Status" action={<WidgetLink to={`${base}/whatsapp`}>{d.waba ? 'Manage' : 'Connect'}</WidgetLink>}>
              {d.waba ? (
                <>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={d.waba.status} label={d.waba.status === 'connected' ? 'Connected' : d.waba.status === 'pending' ? 'Pending' : 'Disconnected'} />
                    {d.waba.wabaName && <span className="truncate text-sm text-slate-600">{d.waba.wabaName}</span>}
                  </div>
                  {d.waba.status === 'disconnected' && d.waba.lastError && <p className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-700">{d.waba.lastError}</p>}
                  <Rows>
                    <Row label="WABA ID">
                      <span className="font-mono text-xs">{d.waba.wabaId}</span>
                    </Row>
                    <Row label="Business verification">{reviewBadge(d.waba.businessVerification)}</Row>
                    <Row label="Display name">{reviewBadge(d.waba.displayNameStatus)}</Row>
                    <Row label="Account review">{reviewBadge(d.waba.accountReview)}</Row>
                  </Rows>
                </>
              ) : (
                <WidgetEmpty icon={ShieldCheck} text="No WhatsApp Business Account is connected yet." />
              )}
            </Widget>

            {/* WhatsApp Business Health */}
            <Widget title="WhatsApp Business Health">
              {d.health ? (
                <>
                  {(() => {
                    const q = QUALITY[d.health.qualityRating ?? ''];
                    return (
                      <div>
                        <p className="text-xs text-slate-500">Quality rating</p>
                        <p className={cn('mt-0.5 flex items-center gap-2 text-lg font-semibold', q?.text ?? 'text-slate-500')}>
                          <span className={cn('size-2.5 rounded-full', q?.dot ?? 'bg-slate-300')} />
                          {q ? `${q.label} (${words(d.health.qualityRating)})` : 'Not rated yet'}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">{q?.help ?? 'Meta rates a number once it has sent enough messages.'}</p>
                      </div>
                    );
                  })()}
                  <Rows>
                    <Row label="Messaging status">{reviewBadge(d.health.canSendMessage)}</Row>
                    <Row label="Phone number status">{reviewBadge(d.health.phoneStatus)}</Row>
                  </Rows>
                  {d.health.issues.length > 0 ? (
                    <ul className="mt-3 space-y-2">
                      {d.health.issues.map((issue, i) => (
                        <li key={i} className="flex gap-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
                          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                          <span>
                            <strong>{issue.entity}:</strong> {issue.message}
                            {issue.solution && <span className="block text-amber-800">{issue.solution}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-700">
                      <CheckCircle2 className="size-3.5" /> No warnings or restrictions from Meta.
                    </p>
                  )}
                </>
              ) : (
                <WidgetEmpty icon={ShieldCheck} text="Health appears here once a number is connected." />
              )}
            </Widget>
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            {/* Broadcasting Limits & Quotas */}
            <Widget title="Broadcasting Limits & Quotas" className="xl:col-span-2">
              <div className="grid gap-6 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-slate-500">Messaging tier (customers per 24 hours)</p>
                  <p className="mt-0.5 text-2xl font-semibold text-ink">{d.limits.tier ? (TIER_LABEL[d.limits.tier] ?? words(d.limits.tier)) : '—'}</p>
                  <Meter
                    label="Used in the last 24 hours"
                    used={d.limits.used}
                    limit={d.limits.unlimited ? null : d.limits.limit}
                    caption={d.limits.unlimited ? `${num(d.limits.used)} used · no limit` : d.limits.limit === null ? `${num(d.limits.used)} used` : `${num(d.limits.used)} used · ${num(d.limits.remaining ?? 0)} remaining`}
                  />
                  <p className="mt-2 text-[11px] leading-snug text-slate-400">Counts customers you started a conversation with using a template. Replies inside the 24-hour window are not limited.</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Templates</p>
                  <p className="mt-0.5 text-2xl font-semibold text-ink">
                    {num(d.limits.templates.total)} <span className="text-base font-normal text-slate-400">/ {num(d.limits.templates.quota)}</span>
                  </p>
                  <Meter label="Template quota used" used={d.limits.templates.total} limit={d.limits.templates.quota} caption={`${num(Math.max(0, d.limits.templates.quota - d.limits.templates.total))} remaining`} />
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <StatusBadge status="approved" label={`${d.limits.templates.approved} approved`} />
                    <StatusBadge status="pending" label={`${d.limits.templates.pending} pending`} />
                    <StatusBadge status="rejected" label={`${d.limits.templates.rejected} rejected`} />
                  </div>
                </div>
              </div>
            </Widget>

            {/* Connectors */}
            <Widget title="Connectors">
              <ul className="divide-y divide-slate-100">
                {d.connectors.map((c) => {
                  const Icon = CONNECTOR_ICON[c.key] ?? Blocks;
                  return (
                    <li key={c.key} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                        <Icon className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-800">{c.name}</p>
                        <p className="truncate text-xs text-slate-500" title={c.detail}>
                          {c.detail}
                        </p>
                        <div className="mt-1">
                          <StatusBadge status={c.connected ? 'connected' : 'draft'} label={c.connected ? 'Connected' : 'Not connected'} />
                        </div>
                      </div>
                      <WidgetLink to={`${base}/${c.path}`}>{c.connected ? 'Manage' : 'Connect'}</WidgetLink>
                    </li>
                  );
                })}
              </ul>
            </Widget>
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ icon: Icon, label, value, hint, to, accent }: { icon: LucideIcon; label: string; value: string; hint?: string; to?: string; accent?: string }) {
  const body = (
    <Card className={cn('h-full p-4', to && 'transition hover:border-brand-500 hover:shadow-md')}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        <Icon className={cn('size-4', accent ?? 'text-slate-400')} />
      </div>
      <p className="mt-2 text-2xl font-semibold text-ink tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

function Widget({ title, action, className, children }: { title: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <Card className={cn('flex flex-col p-5', className)}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

const WidgetLink = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link to={to} className="shrink-0 text-sm font-medium text-brand-700 hover:underline">
    {children}
  </Link>
);

const Rows = ({ children }: { children: ReactNode }) => <dl className="mt-4 space-y-2.5 text-sm">{children}</dl>;
const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-center justify-between gap-3">
    <dt className="shrink-0 text-slate-500">{label}</dt>
    <dd className="min-w-0 text-right font-medium break-words text-slate-800">{children}</dd>
  </div>
);

function WidgetEmpty({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
      <span className="rounded-full bg-slate-100 p-2.5 text-slate-400">
        <Icon className="size-5" />
      </span>
      <p className="text-sm text-slate-500">{text}</p>
    </div>
  );
}

function Meter({ label, used, limit, caption }: { label: string; used: number; limit: number | null; caption: string }) {
  const ratio = limit ? Math.min(1, used / limit) : 0;
  return (
    <div className="mt-3">
      <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="meter" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit ?? undefined}>
        {limit !== null && <div className={cn('h-full rounded-full', ratio >= 1 ? 'bg-red-500' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-brand-600')} style={{ width: `${Math.max(ratio * 100, used > 0 ? 2 : 0)}%` }} />}
      </div>
      <p className="mt-1.5 text-xs text-slate-600">{caption}</p>
    </div>
  );
}

function SetupCard({ base, contacts, canConnect }: { base: string; contacts: number; canConnect: boolean }) {
  const step = (done: boolean, title: string, description: string, action?: ReactNode) => (
    <li className="flex items-start gap-3 px-5 py-3.5">
      {done ? <CheckCircle2 className="mt-0.5 size-5 text-brand-600" /> : <Circle className="mt-0.5 size-5 text-slate-300" />}
      <div className="min-w-0 flex-1">
        <p className={done ? 'text-sm font-medium text-slate-500 line-through' : 'text-sm font-medium text-slate-800'}>{title}</p>
        <p className="mt-0.5 text-sm text-slate-500">{description}</p>
      </div>
      {action}
    </li>
  );
  return (
    <Card>
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-ink">Finish setting up</h2>
        <p className="mt-0.5 text-sm text-slate-500">Connect WhatsApp to start messaging customers.</p>
      </div>
      <ul className="divide-y divide-slate-100">
        {step(true, 'Create your workspace', 'Business details, timezone and currency.')}
        {step(false, 'Connect your WhatsApp Business number', 'Link the number your customers already message.', canConnect ? <WidgetLink to={`${base}/whatsapp`}>Connect</WidgetLink> : undefined)}
        {step(contacts > 0, 'Import your contacts', contacts > 0 ? `${contacts} contact(s) in this workspace.` : 'Upload a CSV of customers with tags and consent.', contacts === 0 ? <WidgetLink to={`${base}/audience`}>Import</WidgetLink> : undefined)}
      </ul>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading dashboard">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Card key={i} className="space-y-3 p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-16" />
          </Card>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Card key={i} className="space-y-3 p-5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </Card>
        ))}
      </div>
    </div>
  );
}

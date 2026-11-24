import { useQuery } from '@tanstack/react-query';
import { Blocks, CalendarClock, CheckCircle2, Circle, FileText, Megaphone, MessageSquare, RefreshCw, Sheet, TriangleAlert, Webhook, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Skeleton, StatusBadge } from '../components/feedback';
import { MirrorChart } from '../components/MirrorChart';
import { Ticks, type TickStatus } from '../components/Ticks';
import { relativeTime } from '../components/crm';
import { Alert, Button, Card, LoadError, PageHeader, cn } from '../components/ui';
import { api, type DashboardData } from '../lib/api';
import { formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';

const num = (n: number) => n.toLocaleString('en-IN');
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');
/** "PENDING_REVIEW" -> "Pending review" */
const words = (v: string | null | undefined) => (v ? v.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : 'Not available');

const TIER_LABEL: Record<string, string> = { TIER_50: '50', TIER_250: '250', TIER_1K: '1K', TIER_10K: '10K', TIER_100K: '100K', TIER_UNLIMITED: 'Unlimited' };
const QUALITY: Record<string, { label: string; dot: string; text: string; help: string }> = {
  GREEN: { label: 'High', dot: 'bg-brand-500', text: 'text-brand-700', help: 'Customers are responding well to your messages.' },
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
const ACTIVITY_ICON: Record<DashboardData['activity'][number]['kind'], LucideIcon> = { chat: MessageSquare, campaign: Megaphone, template: FileText, reminder: CalendarClock };
const ACTIVITY_STATUS: Record<string, string> = { in_appeal: 'pending', pending_deletion: 'failed', disabled: 'failed', sent: 'completed' };

/** "12% more than the week before" */
function change(now: number, before: number): string {
  if (!before) return now ? 'None the week before' : 'None in the last 14 days';
  const diff = Math.round(((now - before) / before) * 100);
  return diff === 0 ? 'Same as the week before' : `${Math.abs(diff)}% ${diff > 0 ? 'more' : 'fewer'} than the week before`;
}

export function DashboardPage() {
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
  const o = d?.overview;
  const live = o ? o.activeFlows + o.activeReminders + o.keywordTriggers + o.campaignsRunning : 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={d ? `${workspace.name}, updated ${formatDate(d.generatedAt, true)}` : workspace.name}
        actions={
          <Button variant="secondary" loading={query.isFetching} onClick={() => void query.refetch()}>
            {!query.isFetching && <RefreshCw className="size-4" strokeWidth={1.5} />} Refresh
          </Button>
        }
      />

      {query.error != null && d && (
        <div className="mb-4">
          <Alert>The dashboard could not be refreshed, so the numbers below are from {formatDate(d.generatedAt, true)}.</Alert>
        </div>
      )}
      {d?.metaError && (
        <div className="mb-4">
          <Alert>
            <strong className="font-medium">WhatsApp account data could not be refreshed.</strong> {d.metaError} The account details below are the last saved values.
          </Alert>
        </div>
      )}

      {!d || !o ? (
        query.error != null ? (
          <Card>
            <LoadError error={query.error} what="the dashboard" onRetry={() => void query.refetch()} />
          </Card>
        ) : (
          <DashboardSkeleton />
        )
      ) : (
        <div className="space-y-6">
          {!d.waba && <SetupCard base={base} contacts={o.contacts} canConnect={can('provider:manage')} />}

          <section aria-label="Overview" className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <Stat label="Contacts" value={num(o.contacts)} hint={o.newContacts ? `${num(o.newContacts)} new in the last 7 days` : 'None new in the last 7 days'} to={`${base}/audience`} />
            <Stat label="Messages sent, 7 days" value={num(o.messages.sent)} hint={change(o.messages.sent, o.messages.prevSent)} to={can('conversations:view_all') ? `${base}/analytics` : undefined} />
            <Stat label="Open chats" value={num(o.openChats)} hint={`${num(o.conversationsToday)} active today`} to={`${base}/inbox`} />
            <Stat label="Automations live" value={num(live)} hint={live ? automations(o) : 'No flows, reminders or triggers are on'} to={`${base}/flows`} />
          </section>

          <div className="grid grid-cols-1 items-stretch gap-6 xl:grid-cols-3">
            <Widget title="Messages, last 14 days" className="xl:col-span-2">
              <MirrorChart days={d.trend} />
            </Widget>
            <Widget title="Delivery, last 7 days" action={o.messages.failed > 0 && can('conversations:view_all') ? <WidgetLink to={`${base}/analytics`}>See failures</WidgetLink> : undefined}>
              <DeliveryLadder m={o.messages} />
            </Widget>
          </div>

          <div className="grid grid-cols-1 items-stretch gap-6 xl:grid-cols-3">
            <Widget title="Recent activity" className="xl:col-span-2">
              {d.activity.length === 0 ? (
                <p className="text-sm text-slate-500">Chats, broadcasts, template decisions and reminders show up here as they happen.</p>
              ) : (
                <ul className="-mx-5 -mb-5 divide-y divide-slate-100 border-t border-slate-100">
                  {d.activity.map((a) => {
                    const Icon = ACTIVITY_ICON[a.kind];
                    return (
                      <li key={a.id} className="relative flex items-center gap-3 px-5 py-2.5 text-sm transition-colors hover:bg-slate-50">
                        <Icon className="size-4 shrink-0 text-slate-400" strokeWidth={1.5} />
                        <span className="min-w-0 flex-1">
                          <Link to={`${base}/${a.path}`} className="block truncate font-medium text-ink after:absolute after:inset-0">
                            {a.title}
                          </Link>
                          <span className="block truncate text-slate-500">{a.detail}</span>
                        </span>
                        {a.status && <StatusBadge status={ACTIVITY_STATUS[a.status] ?? a.status} label={words(a.status)} />}
                        <span className="w-12 shrink-0 text-right text-xs text-slate-400 tabular-nums">{relativeTime(a.at)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Widget>

            <Widget title="WhatsApp number" action={<WidgetLink to={`${base}/whatsapp`}>{d.waba ? 'Manage' : 'Connect'}</WidgetLink>}>
              {d.waba && d.health ? (
                <>
                  <div className="flex items-center gap-3">
                    {d.profile.logoUrl ? (
                      <img src={d.profile.logoUrl} alt="" className="size-10 rounded-full border border-slate-200 object-cover" />
                    ) : (
                      <span className="flex size-10 items-center justify-center rounded-full bg-brand-100 text-sm font-medium text-brand-700">{d.profile.businessName.slice(0, 2).toUpperCase()}</span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-ink">{d.profile.displayName ?? d.profile.businessName}</p>
                      <p className="truncate text-sm text-slate-500 tabular-nums">{d.profile.phoneNumber}</p>
                    </div>
                    <StatusBadge status={d.waba.status} label={d.waba.status === 'connected' ? 'Connected' : d.waba.status === 'pending' ? 'Pending' : 'Disconnected'} />
                  </div>
                  {d.waba.status === 'disconnected' && d.waba.lastError && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{d.waba.lastError}</p>}
                  <Rows>
                    <Row label="Quality rating">
                      <span className={cn('inline-flex items-center gap-2', QUALITY[d.health.qualityRating ?? '']?.text)} title={QUALITY[d.health.qualityRating ?? '']?.help ?? 'Meta rates a number once it has sent enough messages.'}>
                        <span className={cn('size-2 rounded-full', QUALITY[d.health.qualityRating ?? '']?.dot ?? 'bg-slate-300')} />
                        {QUALITY[d.health.qualityRating ?? '']?.label ?? 'Not rated yet'}
                      </span>
                    </Row>
                    <Row label="Sending">{reviewBadge(d.health.canSendMessage)}</Row>
                    <Row label="Number status">{reviewBadge(d.health.phoneStatus)}</Row>
                    <Row label="Display name">{reviewBadge(d.waba.displayNameStatus)}</Row>
                    <Row label="Business verification">{reviewBadge(d.waba.businessVerification)}</Row>
                    <Row label="Account review">{reviewBadge(d.waba.accountReview)}</Row>
                    <Row label="WABA">
                      <span className="text-xs">{d.waba.wabaName ? `${d.waba.wabaName}, ` : ''}</span>
                      <span className="font-mono text-xs">{d.waba.wabaId}</span>
                    </Row>
                  </Rows>
                  {d.health.issues.length > 0 && (
                    <ul className="mt-4 space-y-2">
                      {d.health.issues.map((issue, i) => (
                        <li key={i} className="flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                          <TriangleAlert className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
                          <span>
                            <strong className="font-medium">{issue.entity}:</strong> {issue.message}
                            {issue.solution && <span className="block text-amber-800">{issue.solution}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="text-sm text-slate-500">No WhatsApp Business Account is connected yet. Its health and limits appear here.</p>
              )}
            </Widget>
          </div>

          <div className="grid grid-cols-1 items-stretch gap-6 md:grid-cols-2 xl:grid-cols-4">
            <Widget title="Templates" action={<WidgetLink to={`${base}/templates`}>Open</WidgetLink>}>
              <p className="text-2xl leading-8 font-medium text-ink tabular-nums">
                {num(d.limits.templates.approved)} <span className="text-sm font-normal text-slate-500">approved</span>
              </p>
              <Rows>
                <Row label="In review">{num(d.limits.templates.pending)}</Row>
                <Row label="Rejected">{num(d.limits.templates.rejected)}</Row>
                <Row label="Meta quota">
                  {num(d.limits.templates.total)} of {num(d.limits.templates.quota)}
                </Row>
              </Rows>
            </Widget>
            <Widget title="Messaging limit">
              <p className="text-2xl leading-8 font-medium text-ink tabular-nums">
                {d.limits.tier ? (TIER_LABEL[d.limits.tier] ?? words(d.limits.tier)) : 'Unknown'} <span className="text-sm font-normal text-slate-500">customers per 24 hours</span>
              </p>
              <Meter
                label="Used in the last 24 hours"
                used={d.limits.used}
                limit={d.limits.unlimited ? null : d.limits.limit}
                caption={d.limits.unlimited ? `${num(d.limits.used)} used, no limit` : d.limits.limit === null ? `${num(d.limits.used)} used` : `${num(d.limits.used)} used, ${num(d.limits.remaining ?? 0)} remaining`}
              />
              <p className="mt-3 text-xs text-slate-500">Counts customers you messaged first with a template. Replies within 24 hours are free of this limit.</p>
            </Widget>
            <Widget title="Date reminders" action={<WidgetLink to={`${base}/reminders`}>Open</WidgetLink>}>
              <p className="text-2xl leading-8 font-medium text-ink tabular-nums">
                {num(o.remindersDue)} <span className="text-sm font-normal text-slate-500">due in 7 days</span>
              </p>
              <Rows>
                <Row label="Live reminders">{num(o.activeReminders)}</Row>
                <Row label="Live flows">{num(o.activeFlows)}</Row>
                <Row label="Broadcasts running">{num(o.campaignsRunning)}</Row>
              </Rows>
            </Widget>
            <Widget title="Plan" action={<WidgetLink to={`${base}/billing`}>Billing</WidgetLink>}>
              <p className="flex items-center gap-3 text-2xl leading-8 font-medium text-ink">
                {d.profile.plan.name}
                <StatusBadge status={d.profile.plan.status === 'expired' ? 'failed' : d.profile.plan.status} label={d.profile.plan.status === 'trialing' ? 'Trial' : words(d.profile.plan.status)} />
              </p>
              <Rows>
                <Row label={d.profile.plan.status === 'trialing' ? 'Trial ends' : 'Renews or ends'}>{formatDate(d.profile.plan.trialEndsAt ?? d.profile.plan.renewsAt)}</Row>
                <Row label="Business">{d.profile.businessName}</Row>
                {can('workspace:update') && (
                  <Row label="Profile">
                    <WidgetLink to={`${base}/settings`}>Edit</WidgetLink>
                  </Row>
                )}
              </Rows>
            </Widget>
          </div>

          <Widget title="Connectors">
            <ul className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
              {d.connectors.map((c) => {
                const Icon = CONNECTOR_ICON[c.key] ?? Blocks;
                return (
                  <li key={c.key} className="flex min-w-0 items-center gap-3 py-2">
                    <Icon className="size-[18px] shrink-0 text-slate-500" strokeWidth={1.5} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{c.name}</p>
                      <p className="truncate text-sm text-slate-500" title={c.detail}>
                        {c.detail}
                      </p>
                    </div>
                    {c.connected && <StatusBadge status="connected" />}
                    <WidgetLink to={`${base}/${c.path}`}>{c.connected ? 'Manage' : 'Set up'}</WidgetLink>
                  </li>
                );
              })}
            </ul>
          </Widget>
        </div>
      )}
    </>
  );
}

function automations(o: DashboardData['overview']): string {
  const part = (n: number, one: string, many = `${one}s`) => (n ? [`${n} ${n === 1 ? one : many}`] : []);
  return [...part(o.activeFlows, 'flow'), ...part(o.activeReminders, 'reminder'), ...part(o.keywordTriggers, 'keyword trigger'), ...part(o.campaignsRunning, 'broadcast')].join(', ');
}

function Stat({ label, value, hint, to }: { label: string; value: string; hint: string; to?: string }) {
  const body = (
    <Card className={cn('h-full p-5', to && 'transition-colors hover:border-slate-400')}>
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-2 text-3xl leading-9 font-medium text-ink tabular-nums">{value}</p>
      <p className="mt-1 text-sm text-slate-500">{hint}</p>
    </Card>
  );
  return to ? (
    <Link to={to} className="rounded-xl">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Sent, delivered, read: the same ticks people know from WhatsApp, each as a share of what was sent. */
function DeliveryLadder({ m }: { m: DashboardData['overview']['messages'] }) {
  const steps: { status: TickStatus; label: string; value: number }[] = [
    { status: 'sent', label: 'Sent', value: m.sent },
    { status: 'delivered', label: 'Delivered', value: m.delivered },
    { status: 'read', label: 'Read', value: m.read },
  ];
  return (
    <div className="flex flex-1 flex-col justify-between gap-5">
      {steps.map((s) => (
        <div key={s.status}>
          <div className="flex items-center gap-2.5">
            <Ticks status={s.status} />
            <span className="text-sm text-slate-600">{s.label}</span>
            <span className="ml-auto text-xl leading-7 font-medium text-ink tabular-nums">{num(s.value)}</span>
            <span className="w-11 text-right text-sm text-slate-500 tabular-nums">{s.status === 'sent' ? '' : pct(s.value, m.sent)}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div className={cn('h-full rounded-full', s.status === 'read' ? 'bg-read' : s.status === 'delivered' ? 'bg-slate-500' : 'bg-slate-400')} style={{ width: `${m.sent ? (s.value / m.sent) * 100 : 0}%` }} />
          </div>
        </div>
      ))}
      <dl className="flex justify-between gap-4 border-t border-slate-200 pt-4 text-sm">
        <div className="flex items-center gap-2">
          <Ticks status="failed" className={m.failed ? '' : 'opacity-40'} />
          <dt className="text-slate-500">Failed</dt>
          <dd className="font-medium text-ink tabular-nums">{num(m.failed)}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-slate-500">Received</dt>
          <dd className="font-medium text-ink tabular-nums">{num(m.received)}</dd>
        </div>
      </dl>
    </div>
  );
}

function Widget({ title, action, className, children }: { title: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <Card className={cn('flex min-w-0 flex-col p-5', className)}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-base font-medium text-ink">{title}</h2>
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
    <dd className="min-w-0 text-right break-words text-slate-800 tabular-nums">{children}</dd>
  </div>
);

function Meter({ label, used, limit, caption }: { label: string; used: number; limit: number | null; caption: string }) {
  const ratio = limit ? Math.min(1, used / limit) : 0;
  return (
    <div className="mt-3">
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100" role="meter" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit ?? undefined}>
        {limit !== null && <div className={cn('h-full rounded-full', ratio >= 1 ? 'bg-red-500' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-brand-600')} style={{ width: `${Math.max(ratio * 100, used > 0 ? 2 : 0)}%` }} />}
      </div>
      <p className="mt-1.5 text-sm text-slate-600">{caption}</p>
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
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i} className="space-y-3 p-5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-4 w-32" />
          </Card>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="space-y-4 p-5 xl:col-span-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-[320px] w-full" />
        </Card>
        <Card className="space-y-4 p-5">
          <Skeleton className="h-5 w-32" />
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </Card>
      </div>
    </div>
  );
}

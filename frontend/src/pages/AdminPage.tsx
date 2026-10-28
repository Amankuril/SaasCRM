import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Bot,
  Building2,
  Check,
  ClipboardList,
  Code2,
  Contact,
  Copy,
  CreditCard,
  Eye,
  EyeOff,
  Gauge,
  LogIn,
  Megaphone,
  MessageSquare,
  Minus,
  Pencil,
  PlayCircle,
  Search,
  ShieldOff,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { AButton, ALink, ActionMenu, AdminHeader, Panel, Segmented, Switch, useConfirm } from '../components/admin';
import { Modal, initials } from '../components/crm';
import { Alert, Badge, EmptyState, Field, Input, Select, Spinner, cn, errorMessage } from '../components/ui';
import { api, type FeatureKey, type LimitKey, type PlanInfo, type SubscriptionStatus, type Workspace, type WorkspaceStatus } from '../lib/api';
import { formatDate } from '../lib/options';
import { money } from './BillingPage';
import { ActivityTab, LogList, type LogItem } from './admin/ActivityTab';
import { SettingsTab } from './admin/SettingsTab';
import { UsersTab } from './admin/UsersTab';

export interface AdminWorkspace extends Workspace {
  memberCount: number;
  owners: (string | null)[];
  suspendedReason: string | null;
  subscription: { planCode: string; status: SubscriptionStatus; cycle: string; currentPeriodEnd: string; trialEndsAt: string | null; provider: string } | null;
}

interface Stats {
  users: number;
  workspaces: Record<WorkspaceStatus, number>;
  subscriptions: Partial<Record<SubscriptionStatus, number>>;
  mrr: number;
  currency: string;
}

export interface AdminPlan extends PlanInfo {
  sortOrder: number;
  providerPlanIds: { monthly: string | null; yearly: string | null };
  subscribers: number;
}

interface Ops {
  db: string;
  queues: Record<string, Record<string, number>> | null;
  last24h: { failedMessages: number; failedRuns: number; deadDeliveries: number };
  now: { retryingDeliveries: number; webhookBacklog: number; disabledEndpoints: number; brokenConnections: number };
  billing: { trialsEnding: OpsRow[]; pastDue: OpsRow[] };
}
interface OpsRow {
  workspaceId: string;
  name: string;
  planCode: string;
  status: string;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
}

export const STATUS_TONE = { setup: 'amber', active: 'green', suspended: 'red' } as const;
export const SUB_TONE: Record<SubscriptionStatus, 'blue' | 'green' | 'amber' | 'red' | 'gray'> = { trialing: 'blue', active: 'green', past_due: 'amber', suspended: 'red', cancelled: 'gray', expired: 'red' };

function useStats() {
  return useQuery({ queryKey: ['admin', 'stats'], queryFn: () => api.get<Stats>('/admin/stats') });
}

function StatsRow() {
  const s = useStats().data;
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
      <StatCard label="Users" value={s?.users} />
      <StatCard label="Businesses" value={s ? Object.values(s.workspaces).reduce((a, b) => a + b, 0) : undefined} />
      <StatCard label="Paying" value={s ? (s.subscriptions.active ?? 0) + (s.subscriptions.past_due ?? 0) : undefined} />
      <StatCard label="On trial" value={s?.subscriptions.trialing ?? (s ? 0 : undefined)} />
      <StatCard label="MRR (est.)" value={s ? money(s.mrr, s.currency) : undefined} accent />
    </div>
  );
}

/** /admin: platform at a glance. */
export function AdminDashboardPage() {
  const ops = useQuery({ queryKey: ['admin', 'ops'], queryFn: () => api.get<Ops>('/admin/ops'), refetchInterval: 30_000 });
  const activity = useQuery({ queryKey: ['admin', 'feed', 'recent'], queryFn: () => api.get<{ items: LogItem[] }>('/admin/activity?limit=8') });
  const stats = useStats().data;
  const o = ops.data;
  return (
    <>
      <AdminHeader eyebrow="Overview" title="Dashboard" description="The whole platform at a glance. Everything changed from this panel is logged." />
      <StatsRow />
      {stats && (
        <div className="mb-6 flex flex-wrap gap-2">
          {(['setup', 'active', 'suspended'] as const).map((st) => (
            <Link key={st} to={`/admin/businesses?status=${st}`} className="group inline-flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-[13px] text-slate-600 ring-1 ring-slate-200 transition hover:text-slate-900 hover:ring-slate-300">
              <span className={cn('size-1.5 rounded-full', st === 'active' ? 'bg-emerald-500' : st === 'setup' ? 'bg-amber-500' : 'bg-red-500')} />
              <span className="capitalize">{st}</span>
              <span className="font-semibold text-ink tabular-nums">{stats.workspaces[st] ?? 0}</span>
              <ArrowUpRight className="size-3.5 text-slate-400 group-hover:text-slate-700" />
            </Link>
          ))}
        </div>
      )}
      {o && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="Database" value={o.db} tone={o.db === 'up' ? 'text-emerald-700' : 'text-red-600'} />
          <Metric label="Failed sends (24h)" value={o.last24h.failedMessages} tone={warnTone(o.last24h.failedMessages)} />
          <Metric label="Unprocessed Meta webhooks" value={o.now.webhookBacklog} tone={warnTone(o.now.webhookBacklog)} />
          <Metric label="Numbers needing attention" value={o.now.brokenConnections} tone={warnTone(o.now.brokenConnections)} />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {o && <Attention title="Trials ending within 7 days" rows={o.billing.trialsEnding} date={(r) => r.trialEndsAt} />}
        {o && <Attention title="Overdue payments" rows={o.billing.pastDue} date={(r) => r.graceEndsAt} />}
      </div>
      <Panel className="mt-4" flush title="Recent admin actions" actions={<ALink to="/admin/activity" size="sm" variant="subtle" icon={ArrowUpRight}>View all</ALink>}>
        {activity.data?.items.length ? <LogList items={activity.data.items} showWorkspace /> : <p className="px-5 py-4 text-sm text-slate-500">Nothing logged yet.</p>}
      </Panel>
    </>
  );
}

export function AdminBusinessesPage() {
  return (
    <>
      <AdminHeader eyebrow="Customers" title="Businesses" description="Every tenant on the platform. Open one to manage its plan, members, limits and data." />
      <StatsRow />
      <TenantsTab />
    </>
  );
}

export function AdminUsersPage() {
  return (
    <>
      <AdminHeader eyebrow="Customers" title="Users" description="Every account on the platform: access, passwords, sessions and admin rights." />
      <UsersTab />
    </>
  );
}

export function AdminPlansPage() {
  return (
    <>
      <AdminHeader eyebrow="Billing" title="Plans" description="Prices, limits and features for each plan. Changes apply to every business on the plan right away." />
      <PlansTab />
    </>
  );
}

export function AdminOperationsPage() {
  return (
    <>
      <AdminHeader eyebrow="Platform" title="Operations" description="Queues, failing sends and webhooks, and billing that needs attention. Refreshes every 30 seconds." />
      <OpsTab />
    </>
  );
}

export function AdminActivityPage() {
  return (
    <>
      <AdminHeader eyebrow="Platform" title="Activity & audit" description="What platform admins did, and every business's own audit log." />
      <ActivityTab />
    </>
  );
}

export function AdminSettingsPage() {
  return (
    <>
      <AdminHeader eyebrow="Platform" title="Platform settings" description="Announcement banner, sign-ups, maintenance mode and recovery tools." />
      <SettingsTab />
    </>
  );
}

const warnTone = (n: number) => (n > 0 ? 'text-amber-700' : 'text-ink');

// ---------------------------------------------------------------------------

function TenantsTab() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [params] = useSearchParams();
  const [status, setStatus] = useState<'' | WorkspaceStatus>((params.get('status') as WorkspaceStatus | null) ?? '');
  const [q, setQ] = useState('');
  const [managing, setManaging] = useState<AdminWorkspace | null>(null);
  const list = useQuery({
    queryKey: ['admin', 'workspaces', status, q],
    queryFn: () => {
      const p = new URLSearchParams();
      if (status) p.set('status', status);
      if (q.trim()) p.set('q', q.trim());
      return api.get<{ workspaces: AdminWorkspace[] }>(`/admin/workspaces?${p}`);
    },
  });
  const setWorkspaceStatus = useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: WorkspaceStatus; reason?: string }) => api.patch(`/admin/workspaces/${id}`, { status, reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const support = useMutation({ mutationFn: (id: string) => api.post<{ url: string }>(`/admin/workspaces/${id}/support-access`), onSuccess: (r) => navigate(r.url) });

  const suspend = async (ws: AdminWorkspace) => {
    const reason = await confirm({
      title: `Suspend ${ws.name}?`,
      message: 'The business becomes read-only: nothing can be sent or changed until you reactivate it.',
      confirmLabel: 'Suspend business',
      tone: 'danger',
      input: { label: 'Reason (shown to the business)', placeholder: 'e.g. Unpaid invoice ZC-0042' },
    });
    if (reason !== null) setWorkspaceStatus.mutate({ id: ws.id, status: 'suspended', reason: reason.trim() || undefined });
  };

  return (
    <Panel flush>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3">
        <SearchInput value={q} onChange={setQ} placeholder="Search business, owner email or name…" />
        <Segmented<'' | WorkspaceStatus>
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: 'All' },
            { value: 'active', label: 'Active' },
            { value: 'setup', label: 'Setup' },
            { value: 'suspended', label: 'Suspended' },
          ]}
        />
        {list.data && <span className="ml-auto text-xs text-slate-500">{list.data.workspaces.length} shown</span>}
      </div>
      {(setWorkspaceStatus.error ?? support.error) != null && (
        <div className="px-5 pt-4">
          <Alert>{errorMessage(setWorkspaceStatus.error ?? support.error)}</Alert>
        </div>
      )}
      {list.isPending ? (
        <Spinner />
      ) : list.error ? (
        <div className="p-5">
          <Alert>{errorMessage(list.error)}</Alert>
        </div>
      ) : list.data.workspaces.length === 0 ? (
        <EmptyState icon={<Building2 className="size-5" />} title="No businesses found" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50/70 text-left text-[11px] font-medium tracking-wide text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-2.5 font-medium">Business</th>
                <th className="px-4 py-2.5 font-medium">Owner</th>
                <th className="px-4 py-2.5 font-medium">Plan</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Created</th>
                <th className="w-px px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.workspaces.map((ws) => (
                <tr key={ws.id} className="group hover:bg-slate-50/60">
                  <td className="px-5 py-3">
                    <Link to={`/admin/workspaces/${ws.id}`} className="flex items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-xs font-semibold text-white">{initials(ws.name)}</span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-slate-900 group-hover:underline">{ws.name}</span>
                        <span className="block truncate text-xs text-slate-500">
                          {ws.industry ?? 'No industry'} · {ws.country} · {ws.memberCount} member{ws.memberCount === 1 ? '' : 's'}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td className="max-w-48 truncate px-4 py-3 text-slate-600">{ws.owners.filter(Boolean).join(', ') || '—'}</td>
                  <td className="px-4 py-3">
                    {ws.subscription ? (
                      <div className="flex flex-col items-start gap-1">
                        <span className="flex items-center gap-2">
                          <span className="font-medium text-slate-800 capitalize">{ws.subscription.planCode}</span>
                          <Badge tone={SUB_TONE[ws.subscription.status]}>{ws.subscription.status.replace('_', ' ')}</Badge>
                        </span>
                        <span className="text-[11px] text-slate-400">
                          {ws.subscription.status === 'trialing' && ws.subscription.trialEndsAt ? `Trial ends ${formatDate(ws.subscription.trialEndsAt)}` : `Renews ${formatDate(ws.subscription.currentPeriodEnd)}`}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">Trial not started</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={STATUS_TONE[ws.status]}>{ws.status}</Badge>
                    {ws.suspendedReason && (
                      <p className="mt-1 max-w-40 truncate text-xs text-slate-500" title={ws.suspendedReason}>
                        {ws.suspendedReason}
                      </p>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 text-slate-500 md:table-cell">{formatDate(ws.createdAt)}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <ALink to={`/admin/workspaces/${ws.id}`} size="sm">
                        Open
                      </ALink>
                      <ActionMenu
                        items={[
                          { label: 'Open as support', icon: LogIn, onSelect: () => support.mutate(ws.id) },
                          { label: 'Change plan', icon: CreditCard, onSelect: () => setManaging(ws) },
                          { label: 'Copy business ID', icon: Copy, onSelect: () => void navigator.clipboard?.writeText(ws.id) },
                          'separator',
                          ws.status === 'suspended'
                            ? { label: 'Reactivate', icon: PlayCircle, onSelect: () => setWorkspaceStatus.mutate({ id: ws.id, status: 'active' }) }
                            : { label: 'Suspend…', icon: ShieldOff, danger: true, onSelect: () => void suspend(ws) },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {managing && <SubscriptionModal ws={managing} onClose={() => setManaging(null)} />}
    </Panel>
  );
}

export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative w-full max-w-xs">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
      <input
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border-0 bg-white pr-3 pl-9 text-sm text-slate-900 ring-1 ring-slate-200 placeholder:text-slate-400 focus:ring-2 focus:ring-slate-900/15 focus:outline-none"
      />
    </div>
  );
}

/** Footer bar for admin modals (cancels the Modal's padding). */
export function ModalFooter({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="-mx-5 -mb-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/70 px-5 py-3 sm:-mx-6 sm:-mb-6 sm:px-6">
      <div className="text-xs text-slate-500">{note}</div>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

export function SubscriptionModal({ ws, onClose }: { ws: Pick<AdminWorkspace, 'id' | 'name' | 'subscription'>; onClose: () => void }) {
  const queryClient = useQueryClient();
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api.get<{ plans: AdminPlan[] }>('/admin/plans') });
  const [planCode, setPlanCode] = useState('');
  const [status, setStatus] = useState('');
  const [cycle, setCycle] = useState('');
  const [extendDays, setExtendDays] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/admin/workspaces/${ws.id}/subscription`, {
        ...(planCode ? { planCode } : {}),
        ...(status ? { status } : {}),
        ...(cycle ? { cycle } : {}),
        ...(extendDays ? { extendDays: Number(extendDays) } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
      onClose();
    },
  });
  const current = ws.subscription?.status ?? 'trialing';
  return (
    <Modal title={`Subscription · ${ws.name}`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
          <span className="text-slate-500">Current</span>
          <span className="flex items-center gap-2">
            <strong className="text-slate-900 capitalize">{ws.subscription?.planCode ?? 'trial'}</strong>
            <Badge tone={SUB_TONE[current]}>{current.replace('_', ' ')}</Badge>
          </span>
        </div>
        <p className="text-slate-500">For offline payments, extensions and comps. Fields left on “Keep current” don't change.</p>
        {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
        <Field label="Plan" htmlFor="sm-plan">
          <Select id="sm-plan" value={planCode} onChange={(e) => setPlanCode(e.target.value)}>
            <option value="">Keep current</option>
            {plans.data?.plans.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status" htmlFor="sm-status">
            <Select id="sm-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Keep current</option>
              {['trialing', 'active', 'past_due', 'suspended', 'cancelled', 'expired'].map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Billing cycle" htmlFor="sm-cycle">
            <Select id="sm-cycle" value={cycle} onChange={(e) => setCycle(e.target.value)}>
              <option value="">Keep current</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </Select>
          </Field>
        </div>
        <Field label="Extend by (days)" htmlFor="sm-ext" hint="Extends the trial or the paid period, and restores access if overdue.">
          <Input id="sm-ext" type="number" min={1} max={365} value={extendDays} onChange={(e) => setExtendDays(e.target.value)} />
        </Field>
        <ModalFooter note="Every change is audited.">
          <AButton onClick={onClose}>Cancel</AButton>
          <AButton variant="primary" loading={save.isPending} disabled={!planCode && !status && !cycle && !extendDays} onClick={() => save.mutate()}>
            Apply changes
          </AButton>
        </ModalFooter>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

export const LIMIT_LABEL: Record<LimitKey, string> = {
  monthlyMessages: 'Messages / period',
  contacts: 'Contacts',
  seats: 'Team members',
  activeFlows: 'Live flows',
  forms: 'Forms',
  aiRepliesPerMonth: 'AI replies / period',
  apiRequestsPerMinute: 'API requests / min',
};
const LIMIT_ICON: Record<LimitKey, LucideIcon> = {
  monthlyMessages: MessageSquare,
  contacts: Contact,
  seats: Users,
  activeFlows: Workflow,
  forms: ClipboardList,
  aiRepliesPerMonth: Bot,
  apiRequestsPerMinute: Gauge,
};
export const FEATURES: FeatureKey[] = ['campaigns', 'flows', 'forms', 'ai', 'api'];
export const FEATURE_INFO: Record<FeatureKey, { label: string; icon: LucideIcon }> = {
  campaigns: { label: 'Broadcasts', icon: Megaphone },
  flows: { label: 'Flow builder', icon: Workflow },
  forms: { label: 'WhatsApp forms', icon: ClipboardList },
  ai: { label: 'AI agent', icon: Bot },
  api: { label: 'API & webhooks', icon: Code2 },
};

function PlansTab() {
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api.get<{ plans: AdminPlan[] }>('/admin/plans') });
  const [editing, setEditing] = useState<AdminPlan | null>(null);
  if (plans.isPending) return <Spinner />;
  if (plans.error) return <Alert>{errorMessage(plans.error)}</Alert>;
  const list = plans.data.plans;
  // "Most popular": the public paid plan with the most businesses on it.
  const popular = [...list].filter((p) => p.isPublic && p.priceMonthly > 0 && p.subscribers > 0).sort((a, b) => b.subscribers - a.subscribers)[0]?.code;
  const total = list.reduce((n, p) => n + p.subscribers, 0);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-500">
        <span>
          <strong className="font-semibold text-ink tabular-nums">{list.length}</strong> plans
        </span>
        <span>
          <strong className="font-semibold text-ink tabular-nums">{list.filter((p) => p.isPublic).length}</strong> on the billing page
        </span>
        <span>
          <strong className="font-semibold text-ink tabular-nums">{total}</strong> businesses subscribed
        </span>
      </div>
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {list.map((p) => (
          <PlanCard key={p.code} plan={p} popular={p.code === popular} share={total ? p.subscribers / total : 0} onEdit={() => setEditing(p)} />
        ))}
      </div>
      <p className="mt-5 text-xs text-slate-500">Create the matching plans in the Razorpay dashboard and paste their plan ids into each plan. A plan can only be bought for a billing cycle that has an id.</p>
      {editing && <PlanModal plan={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function PlanCard({ plan: p, popular, share, onEdit }: { plan: AdminPlan; popular: boolean; share: number; onEdit: () => void }) {
  const free = p.priceMonthly === 0;
  const yearlySaving = p.priceMonthly > 0 && p.priceYearly > 0 ? Math.round((1 - p.priceYearly / (p.priceMonthly * 12)) * 100) : 0;
  return (
    <article className={cn('relative flex flex-col overflow-hidden rounded-2xl bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)] transition hover:shadow-md', popular ? 'ring-2 ring-slate-900' : 'ring-1 ring-slate-200')}>
      {popular && <span className="absolute top-4 right-4 rounded-full bg-slate-900 px-2.5 py-0.5 text-[11px] font-medium text-white">Most popular</span>}
      <div className="p-5 pb-4">
        <h3 className="pr-24 text-base font-semibold text-ink">{p.name}</h3>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{p.code}</code>
          {p.isPublic ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
              <Eye className="size-3" /> On billing page
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
              <EyeOff className="size-3" /> Hidden
            </span>
          )}
        </div>
        <p className="mt-3 line-clamp-2 min-h-10 text-[13px] leading-5 text-slate-500">{p.description || 'No description.'}</p>

        <div className="mt-4 flex items-baseline gap-1">
          <span className="text-3xl font-semibold tracking-tight text-ink tabular-nums">{free ? 'Free' : money(p.priceMonthly, p.currency)}</span>
          {!free && <span className="text-sm text-slate-500">/month</span>}
        </div>
        <p className="mt-1 min-h-5 text-xs text-slate-500">
          {free ? (
            p.trialDays ? `${p.trialDays}-day trial, then a paid plan` : 'No charge'
          ) : p.priceYearly ? (
            <>
              {money(p.priceYearly, p.currency)} billed yearly
              {yearlySaving > 0 && <span className="ml-1.5 rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-700">save {yearlySaving}%</span>}
            </>
          ) : (
            'Monthly only'
          )}
        </p>

        <div className="mt-4">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">Businesses on this plan</span>
            <span className="font-medium text-slate-800 tabular-nums">{p.subscribers}</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-slate-900" style={{ width: `${Math.max(share * 100, p.subscribers ? 4 : 0)}%` }} />
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100 px-5 py-4">
        <p className="mb-2.5 text-[11px] font-medium tracking-wide text-slate-400 uppercase">Limits</p>
        <ul className="space-y-1.5 text-[13px]">
          {(Object.keys(LIMIT_LABEL) as LimitKey[]).map((k) => {
            const Icon = LIMIT_ICON[k];
            const v = p.limits[k];
            return (
              <li key={k} className="flex items-center gap-2">
                <Icon className="size-3.5 shrink-0 text-slate-400" />
                <span className="flex-1 text-slate-600">{LIMIT_LABEL[k]}</span>
                <span className={cn('font-medium tabular-nums', v === 0 ? 'text-slate-300' : 'text-slate-900')}>{v === null ? 'Unlimited' : v!.toLocaleString('en-IN')}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="border-t border-slate-100 px-5 py-4">
        <p className="mb-2.5 text-[11px] font-medium tracking-wide text-slate-400 uppercase">Features</p>
        <ul className="space-y-1.5 text-[13px]">
          {FEATURES.map((f) => (
            <li key={f} className={cn('flex items-center gap-2', p.features[f] ? 'text-slate-700' : 'text-slate-400')}>
              {p.features[f] ? <Check className="size-3.5 text-emerald-600" /> : <Minus className="size-3.5 text-slate-300" />}
              {FEATURE_INFO[f].label}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-5 py-3">
        <div className="flex flex-col gap-0.5 text-[11px] text-slate-500">
          {free ? (
            <span>Assigned, not bought</span>
          ) : (
            <>
              <RazorpayId label="Monthly" id={p.providerPlanIds.monthly} />
              <RazorpayId label="Yearly" id={p.providerPlanIds.yearly} />
            </>
          )}
        </div>
        <AButton size="sm" icon={Pencil} onClick={onEdit}>
          Edit plan
        </AButton>
      </div>
    </article>
  );
}

function RazorpayId({ label, id }: { label: string; id: string | null }) {
  return (
    <span className="flex items-center gap-1.5" title={id ?? 'No Razorpay plan id'}>
      <span className={cn('size-1.5 rounded-full', id ? 'bg-emerald-500' : 'bg-slate-300')} />
      {label} {id ? 'linked' : 'not linked'}
    </span>
  );
}

function PlanModal({ plan, onClose }: { plan: AdminPlan; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: plan.name,
    description: plan.description,
    priceMonthly: String(plan.priceMonthly / 100),
    priceYearly: String(plan.priceYearly / 100),
    trialDays: String(plan.trialDays),
    graceDays: String(plan.graceDays),
    isPublic: plan.isPublic,
    monthlyId: plan.providerPlanIds.monthly ?? '',
    yearlyId: plan.providerPlanIds.yearly ?? '',
    limits: Object.fromEntries((Object.keys(LIMIT_LABEL) as LimitKey[]).map((k) => [k, plan.limits[k] === null ? '' : String(plan.limits[k])])) as Record<LimitKey, string>,
    features: { ...plan.features },
  });
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/admin/plans/${plan.code}`, {
        name: form.name,
        description: form.description,
        priceMonthly: Math.round(Number(form.priceMonthly) * 100),
        priceYearly: Math.round(Number(form.priceYearly) * 100),
        trialDays: Number(form.trialDays),
        graceDays: Number(form.graceDays),
        isPublic: form.isPublic,
        providerPlanIds: { monthly: form.monthlyId || null, yearly: form.yearlyId || null },
        limits: Object.fromEntries(Object.entries(form.limits).map(([k, v]) => [k, v.trim() === '' ? null : Number(v)])),
        features: form.features,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
      onClose();
    },
  });
  return (
    <Modal title={`Edit plan · ${plan.name}`} onClose={onClose} wide>
      <div className="space-y-6 text-sm">
        {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
        <FormSection title="Details">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="pm-name">
              <Input id="pm-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Description" htmlFor="pm-desc">
              <Input id="pm-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Field>
          </div>
        </FormSection>
        <FormSection title="Pricing">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Per month (₹)" htmlFor="pm-pm">
              <Input id="pm-pm" type="number" min={0} value={form.priceMonthly} onChange={(e) => setForm({ ...form, priceMonthly: e.target.value })} />
            </Field>
            <Field label="Per year (₹)" htmlFor="pm-py">
              <Input id="pm-py" type="number" min={0} value={form.priceYearly} onChange={(e) => setForm({ ...form, priceYearly: e.target.value })} />
            </Field>
            <Field label="Trial days" htmlFor="pm-trial">
              <Input id="pm-trial" type="number" min={0} value={form.trialDays} onChange={(e) => setForm({ ...form, trialDays: e.target.value })} />
            </Field>
            <Field label="Grace days" htmlFor="pm-grace" hint="After a failed payment">
              <Input id="pm-grace" type="number" min={0} value={form.graceDays} onChange={(e) => setForm({ ...form, graceDays: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Razorpay plan id (monthly)" htmlFor="pm-rm">
                <Input id="pm-rm" value={form.monthlyId} placeholder="plan_…" onChange={(e) => setForm({ ...form, monthlyId: e.target.value })} />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Razorpay plan id (yearly)" htmlFor="pm-ry">
                <Input id="pm-ry" value={form.yearlyId} placeholder="plan_…" onChange={(e) => setForm({ ...form, yearlyId: e.target.value })} />
              </Field>
            </div>
          </div>
        </FormSection>
        <FormSection title="Limits · leave empty for unlimited">
          <div className="grid gap-3 sm:grid-cols-3">
            {(Object.keys(LIMIT_LABEL) as LimitKey[]).map((k) => (
              <Field key={k} label={LIMIT_LABEL[k]} htmlFor={`pm-l-${k}`}>
                <Input id={`pm-l-${k}`} type="number" min={0} placeholder="Unlimited" value={form.limits[k]} onChange={(e) => setForm({ ...form, limits: { ...form.limits, [k]: e.target.value } })} />
              </Field>
            ))}
          </div>
        </FormSection>
        <FormSection title="Features & visibility">
          <div className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
            {FEATURES.map((f) => {
              const Icon = FEATURE_INFO[f].icon;
              return (
                <div key={f} className="flex items-center gap-3 px-4 py-2.5">
                  <Icon className="size-4 text-slate-400" />
                  <span className="flex-1 text-slate-700">{FEATURE_INFO[f].label}</span>
                  <Switch label={FEATURE_INFO[f].label} checked={form.features[f]} onChange={(v) => setForm({ ...form, features: { ...form.features, [f]: v } })} />
                </div>
              );
            })}
            <div className="flex items-center gap-3 px-4 py-2.5">
              <Eye className="size-4 text-slate-400" />
              <span className="flex-1 text-slate-700">Show on the businesses' billing page</span>
              <Switch label="Show on billing page" checked={form.isPublic} onChange={(v) => setForm({ ...form, isPublic: v })} />
            </div>
          </div>
        </FormSection>
        <ModalFooter note="Applies to every business on this plan immediately.">
          <AButton onClick={onClose}>Cancel</AButton>
          <AButton variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save plan
          </AButton>
        </ModalFooter>
      </div>
    </Modal>
  );
}

export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-[11px] font-medium tracking-wide text-slate-400 uppercase">{title}</h3>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------

function OpsTab() {
  const ops = useQuery({ queryKey: ['admin', 'ops'], queryFn: () => api.get<Ops>('/admin/ops'), refetchInterval: 30_000 });
  if (ops.isPending) return <Spinner />;
  if (ops.error) return <Alert>{errorMessage(ops.error)}</Alert>;
  const o = ops.data;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Database" value={o.db} tone={o.db === 'up' ? 'text-emerald-700' : 'text-red-600'} />
        <Metric label="Failed sends (24h)" value={o.last24h.failedMessages} tone={warnTone(o.last24h.failedMessages)} />
        <Metric label="Failed flow runs (24h)" value={o.last24h.failedRuns} tone={warnTone(o.last24h.failedRuns)} />
        <Metric label="Dead webhook deliveries (24h)" value={o.last24h.deadDeliveries} tone={warnTone(o.last24h.deadDeliveries)} />
        <Metric label="Webhook deliveries retrying" value={o.now.retryingDeliveries} tone={warnTone(o.now.retryingDeliveries)} />
        <Metric label="Unprocessed Meta webhooks" value={o.now.webhookBacklog} tone={warnTone(o.now.webhookBacklog)} />
        <Metric label="Disabled webhook endpoints" value={o.now.disabledEndpoints} tone={warnTone(o.now.disabledEndpoints)} />
        <Metric label="Numbers needing attention" value={o.now.brokenConnections} tone={warnTone(o.now.brokenConnections)} />
      </div>

      <Panel flush title="Queues">
        {o.queues === null ? (
          <p className="px-5 py-4 text-sm text-slate-500">Inline queue driver: no Redis queues to report.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50/70 text-left text-[11px] tracking-wide text-slate-500 uppercase">
                <tr>
                  {['Queue', 'Waiting', 'Active', 'Delayed', 'Failed', 'Completed'].map((h, i) => (
                    <th key={h} className={cn('px-5 py-2.5 font-medium', i > 0 && 'text-right')}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {Object.entries(o.queues).map(([name, c]) => (
                  <tr key={name}>
                    <td className="px-5 py-2.5 font-mono text-xs text-slate-700">{name}</td>
                    {(['waiting', 'active', 'delayed', 'failed', 'completed'] as const).map((k) => (
                      <td key={k} className={cn('px-5 py-2.5 text-right tabular-nums', k === 'failed' && (c[k] ?? 0) > 0 ? 'font-medium text-red-600' : 'text-slate-700')}>
                        {c[k] ?? 0}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Attention title="Trials ending within 7 days" rows={o.billing.trialsEnding} date={(r) => r.trialEndsAt} />
        <Attention title="Overdue payments" rows={o.billing.pastDue} date={(r) => r.graceEndsAt} />
      </div>
    </div>
  );
}

function Attention({ title, rows, date }: { title: string; rows: OpsRow[]; date: (r: OpsRow) => string | null }) {
  return (
    <Panel flush title={title} actions={<span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 tabular-nums">{rows.length}</span>}>
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-500">Nothing needs attention.</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {rows.map((r) => (
            <li key={r.workspaceId}>
              <Link to={`/admin/workspaces/${r.workspaceId}`} className="flex items-center justify-between gap-2 px-5 py-2.5 hover:bg-slate-50">
                <span className="font-medium text-slate-800">{r.name}</span>
                <span className="text-xs text-slate-500">
                  {r.status.replace('_', ' ')} · {date(r) ? formatDate(date(r)!, true) : '—'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function Metric({ label, value, tone }: { label: string; value: ReactNode; tone: string }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-slate-200">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cn('mt-1.5 text-xl font-semibold tabular-nums', tone)}>{value}</p>
    </div>
  );
}

export function StatCard({ label, value, accent = false }: { label: string; value: ReactNode | undefined; accent?: boolean }) {
  return (
    <div className={cn('rounded-xl p-4 ring-1', accent ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-slate-200')}>
      <p className={cn('text-xs font-medium', accent ? 'text-slate-400' : 'text-slate-500')}>{label}</p>
      <p className={cn('mt-1.5 text-2xl font-semibold tracking-tight tabular-nums', accent ? 'text-white' : 'text-ink')}>{value ?? '—'}</p>
    </div>
  );
}

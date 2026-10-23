import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowLeft, Building2, Layers, LogOut } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Modal } from '../components/crm';
import { Logo } from '../components/Logo';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, cn, errorMessage } from '../components/ui';
import { api, type FeatureKey, type LimitKey, type PlanInfo, type SubscriptionStatus, type Workspace, type WorkspaceStatus } from '../lib/api';
import { formatDate } from '../lib/options';
import { money } from './BillingPage';

interface AdminWorkspace extends Workspace {
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

interface AdminPlan extends PlanInfo {
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

const STATUS_TONE = { setup: 'amber', active: 'green', suspended: 'red' } as const;
const SUB_TONE: Record<SubscriptionStatus, 'blue' | 'green' | 'amber' | 'red' | 'gray'> = { trialing: 'blue', active: 'green', past_due: 'amber', suspended: 'red', cancelled: 'gray', expired: 'red' };
type Tab = 'tenants' | 'plans' | 'ops';

export function AdminPage() {
  const { user, workspaces, logout } = useAuth();
  const [tab, setTab] = useState<Tab>('tenants');
  const stats = useQuery({ queryKey: ['admin', 'stats'], queryFn: () => api.get<Stats>('/admin/stats'), enabled: !!user?.isPlatformAdmin });

  if (!user?.isPlatformAdmin) return <Navigate to="/" replace />;
  const s = stats.data;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 flex items-center justify-between">
        <Logo />
        {/* An admin without a business has no app to go back to ("/" leads here). */}
        {workspaces.length > 0 ? (
          <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
            <ArrowLeft className="size-4" /> Back to app
          </Link>
        ) : (
          <button onClick={() => void logout('/admin/login')} className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
            <LogOut className="size-4" /> Log out
          </button>
        )}
      </div>
      <PageHeader title="Super Admin" description="All businesses (tenants), plans and platform health." />

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <StatCard label="Users" value={s?.users} />
        <StatCard label="Workspaces" value={s ? Object.values(s.workspaces).reduce((a, b) => a + b, 0) : undefined} />
        <StatCard label="Paying" value={s ? (s.subscriptions.active ?? 0) + (s.subscriptions.past_due ?? 0) : undefined} />
        <StatCard label="On trial" value={s?.subscriptions.trialing ?? (s ? 0 : undefined)} />
        <StatCard label="MRR (est.)" value={s ? money(s.mrr, s.currency) : undefined} />
      </div>

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
        {(
          [
            ['tenants', 'Tenants', Building2],
            ['plans', 'Plans', Layers],
            ['ops', 'Operations', Activity],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn('-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium', tab === id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}
          >
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>
      {tab === 'tenants' && <TenantsTab />}
      {tab === 'plans' && <PlansTab />}
      {tab === 'ops' && <OpsTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TenantsTab() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'' | WorkspaceStatus>('');
  const [q, setQ] = useState('');
  const [managing, setManaging] = useState<AdminWorkspace | null>(null);
  const list = useQuery({
    queryKey: ['admin', 'workspaces', status, q],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (q.trim()) params.set('q', q.trim());
      return api.get<{ workspaces: AdminWorkspace[] }>(`/admin/workspaces?${params}`);
    },
  });
  const setWorkspaceStatus = useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: WorkspaceStatus; reason?: string }) => api.patch(`/admin/workspaces/${id}`, { status, reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });

  return (
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
                <th className="px-4 py-2.5 font-medium">Plan</th>
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
                      {ws.industry ?? 'No industry'} · {ws.country} · {ws.memberCount} member(s)
                    </p>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{ws.owners.filter(Boolean).join(', ') || '—'}</td>
                  <td className="px-4 py-3">
                    {ws.subscription ? (
                      <>
                        <p className="font-medium text-slate-700 capitalize">{ws.subscription.planCode}</p>
                        <Badge tone={SUB_TONE[ws.subscription.status]}>{ws.subscription.status.replace('_', ' ')}</Badge>
                        <p className="mt-0.5 text-[11px] text-slate-400">
                          {ws.subscription.status === 'trialing' && ws.subscription.trialEndsAt ? `trial ends ${formatDate(ws.subscription.trialEndsAt)}` : `until ${formatDate(ws.subscription.currentPeriodEnd)}`}
                        </p>
                      </>
                    ) : (
                      <span className="text-xs text-slate-400">trial (not started)</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={STATUS_TONE[ws.status]}>{ws.status}</Badge>
                    {ws.suspendedReason && <p className="mt-1 text-xs text-slate-500">{ws.suspendedReason}</p>}
                  </td>
                  <td className="hidden px-4 py-3 text-slate-500 md:table-cell">{formatDate(ws.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <Button variant="secondary" onClick={() => setManaging(ws)}>
                        Plan
                      </Button>
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
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {managing && <SubscriptionModal ws={managing} onClose={() => setManaging(null)} />}
    </Card>
  );
}

function SubscriptionModal({ ws, onClose }: { ws: AdminWorkspace; onClose: () => void }) {
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
  return (
    <Modal title={`Plan for ${ws.name}`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">
          Now: <strong className="capitalize">{ws.subscription?.planCode ?? 'trial'}</strong> · {ws.subscription?.status ?? 'trialing'}. Use this for offline payments, extensions or comps. Changes are audited.
        </p>
        {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
        <Field label="Change plan" htmlFor="sm-plan">
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
          <Field label="Set status" htmlFor="sm-status">
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
        <Field label="Extend by (days)" htmlFor="sm-ext" hint="Extends the trial, or the paid period (and restores access if overdue).">
          <Input id="sm-ext" type="number" min={1} max={365} value={extendDays} onChange={(e) => setExtendDays(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!planCode && !status && !cycle && !extendDays} onClick={() => save.mutate()}>
            Apply
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

const LIMIT_LABEL: Record<LimitKey, string> = {
  monthlyMessages: 'Messages / period',
  contacts: 'Contacts',
  seats: 'Team members',
  activeFlows: 'Live flows',
  forms: 'Forms',
  aiRepliesPerMonth: 'AI replies / period',
  apiRequestsPerMinute: 'API requests / min',
};
const FEATURES: FeatureKey[] = ['campaigns', 'flows', 'forms', 'ai', 'api'];

function PlansTab() {
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api.get<{ plans: AdminPlan[] }>('/admin/plans') });
  const [editing, setEditing] = useState<AdminPlan | null>(null);
  if (plans.isPending) return <Spinner />;
  if (plans.error) return <Alert>{errorMessage(plans.error)}</Alert>;
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {plans.data.plans.map((p) => (
          <Card key={p.code} className="flex flex-col p-4 text-sm">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold text-ink">{p.name}</p>
              {!p.isPublic && <Badge>hidden</Badge>}
            </div>
            <p className="mt-1 text-slate-600">
              {money(p.priceMonthly, p.currency)}/mo · {money(p.priceYearly, p.currency)}/yr
            </p>
            <p className="text-xs text-slate-400">{p.subscribers} workspace(s)</p>
            <ul className="mt-3 flex-1 space-y-0.5 text-xs text-slate-600">
              {(Object.keys(LIMIT_LABEL) as LimitKey[]).map((k) => (
                <li key={k} className="flex justify-between gap-2">
                  <span>{LIMIT_LABEL[k]}</span>
                  <span className="tabular-nums">{p.limits[k] === null ? '∞' : p.limits[k]!.toLocaleString('en-IN')}</span>
                </li>
              ))}
              <li className="pt-1 text-slate-500">Features: {FEATURES.filter((f) => p.features[f]).join(', ') || 'none'}</li>
              <li className="text-slate-500">
                Razorpay: {p.providerPlanIds.monthly ? 'monthly ✓' : 'monthly ✗'} · {p.providerPlanIds.yearly ? 'yearly ✓' : 'yearly ✗'}
              </li>
            </ul>
            <Button variant="secondary" className="mt-3" onClick={() => setEditing(p)}>
              Edit
            </Button>
          </Card>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-500">Create the matching plans in the Razorpay dashboard and paste their plan ids here; a plan can only be bought for cycles with an id.</p>
      {editing && <PlanModal plan={editing} onClose={() => setEditing(null)} />}
    </>
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
    <Modal title={`Edit ${plan.name}`} onClose={onClose} wide>
      <div className="space-y-4 text-sm">
        {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="pm-name">
            <Input id="pm-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Description" htmlFor="pm-desc">
            <Input id="pm-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label="Price per month (₹)" htmlFor="pm-pm">
            <Input id="pm-pm" type="number" min={0} value={form.priceMonthly} onChange={(e) => setForm({ ...form, priceMonthly: e.target.value })} />
          </Field>
          <Field label="Price per year (₹)" htmlFor="pm-py">
            <Input id="pm-py" type="number" min={0} value={form.priceYearly} onChange={(e) => setForm({ ...form, priceYearly: e.target.value })} />
          </Field>
          <Field label="Trial days" htmlFor="pm-trial">
            <Input id="pm-trial" type="number" min={0} value={form.trialDays} onChange={(e) => setForm({ ...form, trialDays: e.target.value })} />
          </Field>
          <Field label="Grace days after a failed payment" htmlFor="pm-grace">
            <Input id="pm-grace" type="number" min={0} value={form.graceDays} onChange={(e) => setForm({ ...form, graceDays: e.target.value })} />
          </Field>
          <Field label="Razorpay plan id (monthly)" htmlFor="pm-rm">
            <Input id="pm-rm" value={form.monthlyId} placeholder="plan_…" onChange={(e) => setForm({ ...form, monthlyId: e.target.value })} />
          </Field>
          <Field label="Razorpay plan id (yearly)" htmlFor="pm-ry">
            <Input id="pm-ry" value={form.yearlyId} placeholder="plan_…" onChange={(e) => setForm({ ...form, yearlyId: e.target.value })} />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 font-medium text-slate-700">Limits (empty = unlimited)</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {(Object.keys(LIMIT_LABEL) as LimitKey[]).map((k) => (
              <Field key={k} label={LIMIT_LABEL[k]} htmlFor={`pm-l-${k}`}>
                <Input id={`pm-l-${k}`} type="number" min={0} value={form.limits[k]} onChange={(e) => setForm({ ...form, limits: { ...form.limits, [k]: e.target.value } })} />
              </Field>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap gap-4">
          {FEATURES.map((f) => (
            <label key={f} className="flex items-center gap-2">
              <input type="checkbox" className="size-4 accent-emerald-600" checked={form.features[f]} onChange={(e) => setForm({ ...form, features: { ...form.features, [f]: e.target.checked } })} />
              {f}
            </label>
          ))}
          <label className="flex items-center gap-2">
            <input type="checkbox" className="size-4 accent-emerald-600" checked={form.isPublic} onChange={(e) => setForm({ ...form, isPublic: e.target.checked })} />
            Show on billing page
          </label>
        </div>
        <p className="text-xs text-slate-500">Changes apply to every workspace on this plan immediately. Existing usage above a lowered limit is kept; new usage is blocked.</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save plan
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function OpsTab() {
  const ops = useQuery({ queryKey: ['admin', 'ops'], queryFn: () => api.get<Ops>('/admin/ops'), refetchInterval: 30_000 });
  if (ops.isPending) return <Spinner />;
  if (ops.error) return <Alert>{errorMessage(ops.error)}</Alert>;
  const o = ops.data;
  const warn = (n: number) => (n > 0 ? 'text-amber-700' : 'text-ink');
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Database" value={o.db} tone={o.db === 'up' ? 'text-emerald-700' : 'text-red-600'} />
        <Metric label="Failed sends (24h)" value={o.last24h.failedMessages} tone={warn(o.last24h.failedMessages)} />
        <Metric label="Failed flow runs (24h)" value={o.last24h.failedRuns} tone={warn(o.last24h.failedRuns)} />
        <Metric label="Dead webhook deliveries (24h)" value={o.last24h.deadDeliveries} tone={warn(o.last24h.deadDeliveries)} />
        <Metric label="Webhook deliveries retrying" value={o.now.retryingDeliveries} tone={warn(o.now.retryingDeliveries)} />
        <Metric label="Unprocessed Meta webhooks" value={o.now.webhookBacklog} tone={warn(o.now.webhookBacklog)} />
        <Metric label="Disabled webhook endpoints" value={o.now.disabledEndpoints} tone={warn(o.now.disabledEndpoints)} />
        <Metric label="WhatsApp numbers needing attention" value={o.now.brokenConnections} tone={warn(o.now.brokenConnections)} />
      </div>

      <Card className="overflow-x-auto">
        <h3 className="px-4 pt-4 text-sm font-semibold text-ink">Queues</h3>
        {o.queues === null ? (
          <p className="p-4 text-sm text-slate-500">Inline queue driver: no Redis queues to report.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                {['Queue', 'Waiting', 'Active', 'Delayed', 'Failed', 'Completed'].map((h, i) => (
                  <th key={h} className={cn('px-4 py-2 font-medium', i > 0 && 'text-right')}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {Object.entries(o.queues).map(([name, c]) => (
                <tr key={name}>
                  <td className="px-4 py-2 font-mono text-xs">{name}</td>
                  {(['waiting', 'active', 'delayed', 'failed', 'completed'] as const).map((k) => (
                    <td key={k} className={cn('px-4 py-2 text-right tabular-nums', k === 'failed' && (c[k] ?? 0) > 0 && 'text-red-600')}>
                      {c[k] ?? 0}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Attention title="Trials ending within 7 days" rows={o.billing.trialsEnding} date={(r) => r.trialEndsAt} />
        <Attention title="Overdue payments" rows={o.billing.pastDue} date={(r) => r.graceEndsAt} />
      </div>
    </div>
  );
}

function Attention({ title, rows, date }: { title: string; rows: OpsRow[]; date: (r: OpsRow) => string | null }) {
  return (
    <Card>
      <h3 className="px-4 pt-4 text-sm font-semibold text-ink">{title}</h3>
      {rows.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">Nothing here.</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {rows.map((r) => (
            <li key={r.workspaceId} className="flex items-center justify-between gap-2 px-4 py-2">
              <span className="font-medium text-slate-800">{r.name}</span>
              <span className="text-xs text-slate-500">
                {r.status.replace('_', ' ')} · {date(r) ? formatDate(date(r)!, true) : '—'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Metric({ label, value, tone }: { label: string; value: ReactNode; tone: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cn('mt-1 text-xl font-semibold tabular-nums', tone)}>{value}</p>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: ReactNode | undefined }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink">{value ?? '—'}</p>
    </Card>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, LogIn } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, errorMessage } from '../../components/ui';
import { api, ROLES, type FeatureKey, type LimitKey, type Role, type SubscriptionStatus, type WorkspaceStatus } from '../../lib/api';
import { ROLE_INFO, formatDate } from '../../lib/options';
import { FEATURES, LIMIT_LABEL, STATUS_TONE, SUB_TONE, StatCard, SubscriptionModal } from '../AdminPage';
import { money } from '../BillingPage';
import { LogList, type LogItem } from './ActivityTab';

interface Detail {
  workspace: { id: string; name: string; slug: string; timezone: string; country: string; industry: string | null; currency: string; status: WorkspaceStatus; suspendedReason: string | null; createdAt: string; updatedAt: string };
  members: { id: string; userId: string; name: string; email: string | null; userStatus: string | null; lastLoginAt: string | null; role: Role; joinedAt: string }[];
  subscription: { planCode: string; status: SubscriptionStatus; access: boolean; cycle: string; currentPeriodStart: string; currentPeriodEnd: string; trialEndsAt: string | null; graceEndsAt: string | null; cancelAtPeriodEnd: boolean; provider: string; providerSubscriptionId: string | null; lastPaymentAt: string | null };
  plan: { code: string; name: string; limits: Record<LimitKey, number | null>; features: Record<FeatureKey, boolean> };
  overrides: { limits: Partial<Record<LimitKey, number | null>>; features: Partial<Record<FeatureKey, boolean>> };
  entitlements: { access: boolean; limits: Record<LimitKey, number | null>; features: Record<FeatureKey, boolean> };
  usage: Record<string, number>;
  counts: Record<string, number>;
  connection: { displayPhoneNumber: string | null; verifiedName: string | null; phoneNumberId: string; wabaId: string; status: string; qualityRating: string | null; messagingLimitTier: string | null; lastError: string | null; lastWebhookAt: string | null; connectedVia: string; registered: boolean; createdAt: string } | null;
  invoices: { id: string; number: string; planCode: string; cycle: string; amount: number; currency: string; status: string; provider: string; providerPaymentId: string | null; failureReason: string | null; paidAt: string | null; createdAt: string }[];
  audit: (Omit<LogItem, 'workspaceId' | 'workspaceName'> & { workspaceId?: null; workspaceName?: null })[];
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '∞' : n.toLocaleString('en-IN'));

export function AdminWorkspacePage() {
  const { user } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [planOpen, setPlanOpen] = useState(false);
  const detail = useQuery({ queryKey: ['admin', 'workspace', id], queryFn: () => api.get<Detail>(`/admin/workspaces/${id}`), enabled: !!user?.isPlatformAdmin });
  const support = useMutation({
    mutationFn: () => api.post<{ url: string }>(`/admin/workspaces/${id}/support-access`),
    onSuccess: (r) => navigate(r.url),
  });
  const exportData = useMutation({ mutationFn: () => api.download(`/admin/workspaces/${id}/export`, 'workspace-export.json') });

  if (!user?.isPlatformAdmin) return <Navigate to="/" replace />;
  const d = detail.data;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <Link to="/admin" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
        <ArrowLeft className="size-4" /> All businesses
      </Link>
      {detail.isPending ? (
        <Spinner />
      ) : detail.error ? (
        <Alert>{errorMessage(detail.error)}</Alert>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-ink">
                {d!.workspace.name} <Badge tone={STATUS_TONE[d!.workspace.status]}>{d!.workspace.status}</Badge>
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                {d!.workspace.slug} · id {d!.workspace.id} · created {formatDate(d!.workspace.createdAt)}
              </p>
              {d!.workspace.suspendedReason && <p className="mt-1 text-sm text-red-600">Suspended: {d!.workspace.suspendedReason}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button loading={support.isPending} onClick={() => support.mutate()}>
                <LogIn className="size-4" /> Open as support
              </Button>
              <Button variant="secondary" loading={exportData.isPending} onClick={() => exportData.mutate()}>
                <Download className="size-4" /> Export all data
              </Button>
              <Button variant="secondary" onClick={() => setPlanOpen(true)}>Change plan</Button>
            </div>
          </div>
          {(support.error ?? exportData.error) != null && <Alert>{errorMessage(support.error ?? exportData.error)}</Alert>}

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Plan" value={<span className="capitalize">{d!.plan.name}</span>} />
            <StatCard label="Contacts" value={`${fmt(d!.usage.contacts)} / ${fmt(d!.entitlements.limits.contacts)}`} />
            <StatCard label="Messages this period" value={`${fmt(d!.usage.monthlyMessages)} / ${fmt(d!.entitlements.limits.monthlyMessages)}`} />
            <StatCard label="Members" value={`${d!.members.length} / ${fmt(d!.entitlements.limits.seats)}`} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <DetailsCard d={d!} />
            <SubscriptionCard d={d!} />
          </div>
          <OverridesCard d={d!} />
          <UsageCard d={d!} />
          <MembersCard d={d!} />
          <div className="grid gap-6 lg:grid-cols-2">
            <ConnectionCard d={d!} />
            <DataCard d={d!} />
          </div>
          <InvoicesCard d={d!} />
          <Section title="Audit log (latest 100)" description="Everything that happened in this business, including support-access changes.">
            {d!.audit.length === 0 ? <p className="p-4 text-sm text-slate-500">Nothing logged yet.</p> : <LogList items={d!.audit as LogItem[]} />}
          </Section>
          <DangerZone d={d!} onDeleted={() => { void queryClient.invalidateQueries({ queryKey: ['admin'] }); navigate('/admin'); }} />
        </div>
      )}
      {planOpen && d && <SubscriptionModal ws={{ id: d.workspace.id, name: d.workspace.name, subscription: { ...d.subscription } }} onClose={() => setPlanOpen(false)} />}
    </div>
  );
}

function Section({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description && <p className="text-xs text-slate-500">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </Card>
  );
}

function useRefresh(id: string) {
  const queryClient = useQueryClient();
  return () => Promise.all([queryClient.invalidateQueries({ queryKey: ['admin', 'workspace', id] }), queryClient.invalidateQueries({ queryKey: ['admin', 'workspaces'] }), queryClient.invalidateQueries({ queryKey: ['workspace', id] })]);
}

function DetailsCard({ d }: { d: Detail }) {
  const refresh = useRefresh(d.workspace.id);
  const w = d.workspace;
  const [form, setForm] = useState({ name: w.name, industry: w.industry ?? '', country: w.country, currency: w.currency, timezone: w.timezone });
  const [status, setStatus] = useState<WorkspaceStatus>(w.status);
  const [reason, setReason] = useState(w.suspendedReason ?? '');
  const save = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/admin/workspaces/${w.id}`, body), onSuccess: () => void refresh() });
  return (
    <Section title="Business details">
      <div className="space-y-3 p-4 text-sm">
        {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="wd-name"><Input id="wd-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Industry" htmlFor="wd-ind"><Input id="wd-ind" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} /></Field>
          <Field label="Country (2 letters)" htmlFor="wd-c"><Input id="wd-c" maxLength={2} value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} /></Field>
          <Field label="Currency (3 letters)" htmlFor="wd-cur"><Input id="wd-cur" maxLength={3} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} /></Field>
          <Field label="Timezone" htmlFor="wd-tz"><Input id="wd-tz" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /></Field>
        </div>
        <div className="flex justify-end">
          <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate({ ...form, industry: form.industry.trim() || null })}>Save details</Button>
        </div>
        <div className="grid items-end gap-3 border-t border-slate-100 pt-3 sm:grid-cols-[10rem_1fr_auto]">
          <Field label="Workspace status" htmlFor="wd-st">
            <Select id="wd-st" value={status} onChange={(e) => setStatus(e.target.value as WorkspaceStatus)}>
              <option value="setup">Setup</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended (read-only)</option>
            </Select>
          </Field>
          <Field label="Reason (shown when suspended)" htmlFor="wd-rs"><Input id="wd-rs" value={reason} disabled={status !== 'suspended'} onChange={(e) => setReason(e.target.value)} /></Field>
          <Button variant={status === 'suspended' ? 'danger' : 'secondary'} disabled={save.isPending} onClick={() => save.mutate({ status, ...(status === 'suspended' && reason.trim() ? { reason: reason.trim() } : {}) })}>Apply status</Button>
        </div>
      </div>
    </Section>
  );
}

function SubscriptionCard({ d }: { d: Detail }) {
  const s = d.subscription;
  const rows: [string, ReactNode][] = [
    ['Plan', <span className="capitalize">{d.plan.name} ({s.cycle})</span>],
    ['Status', <Badge tone={SUB_TONE[s.status]}>{s.status.replace('_', ' ')}</Badge>],
    ['Full access', s.access ? 'Yes' : 'No (sending paused)'],
    ['Current period', `${formatDate(s.currentPeriodStart)} → ${formatDate(s.currentPeriodEnd)}`],
    ['Trial ends', s.trialEndsAt ? formatDate(s.trialEndsAt, true) : '—'],
    ['Grace ends', s.graceEndsAt ? formatDate(s.graceEndsAt, true) : '—'],
    ['Cancels at period end', s.cancelAtPeriodEnd ? 'Yes' : 'No'],
    ['Provider', `${s.provider}${s.providerSubscriptionId ? ` · ${s.providerSubscriptionId}` : ''}`],
    ['Last payment', s.lastPaymentAt ? formatDate(s.lastPaymentAt, true) : '—'],
  ];
  return (
    <Section title="Subscription" description="Use “Change plan” above for comps, offline payments and extensions.">
      <dl className="divide-y divide-slate-100 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 px-4 py-2">
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-right text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

const USED_KEY: Partial<Record<LimitKey, string>> = { contacts: 'contacts', seats: 'seats', monthlyMessages: 'monthlyMessages', activeFlows: 'activeFlows', forms: 'forms', aiRepliesPerMonth: 'aiRepliesPerMonth' };

function OverridesCard({ d }: { d: Detail }) {
  const refresh = useRefresh(d.workspace.id);
  // Per key: 'plan' (no override), 'unlimited', or a number as text.
  const [limits, setLimits] = useState<Record<LimitKey, string>>(
    () => Object.fromEntries((Object.keys(LIMIT_LABEL) as LimitKey[]).map((k) => [k, !(k in d.overrides.limits) ? 'plan' : d.overrides.limits[k] === null ? 'unlimited' : String(d.overrides.limits[k])])) as Record<LimitKey, string>,
  );
  const [features, setFeatures] = useState<Record<FeatureKey, 'plan' | 'on' | 'off'>>(
    () => Object.fromEntries(FEATURES.map((f) => [f, !(f in d.overrides.features) ? 'plan' : d.overrides.features[f] ? 'on' : 'off'])) as Record<FeatureKey, 'plan' | 'on' | 'off'>,
  );
  const save = useMutation({
    mutationFn: () =>
      api.put(`/admin/workspaces/${d.workspace.id}/overrides`, {
        limits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, v === 'plan' ? 'plan' : v === 'unlimited' ? null : Number(v)])),
        features: Object.fromEntries(Object.entries(features).map(([k, v]) => [k, v === 'plan' ? 'plan' : v === 'on'])),
      }),
    onSuccess: () => void refresh(),
  });
  const invalid = Object.values(limits).some((v) => v !== 'plan' && v !== 'unlimited' && !/^\d+$/.test(v));

  return (
    <Section
      title="Custom limits & features (bypass the plan)"
      description="Give this one business more (or less) than its plan allows. Overrides survive plan changes until you set them back to “Plan”."
      actions={<Button loading={save.isPending} disabled={invalid} onClick={() => save.mutate()}>Save overrides</Button>}
    >
      {save.error != null && <div className="px-4 pt-3"><Alert>{errorMessage(save.error)}</Alert></div>}
      {save.isSuccess && <div className="px-4 pt-3"><Alert tone="success">Overrides saved and live.</Alert></div>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Limit</th>
              <th className="px-4 py-2 text-right font-medium">Used</th>
              <th className="px-4 py-2 text-right font-medium">Plan</th>
              <th className="px-4 py-2 font-medium">Override</th>
              <th className="px-4 py-2 text-right font-medium">Effective</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(Object.keys(LIMIT_LABEL) as LimitKey[]).map((k) => {
              const v = limits[k];
              const mode = v === 'plan' || v === 'unlimited' ? v : 'custom';
              return (
                <tr key={k}>
                  <td className="px-4 py-2 text-slate-700">{LIMIT_LABEL[k]}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600">{USED_KEY[k] ? fmt(d.usage[USED_KEY[k]!]) : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">{fmt(d.plan.limits[k])}</td>
                  <td className="px-4 py-2">
                    <div className="flex gap-2">
                      <div className="w-32">
                        <Select aria-label={`${LIMIT_LABEL[k]} override`} value={mode} onChange={(e) => setLimits({ ...limits, [k]: e.target.value === 'custom' ? String(d.entitlements.limits[k] ?? 0) : e.target.value })}>
                          <option value="plan">Plan</option>
                          <option value="custom">Custom</option>
                          <option value="unlimited">Unlimited</option>
                        </Select>
                      </div>
                      {mode === 'custom' && <Input aria-label={`${LIMIT_LABEL[k]} value`} className="w-32" type="number" min={0} value={v} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right font-medium tabular-nums text-ink">{fmt(d.entitlements.limits[k])}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-4 border-t border-slate-100 px-4 py-3 text-sm">
        {FEATURES.map((f) => (
          <label key={f} className="flex items-center gap-2">
            <span className="capitalize text-slate-700">{f}</span>
            <div className="w-36">
              <Select aria-label={`${f} feature`} value={features[f]} onChange={(e) => setFeatures({ ...features, [f]: e.target.value as 'plan' | 'on' | 'off' })}>
                <option value="plan">Plan ({d.plan.features[f] ? 'on' : 'off'})</option>
                <option value="on">Force on</option>
                <option value="off">Force off</option>
              </Select>
            </div>
          </label>
        ))}
      </div>
    </Section>
  );
}

const METRICS = [
  ['messages', 'Messages', 'monthlyMessages'],
  ['ai_replies', 'AI replies', 'aiRepliesPerMonth'],
  ['api_requests', 'API requests', 'apiRequests'],
] as const;

function UsageCard({ d }: { d: Detail }) {
  const refresh = useRefresh(d.workspace.id);
  const adjust = useMutation({ mutationFn: (body: { metric?: string; value: number }) => api.post(`/admin/workspaces/${d.workspace.id}/usage`, body), onSuccess: () => void refresh() });
  return (
    <Section
      title="Metered usage this period"
      description={`Since ${formatDate(d.subscription.currentPeriodStart)}. Reset or correct counters when a customer was over-counted.`}
      actions={<Button variant="secondary" loading={adjust.isPending} onClick={() => window.confirm('Reset all usage counters for this period to 0?') && adjust.mutate({ value: 0 })}>Reset all</Button>}
    >
      {adjust.error != null && <div className="px-4 pt-3"><Alert>{errorMessage(adjust.error)}</Alert></div>}
      <ul className="divide-y divide-slate-100 text-sm">
        {METRICS.map(([metric, label, key]) => (
          <li key={metric} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
            <span className="text-slate-700">{label}</span>
            <span className="ml-auto tabular-nums font-medium text-ink">{fmt(d.usage[key])}</span>
            <Button
              variant="ghost"
              onClick={() => {
                const v = window.prompt(`Set ${label.toLowerCase()} used this period to:`, '0');
                if (v !== null && /^\d+$/.test(v.trim())) adjust.mutate({ metric, value: Number(v.trim()) });
              }}
            >
              Set…
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function MembersCard({ d }: { d: Detail }) {
  const refresh = useRefresh(d.workspace.id);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('agent');
  const add = useMutation({ mutationFn: () => api.post(`/admin/workspaces/${d.workspace.id}/members`, { email, role }), onSuccess: () => { setEmail(''); void refresh(); } });
  const change = useMutation({ mutationFn: ({ id, role }: { id: string; role: Role }) => api.patch(`/admin/workspaces/${d.workspace.id}/members/${id}`, { role }), onSuccess: () => void refresh() });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/admin/workspaces/${d.workspace.id}/members/${id}`), onSuccess: () => void refresh() });
  const err = add.error ?? change.error ?? remove.error;
  return (
    <Section title={`Members (${d.members.length})`} description="Change any role (make someone owner to transfer ownership), remove people, or add an existing account directly.">
      {err != null && <div className="px-4 pt-3"><Alert>{errorMessage(err)}</Alert></div>}
      <ul className="divide-y divide-slate-100 text-sm">
        {d.members.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-slate-800">
                {m.name} {m.userStatus === 'disabled' && <Badge tone="red">disabled</Badge>}
              </p>
              <p className="text-xs text-slate-500">{m.email} · joined {formatDate(m.joinedAt)}{m.lastLoginAt ? ` · last login ${formatDate(m.lastLoginAt, true)}` : ''}</p>
            </div>
            <div className="w-36">
              <Select aria-label={`Role of ${m.name}`} value={m.role} disabled={change.isPending} onChange={(e) => change.mutate({ id: m.id, role: e.target.value as Role })}>
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
              </Select>
            </div>
            <Button variant="ghost" onClick={() => window.confirm(`Remove ${m.email ?? m.name} from ${d.workspace.name}?`) && remove.mutate(m.id)}>Remove</Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 px-4 py-3">
        <div className="min-w-56 flex-1">
          <Field label="Add existing account by email" htmlFor="wm-email"><Input id="wm-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@business.com" /></Field>
        </div>
        <div className="w-36">
          <Field label="Role" htmlFor="wm-role">
            <Select id="wm-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
            </Select>
          </Field>
        </div>
        <Button disabled={!email.includes('@')} loading={add.isPending} onClick={() => add.mutate()}>Add member</Button>
      </div>
    </Section>
  );
}

function ConnectionCard({ d }: { d: Detail }) {
  const c = d.connection;
  return (
    <Section title="WhatsApp number">
      {!c ? (
        <p className="p-4 text-sm text-slate-500">Not connected yet.</p>
      ) : (
        <dl className="divide-y divide-slate-100 text-sm">
          {(
            [
              ['Number', `${c.displayPhoneNumber ?? '—'}${c.verifiedName ? ` (${c.verifiedName})` : ''}`],
              ['Status', <Badge tone={c.status === 'connected' ? 'green' : 'red'}>{c.status}</Badge>],
              ['Quality / tier', `${c.qualityRating ?? '—'} · ${c.messagingLimitTier ?? '—'}`],
              ['Phone number id', <span className="font-mono text-xs">{c.phoneNumberId}</span>],
              ['WABA id', <span className="font-mono text-xs">{c.wabaId}</span>],
              ['Connected via', `${c.connectedVia.replace('_', ' ')} · ${c.registered ? 'registered' : 'not registered'}`],
              ['Last webhook', c.lastWebhookAt ? formatDate(c.lastWebhookAt, true) : '—'],
              ['Last error', c.lastError ?? '—'],
            ] as [string, ReactNode][]
          ).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 px-4 py-2">
              <dt className="text-slate-500">{k}</dt>
              <dd className="min-w-0 break-all text-right text-slate-800">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}

function DataCard({ d }: { d: Detail }) {
  const rows = Object.entries(d.counts).filter(([, n]) => n > 0);
  return (
    <Section title="Stored data" description="Documents this business owns, per collection.">
      {rows.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">No data yet.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 px-4 py-2 text-sm">
          {rows.map(([k, n]) => (
            <li key={k} className="flex justify-between gap-2 py-1">
              <span className="truncate text-slate-600">{k}</span>
              <span className="tabular-nums text-slate-800">{n.toLocaleString('en-IN')}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function InvoicesCard({ d }: { d: Detail }) {
  return (
    <Section title={`Payments (${d.invoices.length})`}>
      {d.invoices.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">No payments yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                {['Invoice', 'Plan', 'Amount', 'Status', 'Provider / payment id', 'Date'].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {d.invoices.map((i) => (
                <tr key={i.id}>
                  <td className="px-4 py-2 font-mono text-xs">{i.number}</td>
                  <td className="px-4 py-2 capitalize">{i.planCode} · {i.cycle}</td>
                  <td className="px-4 py-2 tabular-nums">{money(i.amount, i.currency)}</td>
                  <td className="px-4 py-2">
                    <Badge tone={i.status === 'paid' ? 'green' : 'red'}>{i.status}</Badge>
                    {i.failureReason && <p className="text-xs text-red-600">{i.failureReason}</p>}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{i.provider}{i.providerPaymentId ? ` · ${i.providerPaymentId}` : ''}</td>
                  <td className="px-4 py-2 text-slate-500">{formatDate(i.paidAt ?? i.createdAt, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function DangerZone({ d, onDeleted }: { d: Detail; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState('');
  const del = useMutation({ mutationFn: () => api.delete(`/admin/workspaces/${d.workspace.id}`, { confirm }), onSuccess: onDeleted });
  return (
    <Card className="border-red-200 p-4 text-sm">
      <h2 className="font-semibold text-red-700">Delete this business permanently</h2>
      <p className="mt-1 text-slate-600">Removes the workspace and everything it owns (contacts, chats, campaigns, flows, billing records). This cannot be undone — export the data first. The deletion stays in the admin activity log.</p>
      {del.error != null && <div className="mt-3"><Alert>{errorMessage(del.error)}</Alert></div>}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-64 flex-1">
          <Field label={`Type “${d.workspace.name}” to confirm`} htmlFor="dz-confirm"><Input id="dz-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        </div>
        <Button variant="danger" disabled={confirm !== d.workspace.name} loading={del.isPending} onClick={() => del.mutate()}>Delete forever</Button>
      </div>
    </Card>
  );
}

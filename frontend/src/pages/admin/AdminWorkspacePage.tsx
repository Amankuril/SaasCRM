import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, CreditCard, Download, LogIn, PenLine, RotateCcw, Save, Trash2, UserPlus, UserX } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { AButton, DetailList, IconButton, Panel, Segmented, useConfirm } from '../../components/admin';
import { initials } from '../../components/crm';
import { Alert, Badge, Field, Input, Select, Spinner, cn, errorMessage } from '../../components/ui';
import { api, ROLES, type FeatureKey, type LimitKey, type Role, type SubscriptionStatus, type WorkspaceStatus } from '../../lib/api';
import { ROLE_INFO, formatDate } from '../../lib/options';
import { FEATURES, FEATURE_INFO, LIMIT_LABEL, STATUS_TONE, SUB_TONE, StatCard, SubscriptionModal } from '../AdminPage';
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

type Tab = 'overview' | 'limits' | 'members' | 'payments' | 'audit' | 'settings';

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '∞' : n.toLocaleString('en-IN'));

export function AdminWorkspacePage() {
  const { user } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');
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
    <div>
      <Link to="/admin/businesses" className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-slate-500 hover:text-slate-900">
        <ArrowLeft className="size-4" /> Businesses
      </Link>
      {detail.isPending ? (
        <Spinner />
      ) : detail.error ? (
        <Alert>{errorMessage(detail.error)}</Alert>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-base font-semibold text-white">{initials(d!.workspace.name)}</span>
              <div className="min-w-0">
                <h1 className="flex flex-wrap items-center gap-2 text-[22px] font-semibold tracking-tight text-ink">
                  {d!.workspace.name} <Badge tone={STATUS_TONE[d!.workspace.status]}>{d!.workspace.status}</Badge>
                </h1>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-slate-500">
                  <span>{d!.workspace.slug}</span>
                  <span className="text-slate-300">·</span>
                  <button className="inline-flex items-center gap-1 font-mono text-xs hover:text-slate-900" title="Copy business ID" onClick={() => void navigator.clipboard?.writeText(d!.workspace.id)}>
                    {d!.workspace.id} <Copy className="size-3" />
                  </button>
                  <span className="text-slate-300">·</span>
                  <span>Created {formatDate(d!.workspace.createdAt)}</span>
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <AButton icon={Download} loading={exportData.isPending} onClick={() => exportData.mutate()}>
                Export data
              </AButton>
              <AButton icon={CreditCard} onClick={() => setPlanOpen(true)}>
                Change plan
              </AButton>
              <AButton variant="primary" icon={LogIn} loading={support.isPending} onClick={() => support.mutate()}>
                Open as support
              </AButton>
            </div>
          </div>
          {d!.workspace.suspendedReason && <Alert>Suspended: {d!.workspace.suspendedReason}</Alert>}
          {(support.error ?? exportData.error) != null && <Alert>{errorMessage(support.error ?? exportData.error)}</Alert>}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Plan" value={<span className="capitalize">{d!.plan.name}</span>} />
            <StatCard label="Contacts" value={`${fmt(d!.usage.contacts)} / ${fmt(d!.entitlements.limits.contacts)}`} />
            <StatCard label="Messages this period" value={`${fmt(d!.usage.monthlyMessages)} / ${fmt(d!.entitlements.limits.monthlyMessages)}`} />
            <StatCard label="Members" value={`${d!.members.length} / ${fmt(d!.entitlements.limits.seats)}`} />
          </div>

          <div className="overflow-x-auto">
            <Segmented<Tab>
              value={tab}
              onChange={setTab}
              options={[
                { value: 'overview', label: 'Overview' },
                { value: 'limits', label: 'Limits & usage' },
                { value: 'members', label: `Members · ${d!.members.length}` },
                { value: 'payments', label: 'Payments' },
                { value: 'audit', label: 'Audit log' },
                { value: 'settings', label: 'Settings' },
              ]}
            />
          </div>

          {tab === 'overview' && (
            <div className="grid gap-5 lg:grid-cols-2">
              <SubscriptionCard d={d!} onChange={() => setPlanOpen(true)} />
              <ConnectionCard d={d!} />
              <DataCard d={d!} />
            </div>
          )}
          {tab === 'limits' && (
            <div className="space-y-5">
              <OverridesCard d={d!} />
              <UsageCard d={d!} />
            </div>
          )}
          {tab === 'members' && <MembersCard d={d!} />}
          {tab === 'payments' && <InvoicesCard d={d!} />}
          {tab === 'audit' && (
            <Panel flush title="Audit log" description="Latest 100 entries, including changes made on support access.">
              {d!.audit.length === 0 ? <p className="px-5 py-4 text-sm text-slate-500">Nothing logged yet.</p> : <LogList items={d!.audit as LogItem[]} />}
            </Panel>
          )}
          {tab === 'settings' && (
            <div className="space-y-5">
              <DetailsCard d={d!} />
              <StatusCard d={d!} />
              <DangerZone
                d={d!}
                onDeleted={() => {
                  void queryClient.invalidateQueries({ queryKey: ['admin'] });
                  navigate('/admin/businesses');
                }}
              />
            </div>
          )}
        </div>
      )}
      {planOpen && d && <SubscriptionModal ws={{ id: d.workspace.id, name: d.workspace.name, subscription: { ...d.subscription } }} onClose={() => setPlanOpen(false)} />}
    </div>
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
  const save = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/admin/workspaces/${w.id}`, body), onSuccess: () => void refresh() });
  return (
    <Panel
      title="Business details"
      description="Edit on the customer's behalf. The change shows in their audit log."
      actions={
        <AButton size="sm" variant="primary" icon={Save} loading={save.isPending} onClick={() => save.mutate({ ...form, industry: form.industry.trim() || null })}>
          Save details
        </AButton>
      }
    >
      <div className="space-y-3 text-sm">
        {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
        {save.isSuccess && <Alert tone="success">Details saved.</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name" htmlFor="wd-name">
            <Input id="wd-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Industry" htmlFor="wd-ind">
            <Input id="wd-ind" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} />
          </Field>
          <Field label="Timezone" htmlFor="wd-tz">
            <Input id="wd-tz" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
          </Field>
          <Field label="Country (2 letters)" htmlFor="wd-c">
            <Input id="wd-c" maxLength={2} value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
          </Field>
          <Field label="Currency (3 letters)" htmlFor="wd-cur">
            <Input id="wd-cur" maxLength={3} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
          </Field>
        </div>
      </div>
    </Panel>
  );
}

function StatusCard({ d }: { d: Detail }) {
  const refresh = useRefresh(d.workspace.id);
  const w = d.workspace;
  const [status, setStatus] = useState<WorkspaceStatus>(w.status);
  const [reason, setReason] = useState(w.suspendedReason ?? '');
  const save = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/admin/workspaces/${w.id}`, body), onSuccess: () => void refresh() });
  const changed = status !== w.status || (status === 'suspended' && reason !== (w.suspendedReason ?? ''));
  return (
    <Panel title="Workspace status" description="Suspended businesses are read-only: they can view and export, but nothing is sent or changed.">
      <div className="space-y-3 text-sm">
        {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
        <Segmented<WorkspaceStatus>
          value={status}
          onChange={setStatus}
          options={[
            { value: 'setup', label: 'Setup' },
            { value: 'active', label: 'Active' },
            { value: 'suspended', label: 'Suspended' },
          ]}
        />
        {status === 'suspended' && (
          <Field label="Reason (shown to the business)" htmlFor="wd-rs">
            <Input id="wd-rs" value={reason} placeholder="e.g. Unpaid invoice ZC-0042" onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
        <div className="flex justify-end">
          <AButton size="sm" variant={status === 'suspended' ? 'danger' : 'primary'} disabled={!changed} loading={save.isPending} onClick={() => save.mutate({ status, ...(status === 'suspended' && reason.trim() ? { reason: reason.trim() } : {}) })}>
            {status === 'suspended' ? 'Suspend business' : 'Apply status'}
          </AButton>
        </div>
      </div>
    </Panel>
  );
}

function SubscriptionCard({ d, onChange }: { d: Detail; onChange: () => void }) {
  const s = d.subscription;
  return (
    <Panel flush title="Subscription" actions={<AButton size="sm" variant="subtle" icon={PenLine} onClick={onChange}>Change</AButton>}>
      <DetailList
        rows={[
          ['Plan', <span className="capitalize">{d.plan.name} · {s.cycle}</span>],
          ['Status', <Badge tone={SUB_TONE[s.status]}>{s.status.replace('_', ' ')}</Badge>],
          ['Full access', s.access ? 'Yes' : 'No, sending paused'],
          ['Current period', `${formatDate(s.currentPeriodStart)} → ${formatDate(s.currentPeriodEnd)}`],
          ['Trial ends', s.trialEndsAt ? formatDate(s.trialEndsAt, true) : '—'],
          ['Grace ends', s.graceEndsAt ? formatDate(s.graceEndsAt, true) : '—'],
          ['Cancels at period end', s.cancelAtPeriodEnd ? 'Yes' : 'No'],
          ['Provider', `${s.provider}${s.providerSubscriptionId ? ` · ${s.providerSubscriptionId}` : ''}`],
          ['Last payment', s.lastPaymentAt ? formatDate(s.lastPaymentAt, true) : '—'],
        ]}
      />
    </Panel>
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
  const overridden = Object.keys(d.overrides.limits).length + Object.keys(d.overrides.features).length;

  return (
    <Panel
      flush
      title={
        <span className="flex items-center gap-2">
          Custom limits & features {overridden > 0 && <Badge tone="blue">{overridden} override{overridden === 1 ? '' : 's'}</Badge>}
        </span>
      }
      description="Give this one business more (or less) than its plan allows. Overrides survive plan changes until set back to “Plan”."
      actions={
        <AButton size="sm" variant="primary" icon={Save} loading={save.isPending} disabled={invalid} onClick={() => save.mutate()}>
          Save overrides
        </AButton>
      }
    >
      {save.error != null && (
        <div className="px-5 pt-4">
          <Alert>{errorMessage(save.error)}</Alert>
        </div>
      )}
      {save.isSuccess && (
        <div className="px-5 pt-4">
          <Alert tone="success">Overrides saved and live.</Alert>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50/70 text-left text-[11px] tracking-wide text-slate-500 uppercase">
            <tr>
              <th className="px-5 py-2.5 font-medium">Limit</th>
              <th className="px-4 py-2.5 text-right font-medium">Used</th>
              <th className="px-4 py-2.5 text-right font-medium">Plan</th>
              <th className="px-4 py-2.5 font-medium">Override</th>
              <th className="px-5 py-2.5 text-right font-medium">Effective</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(Object.keys(LIMIT_LABEL) as LimitKey[]).map((k) => {
              const v = limits[k];
              const mode = v === 'plan' || v === 'unlimited' ? v : 'custom';
              return (
                <tr key={k} className={cn(mode !== 'plan' && 'bg-sky-50/40')}>
                  <td className="px-5 py-2 text-slate-700">{LIMIT_LABEL[k]}</td>
                  <td className="px-4 py-2 text-right text-slate-600 tabular-nums">{USED_KEY[k] ? fmt(d.usage[USED_KEY[k]!]) : '—'}</td>
                  <td className="px-4 py-2 text-right text-slate-400 tabular-nums">{fmt(d.plan.limits[k])}</td>
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
                  <td className="px-5 py-2 text-right font-semibold text-ink tabular-nums">{fmt(d.entitlements.limits[k])}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 border-t border-slate-100 px-5 py-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => {
          const Icon = FEATURE_INFO[f].icon;
          return (
            <label key={f} className="flex items-center gap-3 rounded-lg px-3 py-2 ring-1 ring-slate-200">
              <Icon className="size-4 text-slate-400" />
              <span className="flex-1 text-slate-700">{FEATURE_INFO[f].label}</span>
              <div className="w-32">
                <Select aria-label={`${f} feature`} value={features[f]} onChange={(e) => setFeatures({ ...features, [f]: e.target.value as 'plan' | 'on' | 'off' })}>
                  <option value="plan">Plan ({d.plan.features[f] ? 'on' : 'off'})</option>
                  <option value="on">Force on</option>
                  <option value="off">Force off</option>
                </Select>
              </div>
            </label>
          );
        })}
      </div>
    </Panel>
  );
}

const METRICS = [
  ['messages', 'Messages', 'monthlyMessages'],
  ['ai_replies', 'AI replies', 'aiRepliesPerMonth'],
  ['api_requests', 'API requests', 'apiRequests'],
] as const;

function UsageCard({ d }: { d: Detail }) {
  const refresh = useRefresh(d.workspace.id);
  const confirm = useConfirm();
  const adjust = useMutation({ mutationFn: (body: { metric?: string; value: number }) => api.post(`/admin/workspaces/${d.workspace.id}/usage`, body), onSuccess: () => void refresh() });
  return (
    <Panel
      flush
      title="Metered usage this period"
      description={`Since ${formatDate(d.subscription.currentPeriodStart)}. Reset or correct counters when a customer was over-counted.`}
      actions={
        <AButton
          size="sm"
          icon={RotateCcw}
          loading={adjust.isPending}
          onClick={async () => (await confirm({ title: 'Reset all usage counters?', message: 'Messages, AI replies and API requests for this period go back to 0.', confirmLabel: 'Reset counters' })) !== null && adjust.mutate({ value: 0 })}
        >
          Reset all
        </AButton>
      }
    >
      {adjust.error != null && (
        <div className="px-5 pt-4">
          <Alert>{errorMessage(adjust.error)}</Alert>
        </div>
      )}
      <ul className="divide-y divide-slate-100 text-sm">
        {METRICS.map(([metric, label, key]) => (
          <li key={metric} className="flex items-center gap-3 px-5 py-3">
            <span className="flex-1 text-slate-700">{label}</span>
            <span className="font-semibold text-ink tabular-nums">{fmt(d.usage[key])}</span>
            <IconButton
              icon={PenLine}
              label={`Set ${label.toLowerCase()} used`}
              onClick={async () => {
                const v = await confirm({ title: `Set ${label.toLowerCase()} used this period`, confirmLabel: 'Set counter', input: { label: 'New value', type: 'number', initial: String(d.usage[key] ?? 0), required: true } });
                if (v !== null && /^\d+$/.test(v.trim())) adjust.mutate({ metric, value: Number(v.trim()) });
              }}
            />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function MembersCard({ d }: { d: Detail }) {
  const refresh = useRefresh(d.workspace.id);
  const confirm = useConfirm();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('agent');
  const add = useMutation({ mutationFn: () => api.post(`/admin/workspaces/${d.workspace.id}/members`, { email, role }), onSuccess: () => { setEmail(''); void refresh(); } });
  const change = useMutation({ mutationFn: ({ id, role }: { id: string; role: Role }) => api.patch(`/admin/workspaces/${d.workspace.id}/members/${id}`, { role }), onSuccess: () => void refresh() });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/admin/workspaces/${d.workspace.id}/members/${id}`), onSuccess: () => void refresh() });
  const err = add.error ?? change.error ?? remove.error;
  return (
    <Panel flush title="Members" description="Change any role (make someone owner to transfer ownership), remove people, or add an existing account directly.">
      {err != null && (
        <div className="px-5 pt-4">
          <Alert>{errorMessage(err)}</Alert>
        </div>
      )}
      <ul className="divide-y divide-slate-100 text-sm">
        {d.members.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700">{initials(m.name)}</span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 font-medium text-slate-900">
                {m.name} {m.userStatus === 'disabled' && <Badge tone="red">disabled</Badge>}
              </p>
              <p className="truncate text-xs text-slate-500">
                {m.email} · joined {formatDate(m.joinedAt)}
                {m.lastLoginAt ? ` · last login ${formatDate(m.lastLoginAt, true)}` : ''}
              </p>
            </div>
            <div className="w-36">
              <Select aria-label={`Role of ${m.name}`} value={m.role} disabled={change.isPending} onChange={(e) => change.mutate({ id: m.id, role: e.target.value as Role })}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_INFO[r].label}
                  </option>
                ))}
              </Select>
            </div>
            <IconButton
              icon={UserX}
              label={`Remove ${m.name}`}
              className="hover:bg-red-50 hover:text-red-600"
              onClick={async () => (await confirm({ title: `Remove ${m.email ?? m.name}?`, message: `They lose access to ${d.workspace.name}. Their account stays.`, confirmLabel: 'Remove member', tone: 'danger' })) !== null && remove.mutate(m.id)}
            />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 bg-slate-50/50 px-5 py-4">
        <div className="min-w-56 flex-1">
          <Field label="Add an existing account" htmlFor="wm-email">
            <Input id="wm-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@business.com" />
          </Field>
        </div>
        <div className="w-36">
          <Field label="Role" htmlFor="wm-role">
            <Select id="wm-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_INFO[r].label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <AButton variant="primary" icon={UserPlus} disabled={!email.includes('@')} loading={add.isPending} onClick={() => add.mutate()}>
          Add member
        </AButton>
      </div>
    </Panel>
  );
}

function ConnectionCard({ d }: { d: Detail }) {
  const c = d.connection;
  return (
    <Panel flush title="WhatsApp number" actions={c && <Badge tone={c.status === 'connected' ? 'green' : 'red'}>{c.status}</Badge>}>
      {!c ? (
        <p className="px-5 py-4 text-sm text-slate-500">Not connected yet.</p>
      ) : (
        <DetailList
          rows={[
            ['Number', `${c.displayPhoneNumber ?? '—'}${c.verifiedName ? ` (${c.verifiedName})` : ''}`],
            ['Quality / tier', `${c.qualityRating ?? '—'} · ${c.messagingLimitTier ?? '—'}`],
            ['Phone number id', <span className="font-mono text-xs">{c.phoneNumberId}</span>],
            ['WABA id', <span className="font-mono text-xs">{c.wabaId}</span>],
            ['Connected via', `${c.connectedVia.replace('_', ' ')} · ${c.registered ? 'registered' : 'not registered'}`],
            ['Last webhook', c.lastWebhookAt ? formatDate(c.lastWebhookAt, true) : '—'],
            ['Last error', c.lastError ?? '—'],
          ]}
        />
      )}
    </Panel>
  );
}

function DataCard({ d }: { d: Detail }) {
  const rows = Object.entries(d.counts).filter(([, n]) => n > 0);
  return (
    <Panel flush title="Stored data" description="Documents this business owns, per collection." className="lg:col-span-2">
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-500">No data yet.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-x-8 px-5 py-3 text-sm sm:grid-cols-3 lg:grid-cols-4">
          {rows.map(([k, n]) => (
            <li key={k} className="flex justify-between gap-2 border-b border-slate-50 py-1.5">
              <span className="truncate text-slate-600">{k}</span>
              <span className="font-medium text-slate-900 tabular-nums">{n.toLocaleString('en-IN')}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function InvoicesCard({ d }: { d: Detail }) {
  return (
    <Panel flush title="Payments" description={`${d.invoices.length} payment record${d.invoices.length === 1 ? '' : 's'}.`}>
      {d.invoices.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-500">No payments yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50/70 text-left text-[11px] tracking-wide text-slate-500 uppercase">
              <tr>
                {['Invoice', 'Plan', 'Amount', 'Status', 'Provider / payment id', 'Date'].map((h) => (
                  <th key={h} className="px-5 py-2.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {d.invoices.map((i) => (
                <tr key={i.id}>
                  <td className="px-5 py-2.5 font-mono text-xs">{i.number}</td>
                  <td className="px-5 py-2.5 capitalize">
                    {i.planCode} · {i.cycle}
                  </td>
                  <td className="px-5 py-2.5 font-medium tabular-nums">{money(i.amount, i.currency)}</td>
                  <td className="px-5 py-2.5">
                    <Badge tone={i.status === 'paid' ? 'green' : 'red'}>{i.status}</Badge>
                    {i.failureReason && <p className="text-xs text-red-600">{i.failureReason}</p>}
                  </td>
                  <td className="px-5 py-2.5 text-xs text-slate-500">
                    {i.provider}
                    {i.providerPaymentId ? ` · ${i.providerPaymentId}` : ''}
                  </td>
                  <td className="px-5 py-2.5 text-slate-500">{formatDate(i.paidAt ?? i.createdAt, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function DangerZone({ d, onDeleted }: { d: Detail; onDeleted: () => void }) {
  const confirm = useConfirm();
  const del = useMutation({ mutationFn: () => api.delete(`/admin/workspaces/${d.workspace.id}`, { confirm: d.workspace.name }), onSuccess: onDeleted });
  return (
    <section className="rounded-xl bg-white ring-1 ring-red-200">
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 text-sm">
        <div className="max-w-xl">
          <h2 className="font-semibold text-red-700">Delete this business</h2>
          <p className="mt-0.5 text-slate-500">Permanently removes the workspace and everything it owns: contacts, chats, campaigns, flows and billing records. Export the data first. The deletion stays in the admin activity log.</p>
          {del.error != null && (
            <div className="mt-3">
              <Alert>{errorMessage(del.error)}</Alert>
            </div>
          )}
        </div>
        <AButton
          variant="danger"
          icon={Trash2}
          loading={del.isPending}
          onClick={async () =>
            (await confirm({ title: `Delete ${d.workspace.name} forever?`, message: 'This cannot be undone.', confirmLabel: 'Delete business', tone: 'danger', input: { label: `Type “${d.workspace.name}” to confirm`, match: d.workspace.name } })) !== null && del.mutate()
          }
        >
          Delete business
        </AButton>
      </div>
    </section>
  );
}


import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CreditCard, ExternalLink, Receipt, X } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Modal } from '../components/crm';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner, cn, errorMessage } from '../components/ui';
import { api, type BillingOverview, type LimitKey, type PlanInfo, type SubscriptionStatus } from '../lib/api';
import { formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';

export const money = (paise: number, currency = 'INR') => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(paise / 100);

const STATUS: Record<SubscriptionStatus, { label: string; tone: 'green' | 'amber' | 'red' | 'gray' | 'blue' }> = {
  trialing: { label: 'On trial', tone: 'blue' },
  active: { label: 'Active', tone: 'green' },
  past_due: { label: 'Payment failed', tone: 'amber' },
  suspended: { label: 'Suspended', tone: 'red' },
  cancelled: { label: 'Ended', tone: 'gray' },
  expired: { label: 'Trial ended', tone: 'red' },
};

/** How each quota is counted (shown under its bar). */
const LIMITS: { key: Exclude<LimitKey, 'apiRequestsPerMinute'>; label: string; rule: string }[] = [
  { key: 'monthlyMessages', label: 'Messages this period', rule: 'Every message accepted for sending (inbox, broadcasts, flows, AI, API), even if WhatsApp later fails to deliver it. Resets each billing period.' },
  { key: 'contacts', label: 'Contacts', rule: 'All saved contacts. Customers who message you are always saved, even over the limit.' },
  { key: 'seats', label: 'Team members', rule: 'Members plus pending invitations.' },
  { key: 'activeFlows', label: 'Live flows', rule: 'Published flows that are turned on.' },
  { key: 'forms', label: 'Forms', rule: 'All forms, drafts included.' },
  { key: 'aiRepliesPerMonth', label: 'AI replies this period', rule: 'Each AI answer attempt for customers (auto-reply, flows, inbox suggestions). Test chats are free.' },
];

const FEATURE_LABEL: Record<string, string> = { campaigns: 'Broadcasts', flows: 'Flow builder', forms: 'WhatsApp Forms', ai: 'AI agent', api: 'API & webhooks' };
const fmt = (n: number | null) => (n === null ? 'Unlimited' : n.toLocaleString('en-IN'));

export function BillingPage() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const query = useQuery({ queryKey: ['billing', workspace.id], queryFn: () => api.get<BillingOverview>(`/workspaces/${workspace.id}/billing`) });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['billing', workspace.id] });
    void queryClient.invalidateQueries({ queryKey: ['workspace', workspace.id] });
  };
  const manage = can('billing:manage') && workspace.status !== 'suspended';

  const checkout = useMutation({
    mutationFn: (plan: PlanInfo) => api.post<{ checkoutUrl: string; provider: string }>(`/workspaces/${workspace.id}/billing/checkout`, { planCode: plan.code, cycle }),
    onSuccess: ({ checkoutUrl, provider }) => {
      refresh();
      // Razorpay's hosted page; the sandbox "page" is this screen with ?checkout=.
      if (provider === 'razorpay') window.location.assign(checkoutUrl);
      else setParams({ checkout: new URL(checkoutUrl).searchParams.get('checkout') ?? '' });
    },
  });
  const cancel = useMutation({ mutationFn: () => api.post(`/workspaces/${workspace.id}/billing/cancel`), onSuccess: refresh });
  const discard = useMutation({ mutationFn: () => api.post(`/workspaces/${workspace.id}/billing/checkout/discard`), onSuccess: refresh });

  if (query.isPending) return <Spinner />;
  if (query.error) return <Alert>{errorMessage(query.error)}</Alert>;
  const { subscription: sub, plan, usage, plans, invoices, provider } = query.data;
  const sandboxCheckout = params.get('checkout');
  const actionError = checkout.error ?? cancel.error ?? discard.error;
  const isPaid = sub.status === 'active' && sub.provider !== 'none';

  return (
    <>
      <PageHeader title="Billing & usage" description="Your Zeta Connect plan. WhatsApp conversation charges are billed by Meta directly to your WhatsApp Business account." />
      {provider === 'sandbox' && (
        <div className="mb-4">
          <Alert tone="info">
            <strong>Sandbox billing.</strong> Checkout is simulated and no money moves. Set <code>BILLING_PROVIDER=razorpay</code> for real payments.
          </Alert>
        </div>
      )}
      {actionError != null && (
        <div className="mb-4">
          <Alert>{errorMessage(actionError)}</Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="space-y-3 p-5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase">Current plan</p>
              <p className="mt-1 text-xl font-semibold text-ink">{plan.name}</p>
            </div>
            <Badge tone={STATUS[sub.status].tone}>{STATUS[sub.status].label}</Badge>
          </div>
          <dl className="space-y-1 text-sm text-slate-600">
            {sub.status === 'trialing' && sub.trialEndsAt && <Row label="Trial ends" value={formatDate(sub.trialEndsAt, true)} />}
            {sub.status !== 'trialing' && sub.planCode !== 'trial' && <Row label="Price" value={`${money(sub.cycle === 'yearly' ? plan.priceYearly : plan.priceMonthly, plan.currency)} / ${sub.cycle === 'yearly' ? 'year' : 'month'}`} />}
            {sub.status === 'active' && <Row label={sub.cancelAtPeriodEnd ? 'Ends on' : 'Renews on'} value={formatDate(sub.currentPeriodEnd)} />}
            {sub.status === 'past_due' && sub.graceEndsAt && <Row label="Access until" value={formatDate(sub.graceEndsAt, true)} />}
            {sub.endedAt && !sub.access && <Row label="Ended" value={formatDate(sub.endedAt)} />}
            <Row label="Usage period" value={`${formatDate(sub.currentPeriodStart)} – ${formatDate(sub.currentPeriodEnd)}`} />
          </dl>
          {!sub.access && <p className="rounded-lg bg-red-50 p-2 text-xs text-red-700">Sending, broadcasts and automations are paused. Contacts, history and exports stay available. Choose a plan to resume.</p>}
          {sub.pending && (
            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <p>
                Payment for <strong>{plans.find((p) => p.code === sub.pending!.planCode)?.name ?? sub.pending.planCode}</strong> ({sub.pending.cycle}) isn&apos;t finished. Your plan changes once it goes through.
              </p>
              {manage && (
                <div className="flex gap-3">
                  {provider === 'razorpay' ? (
                    <a href={sub.pending.checkoutUrl} className="inline-flex items-center gap-1 font-semibold underline">
                      Continue payment <ExternalLink className="size-3" />
                    </a>
                  ) : (
                    <button className="font-semibold underline" onClick={() => setParams({ checkout: new URL(sub.pending!.checkoutUrl).searchParams.get('checkout') ?? '' })}>
                      Continue payment
                    </button>
                  )}
                  <button className="underline" onClick={() => discard.mutate()}>
                    Discard
                  </button>
                </div>
              )}
            </div>
          )}
          {manage && isPaid && !sub.cancelAtPeriodEnd && (
            <Button variant="ghost" className="px-0 text-xs text-red-600 hover:bg-transparent hover:underline" loading={cancel.isPending} onClick={() => window.confirm(`Cancel ${plan.name}? You keep access until ${formatDate(sub.currentPeriodEnd)}.`) && cancel.mutate()}>
              Cancel plan
            </Button>
          )}
        </Card>

        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold text-ink">Usage</h2>
          <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
            {LIMITS.map((l) => (
              <QuotaBar key={l.key} label={l.label} rule={l.rule} used={usage[l.key]} limit={plan.limits[l.key]} />
            ))}
          </div>
          <p className="mt-4 text-xs text-slate-500">
            API requests this period: {usage.apiRequests.toLocaleString('en-IN')}
            {plan.features.api && ` · rate limit ${fmt(plan.limits.apiRequestsPerMinute)} per minute per key`}
          </p>
        </Card>
      </div>

      <div className="mt-8 mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">Plans</h2>
        <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm">
          {(['monthly', 'yearly'] as const).map((c) => (
            <button key={c} onClick={() => setCycle(c)} className={cn('rounded-md px-3 py-1.5 font-medium', cycle === c ? 'bg-white shadow-sm' : 'text-slate-500')}>
              {c === 'monthly' ? 'Monthly' : 'Yearly · 2 months free'}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((p) => {
          const current = sub.planCode === p.code && sub.access && sub.status !== 'trialing' && sub.cycle === cycle && !sub.cancelAtPeriodEnd;
          const buyable = provider === 'sandbox' || p.purchasable[cycle];
          return (
            <Card key={p.code} className={cn('flex flex-col p-5', sub.planCode === p.code && 'ring-2 ring-brand-500')}>
              <p className="text-base font-semibold text-ink">{p.name}</p>
              <p className="mt-1 min-h-10 text-xs text-slate-500">{p.description}</p>
              <p className="mt-3">
                <span className="text-2xl font-semibold text-ink">{money(cycle === 'yearly' ? p.priceYearly : p.priceMonthly, p.currency)}</span>
                <span className="text-sm text-slate-500"> / {cycle === 'yearly' ? 'year' : 'month'}</span>
              </p>
              <p className="text-[11px] text-slate-400">+ GST as applicable</p>
              <ul className="mt-4 flex-1 space-y-1.5 text-sm text-slate-700">
                <li>{fmt(p.limits.monthlyMessages)} messages / period</li>
                <li>{fmt(p.limits.contacts)} contacts</li>
                <li>{fmt(p.limits.seats)} team members</li>
                <li>{fmt(p.limits.activeFlows)} live flows</li>
                {Object.entries(p.features).map(([k, on]) => (
                  <li key={k} className={cn('flex items-center gap-1.5', !on && 'text-slate-400')}>
                    {on ? <Check className="size-3.5 text-emerald-600" /> : <X className="size-3.5" />} {FEATURE_LABEL[k]}
                    {k === 'ai' && on && p.limits.aiRepliesPerMonth !== null && <span className="text-xs text-slate-500">({fmt(p.limits.aiRepliesPerMonth)} replies)</span>}
                  </li>
                ))}
              </ul>
              {manage && (
                <Button className="mt-4" variant={current ? 'secondary' : 'primary'} disabled={current || !buyable} loading={checkout.isPending && checkout.variables?.code === p.code} onClick={() => checkout.mutate(p)}>
                  {current ? 'Current plan' : !buyable ? 'Not available yet' : sub.planCode === p.code ? 'Renew' : 'Choose'}
                </Button>
              )}
            </Card>
          );
        })}
      </div>

      <h2 className="mt-8 mb-3 text-base font-semibold text-ink">Payment history</h2>
      <Card>
        {invoices.length === 0 ? (
          <EmptyState icon={<Receipt className="size-5" />} title="No payments yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Invoice</th>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Plan</th>
                  <th className="px-4 py-2 font-medium">Period</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="px-4 py-2 font-mono text-xs">{i.number}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{formatDate(i.createdAt)}</td>
                    <td className="px-4 py-2 capitalize">
                      {plans.find((p) => p.code === i.planCode)?.name ?? i.planCode} · {i.cycle}
                    </td>
                    <td className="px-4 py-2 text-xs whitespace-nowrap text-slate-500">{i.periodStart && i.periodEnd ? `${formatDate(i.periodStart)} – ${formatDate(i.periodEnd)}` : '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(i.amount, i.currency)}</td>
                    <td className="px-4 py-2">
                      <Badge tone={i.status === 'paid' ? 'green' : 'red'}>{i.status === 'paid' ? 'Paid' : 'Failed'}</Badge>
                      {i.failureReason && <p className="mt-0.5 text-xs text-red-600">{i.failureReason}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {sandboxCheckout && sub.pending && provider === 'sandbox' && (
        <SandboxCheckout
          id={sandboxCheckout}
          planName={plans.find((p) => p.code === sub.pending!.planCode)?.name ?? sub.pending.planCode}
          amount={(() => {
            const p = plans.find((x) => x.code === sub.pending!.planCode);
            return p ? money(sub.pending.cycle === 'yearly' ? p.priceYearly : p.priceMonthly, p.currency) : '';
          })()}
          onClose={() => setParams({})}
          onDone={() => {
            setParams({});
            refresh();
          }}
        />
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{value}</dd>
    </div>
  );
}

function QuotaBar({ label, rule, used, limit }: { label: string; rule: string; used: number; limit: number | null }) {
  const pct = limit === null ? 0 : limit === 0 ? 100 : Math.min(100, (used / limit) * 100);
  const state = limit !== null && used >= limit ? 'full' : pct >= 80 ? 'near' : 'ok';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium text-slate-700">{label}</span>
        <span className="text-slate-600 tabular-nums">
          {used.toLocaleString('en-IN')} <span className="text-slate-400">/ {limit === null ? '∞' : limit === 0 ? 'not included' : limit.toLocaleString('en-IN')}</span>
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100" role="meter" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit ?? undefined}>
        {limit !== null && <div className={cn('h-full rounded-full', state === 'full' ? 'bg-red-500' : state === 'near' ? 'bg-amber-500' : 'bg-brand-600')} style={{ width: `${pct}%` }} />}
      </div>
      {state !== 'ok' && <p className={cn('mt-1 text-xs font-medium', state === 'full' ? 'text-red-600' : 'text-amber-700')}>{state === 'full' ? 'Limit reached' : 'Almost at the limit'}</p>}
      <p className="mt-1 text-[11px] leading-snug text-slate-400">{rule}</p>
    </div>
  );
}

function SandboxCheckout({ id, planName, amount, onClose, onDone }: { id: string; planName: string; amount: string; onClose: () => void; onDone: () => void }) {
  const { workspace } = useWorkspace();
  const pay = useMutation({
    mutationFn: (outcome: 'success' | 'failure') => api.post(`/workspaces/${workspace.id}/billing/sandbox/complete`, { providerSubscriptionId: id, outcome }),
    onSuccess: onDone,
  });
  return (
    <Modal title="Sandbox checkout" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="flex items-center gap-3 rounded-lg border border-slate-200 p-3">
          <CreditCard className="size-5 text-slate-400" />
          <div>
            <p className="font-medium text-slate-800">{planName}</p>
            <p className="text-slate-500">{amount}</p>
          </div>
        </div>
        <p className="text-xs text-slate-500">This stands in for Razorpay&apos;s payment page. Nothing is charged.</p>
        {pay.error != null && <Alert>{errorMessage(pay.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" loading={pay.isPending && pay.variables === 'failure'} onClick={() => pay.mutate('failure')}>
            Decline payment
          </Button>
          <Button loading={pay.isPending && pay.variables === 'success'} onClick={() => pay.mutate('success')}>
            Pay {amount}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

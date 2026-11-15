import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Receipt, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { AButton, AdminHeader, Panel, Segmented } from '../../components/admin';
import { Modal } from '../../components/crm';
import { SkeletonRows, StatusBadge, useToast } from '../../components/feedback';
import { TrendChart } from '../../components/TrendChart';
import { Alert, Button, EmptyState, Field, Input, Select, errorMessage, fieldError } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { StatCard } from '../AdminPage';
import { money } from '../BillingPage';

interface Revenue {
  currency: string;
  days: number;
  mrr: number;
  arr: number;
  payingCustomers: number;
  arpa: number;
  trialing: number;
  pastDue: number;
  collected: number;
  collectedPrevious: number;
  payments: number;
  failed: { count: number; amount: number };
  churned: number;
  trialsStarted: number;
  series: { date: string; amount: number; payments: number }[];
  byPlan: { planCode: string; planName: string; amount: number; payments: number }[];
  planMix: { planCode: string; planName: string; customers: number; mrr: number }[];
  renewals: { workspaceId: string; workspaceName: string; planName: string; cycle: string; amount: number; renewsAt: string; cancelAtPeriodEnd: boolean }[];
}

interface Payment {
  id: string;
  number: string;
  workspaceId: string;
  workspaceName: string;
  planName: string;
  cycle: string;
  amount: number;
  currency: string;
  status: 'paid' | 'failed';
  provider: string;
  providerPaymentId: string | null;
  failureReason: string | null;
  createdAt: string;
}

const RANGES = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '12 months' },
];

/** /admin/revenue: what the platform earns, and every payment behind it. */
export function AdminRevenuePage() {
  const [days, setDays] = useState('30');
  const revenue = useQuery({ queryKey: ['admin', 'revenue', days], queryFn: () => api.get<Revenue>(`/admin/revenue?days=${days}`) });
  const r = revenue.data;
  const change = r && r.collectedPrevious > 0 ? Math.round(((r.collected - r.collectedPrevious) / r.collectedPrevious) * 100) : null;

  return (
    <>
      <AdminHeader
        eyebrow="Billing"
        title="Revenue & payments"
        description="Recurring revenue, collections and every payment across all businesses."
        actions={<Segmented value={days} options={RANGES} onChange={setDays} />}
      />
      {revenue.error != null && (
        <div className="mb-4">
          <Alert>{errorMessage(revenue.error)}</Alert>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="MRR" value={r ? money(r.mrr, r.currency) : undefined} accent />
        <StatCard label="ARR" value={r ? money(r.arr, r.currency) : undefined} />
        <StatCard label="Paying businesses" value={r?.payingCustomers} />
        <StatCard label="Avg. revenue / business" value={r ? money(r.arpa, r.currency) : undefined} />
        <StatCard
          label={`Collected (${RANGES.find((x) => x.value === days)!.label})`}
          value={
            r ? (
              <>
                {money(r.collected, r.currency)}
                {change !== null && <span className={`ml-2 text-xs font-medium ${change >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{change >= 0 ? '+' : ''}{change}%</span>}
              </>
            ) : undefined
          }
        />
        <StatCard label="Failed payments" value={r ? `${r.failed.count} · ${money(r.failed.amount, r.currency)}` : undefined} />
        <StatCard label="On trial / new trials" value={r ? `${r.trialing} / ${r.trialsStarted}` : undefined} />
        <StatCard label="Churned / past due" value={r ? `${r.churned} / ${r.pastDue}` : undefined} />
      </div>

      {r && (
        <div className="mb-6 grid gap-6 xl:grid-cols-3">
          <Panel title="Collections" description="Payments received per day." className="xl:col-span-2">
            <TrendChart title="Revenue collected per day" days={r.series.map((s) => s.date)} series={[{ key: 'amount', label: `Collected (${r.currency})`, color: '#2a78d6', values: r.series.map((s) => Math.round(s.amount / 100)) }]} />
          </Panel>
          <Panel title="Recurring revenue by plan" description="Active and past-due subscriptions." flush>
            {r.planMix.length === 0 ? (
              <EmptyState icon={<Receipt className="size-5" />} title="No paying businesses yet" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {r.planMix.map((p) => (
                  <li key={p.planCode} className="px-5 py-3">
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="font-medium text-slate-800">{p.planName}</span>
                      <span className="font-semibold text-ink tabular-nums">{money(p.mrr, r.currency)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-slate-800" style={{ width: `${r.mrr ? (p.mrr / r.mrr) * 100 : 0}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {p.customers} business(es) · {r.mrr ? Math.round((p.mrr / r.mrr) * 100) : 0}% of MRR
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}

      {r && r.renewals.length > 0 && (
        <Panel title="Renewing in the next 14 days" className="mb-6" flush>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {r.renewals.map((x) => (
                  <tr key={x.workspaceId}>
                    <td className="px-5 py-2.5">
                      <Link to={`/admin/workspaces/${x.workspaceId}`} className="font-medium text-slate-800 hover:underline">
                        {x.workspaceName}
                      </Link>
                    </td>
                    <td className="px-5 py-2.5 text-slate-600 capitalize">
                      {x.planName} · {x.cycle}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{money(x.amount, r.currency)}</td>
                    <td className="px-5 py-2.5 text-right whitespace-nowrap text-slate-600">
                      {x.cancelAtPeriodEnd ? <StatusBadge status="cancelled" label={`Ends ${formatDate(x.renewsAt)}`} /> : formatDate(x.renewsAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <PaymentsPanel />
    </>
  );
}

function PaymentsPanel() {
  const toast = useToast();
  const [status, setStatus] = useState<'' | 'paid' | 'failed'>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const filter = `${status ? `&status=${status}` : ''}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`;
  const payments = useQuery({
    queryKey: ['admin', 'payments', status, q.trim(), page],
    queryFn: () => api.get<{ payments: Payment[]; total: number; pages: number }>(`/admin/payments?page=${page}${filter}`),
    placeholderData: (prev) => prev,
  });
  const exportCsv = useMutation({ mutationFn: () => api.download(`/admin/payments?format=csv${filter}`, 'payments.csv'), onError: (err) => toast.error(err) });
  const data = payments.data;

  return (
    <Panel
      title="Payments"
      description={data ? `${data.total.toLocaleString('en-IN')} payment(s)` : undefined}
      flush
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              aria-label="Search payments"
              placeholder="Business, invoice or payment id"
              className="w-64 pl-8"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Segmented
            value={status}
            options={[
              { value: '', label: 'All' },
              { value: 'paid', label: 'Paid' },
              { value: 'failed', label: 'Failed' },
            ]}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          />
          <AButton icon={Download} onClick={() => exportCsv.mutate()} disabled={exportCsv.isPending || !data?.total}>
            Export CSV
          </AButton>
        </div>
      }
    >
      {payments.error != null ? (
        <div className="p-4">
          <Alert>{errorMessage(payments.error)}</Alert>
        </div>
      ) : !data ? (
        <SkeletonRows rows={6} className="p-4" />
      ) : data.payments.length === 0 ? (
        <EmptyState icon={<Receipt className="size-5" />} title={q || status ? 'No payments match these filters' : 'No payments yet'}>
          {q || status ? 'Try a different search or status.' : 'Payments appear here as soon as a business buys a plan.'}
        </EmptyState>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Invoice</th>
                  <th className="px-5 py-2.5 font-medium">Date</th>
                  <th className="px-5 py-2.5 font-medium">Business</th>
                  <th className="px-5 py-2.5 font-medium">Plan</th>
                  <th className="px-5 py-2.5 text-right font-medium">Amount</th>
                  <th className="px-5 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 font-medium">Payment id</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.payments.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-2.5 font-mono text-xs">{p.number}</td>
                    <td className="px-5 py-2.5 whitespace-nowrap text-slate-600">{formatDate(p.createdAt, true)}</td>
                    <td className="px-5 py-2.5">
                      <Link to={`/admin/workspaces/${p.workspaceId}`} className="font-medium text-slate-800 hover:underline">
                        {p.workspaceName}
                      </Link>
                    </td>
                    <td className="px-5 py-2.5 text-slate-600 capitalize">
                      {p.planName} · {p.cycle}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{money(p.amount, p.currency)}</td>
                    <td className="px-5 py-2.5">
                      <StatusBadge status={p.status} label={p.status === 'paid' ? 'Paid' : 'Failed'} />
                      {p.failureReason && <p className="mt-0.5 max-w-56 truncate text-xs text-red-600" title={p.failureReason}>{p.failureReason}</p>}
                    </td>
                    <td className="px-5 py-2.5 font-mono text-xs text-slate-500">
                      {p.providerPaymentId ?? '—'} <span className="font-sans text-slate-400">({p.provider})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.pages > 1 && (
            <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-sm text-slate-500">
              <span>
                Page {page} of {data.pages}
              </span>
              <div className="flex gap-2">
                <AButton size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </AButton>
                <AButton size="sm" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>
                  Next
                </AButton>
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/** Creates a plan (e.g. a custom deal) as a copy of an existing plan's limits and features. */
export function NewPlanButton({ plans }: { plans: { code: string; name: string }[] }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', description: '', priceMonthly: '', priceYearly: '', copyFrom: plans.find((p) => p.code !== 'trial')?.code ?? plans[0]?.code ?? '', isPublic: false });
  const create = useMutation({
    mutationFn: () => api.post('/admin/plans', { ...form, priceMonthly: Math.round(Number(form.priceMonthly || 0) * 100), priceYearly: Math.round(Number(form.priceYearly || 0) * 100) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
      toast.success(`Plan "${form.name}" created. Edit it to adjust limits and features.`);
      setOpen(false);
    },
  });
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  return (
    <>
      <AButton variant="primary" icon={Plus} onClick={() => setOpen(true)}>
        New plan
      </AButton>
      {open && (
        <Modal title="New plan" onClose={() => setOpen(false)}>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            {create.error != null && <Alert>{errorMessage(create.error)}</Alert>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="np-name" error={fieldError(create.error, 'name')}>
                <Input id="np-name" autoFocus maxLength={60} value={form.name} onChange={(e) => set({ name: e.target.value, code: form.code || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) })} />
              </Field>
              <Field label="Code" htmlFor="np-code" hint="Permanent id, e.g. enterprise." error={fieldError(create.error, 'code')}>
                <Input id="np-code" value={form.code} onChange={(e) => set({ code: e.target.value.toLowerCase() })} />
              </Field>
            </div>
            <Field label="Description" htmlFor="np-desc">
              <Input id="np-desc" maxLength={300} value={form.description} onChange={(e) => set({ description: e.target.value })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Price per month (₹)" htmlFor="np-pm" error={fieldError(create.error, 'priceMonthly')}>
                <Input id="np-pm" type="number" min={0} value={form.priceMonthly} onChange={(e) => set({ priceMonthly: e.target.value })} />
              </Field>
              <Field label="Price per year (₹)" htmlFor="np-py" error={fieldError(create.error, 'priceYearly')}>
                <Input id="np-py" type="number" min={0} value={form.priceYearly} onChange={(e) => set({ priceYearly: e.target.value })} />
              </Field>
            </div>
            <Field label="Copy limits and features from" htmlFor="np-copy">
              <Select id="np-copy" value={form.copyFrom} onChange={(e) => set({ copyFrom: e.target.value })}>
                {plans.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={form.isPublic} onChange={(e) => set({ isPublic: e.target.checked })} />
              <span>
                <span className="font-medium text-slate-800">Show on the billing page</span>
                <span className="block text-slate-500">Leave off for a private plan you assign to one business by hand.</span>
              </span>
            </label>
            <Button type="submit" loading={create.isPending} disabled={!form.name.trim() || !form.code.trim()}>
              Create plan
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}

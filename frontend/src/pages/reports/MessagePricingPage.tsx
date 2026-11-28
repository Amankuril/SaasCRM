import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, Info, ReceiptIndianRupee, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { TrendChart } from '../../components/TrendChart';
import { Alert, Button, Card, EmptyState, Field, Input, LoadError, PageHeader, Select, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type MessagePricingReport } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';

type Direction = 'all' | 'incoming' | 'outgoing';
type Group = MessagePricingReport['range']['group'];

const MAX_DAYS = 365;

const TYPES: { value: string; label: string }[] = [
  { value: 'all', label: 'All types' },
  { value: 'regular', label: 'Regular' },
  { value: 'free_customer_service', label: 'Free customer service' },
  { value: 'free_entry_point', label: 'Free entry point' },
  { value: 'not_available', label: 'Not available' },
];
const CATEGORIES: { value: string; label: string }[] = [
  { value: 'all', label: 'All categories' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'utility', label: 'Utility' },
  { value: 'authentication', label: 'Authentication' },
  { value: 'service', label: 'Service' },
  { value: 'not_available', label: 'Not available' },
];

/** Meta's lowercase keys in plain words ("free_customer_service" -> "Free customer service"). */
export function pricingLabel(key: string): string {
  const known = [...TYPES, ...CATEGORIES].find((o) => o.value === key);
  if (known) return known.label;
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const inr = (n: number) => n.toLocaleString('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n: number) => n.toLocaleString('en-IN');

function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}
const spanDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

const fmtDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const LABELS: Record<Group, { format: (d: string) => string; column: string }> = {
  daily: { format: fmtDay, column: 'Day' },
  weekly: { format: (d) => `Week of ${fmtDay(d)}`, column: 'Week' },
  monthly: { format: (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }), column: 'Month' },
};

/** Insights > Message pricing: what was sent and received, and what Meta bills for it. */
export function MessagePricingPage() {
  const { workspace } = useWorkspace();
  const today = todayIn(workspace.timezone);
  const [from, setFrom] = useState(() => shiftDay(today, -29));
  const [to, setTo] = useState(today);
  const [direction, setDirection] = useState<Direction>('all');
  const [type, setType] = useState('all');
  const [category, setCategory] = useState('all');
  const [group, setGroup] = useState<Group>('daily');
  const [exportError, setExportError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);

  const rangeError = !from || !to ? 'Pick both dates.' : from > to ? 'The start date must be on or before the end date.' : spanDays(from, to) > MAX_DAYS ? `Choose at most ${MAX_DAYS} days.` : null;
  const params = new URLSearchParams({ from, to, direction, type, category, group }).toString();
  const base = `/workspaces/${workspace.id}/reports/message-pricing`;

  const query = useQuery({
    queryKey: ['message-pricing', workspace.id, params],
    queryFn: () => api.get<MessagePricingReport>(`${base}?${params}`),
    enabled: !rangeError,
    placeholderData: keepPreviousData,
  });

  async function exportCsv() {
    setExportError(null);
    setExporting(true);
    try {
      await api.download(`${base}/export?${params}`, `message-pricing-${from}-to-${to}.csv`);
    } catch (err) {
      setExportError(err);
    } finally {
      setExporting(false);
    }
  }

  const pricingFilter = type !== 'all' || category !== 'all';

  return (
    <>
      <PageHeader
        title="Message pricing"
        description="Incoming and outgoing message activity, and what WhatsApp charges for it."
        actions={
          <>
            <Link to={`/w/${workspace.id}/analytics`} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900">
              <ArrowLeft className="size-4" strokeWidth={1.5} /> All reports
            </Link>
            <Button variant="secondary" onClick={() => void exportCsv()} loading={exporting} disabled={!!rangeError || !query.data}>
              {!exporting && <Download className="size-4" strokeWidth={1.5} />} Export CSV
            </Button>
          </>
        }
      />

      {exportError != null && (
        <div className="mb-4">
          <Alert>{errorMessage(exportError)}</Alert>
        </div>
      )}

      <Card className="mb-5 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          <Field label="From" htmlFor="mp-from">
            <Input id="mp-from" type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} invalid={!!rangeError} />
          </Field>
          <Field label="To" htmlFor="mp-to">
            <Input id="mp-to" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} invalid={!!rangeError} />
          </Field>
          <Field label="Direction" htmlFor="mp-direction">
            <Select id="mp-direction" value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
              <option value="all">Incoming and outgoing</option>
              <option value="incoming">Incoming</option>
              <option value="outgoing">Outgoing</option>
            </Select>
          </Field>
          <Field label="Pricing type" htmlFor="mp-type">
            <Select id="mp-type" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pricing category" htmlFor="mp-category">
            <Select id="mp-category" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {rangeError ? (
          <p className="mt-2 text-xs text-red-600">{rangeError}</p>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            Dates are in {workspace.timezone}.{pricingFilter && ' Pricing filters only apply to outgoing messages, so incoming ones are hidden.'}
          </p>
        )}
      </Card>

      {rangeError ? null : query.isPending ? (
        <Spinner />
      ) : query.error ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} what="the report" />
      ) : (
        <Report data={query.data} group={group} onGroup={setGroup} onRefresh={() => void query.refetch()} refreshing={query.isFetching} />
      )}
    </>
  );
}

function Report({ data, group, onGroup, onRefresh, refreshing }: { data: MessagePricingReport; group: Group; onGroup: (g: Group) => void; onRefresh: () => void; refreshing: boolean }) {
  const t = data.totals;
  const labels = LABELS[group];
  return (
    <div className={cn('space-y-5 transition-opacity', refreshing && 'opacity-70')}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Total messages" value={num(t.total)} hint="In this range" />
        <Kpi label="Incoming" value={num(t.incoming)} hint="From customers" />
        <Kpi label="Outgoing" value={num(t.outgoing)} hint="Sent by you" />
        <Kpi label="Billable outgoing" value={num(t.billable)} hint="Charged by Meta" />
        <Kpi
          label="Estimated cost"
          value={inr(t.estCost)}
          accent
          hint={t.unpricedBillable ? `${num(t.unpricedBillable)} billable without a rate` : data.markupPct ? `Includes ${data.markupPct}% service fee` : 'Billable × Meta rate'}
          className="col-span-2 lg:col-span-1"
        />
      </div>

      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Messages over time</h2>
            <p className="text-xs text-slate-500">
              {fmtDay(data.range.from)} – {fmtDay(data.range.to)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm" role="group" aria-label="Group by">
              {(['daily', 'weekly', 'monthly'] as const).map((g) => (
                <button key={g} onClick={() => onGroup(g)} aria-pressed={group === g} className={cn('rounded-md px-3 py-1 font-medium capitalize', group === g ? 'bg-white shadow-sm' : 'text-slate-500')}>
                  {g}
                </button>
              ))}
            </div>
            <button onClick={onRefresh} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800" aria-label="Refresh">
              <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} strokeWidth={1.5} />
            </button>
          </div>
        </div>
        {t.total === 0 ? (
          <EmptyState icon={<ReceiptIndianRupee className="size-6" strokeWidth={1.5} />} title="No messages in this range">
            Try a wider date range or clear the filters.
          </EmptyState>
        ) : (
          <TrendChart
            title="Messages over time"
            days={data.series.map((p) => p.date)}
            formatLabel={labels.format}
            firstColumn={labels.column}
            series={[
              { key: 'incoming', label: 'Incoming', color: '#0a7d55', values: data.series.map((p) => p.incoming) },
              { key: 'outgoing', label: 'Outgoing', color: '#334155', values: data.series.map((p) => p.outgoing) },
            ]}
          />
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-sm font-semibold text-ink">Outgoing pricing breakdown</h2>
          <p className="text-xs text-slate-500">Outgoing messages grouped by how Meta priced them.</p>
        </div>
        {data.breakdown.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No outgoing messages in this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Pricing type</th>
                  <th className="px-5 py-2 font-medium">Pricing category</th>
                  <th className="px-5 py-2 text-right font-medium">Total messages</th>
                  <th className="px-5 py-2 text-right font-medium">Billable</th>
                  <th className="px-5 py-2 text-right font-medium">Est. cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.breakdown.map((b) => (
                  <tr key={`${b.type}|${b.category}`}>
                    <td className="px-5 py-2.5 text-slate-800">{pricingLabel(b.type)}</td>
                    <td className="px-5 py-2.5 text-slate-600">{pricingLabel(b.category)}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{num(b.total)}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{num(b.billable)}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">
                      {b.unpricedBillable ? <span title={`${num(b.unpricedBillable)} billable messages have no rate set`}>{inr(b.estCost)}*</span> : b.billable ? inr(b.estCost) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="flex items-start gap-1.5 border-t border-slate-200 px-5 py-3 text-xs text-slate-500">
          <Info className="mt-px size-3.5 shrink-0" strokeWidth={1.5} />
          <span>
            Estimate. Actual charges come from your Meta invoice. “Not available” means WhatsApp sent no pricing for the message, which is usual for free replies inside the 24-hour window.
            {t.unpricedBillable > 0 && ' * Some billable messages have no rate set yet, so their cost is not included.'}
          </span>
        </p>
      </Card>
    </div>
  );
}

function Kpi({ label, value, hint, accent, className }: { label: string; value: ReactNode; hint?: string; accent?: boolean; className?: string }) {
  return (
    <div className={cn('rounded-xl border bg-white p-3.5', accent ? 'border-brand-200' : 'border-slate-200', className)}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cn('mt-1 text-xl font-semibold tabular-nums', accent ? 'text-brand-700' : 'text-ink')}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

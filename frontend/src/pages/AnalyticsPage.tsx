import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { TrendChart } from '../components/TrendChart';
import { Alert, Card, PageHeader, Spinner, cn, errorMessage } from '../components/ui';
import { api, type Analytics, type DurationStats } from '../lib/api';
import { formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

export function duration(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = ms / 3_600_000;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${Math.round(h / 24)}d`;
}

export function AnalyticsPage() {
  const { workspace } = useWorkspace();
  const [days, setDays] = useState(30);
  const query = useQuery({
    queryKey: ['analytics', workspace.id, days],
    queryFn: () => api.get<Analytics>(`/workspaces/${workspace.id}/analytics?days=${days}`),
  });

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Messages, inbox speed, broadcasts, automations and AI, computed from your stored data."
        actions={
          <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm" role="group" aria-label="Date range">
            {[7, 30, 90].map((d) => (
              <button key={d} onClick={() => setDays(d)} className={cn('rounded-md px-3 py-1.5 font-medium', days === d ? 'bg-white shadow-sm' : 'text-slate-500')}>
                {d} days
              </button>
            ))}
          </div>
        }
      />
      {query.isPending ? (
        <Spinner />
      ) : query.error ? (
        <Alert>{errorMessage(query.error)}</Alert>
      ) : (
        <Report data={query.data} />
      )}
    </>
  );
}

function Report({ data: a }: { data: Analytics }) {
  const { workspace } = useWorkspace();
  const sent = a.messages.outbound.total ?? 0;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="Messages sent" value={sent.toLocaleString('en-IN')} />
        <Stat label="Messages received" value={a.messages.inbound.toLocaleString('en-IN')} />
        <Stat label="Delivery rate" value={pct(a.messages.deliveryRate)} hint="Delivered or read, of sends WhatsApp reported on" />
        <Stat label="Read rate" value={pct(a.messages.readRate)} hint="Read, of delivered (only if the customer shares read receipts)" />
        <Stat label="New contacts" value={a.contacts.new.toLocaleString('en-IN')} hint={`${a.contacts.total.toLocaleString('en-IN')} total`} />
        <Stat label="Failed sends" value={(a.messages.outbound.failed ?? 0).toLocaleString('en-IN')} hint={pct(a.messages.failureRate)} />
      </div>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">Messages per day</h2>
        <TrendChart
          title="Messages per day"
          days={a.messages.daily.map((d) => d.day)}
          series={[
            { key: 'outbound', label: 'Sent', color: '#2a78d6', values: a.messages.daily.map((d) => d.outbound) },
            { key: 'inbound', label: 'Received', color: '#eb6834', values: a.messages.daily.map((d) => d.inbound) },
          ]}
        />
      </Card>

      <Section title="Team inbox">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Open now" value={a.inbox.openNow} hint={`${a.inbox.unassignedOpen} unassigned`} />
          <Stat label="Pending" value={a.inbox.pendingNow} />
          <Stat label="Resolved" value={a.inbox.resolved} />
          <Stat label="First response" value={duration(a.inbox.firstResponse.medianMs)} hint={timing(a.inbox.firstResponse)} />
          <Stat label="Resolution time" value={duration(a.inbox.resolution.medianMs)} hint={timing(a.inbox.resolution)} />
        </div>
        {a.inbox.agents.length > 0 && (
          <Table head={['Teammate', 'Open now', 'Resolved', 'First response (median)']}>
            {a.inbox.agents.map((ag) => (
              <tr key={ag.userId}>
                <td className="px-4 py-2 font-medium text-slate-800">{ag.name}</td>
                <Num>{ag.open}</Num>
                <Num>{ag.resolved}</Num>
                <Num>{duration(ag.firstResponse.medianMs)}</Num>
              </tr>
            ))}
          </Table>
        )}
        <p className="text-xs text-slate-400">First response: time from a conversation opening to a teammate&apos;s first reply (bots and broadcasts don&apos;t count).</p>
      </Section>

      <Section title="Broadcasts launched">
        {a.campaigns.length === 0 ? (
          <Empty>No broadcasts launched in this period.</Empty>
        ) : (
          <Table head={['Campaign', 'Launched', 'Recipients', 'Delivered', 'Read', 'Replied', 'Failed']}>
            {a.campaigns.map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-2">
                  <Link to={`/w/${workspace.id}/campaigns/${c.id}`} className="font-medium text-slate-800 hover:underline">
                    {c.name}
                  </Link>
                </td>
                <td className="px-4 py-2 text-xs whitespace-nowrap text-slate-500">{formatDate(c.launchedAt)}</td>
                <Num>{c.total - c.skipped}</Num>
                <Num>{c.delivered}</Num>
                <Num>{c.read}</Num>
                <Num>{c.replied}</Num>
                <Num>{c.failed}</Num>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Automations">
        {a.automation.length === 0 ? (
          <Empty>No flow runs in this period.</Empty>
        ) : (
          <Table head={['Flow', 'Started', 'Completed', 'In progress', 'Exited', 'Failed', 'Goals', 'Where runs stop']}>
            {a.automation.map((f) => (
              <tr key={f.flowId}>
                <td className="px-4 py-2">
                  <Link to={`/w/${workspace.id}/flows/${f.flowId}`} className="font-medium text-slate-800 hover:underline">
                    {f.name}
                  </Link>
                </td>
                <Num>{f.started}</Num>
                <Num>{f.completed}</Num>
                <Num>{f.active}</Num>
                <Num>{f.exited}</Num>
                <Num>{f.failed}</Num>
                <Num>{f.goals}</Num>
                <td className="px-4 py-2 text-xs text-slate-500">
                  {f.dropOffs.length === 0
                    ? '—'
                    : f.dropOffs.map((d) => (
                        <p key={`${d.nodeId}-${d.status}`} className="truncate" title={d.label ?? undefined}>
                          {d.count}× {d.status} at {d.label ? `"${d.label.slice(0, 30)}"` : d.type}
                        </p>
                      ))}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="AI agent">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="AI answers attempted" value={a.ai.total} />
          <Stat label="Resolved by AI" value={pct(a.ai.resolvedRate)} hint={`${a.ai.answered} answered`} />
          <Stat label="Handed to team" value={a.ai.handedOff} />
          <Stat label="Errors / fallbacks" value={a.ai.errors} />
          <Stat label="Avg answer time" value={a.ai.avgLatencyMs === null ? '—' : `${(a.ai.avgLatencyMs / 1000).toFixed(1)}s`} hint={`${((a.ai.inputTokens + a.ai.outputTokens) / 1000).toFixed(1)}k tokens`} />
        </div>
      </Section>
    </div>
  );
}

function timing(s: DurationStats) {
  return s.count ? `avg ${duration(s.avgMs)} · ${s.count} conversation(s)` : 'no data yet';
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-ink tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-xs text-slate-500">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={cn('px-4 py-2 font-medium whitespace-nowrap', i > 0 && 'text-right', h === 'Where runs stop' && 'text-left', h === 'Launched' && 'text-left')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </Card>
  );
}

function Num({ children }: { children: ReactNode }) {
  return <td className="px-4 py-2 text-right text-slate-700 tabular-nums">{children}</td>;
}

function Empty({ children }: { children: ReactNode }) {
  return <Card className="p-6 text-center text-sm text-slate-500">{children}</Card>;
}

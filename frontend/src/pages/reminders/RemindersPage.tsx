import { useQuery } from '@tanstack/react-query';
import { ChevronRight, MessageSquareText } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Skeleton, StatusBadge } from '../../components/feedback';
import { TemplatePreview } from '../../components/TemplatePreview';
import { Alert, Card, LoadError, PageHeader, cn } from '../../components/ui';
import { api, type ReminderOverview } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { CategoryIcon, dateTime, scheduleText } from './shared';
import { UnlockPanel } from './UnlockPanel';

export function useReminders() {
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: ['reminders', workspace.id, 'overview'],
    queryFn: () => api.get<ReminderOverview>(`/workspaces/${workspace.id}/reminders`),
  });
}

/** A category's sample sentence with its example values filled in. */
export function sampleText(c: ReminderOverview['categories'][number], business: string): string {
  const values: Record<string, string> = { name: 'Rahul', date: '14 Dec', time: '11:30 AM', cycle_number: '3', business_name: business, ...Object.fromEntries(c.fields.map((f) => [f.key, f.example])) };
  return c.sample.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');
}

/** Automation > Date reminders: pick an event type, each with its own setup. */
export function RemindersPage() {
  const { workspace } = useWorkspace();
  const base = `/w/${workspace.id}/reminders`;
  const query = useReminders();
  const [hovered, setHovered] = useState('birthdays');
  const d = query.data;

  if (query.error) return <LoadError error={query.error} what="date reminders" onRetry={() => void query.refetch()} />;
  const preview = d?.categories.find((c) => c.key === hovered) ?? d?.categories[0];

  return (
    <>
      <PageHeader title="Date reminders" description="Add people with their dates. Each person gets a personal WhatsApp message at the right time." />

      {d && !d.access.enabled && (
        <div className="mb-6">
          <Alert tone="info">Date reminders are turned off on this platform. Contact support to enable them.</Alert>
        </div>
      )}

      {d && d.setups.length > 0 && (
        <section className="mb-8" aria-label="Your reminders">
          <dl className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[
              ['Live reminders', d.totals.live, `${d.totals.setups} set up`],
              ['Contacts', d.totals.contacts, `${d.totals.active} with a date ahead`],
              ['Sent', d.totals.sent, d.totals.failed ? `${d.totals.failed} failed` : 'No failures'],
              ['Next reminder', d.totals.nextRunAt ? dateTime(d.totals.nextRunAt, d.timezone) : 'None', d.totals.nextRunAt ? d.timezone.replace('_', ' ') : 'Activate a reminder to schedule one'],
            ].map(([label, value, hint]) => (
              <Card key={label as string} className="p-4">
                <dt className="text-sm text-slate-500">{label}</dt>
                <dd className={cn('mt-2 font-medium text-ink tabular-nums', typeof value === 'number' ? 'text-2xl leading-8' : 'text-base leading-8')}>{value}</dd>
                <dd className="mt-1 text-xs text-slate-500">{hint}</dd>
              </Card>
            ))}
          </dl>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-4 py-2.5 font-normal">Reminder</th>
                  <th className="px-4 py-2.5 font-normal">Status</th>
                  <th className="px-4 py-2.5 text-right font-normal">Contacts</th>
                  <th className="px-4 py-2.5 font-normal">Sends</th>
                  <th className="px-4 py-2.5 font-normal">Next run</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.setups.map((s) => (
                  <tr key={s.id} className="relative transition-colors hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-3">
                        <CategoryIcon category={s.category} />
                        <span className="min-w-0">
                          <Link to={`${base}/${s.id}`} className="block truncate font-medium text-ink after:absolute after:inset-0">
                            {s.name}
                          </Link>
                          <span className="block text-xs text-slate-500">{d.categories.find((c) => c.key === s.category)?.name}</span>
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={s.status} label={s.status === 'active' ? 'Live' : undefined} />
                    </td>
                    <td className="px-4 py-3 text-right text-slate-700 tabular-nums">{s.counts.contacts}</td>
                    <td className="px-4 py-3 text-slate-600">{scheduleText(s)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-600">{s.counts.nextRunAt ? dateTime(s.counts.nextRunAt, d.timezone) : 'Not scheduled'}</td>
                    <td className="pr-4 text-slate-400">
                      <ChevronRight className="size-4" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="event-types">
          <h2 id="event-types" className="mb-3 text-base font-medium text-ink">
            Event types
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {!d
              ? Array.from({ length: 11 }, (_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
              : d.categories.map((c) => (
                  <Link
                    key={c.key}
                    to={`${base}/type/${c.key}`}
                    onMouseEnter={() => setHovered(c.key)}
                    onFocus={() => setHovered(c.key)}
                    className={cn('flex gap-3 rounded-xl border bg-white p-4 transition-colors hover:border-slate-400', c.key === 'custom' ? 'border-dashed border-slate-300' : 'border-slate-200')}
                  >
                    <CategoryIcon category={c.key} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">{c.name}</span>
                      <span className="mt-0.5 block text-sm text-slate-500">{c.description}</span>
                      {c.setups > 0 && (
                        <span className="mt-2 block text-xs text-slate-500 tabular-nums">
                          {c.live > 0 ? `${c.live} live` : 'Not live'}, {c.contacts} contact{c.contacts === 1 ? '' : 's'}
                        </span>
                      )}
                    </span>
                  </Link>
                ))}
          </div>
        </section>

        <aside className="space-y-4 xl:sticky xl:top-0">
          {d && d.access.enabled && !d.access.unlocked && <UnlockPanel access={d.access} />}
          {preview && (
            <Card className="overflow-hidden">
              <p className="flex items-center gap-2 px-4 py-3 text-sm text-slate-600">
                <MessageSquareText className="size-4 text-slate-400" strokeWidth={1.5} /> {preview.name}, as the customer sees it
              </p>
              <div className="[&>.wa-wallpaper]:rounded-none">
                <TemplatePreview components={[{ type: 'BODY', text: sampleText(preview, workspace.name) }]} />
              </div>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}

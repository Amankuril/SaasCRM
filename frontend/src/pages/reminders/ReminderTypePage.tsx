import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { SkeletonRows, StatusBadge } from '../../components/feedback';
import { TemplatePreview } from '../../components/TemplatePreview';
import { Alert, Button, Card, Field, Input, LoadError, errorMessage } from '../../components/ui';
import { api, type ReminderSetup } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { sampleText, useReminders } from './RemindersPage';
import { CategoryIcon, RECURRENCE_LABEL, dateTime, ruleText } from './shared';
import { UnlockPanel } from './UnlockPanel';

/** One event type: what it stores, its timing, and the reminders already set up with it. */
export function ReminderTypePage() {
  const { workspace, can } = useWorkspace();
  const { categoryKey } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useReminders();
  const [eventLabel, setEventLabel] = useState('');
  const base = `/w/${workspace.id}/reminders`;
  const create = useMutation({
    mutationFn: () => api.post<{ setup: ReminderSetup }>(`/workspaces/${workspace.id}/reminders/setups`, { category: categoryKey, ...(categoryKey === 'custom' ? { eventLabel: eventLabel.trim() } : {}) }),
    onSuccess: ({ setup }) => {
      void queryClient.invalidateQueries({ queryKey: ['reminders', workspace.id] });
      navigate(`${base}/${setup.id}`);
    },
  });

  if (query.error) return <LoadError error={query.error} what="date reminders" onRetry={() => void query.refetch()} />;
  const d = query.data;
  if (!d) return <SkeletonRows />;
  const c = d.categories.find((x) => x.key === categoryKey);
  if (!c) return <LoadError error={null} what="this event type" />;
  const setups = d.setups.filter((s) => s.category === c.key);
  const canManage = can('campaigns:manage') && workspace.status !== 'suspended';
  const custom = c.key === 'custom';

  return (
    <>
      <Link to={base} className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-ink">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Date reminders
      </Link>
      <div className="mb-6 flex items-center gap-4">
        <CategoryIcon category={c.key} className="size-11" />
        <div>
          <h1 className="text-2xl leading-8 font-medium text-ink">{custom ? 'Your own event type' : c.name}</h1>
          <p className="text-sm text-slate-500">{c.description}</p>
        </div>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          {setups.length > 0 && (
            <Card>
              <h2 className="border-b border-slate-200 px-5 py-3 text-sm font-medium text-ink">Set up already</h2>
              <ul className="divide-y divide-slate-100">
                {setups.map((s) => (
                  <li key={s.id} className="relative flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm transition-colors hover:bg-slate-50">
                    <Link to={`${base}/${s.id}`} className="min-w-40 flex-1 font-medium text-ink after:absolute after:inset-0">
                      {s.name}
                    </Link>
                    <span className="text-slate-500 tabular-nums">{s.counts.contacts} contacts</span>
                    <span className="text-slate-500">{s.counts.nextRunAt ? `Next ${dateTime(s.counts.nextRunAt, d.timezone)}` : 'Not scheduled'}</span>
                    <StatusBadge status={s.status} label={s.status === 'active' ? 'Live' : undefined} />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="p-5">
            <h2 className="text-base font-medium text-ink">{setups.length ? 'New reminder' : 'What you set up'}</h2>
            <dl className="mt-4 grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">Saved for each {c.person.toLowerCase()}</dt>
                <dd className="mt-1 text-slate-800">
                  {['Name', 'WhatsApp number', c.dateLabel, ...(c.dateKind === 'datetime' ? ['Time'] : []), ...c.fields.map((f) => f.label)].join(', ')}
                  {custom && ', and fields you add'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Starts with</dt>
                <dd className="mt-1 text-slate-800">{c.defaultRules.map(ruleText).join(', ')}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Repeats</dt>
                <dd className="mt-1 text-slate-800">{c.recurrences.map((r) => RECURRENCE_LABEL[r].split(',')[0]).join(', ')}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Follow-ups</dt>
                <dd className="mt-1 text-slate-800">{c.followUps ? `After the date, until marked ${(c.doneLabel ?? 'done').toLowerCase()}` : 'Not used for this event type'}</dd>
              </div>
            </dl>
            {custom && canManage && (
              <div className="mt-5 max-w-sm">
                <Field label="Event name" htmlFor="event-label" hint="For example Car service due or Membership day">
                  <Input id="event-label" maxLength={60} value={eventLabel} onChange={(e) => setEventLabel(e.target.value)} />
                </Field>
              </div>
            )}
            {create.error != null && (
              <div className="mt-4">
                <Alert>{errorMessage(create.error)}</Alert>
              </div>
            )}
            {canManage && (
              <Button className="mt-5" loading={create.isPending} disabled={!d.access.unlocked || (custom && !eventLabel.trim())} onClick={() => create.mutate()}>
                <Plus className="size-4" /> {setups.length ? 'Add another' : 'Start setup'}
              </Button>
            )}
            {!d.access.unlocked && d.access.enabled && <p className="mt-2 text-sm text-slate-500">Unlock date reminders to start.</p>}
          </Card>
        </div>
        <aside className="space-y-4">
          {d.access.enabled && !d.access.unlocked && <UnlockPanel access={d.access} />}
          <Card className="overflow-hidden">
            <p className="px-4 py-3 text-sm text-slate-600">Example message</p>
            <div className="[&>.wa-wallpaper]:rounded-none">
              <TemplatePreview components={[{ type: 'BODY', text: sampleText(c, workspace.name) }]} />
            </div>
          </Card>
        </aside>
      </div>
    </>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useToast } from '../../components/feedback';
import { TemplatePreview } from '../../components/TemplatePreview';
import { TemplateExtrasFields, buttonValueLabel, emptyExtras, extrasPreview } from '../../components/TemplateSendFields';
import { Alert, Button, Card, Field, Input, Select, errorMessage } from '../../components/ui';
import { ApiError, api, type MessageTemplate, type ReminderCategory, type ReminderPreview, type ReminderRecurrence, type ReminderRule, type ReminderSetup, type ReminderVariable, type TemplateExtras } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { RECURRENCE_LABEL, dateTime, recurrenceText, scheduleText } from './shared';

const EDITABLE = ['name', 'eventLabel', 'extraFields', 'recurrence', 'everyDays', 'rules', 'sendTime', 'sendMissedToday', 'templateId', 'headerVariables', 'bodyVariables', 'buttonVariables', 'templateExtras'] as const;
type Draft = Pick<ReminderSetup, (typeof EDITABLE)[number]>;
const draftOf = (s: ReminderSetup): Draft => Object.fromEntries(EDITABLE.map((k) => [k, s[k]])) as unknown as Draft;
/** Same content, whatever the key order; empty values count as none. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .map(([k, x]) => [k, canonical(x)] as const)
            .filter(([, x]) => x !== null && x !== undefined && x !== '' && !(typeof x === 'object' && !Array.isArray(x) && Object.keys(x as object).length === 0))
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : v;
const same = (a: Draft, b: Draft) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

const blank = (): ReminderVariable => ({ source: 'field', value: '', fallback: null });
const fit = (list: ReminderVariable[], n: number) => Array.from({ length: n }, (_, i) => list[i] ?? blank());
const keyOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40) || 'field';

export function ReminderForm({ setup, category, timezone, url, canManage, onContacts }: { setup: ReminderSetup; category: ReminderCategory; timezone: string; url: string; canManage: boolean; onContacts: () => void }) {
  const { workspace } = useWorkspace();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(setup));
  const dirty = useMemo(() => !same(draft, draftOf(setup)), [draft, setup]);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const templates = useQuery({
    queryKey: ['templates', workspace.id, 'APPROVED'],
    queryFn: () => api.get<{ templates: MessageTemplate[] }>(`/workspaces/${workspace.id}/templates?status=APPROVED`),
  });
  const preview = useQuery({
    queryKey: ['reminders', workspace.id, 'setup', setup.id, 'preview', setup.updatedAt],
    queryFn: () => api.get<ReminderPreview>(`${url}/preview`),
  });
  // The chosen template may have stopped being approved since: it is still shown, with its status.
  const template = templates.data?.templates.find((t) => t.id === draft.templateId) ?? null;
  const components = template?.components ?? (draft.templateId === setup.templateId ? setup.template?.components : undefined);
  const req = template?.requirements;

  const save = useMutation({
    mutationFn: () => api.patch<{ setup: ReminderSetup }>(url, req ? { ...draft, headerVariables: fit(draft.headerVariables, req.header), bodyVariables: fit(draft.bodyVariables, req.body), buttonVariables: fit(draft.buttonVariables, req.buttons.length) } : draft),
    onSuccess: ({ setup: next }) => {
      setDraft(draftOf(next));
      toast.success('Saved.');
      void queryClient.invalidateQueries({ queryKey: ['reminders', workspace.id] });
    },
  });
  const details = save.error instanceof ApiError ? Object.values(save.error.details ?? {}).flat() : [];

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Custom fields appear as variables as soon as they are typed.
  const variables = useMemo(() => {
    const own = new Set(setup.extraFields.map((f) => f.key));
    const rest = setup.variables.filter((v) => !own.has(v.key));
    return [...rest.slice(0, 3), ...draft.extraFields.filter((f) => f.label.trim()).map((f) => ({ key: f.key, label: f.label, example: f.label })), ...rest.slice(3)];
  }, [setup, draft.extraFields]);

  const choose = (id: string) => {
    const t = templates.data?.templates.find((x) => x.id === id);
    // A sensible first guess: the order this event type's example sentence uses.
    const inSample = [...category.sample.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    const order = [...new Set(['name', ...inSample, ...draft.extraFields.map((f) => f.key), 'date', ...category.fields.map((f) => f.key), 'business_name'])];
    const guess = (n: number): ReminderVariable[] => Array.from({ length: n }, (_, i) => ({ source: 'field', value: order[i] ?? '', fallback: null }));
    set({
      templateId: id || null,
      headerVariables: guess(t?.requirements.header ?? 0),
      bodyVariables: guess(t?.requirements.body ?? 0),
      buttonVariables: fit([], t?.requirements.buttons.length ?? 0),
      templateExtras: t ? emptyExtras(t.requirements) : null,
    });
  };

  const valueOf = (v: ReminderVariable) => {
    if (v.source === 'static') return v.value;
    const known = preview.data?.values[v.value] ?? variables.find((x) => x.key === v.value)?.example;
    return known || v.fallback || '';
  };
  const extras: TemplateExtras = draft.templateExtras ?? {};
  const missing = Object.values(setup.missing).flat();
  const statusOf = setup.template && setup.template.status !== 'APPROVED' && draft.templateId === setup.templateId ? setup.template : null;

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <fieldset disabled={!canManage} className="min-w-0 space-y-6">
        {setup.lastError && <Alert>{setup.lastError}</Alert>}
        <Section title={category.key === 'custom' ? 'Event' : 'Name'}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Reminder name" htmlFor="r-name" hint="Only your team sees this">
              <Input id="r-name" maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            {category.key === 'custom' && (
              <Field label="Event name" htmlFor="r-event">
                <Input id="r-event" maxLength={60} value={draft.eventLabel ?? ''} onChange={(e) => set({ eventLabel: e.target.value })} />
              </Field>
            )}
          </div>
          {category.key === 'custom' && (
            <div className="mt-4">
              <p className="mb-2 text-sm font-medium text-slate-700">Fields saved for each contact</p>
              <div className="space-y-2">
                {draft.extraFields.map((f, i) => (
                  <div key={i} className="flex max-w-md gap-2">
                    <Input
                      aria-label={`Field ${i + 1}`}
                      placeholder="Vehicle number"
                      maxLength={60}
                      value={f.label}
                      onChange={(e) => {
                        // A saved field keeps its key, so contacts already imported keep their values.
                        const savedKey = setup.extraFields[i]?.key;
                        const taken = new Set([...draft.extraFields.filter((_, j) => j !== i).map((x) => x.key), ...setup.variables.map((v) => v.key)]);
                        let key = savedKey ?? keyOf(e.target.value);
                        if (!savedKey) for (let n = 2; taken.has(key); n++) key = `${keyOf(e.target.value)}_${n}`;
                        set({ extraFields: draft.extraFields.map((x, j) => (j === i ? { key, label: e.target.value } : x)) });
                      }}
                    />
                    <Button type="button" variant="ghost" aria-label={`Remove field ${i + 1}`} onClick={() => set({ extraFields: draft.extraFields.filter((_, j) => j !== i) })}>
                      <X className="size-4" strokeWidth={1.5} />
                    </Button>
                  </div>
                ))}
                {draft.extraFields.length < 10 && (
                  <Button type="button" variant="secondary" onClick={() => set({ extraFields: [...draft.extraFields, { key: `field_${draft.extraFields.length + 1}`, label: '' }] })}>
                    <Plus className="size-4" /> Add field
                  </Button>
                )}
              </div>
            </div>
          )}
        </Section>

        <Section title="When it is sent" description={`Relative to each ${category.person.toLowerCase()}’s ${(setup.eventLabel ?? category.dateLabel).toLowerCase()}, in the ${timezone.replace('_', ' ')} timezone`}>
          <RuleEditor category={category} rules={draft.rules} onChange={(rules) => set({ rules })} disabled={!canManage} />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="Send time" htmlFor="r-time" hint={category.dateKind === 'datetime' ? 'For reminders set in days. Hours and minutes count from the event time.' : undefined}>
              <Input id="r-time" type="time" value={draft.sendTime} onChange={(e) => e.target.value && set({ sendTime: e.target.value })} />
            </Field>
            <Field label="Repeats" htmlFor="r-repeat">
              <Select id="r-repeat" value={draft.recurrence} onChange={(e) => set({ recurrence: e.target.value as ReminderRecurrence })}>
                {category.recurrences.map((r) => (
                  <option key={r} value={r}>
                    {RECURRENCE_LABEL[r]}
                  </option>
                ))}
              </Select>
            </Field>
            {draft.recurrence === 'custom_days' && (
              <Field label="Number of days" htmlFor="r-days">
                <Input id="r-days" type="number" min={1} max={730} value={draft.everyDays} onChange={(e) => set({ everyDays: Math.max(1, Math.min(730, Number(e.target.value) || 1)) })} />
              </Field>
            )}
          </div>
          <label className="mt-4 flex items-start gap-2.5 text-sm text-slate-700">
            <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" checked={draft.sendMissedToday} onChange={(e) => set({ sendMissedToday: e.target.checked })} />
            <span>
              Send today’s reminders even if the send time has passed
              <span className="block text-xs text-slate-500">Applies when you activate or add a contact later in the day</span>
            </span>
          </label>
        </Section>

        <Section title="WhatsApp message" description="Reminders use approved templates, because customers may not have messaged you in the last 24 hours">
          {templates.error ? (
            <LoadInline error={templates.error} onRetry={() => void templates.refetch()} />
          ) : (
            <Field label="Template" htmlFor="r-template">
              <Select id="r-template" value={draft.templateId ?? ''} onChange={(e) => choose(e.target.value)}>
                <option value="">{templates.isPending ? 'Loading templates' : 'Choose an approved template'}</option>
                {statusOf && (
                  <option value={statusOf.id}>
                    {statusOf.name} ({statusOf.status.toLowerCase()})
                  </option>
                )}
                {templates.data?.templates
                  .filter((t) => t.category !== 'AUTHENTICATION')
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.language}, {t.category.toLowerCase()})
                    </option>
                  ))}
              </Select>
            </Field>
          )}
          {statusOf && (
            <div className="mt-3">
              <Alert>
                Template {statusOf.name} is {statusOf.status.toLowerCase().replace(/_/g, ' ')} on WhatsApp. Reminders wait until Meta approves it, or choose another one.
              </Alert>
            </div>
          )}
          {templates.data && templates.data.templates.length === 0 && (
            <div className="mt-3">
              <Alert tone="info">
                No approved templates yet.{' '}
                <Link to={`/w/${workspace.id}/templates/new`} className="font-medium underline">
                  Create one
                </Link>
                . It appears here as soon as Meta approves it.
              </Alert>
            </div>
          )}
          {template && req && (
            <div className="mt-5 space-y-5">
              <VariableGroup title="Header" list={fit(draft.headerVariables, req.header)} variables={variables} onChange={(headerVariables) => set({ headerVariables })} />
              <VariableGroup title="Body" list={fit(draft.bodyVariables, req.body)} variables={variables} onChange={(bodyVariables) => set({ bodyVariables })} />
              <VariableGroup title="Buttons" labels={req.buttons.map(buttonValueLabel)} list={fit(draft.buttonVariables, req.buttons.length)} variables={variables} onChange={(buttonVariables) => set({ buttonVariables })} />
              {req.header + req.body + req.buttons.length === 0 && <p className="text-sm text-slate-500">This template has no variables, so everyone gets the same text.</p>}
              <TemplateExtrasFields requirements={req} value={extras} onChange={(v) => set({ templateExtras: v })} error={save.error} shared />
            </div>
          )}
        </Section>
      </fieldset>

      <aside className="space-y-4 xl:sticky xl:top-0">
        <Card className="overflow-hidden">
          <p className="px-4 py-3 text-sm text-slate-600">{preview.data?.record ? `Preview for ${preview.data.record.name || preview.data.record.phone}` : 'Preview with example values'}</p>
          <div className="[&>.wa-wallpaper]:rounded-none">
            {components ? (
              <TemplatePreview
                components={components}
                headerParams={draft.headerVariables.map(valueOf)}
                bodyParams={(req ? fit(draft.bodyVariables, req.body) : draft.bodyVariables).map(valueOf)}
                {...extrasPreview(extras)}
              />
            ) : (
              <div className="wa-wallpaper px-4 py-10 text-center text-sm text-slate-500">Choose a template to see the message</div>
            )}
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-medium text-ink">Summary</h2>
          <dl className="mt-3 space-y-2.5 text-sm">
            <SummaryRow label="Event type">{setup.eventLabel ?? category.name}</SummaryRow>
            <SummaryRow label="Contacts">
              <button type="button" onClick={onContacts} className="font-medium text-brand-700 tabular-nums hover:underline">
                {setup.counts.contacts || 'Add contacts'}
              </button>
            </SummaryRow>
            <SummaryRow label="Sends">{scheduleText(draft)}</SummaryRow>
            <SummaryRow label="Repeats">{recurrenceText(draft)}</SummaryRow>
            <SummaryRow label="Template">{template?.name ?? statusOf?.name ?? 'Not chosen'}</SummaryRow>
            <SummaryRow label="Next run">{dirty ? 'Save to update' : preview.data?.nextRunAt ? dateTime(preview.data.nextRunAt, timezone) : 'Not scheduled'}</SummaryRow>
          </dl>
          {!dirty && (
            <ul className="mt-4 space-y-2 border-t border-slate-200 pt-4 text-sm">
              {missing.map((m) => (
                <li key={m} className="flex gap-2 text-slate-600">
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" strokeWidth={1.5} /> {m}
                </li>
              ))}
              {setup.counts.contacts === 0 && (
                <li className="flex gap-2 text-slate-600">
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" strokeWidth={1.5} /> Add at least one contact.
                </li>
              )}
              {preview.data && preview.data.record && preview.data.missing.length > 0 && missing.length === 0 && (
                <li className="flex gap-2 text-slate-600">
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" strokeWidth={1.5} />
                  {preview.data.record.name || preview.data.record.phone} has no {preview.data.missing.map((k) => setup.variables.find((v) => v.key === k)?.label.toLowerCase() ?? k).join(', ')}. Add it or set a fallback.
                </li>
              )}
              {missing.length === 0 && setup.counts.contacts > 0 && (
                <li className="flex gap-2 text-brand-700">
                  <CircleCheck className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} /> {setup.status === 'active' ? 'Live and complete' : 'Ready to activate'}
                </li>
              )}
            </ul>
          )}
          {save.error != null && (
            <div className="mt-4">
              <Alert>
                {errorMessage(save.error)}
                {details.length > 0 && <span className="mt-1 block">{details.join(' ')}</span>}
              </Alert>
            </div>
          )}
          {canManage && (
            <div className="mt-4 flex gap-2">
              <Button className="flex-1" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
                {dirty ? 'Save changes' : 'Saved'}
              </Button>
              {dirty && (
                <Button variant="ghost" onClick={() => setDraft(draftOf(setup))}>
                  Discard
                </Button>
              )}
            </div>
          )}
        </Card>
      </aside>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="text-base font-medium text-ink">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
      <div className="mt-4">{children}</div>
    </Card>
  );
}

const SummaryRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex justify-between gap-4">
    <dt className="shrink-0 text-slate-500">{label}</dt>
    <dd className="min-w-0 text-right break-words text-slate-800">{children}</dd>
  </div>
);

function LoadInline({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Alert>
      {errorMessage(error)}{' '}
      <button type="button" className="font-medium underline" onClick={onRetry}>
        Try again
      </button>
    </Alert>
  );
}

/** The list of moments a reminder goes out. Only the timings this event type supports are offered. */
function RuleEditor({ category, rules, onChange, disabled }: { category: ReminderCategory; rules: ReminderRule[]; onChange: (r: ReminderRule[]) => void; disabled: boolean }) {
  const units: ReminderRule['unit'][] = category.dateKind === 'datetime' ? ['minute', 'hour', 'day', 'week'] : ['day', 'week'];
  const update = (i: number, patch: Partial<ReminderRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rules.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          {r.when !== 'on' && (
            <>
              <Input aria-label={`Reminder ${i + 1} amount`} type="number" min={1} max={365} className="w-20!" value={r.value || ''} onChange={(e) => update(i, { value: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })} />
              <Select aria-label={`Reminder ${i + 1} unit`} className="w-28!" value={r.unit} onChange={(e) => update(i, { unit: e.target.value as ReminderRule['unit'] })}>
                {units.map((u) => (
                  <option key={u} value={u}>
                    {r.value === 1 ? u : `${u}s`}
                  </option>
                ))}
              </Select>
            </>
          )}
          <Select
            aria-label={`Reminder ${i + 1} timing`}
            className="w-44!"
            value={r.when}
            onChange={(e) => {
              const when = e.target.value as ReminderRule['when'];
              update(i, when === 'on' ? { when, value: 0, unit: 'day' } : { when, value: r.value || 1 });
            }}
          >
            <option value="before">before</option>
            <option value="on">on the date</option>
            {category.followUps && <option value="after">after (follow-up)</option>}
          </Select>
          <Button type="button" variant="ghost" aria-label={`Remove reminder ${i + 1}`} disabled={disabled} onClick={() => onChange(rules.filter((_, j) => j !== i))}>
            <X className="size-4" strokeWidth={1.5} />
          </Button>
        </div>
      ))}
      {rules.length < 8 && (
        <Button type="button" variant="secondary" disabled={disabled} onClick={() => onChange([...rules, { when: 'before', value: (rules.filter((r) => r.when === 'before' && r.unit === 'day').at(-1)?.value ?? 0) + 1, unit: 'day' }])}>
          <Plus className="size-4" /> Add reminder
        </Button>
      )}
    </div>
  );
}

function VariableGroup({ title, labels, list, variables, onChange }: { title: string; labels?: string[]; list: ReminderVariable[]; variables: { key: string; label: string }[]; onChange: (v: ReminderVariable[]) => void }) {
  if (!list.length) return null;
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-slate-700">{title}</p>
      <div className="space-y-2">
        {list.map((v, i) => {
          const label = labels?.[i] ?? `{{${i + 1}}}`;
          const update = (next: ReminderVariable) => onChange(list.map((x, j) => (j === i ? next : x)));
          return (
            <div key={i} className="grid items-center gap-2 sm:grid-cols-[minmax(3rem,auto)_1fr_1fr]">
              <span className="font-mono text-xs text-slate-500">{label}</span>
              <Select
                aria-label={`${label} value`}
                value={v.source === 'static' ? '__text' : v.value}
                onChange={(e) => update(e.target.value === '__text' ? { source: 'static', value: '', fallback: null } : { source: 'field', value: e.target.value, fallback: v.fallback ?? null })}
              >
                <option value="">Choose what to insert</option>
                {variables.map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.label}
                  </option>
                ))}
                <option value="__text">Same text for everyone</option>
              </Select>
              {v.source === 'static' ? (
                <Input aria-label={`${label} text`} placeholder="Text" value={v.value} onChange={(e) => update({ ...v, value: e.target.value })} />
              ) : (
                <Input aria-label={`${label} fallback`} placeholder="If empty (optional)" value={v.fallback ?? ''} onChange={(e) => update({ ...v, fallback: e.target.value || null })} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock,
  FlaskConical,
  GitBranch,
  Lock,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Rocket,
  Save,
  Trash2,
  Users,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/feedback';
import { TemplatePreview } from '../../components/TemplatePreview';
import { Alert, Badge, Button, Card, Field, Input, LoadError, Select, Spinner, Toggle, cn, errorMessage, fieldError } from '../../components/ui';
import {
  ApiError,
  api,
  type ChecklistItem,
  type ContactList,
  type CustomFieldDef,
  type MessageTemplate,
  type SeqCondition,
  type SeqOutcomeRule,
  type SeqStep,
  type SeqVariable,
  type SequenceDetail,
  type SequenceRules,
  type SequenceSummary,
  type SequenceTrigger,
} from '../../lib/api';
import { useMembers, useStages, useTags } from '../../lib/hooks';
import { useWorkspace } from '../../layouts/workspaceContext';
import { NEW_CONTACT_SOURCES, StatusBadge, TRIGGER_OPTIONS, messageNumbers, newStepId, timingLabels, triggerSummary } from './shared';

type Draft = Pick<SequenceDetail, 'name' | 'trigger' | 'entryFilter' | 'dateMode' | 'fixedDate' | 'dateKey' | 'goal' | 'stopConditions' | 'rules' | 'draftGraph'>;
type MessageStepT = Extract<SeqStep, { type: 'message' }>;
type ActionStepT = Extract<SeqStep, { type: 'action' }>;

const pick = (s: SequenceDetail): Draft => ({
  name: s.name,
  trigger: s.trigger,
  entryFilter: s.entryFilter,
  dateMode: s.dateMode,
  fixedDate: s.fixedDate,
  dateKey: s.dateKey,
  goal: s.goal,
  stopConditions: s.stopConditions,
  rules: s.rules,
  draftGraph: s.draftGraph,
});

function useRefs(workspaceId: string, canSeeMembers: boolean) {
  const templates = useQuery({
    queryKey: ['templates', workspaceId, 'approved'],
    queryFn: () => api.get<{ templates: MessageTemplate[] }>(`/workspaces/${workspaceId}/templates?status=APPROVED`),
    select: (d) => d.templates.filter((t) => ['MARKETING', 'UTILITY'].includes(t.category.toUpperCase())),
  });
  const lists = useQuery({ queryKey: ['contact-lists', workspaceId, ''], queryFn: () => api.get<{ lists: ContactList[] }>(`/workspaces/${workspaceId}/contact-lists`), select: (d) => d.lists });
  const fields = useQuery({ queryKey: ['custom-fields', workspaceId], queryFn: () => api.get<{ fields: CustomFieldDef[] }>(`/workspaces/${workspaceId}/custom-fields`), select: (d) => d.fields });
  const sequences = useQuery({ queryKey: ['sequences', workspaceId, 'active'], queryFn: () => api.get<{ sequences: SequenceSummary[] }>(`/workspaces/${workspaceId}/sequences`), select: (d) => d.sequences });
  return { templates, lists, fields, sequences, tags: useTags(workspaceId), stages: useStages(workspaceId), members: useMembers(workspaceId, canSeeMembers) };
}
type Refs = ReturnType<typeof useRefs>;

export function SequenceBuilderPage() {
  const { sequenceId } = useParams();
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const toast = useToast();
  const manage = can('sequences:manage');
  const base = `/workspaces/${workspace.id}/sequences/${sequenceId}`;
  const query = useQuery({ queryKey: ['sequence', workspace.id, sequenceId], queryFn: () => api.get<{ sequence: SequenceDetail }>(base), select: (d) => d.sequence });
  const refs = useRefs(workspace.id, can('members:read'));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedJson, setSavedJson] = useState('');
  const [testing, setTesting] = useState(false);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    if (query.data && !draft) {
      setDraft(pick(query.data));
      setSavedJson(JSON.stringify(pick(query.data)));
    }
  }, [query.data, draft]);

  const dirty = !!draft && JSON.stringify(draft) !== savedJson;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = useMutation({
    mutationFn: async () => {
      const seq = query.data!;
      const body: Partial<Draft> = { ...draft! };
      // The trigger is locked once published.
      if (seq.published) delete body.trigger;
      return (await api.patch<{ sequence: SequenceDetail }>(base, body)).sequence;
    },
    onSuccess: (seq) => {
      queryClient.setQueryData(['sequence', workspace.id, sequenceId], { sequence: seq });
      setSavedJson(JSON.stringify(draft));
      void queryClient.invalidateQueries({ queryKey: ['sequences', workspace.id] });
    },
  });
  const status = useMutation({
    mutationFn: (action: 'pause' | 'resume') => api.post<{ sequence: SequenceDetail }>(`${base}/${action}`),
    onSuccess: (res, action) => {
      queryClient.setQueryData(['sequence', workspace.id, sequenceId], res);
      toast.success(action === 'pause' ? 'Paused. Contacts keep their place.' : 'Resumed.');
    },
    onError: (err) => toast.error(err),
  });

  if (query.isPending || (query.data && !draft)) return <Spinner />;
  if (query.error) return <LoadError error={query.error} onRetry={() => void query.refetch()} what="this sequence" />;
  const seq = query.data!;
  const d = draft!;
  const set = (patch: Partial<Draft>) => setDraft({ ...d, ...patch });
  const readOnly = !manage || seq.status === 'archived';
  const checklist = seq.checklist;

  async function saveFirst() {
    if (dirty) await save.mutateAsync();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <Link to={`/w/${workspace.id}/sequences`} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label="Back to sequences">
          <ArrowLeft className="size-4" />
        </Link>
        <input
          aria-label="Sequence name"
          value={d.name}
          disabled={readOnly}
          maxLength={120}
          onChange={(e) => set({ name: e.target.value })}
          className="min-w-0 flex-1 rounded-md border border-transparent px-2 py-1 text-lg font-medium text-ink hover:border-slate-200 focus:border-brand-600 focus:outline-none disabled:bg-transparent sm:max-w-md"
        />
        <StatusBadge status={seq.status} />
        {seq.live && <span className="hidden text-xs text-slate-500 md:inline">v{seq.live.versionNo} live{seq.live.changedSincePublish || dirty ? ' · unpublished changes' : ''}</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {seq.published && (
            <Link to={`/w/${workspace.id}/sequences/${seq.id}/contacts`} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100">
              <Users className="size-4" strokeWidth={1.5} /> Contacts
            </Link>
          )}
          {manage && seq.status === 'active' && (
            <Button variant="ghost" onClick={() => status.mutate('pause')} loading={status.isPending}>
              <Pause className="size-4" /> Pause
            </Button>
          )}
          {manage && seq.status === 'paused' && (
            <Button variant="ghost" onClick={() => status.mutate('resume')} loading={status.isPending}>
              <Play className="size-4" /> Resume
            </Button>
          )}
          {!readOnly && (
            <>
              <Button variant="secondary" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
                {!save.isPending && <Save className="size-4" />} {dirty ? 'Save' : 'Saved'}
              </Button>
              <Button variant="secondary" onClick={() => void saveFirst().then(() => setTesting(true))}>
                <FlaskConical className="size-4" /> Test
              </Button>
              <Button onClick={() => void saveFirst().then(() => setPublishing(true))}>
                <Rocket className="size-4" /> Preview & publish
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/60">
          <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
            {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
            {seq.status === 'archived' && <Alert tone="info">This sequence is archived. Restore it from the list to edit it.</Alert>}
            <SetupCard d={d} set={set} seq={seq} refs={refs} readOnly={readOnly} />
            <StepList steps={d.draftGraph.steps} onChange={(steps) => set({ draftGraph: { steps } })} refs={refs} readOnly={readOnly} checklist={checklist} selfId={seq.id} />
          </div>
        </div>
        <ThingsLeft items={checklist} dirty={dirty} onSave={() => save.mutate()} saving={save.isPending} readOnly={readOnly} />
      </div>

      {testing && <TestDialog sequenceId={seq.id} onClose={() => setTesting(false)} />}
      {publishing && <PublishDialog seq={queryClient.getQueryData<{ sequence: SequenceDetail }>(['sequence', workspace.id, sequenceId])?.sequence ?? seq} refs={refs} onClose={() => setPublishing(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Things left

function ThingsLeft({ items, dirty, onSave, saving, readOnly }: { items: ChecklistItem[]; dirty: boolean; onSave: () => void; saving: boolean; readOnly: boolean }) {
  const ready = items.length === 0;
  const jump = (item: ChecklistItem) => {
    const el = document.getElementById(item.stepId ? `step-${item.stepId}` : `setup-${item.key}`) ?? document.getElementById('setup');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.classList.add('ring-2', 'ring-amber-300');
    window.setTimeout(() => el?.classList.remove('ring-2', 'ring-amber-300'), 1600);
  };
  return (
    <aside className="shrink-0 border-t border-slate-200 bg-white p-4 lg:w-80 lg:overflow-y-auto lg:border-t-0 lg:border-l">
      <h2 className={cn('flex items-center gap-2 text-sm font-semibold', ready ? 'text-brand-700' : 'text-ink')}>
        {ready ? <CheckCircle2 className="size-4" /> : <Circle className="size-4 text-amber-500" />}
        {ready ? 'Ready to publish' : `Things left (${items.length})`}
      </h2>
      {dirty && !readOnly && (
        <p className="mt-2 text-xs text-slate-500">
          You have unsaved changes; this list updates when you{' '}
          <button onClick={onSave} disabled={saving} className="font-medium text-brand-700 hover:underline">
            save
          </button>
          .
        </p>
      )}
      {ready ? (
        <p className="mt-2 text-sm text-slate-600">Every message has an approved template and its variables. Use Test to try it on your own number, then Preview & publish.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {items.map((item, i) => (
            <li key={i}>
              <button onClick={() => jump(item)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-amber-50">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
                <span>
                  {item.message}
                  {item.publishOnly && <span className="ml-1 text-xs text-slate-400">(needed to publish, not to test)</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Setup: who joins, filter, dates, goal, stop, rules

function Section({ id, icon: Icon, title, hint, children, defaultOpen = true }: { id: string; icon: LucideIcon; title: string; hint?: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div id={`setup-${id}`} className="rounded-lg transition-shadow">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 py-2 text-left">
        <Icon className="size-4 text-slate-400" strokeWidth={1.5} />
        <span className="text-sm font-semibold text-ink">{title}</span>
        {hint && <span className="truncate text-xs text-slate-500">{hint}</span>}
        <ChevronDown className={cn('ml-auto size-4 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="pb-3 pl-6">{children}</div>}
    </div>
  );
}

function SetupCard({ d, set, seq, refs, readOnly }: { d: Draft; set: (p: Partial<Draft>) => void; seq: SequenceDetail; refs: Refs; readOnly: boolean }) {
  const { workspace } = useWorkspace();
  const t = d.trigger;
  const setT = (p: Partial<SequenceTrigger>) => set({ trigger: { ...t, ...p } });
  const locked = seq.published;
  const usesDates = useMemo(() => JSON.stringify(d.draftGraph).includes('"wait_until_date"'), [d.draftGraph]);

  return (
    <Card className="divide-y divide-slate-100 px-5 py-2" >
      <div id="setup">
        <Section id="trigger" icon={Zap} title="Who joins" hint={locked ? undefined : 'Exactly one trigger. Only events after publishing count.'}>
          {locked ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <Lock className="size-4 text-slate-400" />
              {triggerSummary(t, { tags: refs.tags.data, lists: refs.lists.data, stages: refs.stages.data })}
              <span className="text-xs text-slate-500">
                Locked after publishing. Need a different trigger?{' '}
                <Link to={`/w/${workspace.id}/sequences`} className="text-brand-700 hover:underline">
                  Create a new sequence
                </Link>
              </span>
            </div>
          ) : (
            <TriggerEditor t={t} setT={setT} refs={refs} readOnly={readOnly} />
          )}
        </Section>
        <Section id="filter" icon={Users} title="Only these contacts" hint={d.entryFilter.length ? `${d.entryFilter.length} condition${d.entryFilter.length === 1 ? '' : 's'}` : 'Everyone (optional)'} defaultOpen={d.entryFilter.length > 0}>
          <ConditionsEditor conditions={d.entryFilter} onChange={(entryFilter) => set({ entryFilter })} refs={refs} readOnly={readOnly} kinds={['tag', 'stage', 'field']} empty="Everyone the trigger brings in joins. Add conditions to narrow it (all must match)." />
        </Section>
        <Section id="dates" icon={CalendarClock} title="Dates for reminders" hint={d.dateMode === 'none' ? 'Only relative waits' : d.dateMode === 'fixed' ? 'One date for everyone' : 'Each contact has a date'} defaultOpen={usesDates}>
          <div className="space-y-3">
            <Select aria-label="Dates for reminders" value={d.dateMode} disabled={readOnly} onChange={(e) => set({ dateMode: e.target.value as Draft['dateMode'] })} className="sm:w-80">
              <option value="none">None: only waits like "after 2 days"</option>
              <option value="fixed">One date for everyone (webinar, launch, class)</option>
              <option value="per_contact">Each contact's own date (trial end, renewal, booking)</option>
            </Select>
            {d.dateMode === 'fixed' && (
              <Field label="Event date and time" htmlFor="seq-fixed" hint="Changing it moves everyone's dated reminders.">
                <Input
                  id="seq-fixed"
                  type="datetime-local"
                  className="sm:w-64"
                  disabled={readOnly}
                  value={d.fixedDate ? toLocalInput(d.fixedDate) : ''}
                  onChange={(e) => set({ fixedDate: e.target.value ? new Date(e.target.value).toISOString() : null })}
                />
              </Field>
            )}
            {d.dateMode === 'per_contact' && (
              <Field label="Where the date comes from" htmlFor="seq-datekey" hint="A key in the data sent when they join (e.g. trial_ends_at), or a custom field.">
                <Input id="seq-datekey" list="seq-date-fields" className="sm:w-64" disabled={readOnly} placeholder="trial_ends_at" value={d.dateKey ?? ''} onChange={(e) => set({ dateKey: e.target.value.trim() || null })} />
                <datalist id="seq-date-fields">
                  {(refs.fields.data ?? []).map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </datalist>
              </Field>
            )}
            <p className="text-xs text-slate-500">Late joiners skip dated steps whose time has passed (logged). Contacts without a date skip dated steps but get the rest.</p>
          </div>
        </Section>
        <Section id="goal" icon={CheckCircle2} title="Goal" hint={d.goal.type === 'none' ? 'Recommended' : outcomeLabel(d.goal, refs)} defaultOpen={false}>
          <p className="mb-2 text-xs text-slate-500">Reaching the goal ends the sequence for that contact right away and counts as a success.</p>
          <OutcomeEditor rule={d.goal} onChange={(goal) => set({ goal })} refs={refs} readOnly={readOnly} allowNone />
        </Section>
        <Section id="stop" icon={X} title="Stop conditions" hint={d.stopConditions.length ? `${d.stopConditions.length} set` : 'None'} defaultOpen={false}>
          <div className="space-y-2">
            {d.stopConditions.map((rule, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="flex-1">
                  <OutcomeEditor rule={rule} onChange={(r) => set({ stopConditions: d.stopConditions.map((x, j) => (j === i ? r : x)) })} refs={refs} readOnly={readOnly} />
                </div>
                {!readOnly && <RemoveButton onClick={() => set({ stopConditions: d.stopConditions.filter((_, j) => j !== i) })} />}
              </div>
            ))}
            {!readOnly && d.stopConditions.length < 5 && (
              <button onClick={() => set({ stopConditions: [...d.stopConditions, { type: 'tag_added', tagIds: [], stages: [] }] })} className="text-sm font-medium text-brand-700 hover:underline">
                + Add stop condition
              </button>
            )}
            <p className="text-xs text-slate-500">Also always: every message sent, STOP/unsubscribe, or removed by hand.</p>
          </div>
        </Section>
        <Section id="rules" icon={Clock} title="Sending rules" hint="Apply to everyone, including people already inside" defaultOpen={false}>
          <RulesEditor rules={d.rules} onChange={(rules) => set({ rules })} readOnly={readOnly} />
        </Section>
      </div>
    </Card>
  );
}

function toLocalInput(iso: string) {
  const dt = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function MultiPick({ options, value, onChange, placeholder, disabled }: { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; placeholder: string; disabled?: boolean }) {
  const rest = options.filter((o) => !value.includes(o.value));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-1 text-xs font-medium text-brand-800 ring-1 ring-brand-200">
          {options.find((o) => o.value === v)?.label ?? 'Deleted'}
          {!disabled && (
            <button onClick={() => onChange(value.filter((x) => x !== v))} aria-label="Remove" className="text-brand-600 hover:text-brand-900">
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && rest.length > 0 && (
        <select aria-label={placeholder} value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} className="zc-select min-h-8 rounded-md border border-dashed border-slate-300 bg-white px-2 py-1 text-xs text-slate-600">
          <option value="">{placeholder}</option>
          {rest.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {!options.length && <span className="text-xs text-slate-400">Nothing to choose yet.</span>}
    </div>
  );
}

function TriggerEditor({ t, setT, refs, readOnly }: { t: SequenceTrigger; setT: (p: Partial<SequenceTrigger>) => void; refs: Refs; readOnly: boolean }) {
  const tagOpts = (refs.tags.data ?? []).map((x) => ({ value: x.id, label: x.name }));
  const fieldOpts = refs.fields.data ?? [];
  return (
    <div className="space-y-3">
      <div className="grid gap-1.5 sm:grid-cols-2">
        {TRIGGER_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={readOnly}
            onClick={() => setT({ type: o.value })}
            className={cn('rounded-lg border px-3 py-2 text-left transition-colors', t.type === o.value ? 'border-brand-500 bg-brand-50/70' : 'border-slate-200 bg-white hover:border-slate-300')}
          >
            <span className="block text-sm font-medium text-ink">{o.label}</span>
            <span className="block text-xs text-slate-500">{o.hint}</span>
          </button>
        ))}
      </div>
      {t.type === 'tag_added' && <MultiPick options={tagOpts} value={t.tagIds} onChange={(tagIds) => setT({ tagIds })} placeholder="+ Choose tag" disabled={readOnly} />}
      {t.type === 'lifecycle_changed' && <MultiPick options={(refs.stages.data ?? []).map((s) => ({ value: s.key, label: s.name }))} value={t.stages} onChange={(stages) => setT({ stages })} placeholder="+ Choose stage" disabled={readOnly} />}
      {t.type === 'list_added' && <MultiPick options={(refs.lists.data ?? []).map((l) => ({ value: l.id, label: l.name }))} value={t.listIds} onChange={(listIds) => setT({ listIds })} placeholder="+ Choose list" disabled={readOnly} />}
      {t.type === 'new_contact' && (
        <div>
          <MultiPick options={NEW_CONTACT_SOURCES} value={t.sources} onChange={(sources) => setT({ sources })} placeholder="+ Only from…" disabled={readOnly} />
          <p className="mt-1 text-xs text-slate-500">Leave empty for any source.</p>
        </div>
      )}
      {(t.type === 'field_changed' || t.type === 'date_field') && (
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Custom field" list="seq-trigger-fields" className="w-56" placeholder="Custom field key" disabled={readOnly} value={t.fieldKey ?? ''} onChange={(e) => setT({ fieldKey: e.target.value.trim() || null })} />
          <datalist id="seq-trigger-fields">
            {fieldOpts
              .filter((f) => t.type !== 'date_field' || f.type === 'date' || f.type === 'text')
              .map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
          </datalist>
          {t.type === 'field_changed' && (
            <>
              <Select aria-label="When" className="w-40" disabled={readOnly} value={t.fieldOp} onChange={(e) => setT({ fieldOp: e.target.value as 'any' | 'equals' })}>
                <option value="any">gets any value</option>
                <option value="equals">becomes</option>
              </Select>
              {t.fieldOp === 'equals' && <Input aria-label="Value" className="w-40" disabled={readOnly} value={t.fieldValue ?? ''} onChange={(e) => setT({ fieldValue: e.target.value })} />}
            </>
          )}
        </div>
      )}
      {t.type === 'date_field' && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {t.direction !== 'on' && <Input aria-label="Days" type="number" min={0} max={365} className="w-20" disabled={readOnly} value={t.offsetDays} onChange={(e) => setT({ offsetDays: Math.max(0, Number(e.target.value) || 0) })} />}
          <Select aria-label="Before, on or after" className="w-36" disabled={readOnly} value={t.direction} onChange={(e) => setT({ direction: e.target.value as SequenceTrigger['direction'] })}>
            <option value="before">days before</option>
            <option value="on">on the day</option>
            <option value="after">days after</option>
          </Select>
          <span className="text-slate-500">at</span>
          <Input aria-label="Time" type="time" className="w-32" disabled={readOnly} value={t.time} onChange={(e) => setT({ time: e.target.value })} />
          <LabeledToggle label="Every year" checked={t.repeatYearly} disabled={readOnly} onChange={(repeatYearly) => setT({ repeatYearly })} />
        </div>
      )}
      {t.type === 'inactive' && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-600">No message from them for</span>
          <Input aria-label="Days" type="number" min={1} max={365} className="w-20" disabled={readOnly} value={t.days} onChange={(e) => setT({ days: Math.max(1, Number(e.target.value) || 1) })} />
          <span className="text-slate-600">days</span>
        </div>
      )}
    </div>
  );
}

const OUTCOME_TYPES = [
  { value: 'replied', label: 'Contact replied' },
  { value: 'tag_added', label: 'Has the tag' },
  { value: 'lifecycle', label: 'Reaches the stage' },
] as const;

function outcomeLabel(r: SeqOutcomeRule, refs: Refs) {
  if (r.type === 'replied') return 'Contact replied';
  if (r.type === 'tag_added') return `Tag ${r.tagIds.map((id) => refs.tags.data?.find((t) => t.id === id)?.name ?? '?').join(', ') || '…'}`;
  if (r.type === 'lifecycle') return `Stage ${r.stages.map((k) => refs.stages.data?.find((s) => s.key === k)?.name ?? k).join(', ') || '…'}`;
  return 'None';
}

function OutcomeEditor({ rule, onChange, refs, readOnly, allowNone }: { rule: SeqOutcomeRule; onChange: (r: SeqOutcomeRule) => void; refs: Refs; readOnly: boolean; allowNone?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label="Type" className="w-48" disabled={readOnly} value={rule.type} onChange={(e) => onChange({ ...rule, type: e.target.value as SeqOutcomeRule['type'] })}>
        {allowNone && <option value="none">No goal</option>}
        {OUTCOME_TYPES.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      {rule.type === 'tag_added' && <MultiPick options={(refs.tags.data ?? []).map((t) => ({ value: t.id, label: t.name }))} value={rule.tagIds} onChange={(tagIds) => onChange({ ...rule, tagIds })} placeholder="+ Tag" disabled={readOnly} />}
      {rule.type === 'lifecycle' && <MultiPick options={(refs.stages.data ?? []).map((s) => ({ value: s.key, label: s.name }))} value={rule.stages} onChange={(stages) => onChange({ ...rule, stages })} placeholder="+ Stage" disabled={readOnly} />}
    </div>
  );
}

type CondKind = SeqCondition['kind'];
const FIELD_OPS = [
  { value: 'equals', label: 'is' },
  { value: 'not_equals', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'is_set', label: 'has a value' },
  { value: 'not_set', label: 'is empty' },
];

function blankCondition(kind: CondKind): SeqCondition {
  switch (kind) {
    case 'tag':
      return { kind, op: 'has', tagId: '' };
    case 'stage':
      return { kind, op: 'is', stage: '' };
    case 'field':
    case 'data':
      return { kind, key: '', op: 'equals', value: '' };
    case 'last_message':
      return { kind, op: 'read' };
    case 'replied':
      return { kind, op: 'replied', value: '' };
    case 'split':
      return { kind, percent: 50 };
  }
}

function ConditionsEditor({ conditions, onChange, refs, readOnly, kinds, empty }: { conditions: SeqCondition[]; onChange: (c: SeqCondition[]) => void; refs: Refs; readOnly: boolean; kinds: CondKind[]; empty: string }) {
  const labels: Record<CondKind, string> = { tag: 'Tag', stage: 'Lifecycle stage', field: 'Custom field', data: 'Joined-with data', last_message: 'Last message', replied: 'Reply', split: 'Split test' };
  const update = (i: number, c: SeqCondition) => onChange(conditions.map((x, j) => (j === i ? c : x)));
  return (
    <div className="space-y-2">
      {!conditions.length && <p className="text-xs text-slate-500">{empty}</p>}
      {conditions.map((c, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          {i > 0 && <span className="text-xs font-medium text-slate-400">AND</span>}
          <Select aria-label="Condition" className="w-40" disabled={readOnly} value={c.kind} onChange={(e) => update(i, blankCondition(e.target.value as CondKind))}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {labels[k]}
              </option>
            ))}
          </Select>
          {c.kind === 'tag' && (
            <>
              <Select aria-label="Has" className="w-36" disabled={readOnly} value={c.op} onChange={(e) => update(i, { ...c, op: e.target.value as 'has' | 'not_has' })}>
                <option value="has">has</option>
                <option value="not_has">doesn't have</option>
              </Select>
              <Select aria-label="Tag" className="w-44" disabled={readOnly} value={c.tagId} onChange={(e) => update(i, { ...c, tagId: e.target.value })}>
                <option value="">Choose tag…</option>
                {(refs.tags.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </>
          )}
          {c.kind === 'stage' && (
            <>
              <Select aria-label="Is" className="w-28" disabled={readOnly} value={c.op} onChange={(e) => update(i, { ...c, op: e.target.value as 'is' | 'is_not' })}>
                <option value="is">is</option>
                <option value="is_not">is not</option>
              </Select>
              <Select aria-label="Stage" className="w-44" disabled={readOnly} value={c.stage} onChange={(e) => update(i, { ...c, stage: e.target.value })}>
                <option value="">Choose stage…</option>
                {(refs.stages.data ?? []).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </>
          )}
          {(c.kind === 'field' || c.kind === 'data') && (
            <>
              <Input aria-label="Key" className="w-36" list={c.kind === 'field' ? 'seq-cond-fields' : undefined} placeholder={c.kind === 'field' ? 'field key' : 'data key'} disabled={readOnly} value={c.key} onChange={(e) => update(i, { ...c, key: e.target.value.trim() })} />
              <Select aria-label="Operator" className="w-36" disabled={readOnly} value={c.op} onChange={(e) => update(i, { ...c, op: e.target.value as typeof c.op })}>
                {FIELD_OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              {!['is_set', 'not_set'].includes(c.op) && <Input aria-label="Value" className="w-36" disabled={readOnly} value={c.value} onChange={(e) => update(i, { ...c, value: e.target.value })} />}
            </>
          )}
          {c.kind === 'last_message' && (
            <Select aria-label="Last message" className="w-56" disabled={readOnly} value={c.op} onChange={(e) => update(i, { ...c, op: e.target.value as typeof c.op })}>
              <option value="read">was read</option>
              <option value="delivered">was delivered</option>
              <option value="not_read">was not read</option>
            </Select>
          )}
          {c.kind === 'replied' && (
            <>
              <Select aria-label="Reply" className="w-44" disabled={readOnly} value={c.op} onChange={(e) => update(i, { ...c, op: e.target.value as typeof c.op })}>
                <option value="replied">has replied</option>
                <option value="not_replied">has not replied</option>
                <option value="contains">reply contains</option>
              </Select>
              {c.op === 'contains' && <Input aria-label="Words" className="w-40" disabled={readOnly} placeholder="yes, book" value={c.value} onChange={(e) => update(i, { ...c, value: e.target.value })} />}
            </>
          )}
          {c.kind === 'split' && (
            <span className="flex items-center gap-1.5 text-sm text-slate-600">
              first
              <Input aria-label="Percent" type="number" min={1} max={99} className="w-20" disabled={readOnly} value={c.percent} onChange={(e) => update(i, { ...c, percent: Math.min(99, Math.max(1, Number(e.target.value) || 1)) })} />% of contacts
            </span>
          )}
          {!readOnly && <RemoveButton onClick={() => onChange(conditions.filter((_, j) => j !== i))} />}
        </div>
      ))}
      <datalist id="seq-cond-fields">
        {(refs.fields.data ?? []).map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </datalist>
      {!readOnly && conditions.length < 10 && (
        <button onClick={() => onChange([...conditions, blankCondition(kinds[0]!)])} className="text-sm font-medium text-brand-700 hover:underline">
          + Add condition
        </button>
      )}
    </div>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function RulesEditor({ rules, onChange, readOnly }: { rules: SequenceRules; onChange: (r: SequenceRules) => void; readOnly: boolean }) {
  const set = (p: Partial<SequenceRules>) => onChange({ ...rules, ...p });
  return (
    <div className="space-y-3 text-sm">
      <RuleRow label="Join only once" hint={rules.joinOnce ? 'Each contact joins one time.' : 'They can join again after a cool-down.'}>
        <Toggle label="Join only once" checked={rules.joinOnce} disabled={readOnly} onChange={(joinOnce) => set({ joinOnce })} />
        {!rules.joinOnce && (
          <span className="flex items-center gap-1.5 text-slate-600">
            after <Input aria-label="Cool-down days" type="number" min={0} className="w-20" disabled={readOnly} value={rules.reentryDays} onChange={(e) => set({ reentryDays: Math.max(0, Number(e.target.value) || 0) })} /> days
          </span>
        )}
      </RuleRow>
      <RuleRow label="Stop adding after" hint="A safety cap on how many contacts can ever join.">
        <Toggle label="Cap enrollments" checked={rules.maxEnrollments !== null} disabled={readOnly} onChange={(on) => set({ maxEnrollments: on ? 1000 : null })} />
        {rules.maxEnrollments !== null && <Input aria-label="Max contacts" type="number" min={1} className="w-28" disabled={readOnly} value={rules.maxEnrollments} onChange={(e) => set({ maxEnrollments: Math.max(1, Number(e.target.value) || 1) })} />}
      </RuleRow>
      <RuleRow label="Stop when contact replies" hint="Turn off to branch on replies.">
        <Toggle label="Stop when contact replies" checked={rules.stopOnReply} disabled={readOnly} onChange={(stopOnReply) => set({ stopOnReply })} />
      </RuleRow>
      <RuleRow label="Do not send at night" hint="Due messages wait until the window opens.">
        <Toggle label="Quiet hours" checked={rules.quietHours.enabled} disabled={readOnly} onChange={(enabled) => set({ quietHours: { ...rules.quietHours, enabled } })} />
        {rules.quietHours.enabled && (
          <span className="flex items-center gap-1.5 text-slate-600">
            <Input aria-label="Quiet from" type="time" className="w-28" disabled={readOnly} value={rules.quietHours.start} onChange={(e) => set({ quietHours: { ...rules.quietHours, start: e.target.value } })} /> to
            <Input aria-label="Quiet until" type="time" className="w-28" disabled={readOnly} value={rules.quietHours.end} onChange={(e) => set({ quietHours: { ...rules.quietHours, end: e.target.value } })} />
          </span>
        )}
      </RuleRow>
      <RuleRow label="Only send on">
        <div className="flex flex-wrap gap-1">
          {DAYS.map((label, i) => {
            const day = i + 1;
            const on = rules.days.includes(day);
            return (
              <button
                key={label}
                type="button"
                disabled={readOnly || (on && rules.days.length === 1)}
                onClick={() => set({ days: on ? rules.days.filter((x) => x !== day) : [...rules.days, day].sort() })}
                className={cn('rounded-md px-2 py-1 text-xs font-medium ring-1', on ? 'bg-brand-50 text-brand-800 ring-brand-200' : 'bg-white text-slate-500 ring-slate-200')}
              >
                {label}
              </button>
            );
          })}
        </div>
      </RuleRow>
      <RuleRow label="Timezone" hint='"Contact" uses a "timezone" custom field when it has one.'>
        <Select aria-label="Timezone" className="w-56" disabled={readOnly} value={rules.timezone} onChange={(e) => set({ timezone: e.target.value as SequenceRules['timezone'] })}>
          <option value="workspace">Workspace timezone</option>
          <option value="contact">Contact's timezone</option>
        </Select>
      </RuleRow>
      <RuleRow label="Send next only after delivered" hint="If a message fails or is not delivered in 48 h, the contact leaves.">
        <Toggle label="Send next only after delivered" checked={rules.sendAfterDelivered} disabled={readOnly} onChange={(sendAfterDelivered) => set({ sendAfterDelivered })} />
      </RuleRow>
      <RuleRow label="Retry when WhatsApp holds back" hint="On error 131049, try once more about 4 hours later.">
        <Toggle label="Retry when WhatsApp holds back" checked={rules.retryEcosystemLimit} disabled={readOnly} onChange={(retryEcosystemLimit) => set({ retryEcosystemLimit })} />
      </RuleRow>
      <RuleRow label="Max per contact per day" hint="Across all sequences; extra messages move to the next day.">
        <Input aria-label="Max per day" type="number" min={1} max={20} className="w-20" disabled={readOnly} value={rules.maxPerContactPerDay} onChange={(e) => set({ maxPerContactPerDay: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })} />
      </RuleRow>
    </div>
  );
}

function RuleRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-slate-100 pb-3 last:border-0 last:pb-0">
      <div className="min-w-0">
        <p className="font-medium text-slate-800">{label}</p>
        {hint && <p className="text-xs text-slate-500">{hint}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function LabeledToggle(props: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-700">
      <Toggle {...props} />
      <span onClick={() => !props.disabled && props.onChange(!props.checked)} className="cursor-pointer select-none">
        {props.label}
      </span>
    </span>
  );
}

function RemoveButton({ onClick, label = 'Remove' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick} className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={label} title={label}>
      <Trash2 className="size-4" strokeWidth={1.5} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Steps

type AddType = 'message' | 'wait' | 'wait_until_date' | 'action' | 'branch';
const ADD_OPTIONS: { type: AddType; label: string; icon: LucideIcon; hint?: string }[] = [
  { type: 'message', label: 'Message', icon: MessageSquare },
  { type: 'wait', label: 'Wait', icon: Clock },
  { type: 'wait_until_date', label: 'Wait until date', icon: CalendarClock },
  { type: 'action', label: 'Action', icon: Zap },
  { type: 'branch', label: 'Branch', icon: GitBranch, hint: 'Different steps for different contacts' },
];
/** A branch may sit inside one other branch at most. */
const MAX_BRANCH_DEPTH = 2;

function newStep(type: AddType): SeqStep {
  if (type === 'branch') {
    return {
      id: newStepId('b'),
      type: 'branch',
      ways: [
        { id: newStepId('y'), label: 'Way 1', conditions: [{ kind: 'tag', op: 'has', tagId: '' }], steps: [] },
        { id: newStepId('y'), label: 'Everyone else', conditions: [], steps: [] },
      ],
    };
  }
  if (type === 'message') return { id: newStepId('m'), type, note: '', templateId: null, headerVariables: [], bodyVariables: [], mediaUrl: null, filter: [], freeIfWindowOpen: false };
  if (type === 'wait') return { id: newStepId('w'), type, amount: 1, unit: 'days' };
  if (type === 'wait_until_date') return { id: newStepId('d'), type, offsetDays: -1, time: '10:00' };
  return { id: newStepId('a'), type: 'action', action: 'add_tag', tagId: '' };
}

interface ListCtx {
  timing: Map<string, string>;
  numbers: Map<string, number>;
  checklist: ChecklistItem[];
  refs: Refs;
  readOnly: boolean;
  selfId: string;
}

function StepList({ steps, onChange, refs, readOnly, checklist, selfId }: { steps: SeqStep[]; onChange: (s: SeqStep[]) => void; refs: Refs; readOnly: boolean; checklist: ChecklistItem[]; selfId: string }) {
  const ctx: ListCtx = { timing: timingLabels(steps), numbers: messageNumbers(steps), checklist, refs, readOnly, selfId };
  return (
    <div>
      <Steps steps={steps} onChange={onChange} ctx={ctx} depth={0} />
      <div className="flex items-center justify-center gap-2 py-2 text-xs font-medium text-slate-400">
        <span className="h-px w-10 bg-slate-200" /> Done: the contact has had every message <span className="h-px w-10 bg-slate-200" />
      </div>
    </div>
  );
}

/** One list of steps (the main path, or one way of a branch). */
function Steps({ steps, onChange, ctx, depth }: { steps: SeqStep[]; onChange: (s: SeqStep[]) => void; ctx: ListCtx; depth: number }) {
  const { readOnly } = ctx;
  const allowBranch = depth < MAX_BRANCH_DEPTH;
  const insert = (at: number, type: AddType) => onChange([...steps.slice(0, at), newStep(type), ...steps.slice(at)]);
  const move = (i: number, by: number) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s!);
    onChange(next);
  };
  return (
    <div>
      {!readOnly && <AddStep onAdd={(t) => insert(0, t)} first={!steps.length} firstLabel={depth === 0 ? 'Add the first step' : 'Add a step to this way'} allowBranch={allowBranch} />}
      {readOnly && !steps.length && depth > 0 && <p className="py-2 text-center text-xs text-slate-400">No steps: goes straight on</p>}
      {steps.map((step, i) => (
        <div key={step.id}>
          <StepCard
            step={step}
            index={ctx.numbers.get(step.id) ?? null}
            timing={ctx.timing.get(step.id) ?? null}
            problems={ctx.checklist.filter((c) => c.stepId === step.id)}
            onChange={(s) => onChange(steps.map((x) => (x.id === step.id ? s : x)))}
            onRemove={() => onChange(steps.filter((x) => x.id !== step.id))}
            onMove={(by) => move(i, by)}
            canUp={i > 0}
            canDown={i < steps.length - 1}
            refs={ctx.refs}
            readOnly={readOnly}
            selfId={ctx.selfId}
            ctx={ctx}
            depth={depth}
          />
          {!readOnly ? <AddStep onAdd={(t) => insert(i + 1, t)} allowBranch={allowBranch} /> : <Connector />}
        </div>
      ))}
    </div>
  );
}

const Connector = () => <div className="mx-auto h-5 w-px bg-slate-300" />;

function AddStep({ onAdd, first, firstLabel = 'Add the first step', allowBranch = true }: { onAdd: (t: AddType) => void; first?: boolean; firstLabel?: string; allowBranch?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative flex flex-col items-center">
      <div className="h-3 w-px bg-slate-300" />
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn('flex items-center gap-1 rounded-full border border-slate-300 bg-white text-slate-500 shadow-sm hover:border-brand-500 hover:text-brand-700', first ? 'px-3 py-1.5 text-sm font-medium' : 'p-1')}
        aria-label="Add a step"
      >
        <Plus className="size-4" />
        {first && firstLabel}
      </button>
      <div className="h-3 w-px bg-slate-300" />
      {open && (
        <div className="absolute top-9 z-20 w-52 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
          {ADD_OPTIONS.filter((o) => allowBranch || o.type !== 'branch').map((o) => (
            <button
              key={o.type}
              type="button"
              onClick={() => {
                onAdd(o.type);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
            >
              <o.icon className="size-4 shrink-0 text-slate-400" strokeWidth={1.5} />
              <span>
                {o.label}
                {o.hint && <span className="block text-xs text-slate-400">{o.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const STEP_META: Record<SeqStep['type'], { icon: LucideIcon; tone: string; title: string }> = {
  message: { icon: MessageSquare, tone: 'bg-brand-50 text-brand-700', title: 'Message' },
  wait: { icon: Clock, tone: 'bg-slate-100 text-slate-600', title: 'Wait' },
  wait_until_date: { icon: CalendarClock, tone: 'bg-sky-50 text-sky-700', title: 'Wait until date' },
  action: { icon: Zap, tone: 'bg-amber-50 text-amber-700', title: 'Action' },
  branch: { icon: GitBranch, tone: 'bg-violet-50 text-violet-700', title: 'Branch' },
};

function StepCard({
  step,
  index,
  timing,
  problems,
  onChange,
  onRemove,
  onMove,
  canUp,
  canDown,
  refs,
  readOnly,
  selfId,
  ctx,
  depth,
}: {
  ctx: ListCtx;
  depth: number;
  step: SeqStep;
  index: number | null;
  timing: string | null;
  problems: ChecklistItem[];
  onChange: (s: SeqStep) => void;
  onRemove: () => void;
  onMove: (by: number) => void;
  canUp: boolean;
  canDown: boolean;
  refs: Refs;
  readOnly: boolean;
  selfId: string;
}) {
  const meta = STEP_META[step.type];
  return (
    <Card className={cn('scroll-mt-24 transition-shadow', problems.length > 0 && 'border-amber-300')}>
      <div id={`step-${step.id}`} className="rounded-xl transition-shadow">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
          <span className={cn('rounded-md p-1.5', meta.tone)}>
            <meta.icon className="size-4" strokeWidth={1.5} />
          </span>
          <span className="text-sm font-semibold text-ink">
            {meta.title}
            {index !== null && ` ${index}`}
          </span>
          {timing && step.type !== 'wait' && step.type !== 'wait_until_date' && <Badge tone="gray">{timing}</Badge>}
          {!readOnly && (
            <div className="ml-auto flex items-center">
              <IconBtn icon={ArrowUp} label="Move up" disabled={!canUp} onClick={() => onMove(-1)} />
              <IconBtn icon={ArrowDown} label="Move down" disabled={!canDown} onClick={() => onMove(1)} />
              <RemoveButton onClick={onRemove} label="Delete step" />
            </div>
          )}
        </div>
        <div className="px-4 py-3">
          {step.type === 'message' && <MessageEditor step={step} onChange={onChange} refs={refs} readOnly={readOnly} />}
          {step.type === 'wait' && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-slate-600">Wait</span>
              <Input aria-label="Amount" type="number" min={1} className="w-20" disabled={readOnly} value={step.amount} onChange={(e) => onChange({ ...step, amount: Math.max(1, Number(e.target.value) || 1) })} />
              <Select aria-label="Unit" className="w-32" disabled={readOnly} value={step.unit} onChange={(e) => onChange({ ...step, unit: e.target.value as typeof step.unit })}>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
                <option value="weeks">weeks</option>
              </Select>
            </div>
          )}
          {step.type === 'wait_until_date' && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {step.offsetDays !== 0 && <Input aria-label="Days" type="number" min={1} max={365} className="w-20" disabled={readOnly} value={Math.abs(step.offsetDays)} onChange={(e) => onChange({ ...step, offsetDays: Math.sign(step.offsetDays) * Math.max(1, Number(e.target.value) || 1) })} />}
              <Select
                aria-label="Before, on or after"
                className="w-40"
                disabled={readOnly}
                value={step.offsetDays < 0 ? 'before' : step.offsetDays > 0 ? 'after' : 'on'}
                onChange={(e) => {
                  const n = Math.abs(step.offsetDays) || 1;
                  onChange({ ...step, offsetDays: e.target.value === 'before' ? -n : e.target.value === 'after' ? n : 0 });
                }}
              >
                <option value="before">days before</option>
                <option value="on">on the day</option>
                <option value="after">days after</option>
              </Select>
              <span className="text-slate-600">the reminder date, at</span>
              <Input aria-label="Time" type="time" className="w-32" disabled={readOnly} value={step.time} onChange={(e) => onChange({ ...step, time: e.target.value })} />
            </div>
          )}
          {step.type === 'action' && <ActionEditor step={step} onChange={onChange} refs={refs} readOnly={readOnly} selfId={selfId} />}
          {step.type === 'branch' && <BranchEditor step={step} onChange={onChange} ctx={ctx} depth={depth} />}
          {problems.length > 0 && (
            <ul className="mt-3 space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {problems.map((p, i) => (
                <li key={i}>{p.message}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

const WAY_COLORS = ['border-violet-400', 'border-sky-400', 'border-amber-400', 'border-emerald-400', 'border-rose-400'];
const BRANCH_KINDS: CondKind[] = ['tag', 'stage', 'field', 'data', 'last_message', 'replied', 'split'];

/**
 * Ways are checked top to bottom; the first that matches wins. The last way is
 * always "Everyone else". After any way, contacts continue with the step below the branch.
 */
function BranchEditor({ step, onChange, ctx, depth }: { step: Extract<SeqStep, { type: 'branch' }>; onChange: (s: SeqStep) => void; ctx: ListCtx; depth: number }) {
  const { readOnly, refs } = ctx;
  const ways = step.ways;
  const setWay = (i: number, patch: Partial<(typeof ways)[number]>) => onChange({ ...step, ways: ways.map((w, j) => (j === i ? { ...w, ...patch } : w)) });
  const addWay = () => {
    const at = ways.length - 1;
    const way = { id: newStepId('y'), label: `Way ${at + 1}`, conditions: [{ kind: 'tag', op: 'has', tagId: '' } as SeqCondition], steps: [] };
    onChange({ ...step, ways: [...ways.slice(0, at), way, ways[at]!] });
  };
  const removeWay = (i: number) => onChange({ ...step, ways: ways.filter((_, j) => j !== i) });
  const splitUsed = ways.some((w) => w.conditions.some((c) => c.kind === 'split'));
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">Ways are checked from the top; a contact takes the first one that matches. Afterwards everyone continues with the step below the branch.</p>
      {ways.map((way, i) => {
        const last = i === ways.length - 1;
        return (
          <div key={way.id} className={cn('rounded-lg border-l-4 bg-slate-50/70 py-3 pr-3 pl-4', WAY_COLORS[i % WAY_COLORS.length])}>
            <div className="mb-2 flex items-center gap-2">
              <Input aria-label="Way name" className="h-8 max-w-56 bg-white text-sm font-medium" maxLength={60} disabled={readOnly} value={way.label} onChange={(e) => setWay(i, { label: e.target.value })} />
              {!last && !readOnly && ways.length > 2 && <RemoveButton onClick={() => removeWay(i)} label="Remove way" />}
            </div>
            {last ? (
              <p className="mb-1 text-xs text-slate-500">Everyone else: contacts that match none of the ways above.</p>
            ) : (
              <div className="mb-1">
                <ConditionsEditor conditions={way.conditions} onChange={(conditions) => setWay(i, { conditions })} refs={refs} readOnly={readOnly} kinds={BRANCH_KINDS} empty="Add at least one condition (all must match)." />
              </div>
            )}
            <Steps steps={way.steps} onChange={(steps) => setWay(i, { steps })} ctx={ctx} depth={depth + 1} />
          </div>
        );
      })}
      {!readOnly && ways.length < 5 && (
        <button type="button" onClick={addWay} className="text-sm font-medium text-brand-700 hover:underline">
          + Add a way
        </button>
      )}
      {splitUsed && <p className="text-xs text-slate-500">Split tests count from the top: one way with "first 50%" plus Everyone else splits half and half; "first 33%", "first 66%", then Everyone else splits in three. Each contact always lands in the same way.</p>}
    </div>
  );
}

function IconBtn({ icon: Icon, label, onClick, disabled }: { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30" aria-label={label} title={label}>
      <Icon className="size-4" strokeWidth={1.5} />
    </button>
  );
}

const VAR_SOURCES = [
  { value: 'contact', label: 'Contact' },
  { value: 'field', label: 'Custom field' },
  { value: 'data', label: 'Joined-with data' },
  { value: 'today', label: "Today's date" },
  { value: 'text', label: 'Fixed text' },
] as const;
const CONTACT_VALUES = [
  { value: 'first_name', label: 'First name' },
  { value: 'name', label: 'Full name' },
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
];

function sample(v: SeqVariable): string {
  if (v.source === 'contact') return v.value === 'phone' ? '+91 98765 43210' : v.value === 'email' ? 'ravi@example.com' : v.value === 'name' ? 'Ravi Kumar' : 'Ravi';
  if (v.source === 'today') return new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  if (v.source === 'text') return v.value || '…';
  return v.value ? `{${v.value}}` : '…';
}

function MessageEditor({ step, onChange, refs, readOnly }: { step: MessageStepT; onChange: (s: SeqStep) => void; refs: Refs; readOnly: boolean }) {
  const { workspace } = useWorkspace();
  const templates = refs.templates.data ?? [];
  const template = templates.find((t) => t.id === step.templateId) ?? null;
  const pickTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    const fit = (current: SeqVariable[], n: number): SeqVariable[] => Array.from({ length: n }, (_, i): SeqVariable => current[i] ?? (i === 0 ? { source: 'contact', value: 'first_name', fallback: 'there' } : { source: 'text', value: '', fallback: '' }));
    onChange({ ...step, templateId: id || null, headerVariables: fit(step.headerVariables, t?.variables.header ?? 0), bodyVariables: fit(step.bodyVariables, t?.variables.body ?? 0) });
  };
  const setVar = (part: 'headerVariables' | 'bodyVariables', i: number, v: SeqVariable) => onChange({ ...step, [part]: step[part].map((x, j) => (j === i ? v : x)) });

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_15rem]">
      <div className="space-y-3">
        <Field label="Note (only you see it)" htmlFor={`note-${step.id}`}>
          <Input id={`note-${step.id}`} maxLength={120} disabled={readOnly} placeholder="e.g. Welcome" value={step.note} onChange={(e) => onChange({ ...step, note: e.target.value })} />
        </Field>
        <Field label="Template" htmlFor={`tpl-${step.id}`} hint={templates.length ? 'Approved Marketing or Utility templates.' : undefined}>
          <Select id={`tpl-${step.id}`} disabled={readOnly} value={step.templateId ?? ''} onChange={(e) => pickTemplate(e.target.value)}>
            <option value="">Choose a template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.language}, {t.category.toLowerCase()})
              </option>
            ))}
            {step.templateId && !template && <option value={step.templateId}>Template not available</option>}
          </Select>
        </Field>
        {!refs.templates.isPending && !templates.length && (
          <p className="text-xs text-amber-700">
            No approved Marketing or Utility template yet.{' '}
            <Link to={`/w/${workspace.id}/templates/new`} className="font-medium underline">
              Create one in Templates
            </Link>
            .
          </p>
        )}
        {template && [...step.headerVariables, ...step.bodyVariables].length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-500">Variables</p>
            {(['headerVariables', 'bodyVariables'] as const).map((part) =>
              step[part].map((v, i) => (
                <div key={`${part}-${i}`} className="flex flex-wrap items-center gap-1.5">
                  <span className="w-14 shrink-0 font-mono text-xs text-slate-500">{part === 'headerVariables' ? 'Header' : `{{${i + 1}}}`}</span>
                  <Select aria-label="Source" className="w-36" disabled={readOnly} value={v.source} onChange={(e) => setVar(part, i, { ...v, source: e.target.value as SeqVariable['source'], value: e.target.value === 'contact' ? 'first_name' : '' })}>
                    {VAR_SOURCES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                  {v.source === 'contact' && (
                    <Select aria-label="Contact value" className="w-32" disabled={readOnly} value={v.value} onChange={(e) => setVar(part, i, { ...v, value: e.target.value })}>
                      {CONTACT_VALUES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  )}
                  {v.source === 'field' && (
                    <Select aria-label="Field" className="w-36" disabled={readOnly} value={v.value} onChange={(e) => setVar(part, i, { ...v, value: e.target.value })}>
                      <option value="">Choose…</option>
                      {(refs.fields.data ?? []).map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </Select>
                  )}
                  {(v.source === 'data' || v.source === 'text') && (
                    <Input aria-label="Value" className="w-36" disabled={readOnly} placeholder={v.source === 'data' ? 'order_no' : 'Text'} value={v.value} onChange={(e) => setVar(part, i, { ...v, value: e.target.value })} />
                  )}
                  {v.source !== 'text' && v.source !== 'today' && (
                    <Input aria-label="Fallback" className="w-28" disabled={readOnly} placeholder="Fallback" value={v.fallback} onChange={(e) => setVar(part, i, { ...v, fallback: e.target.value })} />
                  )}
                </div>
              )),
            )}
            <p className="text-xs text-slate-500">If a value is empty and has no fallback, that contact stops with an error.</p>
          </div>
        )}
        {template?.requirements.headerMedia && (
          <Field label={`Header ${template.requirements.headerMedia.toLowerCase()} link`} htmlFor={`media-${step.id}`} hint="A public https link sent with every message.">
            <Input id={`media-${step.id}`} type="url" disabled={readOnly} placeholder="https://…" value={step.mediaUrl ?? ''} onChange={(e) => onChange({ ...step, mediaUrl: e.target.value.trim() || null })} />
          </Field>
        )}
        <LabeledToggle label="Use a free message if the 24-hour window is open" checked={step.freeIfWindowOpen} disabled={readOnly} onChange={(freeIfWindowOpen) => onChange({ ...step, freeIfWindowOpen })} />
        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-medium text-slate-500">Only send to some contacts{step.filter.length ? ` (${step.filter.length})` : ''}</summary>
          <div className="mt-2">
            <ConditionsEditor conditions={step.filter} onChange={(filter) => onChange({ ...step, filter })} refs={refs} readOnly={readOnly} kinds={['tag', 'stage', 'field', 'data']} empty="Everyone gets this message. Contacts that don't match a filter skip it and move on." />
          </div>
        </details>
      </div>
      <div>
        {template ? (
          <TemplatePreview components={template.components} headerParams={step.headerVariables.map(sample)} bodyParams={step.bodyVariables.map(sample)} />
        ) : (
          <div className="flex h-full min-h-28 items-center justify-center rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">Choose a template to see the preview</div>
        )}
      </div>
    </div>
  );
}

const ACTIONS: { value: ActionStepT['action']; label: string }[] = [
  { value: 'add_tag', label: 'Add a tag' },
  { value: 'remove_tag', label: 'Remove a tag' },
  { value: 'set_lifecycle', label: 'Set lifecycle stage' },
  { value: 'add_to_list', label: 'Add to a contact list' },
  { value: 'start_sequence', label: 'Start another sequence' },
  { value: 'assign_chat', label: 'Assign the chat' },
  { value: 'webhook', label: 'Send a webhook' },
];

function blankAction(id: string, action: ActionStepT['action']): SeqStep {
  switch (action) {
    case 'add_tag':
    case 'remove_tag':
      return { id, type: 'action', action, tagId: '' };
    case 'set_lifecycle':
      return { id, type: 'action', action, stage: '' };
    case 'add_to_list':
      return { id, type: 'action', action, listId: '' };
    case 'start_sequence':
      return { id, type: 'action', action, sequenceId: '' };
    case 'assign_chat':
      return { id, type: 'action', action, userId: null };
    case 'webhook':
      return { id, type: 'action', action, url: '', secret: null };
  }
}

function ActionEditor({ step, onChange, refs, readOnly, selfId }: { step: ActionStepT; onChange: (s: SeqStep) => void; refs: Refs; readOnly: boolean; selfId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Select aria-label="Action" className="w-52" disabled={readOnly} value={step.action} onChange={(e) => onChange(blankAction(step.id, e.target.value as ActionStepT['action']))}>
        {ACTIONS.map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </Select>
      {(step.action === 'add_tag' || step.action === 'remove_tag') && (
        <Select aria-label="Tag" className="w-48" disabled={readOnly} value={step.tagId} onChange={(e) => onChange({ ...step, tagId: e.target.value })}>
          <option value="">Choose tag…</option>
          {(refs.tags.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      )}
      {step.action === 'set_lifecycle' && (
        <Select aria-label="Stage" className="w-48" disabled={readOnly} value={step.stage} onChange={(e) => onChange({ ...step, stage: e.target.value })}>
          <option value="">Choose stage…</option>
          {(refs.stages.data ?? []).map((s) => (
            <option key={s.key} value={s.key}>
              {s.name}
            </option>
          ))}
        </Select>
      )}
      {step.action === 'add_to_list' && (
        <Select aria-label="List" className="w-48" disabled={readOnly} value={step.listId} onChange={(e) => onChange({ ...step, listId: e.target.value })}>
          <option value="">Choose list…</option>
          {(refs.lists.data ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      )}
      {step.action === 'start_sequence' && (
        <Select aria-label="Sequence" className="w-56" disabled={readOnly} value={step.sequenceId} onChange={(e) => onChange({ ...step, sequenceId: e.target.value })}>
          <option value="">Choose sequence…</option>
          {(refs.sequences.data ?? [])
            .filter((s) => s.id !== selfId && s.status !== 'archived')
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </Select>
      )}
      {step.action === 'assign_chat' && (
        <Select aria-label="Assign to" className="w-56" disabled={readOnly} value={step.userId ?? ''} onChange={(e) => onChange({ ...step, userId: e.target.value || null })}>
          <option value="">The least busy teammate</option>
          {(refs.members.data ?? []).map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </Select>
      )}
      {step.action === 'webhook' && (
        <div className="flex w-full flex-wrap gap-2">
          <Input aria-label="Webhook URL" type="url" className="min-w-0 flex-1" disabled={readOnly} placeholder="https://your-server.com/hook" value={step.url} onChange={(e) => onChange({ ...step, url: e.target.value.trim() })} />
          <Input aria-label="Signing secret" className="w-44" disabled={readOnly} placeholder="Secret (optional)" value={step.secret ?? ''} onChange={(e) => onChange({ ...step, secret: e.target.value || null })} />
          <p className="w-full text-xs text-slate-500">POSTs JSON (contact, sequence, joined-with data). With a secret, it is signed in the X-Zeta-Signature header (HMAC SHA-256).</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test and publish

function TestDialog({ sequenceId, onClose }: { sequenceId: string; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const toast = useToast();
  const key = `zc-seq-test-phone:${workspace.id}`;
  const [phone, setPhone] = useState(() => {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  });
  const run = useMutation({
    mutationFn: () => api.post<{ enrollmentId: string; testsLeftToday: number }>(`/workspaces/${workspace.id}/sequences/${sequenceId}/test`, { phone }),
    onSuccess: (res) => {
      try {
        localStorage.setItem(key, phone);
      } catch {
        /* private mode */
      }
      toast.success(`Test started. Messages arrive on your WhatsApp over the next few minutes (${res.testsLeftToday} tests left today).`);
      onClose();
    },
  });
  const notReady = run.error instanceof ApiError && run.error.code === 'SEQUENCE_NOT_READY' ? ((run.error.details as { checklist?: ChecklistItem[] })?.checklist ?? []) : [];
  return (
    <Dialog
      icon={<FlaskConical className="size-5" strokeWidth={1.5} />}
      title="Test on your own number"
      subtitle="Runs the whole draft: every wait is 20 seconds, quiet hours are ignored."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => run.mutate()} loading={run.isPending} disabled={phone.trim().length < 5}>
            Send test
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {run.error != null && !fieldError(run.error, 'phone') && <Alert>{errorMessage(run.error)}</Alert>}
        {notReady.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            {notReady.map((i, n) => (
              <li key={n}>{i.message}</li>
            ))}
          </ul>
        )}
        <Field label="Your WhatsApp number" htmlFor="seq-test-phone" error={fieldError(run.error, 'phone')} hint="Tests are not counted in stats or your monthly contacts. Up to 20 a day.">
          <Input id="seq-test-phone" autoFocus inputMode="tel" placeholder="+91 98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

interface Estimate {
  messagesPerContact: number;
  messageSteps: number;
  messages: { used: number; limit: number | null };
  sequenceContacts: { used: number; limit: number | null };
  periodEnd: string;
}

function PublishDialog({ seq, refs, onClose }: { seq: SequenceDetail; refs: Refs; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const base = `/workspaces/${workspace.id}/sequences/${seq.id}`;
  const estimate = useQuery({ queryKey: ['sequence-estimate', seq.id, seq.updatedAt], queryFn: () => api.get<Estimate>(`${base}/estimate`) });
  const publish = useMutation({
    mutationFn: () => api.post<{ sequence: SequenceDetail }>(`${base}/publish`),
    onSuccess: (res) => {
      queryClient.setQueryData(['sequence', workspace.id, seq.id], res);
      void queryClient.invalidateQueries({ queryKey: ['sequences', workspace.id] });
      toast.success(seq.published ? 'Changes published. People already inside keep their path; new joiners get this version.' : 'Your sequence is live.');
      onClose();
      if (!seq.published) navigate(`/w/${workspace.id}/sequences/${seq.id}/contacts`);
    },
  });
  const timing = timingLabels(seq.draftGraph.steps);
  const e = estimate.data;
  const left = e?.messages.limit != null ? Math.max(0, e.messages.limit - e.messages.used) : null;
  const ready = seq.checklist.length === 0;
  let n = 0;
  return (
    <Dialog
      icon={<Rocket className="size-5" strokeWidth={1.5} />}
      title={seq.published ? 'Publish changes' : 'Preview & publish'}
      subtitle={seq.name}
      width="max-w-xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Back to editing
          </Button>
          <Button onClick={() => publish.mutate()} loading={publish.isPending} disabled={!ready}>
            <Rocket className="size-4" /> {seq.published ? 'Publish changes' : 'Go live'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {publish.error != null && <Alert>{errorMessage(publish.error)}</Alert>}
        {!ready && <Alert>Finish the things left first ({seq.checklist.length}).</Alert>}
        <div className="rounded-lg bg-slate-50 px-3 py-2.5">
          <p className="text-xs font-medium text-slate-500">Who joins</p>
          <p className="font-medium text-ink">{triggerSummary(seq.trigger, { tags: refs.tags.data, lists: refs.lists.data, stages: refs.stages.data })}</p>
          {seq.entryFilter.length > 0 && <p className="text-xs text-slate-500">Only contacts matching {seq.entryFilter.length} condition(s).</p>}
        </div>
        <ol className="relative space-y-2 border-l border-slate-200 pl-4">
          {seq.draftGraph.steps.map((s) => {
            const meta = STEP_META[s.type];
            const label =
              s.type === 'message'
                ? `Message ${++n}${s.note ? `: ${s.note}` : ''} · ${refs.templates.data?.find((t) => t.id === s.templateId)?.name ?? 'no template'}`
                : s.type === 'wait'
                  ? `Wait ${s.amount} ${s.unit}`
                  : s.type === 'wait_until_date'
                    ? `Wait until ${s.offsetDays === 0 ? 'the day' : `${Math.abs(s.offsetDays)}d ${s.offsetDays < 0 ? 'before' : 'after'}`}, ${s.time}`
                    : s.type === 'action'
                      ? ACTIONS.find((a) => a.value === s.action)?.label ?? 'Action'
                      : 'Branch';
            return (
              <li key={s.id} className="flex items-center gap-2">
                <span className={cn('-ml-[25px] rounded-full p-1 ring-2 ring-white', meta.tone)}>
                  <meta.icon className="size-3" />
                </span>
                <span className="text-slate-700">{label}</span>
                {s.type === 'message' && timing.get(s.id) && <span className="text-xs text-slate-400">{timing.get(s.id)}</span>}
              </li>
            );
          })}
        </ol>
        {e && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 px-3 py-2">
              <p className="text-xs text-slate-500">Messages per contact</p>
              <p className="text-lg font-semibold text-ink">up to {e.messagesPerContact}</p>
            </div>
            <div className="rounded-lg border border-slate-200 px-3 py-2">
              <p className="text-xs text-slate-500">Messages left this period</p>
              <p className="text-lg font-semibold text-ink">{left === null ? 'Unlimited' : left.toLocaleString('en-IN')}</p>
              {left !== null && e.messagesPerContact > 0 && <p className="text-xs text-slate-500">Enough for about {Math.floor(left / e.messagesPerContact).toLocaleString('en-IN')} contacts</p>}
            </div>
          </div>
        )}
        <p className="text-xs text-slate-500">
          {seq.published
            ? 'People already in the sequence keep the steps they started with. New joiners get this version. Sending rules apply to everyone right away.'
            : 'Only events after you go live bring people in (no back-fill). When your monthly messages run out, sending pauses and continues when the plan renews; no contact is lost.'}
        </p>
      </div>
    </Dialog>
  );
}

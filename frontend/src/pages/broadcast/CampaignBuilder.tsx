import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, CircleHelp, Eye, Megaphone, Repeat, Search, Send, Trash2, Users } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Dialog } from '../../components/Dialog';
import { TemplatePreview } from '../../components/TemplatePreview';
import { TemplateExtrasFields, emptyExtras, extrasPreview } from '../../components/TemplateSendFields';
import { VariableRow } from '../../components/VariableRow';
import { Alert, Button, Input, Select, Spinner, cn, errorMessage, fieldError } from '../../components/ui';
import {
  api,
  type AudienceFilter,
  type Campaign,
  type CampaignPreview,
  type ConnectionPayload,
  type ContactList,
  type MessageTemplate,
  type RetargetOutcome,
  type VariableSpec,
} from '../../lib/api';
import { useMembers } from '../../lib/hooks';
import { formatInZone, zonedLocalToIso } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { AudiencePicker, SKIP_LABEL, sampleValue } from '../CampaignPage';

type Draft = Pick<
  Campaign,
  'name' | 'templateId' | 'headerVariables' | 'bodyVariables' | 'buttonVariables' | 'templateExtras' | 'audience' | 'sendRatePerMinute' | 'quietHours' | 'assigneeIds'
>;

const EMPTY_FILTER: AudienceFilter = { tagsAny: [], excludeTags: [], stages: [], requireOptIn: false, listsAny: [] };

export const RETARGET_INFO: Record<RetargetOutcome, { label: string; hint: string }> = {
  read: { label: 'Read', hint: 'Opened and read your message — good for a follow-up or next step.' },
  delivered: { label: 'Delivered', hint: "Received it but didn't open it — send a reminder." },
  sent: { label: 'Sent', hint: 'Everyone from the original campaign, whatever happened.' },
  failed: { label: 'Failed', hint: 'Not delivered (invalid number, blocked…). Usually fails again.' },
};

const STEPS = [
  { id: 'business', label: 'Business Info', required: true },
  { id: 'target', label: 'Target Customers', required: true },
  { id: 'template', label: 'Template Customization', required: true },
  { id: 'schedule', label: 'Schedule or Publish', required: true },
  { id: 'team', label: 'Assign Teammates', required: false },
] as const;
type StepId = (typeof STEPS)[number]['id'];

function fromCampaign(c: Campaign): Draft {
  return {
    name: c.name === 'Untitled campaign' ? '' : c.name,
    templateId: c.templateId,
    headerVariables: c.headerVariables,
    bodyVariables: c.bodyVariables,
    buttonVariables: c.buttonVariables ?? [],
    templateExtras: c.templateExtras,
    audience: { ...c.audience, filter: { ...EMPTY_FILTER, ...c.audience.filter }, type: c.audience.type === 'all' && !c.templateId ? 'list' : c.audience.type },
    sendRatePerMinute: c.sendRatePerMinute,
    quietHours: c.quietHours,
    assigneeIds: c.assigneeIds ?? [],
  };
}

/** The draft editor: "Create Campaign" in five steps with a live preview. */
export function CampaignBuilder({ campaign }: { campaign: Campaign }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const editable = can('campaigns:manage') && workspace.status !== 'suspended';
  const [draft, setDraft] = useState<Draft>(() => fromCampaign(campaign));
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [scheduleLocal, setScheduleLocal] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [moreAudience, setMoreAudience] = useState(['segment', 'filter', 'all'].includes(campaign.audience.type) && !!campaign.templateId);
  const [active, setActive] = useState<StepId>('business');
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const scroller = useRef<HTMLDivElement>(null);

  const connection = useQuery({ queryKey: ['whatsapp', workspace.id], queryFn: () => api.get<ConnectionPayload>(`/workspaces/${workspace.id}/whatsapp/connection`) });
  const templates = useQuery({
    queryKey: ['templates', workspace.id, 'APPROVED'],
    queryFn: () => api.get<{ templates: MessageTemplate[] }>(`/workspaces/${workspace.id}/templates?status=APPROVED`),
  });
  const template = templates.data?.templates.find((t) => t.id === draft.templateId);

  // Keep variable rows in step with the chosen template.
  useEffect(() => {
    if (!template) return;
    const fit = (list: VariableSpec[], n: number, first: VariableSpec) =>
      Array.from({ length: n }, (_, i) => list[i] ?? (i === 0 ? first : { source: 'static' as const, value: '', fallback: '' }));
    setDraft((d) => ({
      ...d,
      headerVariables: fit(d.headerVariables, template.variables.header, { source: 'field', value: 'first_name', fallback: 'there' }),
      bodyVariables: fit(d.bodyVariables, template.variables.body, { source: 'field', value: 'first_name', fallback: 'there' }),
      buttonVariables: fit(d.buttonVariables, template.requirements.buttons.length, { source: 'static', value: '', fallback: '' }),
      templateExtras: d.templateExtras?.cards?.length === template.requirements.cards.length ? d.templateExtras : { ...d.templateExtras, ...emptyExtras(template.requirements) },
    }));
  }, [template]);

  const payload = () => ({ ...draft, name: draft.name.trim() || 'Untitled campaign' });
  const save = useMutation({
    mutationFn: () => api.patch<{ campaign: Campaign }>(`/workspaces/${workspace.id}/campaigns/${campaign.id}`, payload()),
    onSuccess: ({ campaign: c }) => queryClient.setQueryData(['campaign', workspace.id, campaign.id], { campaign: c }),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/workspaces/${workspace.id}/campaigns/${campaign.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaigns', workspace.id] });
      navigate(`/w/${workspace.id}/campaigns`);
    },
  });

  // Step completion drives the left rail and the Review & Send button.
  const a = draft.audience;
  const audienceDone =
    a.type === 'list' ? (a.filter.listsAny ?? []).length > 0 : a.type === 'retarget' ? !!a.retarget?.campaignId && (a.retarget.outcomes ?? []).length > 0 : a.type !== 'segment' || !!a.segmentId;
  const variablesDone = [...draft.headerVariables, ...draft.bodyVariables, ...draft.buttonVariables].every((v) => v.source === 'field' || v.value.trim());
  const done: Record<StepId, boolean> = {
    business: !!draft.name.trim(),
    target: audienceDone,
    template: !!template && variablesDone,
    schedule: when === 'now' || !!scheduleLocal,
    team: draft.assigneeIds.length > 0,
  };
  const ready = done.business && done.target && done.template && done.schedule;

  const goTo = (id: StepId) => {
    setActive(id);
    document.getElementById(`step-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // Highlight the step whose card is in view.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((x, y) => x.boundingClientRect.top - y.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id.replace('step-', '') as StepId);
      },
      { root, rootMargin: '0px 0px -60% 0px' },
    );
    STEPS.forEach((s) => {
      const el = document.getElementById(`step-${s.id}`);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  const profileName = connection.data?.connection?.verifiedName || connection.data?.connection?.displayPhoneNumber || workspace.name;
  const error = save.error ?? remove.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-6 py-4">
        <span className="rounded-xl bg-emerald-50 p-2.5 text-emerald-600 ring-1 ring-emerald-100">
          <Megaphone className="size-5" />
        </span>
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-ink">
            {a.type === 'retarget' ? 'Retarget Campaign' : 'Create Campaign'}
            <Link
              to={`/w/${workspace.id}/broadcast/guide#create-campaign`}
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              <CircleHelp className="size-3.5" /> How it works
            </Link>
          </h1>
          <p className="text-sm text-slate-500">Send a template message to your selected contact lists.</p>
        </div>
      </div>

      <div ref={scroller} className="flex-1 overflow-y-auto bg-slate-50 px-4 py-6 sm:px-6">
        {error != null && (
          <div className="mb-4">
            <Alert>{errorMessage(error)}</Alert>
          </div>
        )}
        {connection.data && !connection.data.connection && (
          <div className="mb-4">
            <Alert tone="info">
              Connect a WhatsApp number before sending.{' '}
              <Link to={`/w/${workspace.id}/whatsapp`} className="font-medium underline">
                WhatsApp setup
              </Link>
            </Alert>
          </div>
        )}
        <div className="grid items-start gap-6 lg:grid-cols-[12rem_minmax(0,1fr)_minmax(0,20rem)]">
          <ol className="relative hidden lg:sticky lg:top-0 lg:block">
            {STEPS.map((s, i) => (
              <li key={s.id} className="relative pb-10 last:pb-0">
                {i < STEPS.length - 1 && <span className="absolute top-8 left-[15px] h-[calc(100%-2rem)] w-0.5 bg-slate-200" />}
                <button type="button" onClick={() => goTo(s.id)} className="flex items-start gap-3 text-left">
                  <span
                    className={cn(
                      'relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold',
                      done[s.id] ? 'border-emerald-500 bg-emerald-500 text-white' : active === s.id ? 'border-slate-700 bg-white text-ink ring-4 ring-slate-200' : 'border-slate-200 bg-white text-slate-500',
                    )}
                  >
                    {done[s.id] ? <Check className="size-4" /> : i + 1}
                  </span>
                  <span className={cn('pt-1.5 text-sm', active === s.id ? 'font-semibold text-ink' : 'text-slate-500')}>
                    {s.label}
                    {s.required ? <span className="text-red-500">*</span> : <span className="text-xs font-normal"> (Optional)</span>}
                  </span>
                </button>
              </li>
            ))}
          </ol>

          <div className="space-y-5">
            <StepCard id="business" n={1} title="Business Info" required>
              <p className="text-sm text-slate-500">Profile name :</p>
              <p className="mb-4 font-medium text-ink">{profileName}</p>
              <label htmlFor="c-name" className="mb-1.5 block text-sm font-medium text-slate-600">
                Campaign name <span className="text-red-500">*</span>
              </label>
              <Input id="c-name" disabled={!editable} maxLength={120} placeholder="Enter campaign name" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
              <p className="mt-1 text-xs text-slate-500">Only your team sees this, e.g. “Diwali Sale 2026”.</p>
            </StepCard>

            <StepCard id="target" n={2} title="Target Customers" required>
              {a.type === 'retarget' ? (
                <RetargetPicker audience={a} disabled={!editable} onChange={(audience) => set({ audience })} />
              ) : moreAudience ? (
                <>
                  <AudiencePicker audience={a} disabled={!editable} onChange={(audience) => set({ audience })} />
                  <button type="button" className="mt-3 text-xs font-medium text-brand-700 hover:underline" onClick={() => (setMoreAudience(false), set({ audience: { ...a, type: 'list' } }))}>
                    ← Back to contact lists
                  </button>
                </>
              ) : (
                <>
                  <ListMultiSelect selected={a.filter.listsAny ?? []} disabled={!editable} onChange={(listsAny) => set({ audience: { ...a, type: 'list', filter: { ...a.filter, listsAny } } })} />
                  <AudienceCount filter={{ ...EMPTY_FILTER, requireOptIn: a.filter.requireOptIn, listsAny: a.filter.listsAny ?? [] }} show={(a.filter.listsAny ?? []).length > 0} />
                  <button type="button" className="mt-3 text-xs font-medium text-slate-500 hover:text-ink hover:underline" onClick={() => setMoreAudience(true)}>
                    Use tags, a saved segment or all contacts instead
                  </button>
                </>
              )}
              {fieldError(save.error, 'audience') && <p className="mt-2 text-xs text-red-600">{fieldError(save.error, 'audience')}</p>}
            </StepCard>

            <StepCard id="template" n={3} title="Template Customization" required>
              {templates.data?.templates.length === 0 ? (
                <Alert tone="info">
                  No approved templates yet.{' '}
                  <Link to={`/w/${workspace.id}/templates/new`} className="font-medium underline">
                    Create one
                  </Link>{' '}
                  — WhatsApp usually approves within minutes to a day.
                </Alert>
              ) : (
                <div className="space-y-4">
                  <div>
                    <p className="mb-1.5 text-sm font-medium text-slate-600">3a. Choose template</p>
                    <Select
                      aria-label="Template"
                      disabled={!editable}
                      value={draft.templateId ?? ''}
                      onChange={(e) => set({ templateId: e.target.value || null, headerVariables: [], bodyVariables: [], buttonVariables: [], templateExtras: null })}
                    >
                      <option value="">Select an approved template</option>
                      {templates.data?.templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.language}, {t.category.toLowerCase()})
                        </option>
                      ))}
                    </Select>
                  </div>
                  {template && (
                    <div className="space-y-3">
                      <p className="text-sm font-medium text-slate-600">3b. Update variables</p>
                      {draft.headerVariables.length + draft.bodyVariables.length + template.requirements.buttons.length === 0 && (
                        <p className="text-sm text-slate-500">This template has no variables.</p>
                      )}
                      {draft.headerVariables.map((v, i) => (
                        <VariableRow key={`h${i}`} label={`Header {{${i + 1}}}`} spec={v} disabled={!editable} onChange={(spec) => set({ headerVariables: draft.headerVariables.map((x, j) => (j === i ? spec : x)) })} />
                      ))}
                      {draft.bodyVariables.map((v, i) => (
                        <VariableRow key={`b${i}`} label={`{{${i + 1}}}`} spec={v} disabled={!editable} onChange={(spec) => set({ bodyVariables: draft.bodyVariables.map((x, j) => (j === i ? spec : x)) })} />
                      ))}
                      {template.requirements.buttons.map((b, i) => (
                        <VariableRow
                          key={`btn${i}`}
                          label={b.type === 'COPY_CODE' ? 'Offer code' : `“${b.text}” link`}
                          spec={draft.buttonVariables[i] ?? { source: 'static', value: '', fallback: '' }}
                          disabled={!editable}
                          onChange={(spec) => set({ buttonVariables: template.requirements.buttons.map((_, j) => (j === i ? spec : (draft.buttonVariables[j] ?? { source: 'static', value: '', fallback: '' }))) })}
                        />
                      ))}
                      <TemplateExtrasFields requirements={template.requirements} value={draft.templateExtras ?? {}} onChange={(templateExtras) => set({ templateExtras })} disabled={!editable} error={save.error} shared />
                    </div>
                  )}
                  {(fieldError(save.error, 'bodyVariables') || fieldError(save.error, 'headerVariables') || fieldError(save.error, 'buttonVariables')) && (
                    <p className="text-xs text-red-600">{fieldError(save.error, 'bodyVariables') ?? fieldError(save.error, 'headerVariables') ?? fieldError(save.error, 'buttonVariables')}</p>
                  )}
                </div>
              )}
            </StepCard>

            <StepCard id="schedule" n={4} title="Schedule or Publish" required>
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ['now', 'Send Now', 'Campaign starts right after you confirm.'],
                    ['later', 'Schedule', 'Pick a future date and time.'],
                  ] as const
                ).map(([value, title, hint]) => (
                  <label key={value} className={cn('cursor-pointer rounded-xl border p-3', when === value ? 'border-slate-600 bg-slate-50' : 'border-slate-200')}>
                    <span className="flex items-center gap-2 text-sm font-medium text-slate-800">
                      <input type="radio" name="when" checked={when === value} onChange={() => setWhen(value)} /> {title}
                    </span>
                    <span className="mt-1 block text-xs text-slate-500">{hint}</span>
                  </label>
                ))}
              </div>
              {when === 'later' && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Input aria-label="Send at" type="datetime-local" value={scheduleLocal} onChange={(e) => setScheduleLocal(e.target.value)} className="w-60" />
                  <span className="text-xs text-slate-500">{workspace.timezone}</span>
                </div>
              )}
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer text-slate-600">Sending options</summary>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="c-rate" className="mb-1.5 block text-xs font-medium text-slate-600">
                      Messages per minute
                    </label>
                    <Input
                      id="c-rate"
                      type="number"
                      min={1}
                      max={1000}
                      disabled={!editable}
                      value={draft.sendRatePerMinute}
                      onChange={(e) => set({ sendRatePerMinute: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })}
                    />
                    <p className="mt-1 text-xs text-slate-500">Stay within your WhatsApp messaging limit.</p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                      <input type="checkbox" disabled={!editable} checked={draft.quietHours.enabled} onChange={(e) => set({ quietHours: { ...draft.quietHours, enabled: e.target.checked } })} />
                      Pause during quiet hours
                    </label>
                    <div className="flex items-center gap-2">
                      <Input aria-label="Quiet hours start" type="time" disabled={!editable || !draft.quietHours.enabled} value={draft.quietHours.start} onChange={(e) => set({ quietHours: { ...draft.quietHours, start: e.target.value } })} />
                      <span className="text-slate-400">to</span>
                      <Input aria-label="Quiet hours end" type="time" disabled={!editable || !draft.quietHours.enabled} value={draft.quietHours.end} onChange={(e) => set({ quietHours: { ...draft.quietHours, end: e.target.value } })} />
                    </div>
                  </div>
                </div>
              </details>
            </StepCard>

            <StepCard id="team" n={5} title="Assign Teammates" hint="(Optional)">
              <TeammatePicker selected={draft.assigneeIds} disabled={!editable} onChange={(assigneeIds) => set({ assigneeIds })} />
              {fieldError(save.error, 'assigneeIds') && <p className="mt-2 text-xs text-red-600">{fieldError(save.error, 'assigneeIds')}</p>}
            </StepCard>
          </div>

          <aside className="overflow-hidden rounded-xl border border-slate-200 bg-white lg:sticky lg:top-0">
            <p className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-ink">Preview</p>
            {template ? (
              <TemplatePreview components={template.components} headerParams={draft.headerVariables.map(sampleValue)} bodyParams={draft.bodyVariables.map(sampleValue)} {...extrasPreview(draft.templateExtras ?? {})} />
            ) : (
              <div className="wa-wallpaper p-4">
                <p className="rounded-xl bg-white/90 px-4 py-6 text-center text-sm text-slate-500">Choose a template to see the live preview.</p>
              </div>
            )}
          </aside>
        </div>
      </div>

      {editable && (
        <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-100/90 px-6 py-3 backdrop-blur">
          <Button variant="ghost" className="mr-auto" onClick={() => window.confirm('Delete this draft?') && remove.mutate()} aria-label="Delete draft" title="Delete draft">
            <Trash2 className="size-4" />
          </Button>
          <Button variant="secondary" loading={save.isPending && !reviewing} onClick={() => save.mutate()}>
            Save draft
          </Button>
          <Button disabled={!ready} onClick={() => setReviewing(true)} className="bg-slate-700 px-5 hover:bg-slate-800" title={ready ? undefined : 'Finish the required steps first'}>
            <Eye className="size-4" /> Review &amp; Send
          </Button>
        </div>
      )}

      {reviewing && (
        <ReviewDialog
          campaign={campaign}
          draft={payload()}
          template={template}
          scheduledAt={when === 'later' && scheduleLocal ? zonedLocalToIso(scheduleLocal, workspace.timezone) : null}
          onClose={() => setReviewing(false)}
        />
      )}
    </div>
  );
}

function StepCard({ id, n, title, required, hint, children }: { id: StepId; n: number; title: string; required?: boolean; hint?: string; children: ReactNode }) {
  return (
    <section id={`step-${id}`} className="scroll-mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-base font-semibold text-ink">
        {n}. {title}
        {required && <span className="text-red-500"> *</span>}
        {hint && <span className="text-sm font-normal text-slate-500"> {hint}</span>}
      </h2>
      {children}
    </section>
  );
}

function AudienceCount({ filter, show }: { filter: AudienceFilter; show: boolean }) {
  const { workspace } = useWorkspace();
  const count = useQuery({
    queryKey: ['audience-count', workspace.id, JSON.stringify(filter)],
    queryFn: () => api.post<{ matched: number; reachable: number; optedOut: number }>(`/workspaces/${workspace.id}/segments/count`, filter),
    placeholderData: keepPreviousData,
    enabled: show,
  });
  if (!show || !count.data) return null;
  return (
    <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
      <strong>{count.data.reachable}</strong> reachable of {count.data.matched} contacts
      {count.data.optedOut > 0 && ` (${count.data.optedOut} unsubscribed, skipped)`}
    </p>
  );
}

/** "Select contact lists..." dropdown with search, Select all and OK, like the reference design. */
function ListMultiSelect({ selected, onChange, disabled }: { selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const { workspace } = useWorkspace();
  const lists = useQuery({ queryKey: ['contact-lists', workspace.id, ''], queryFn: () => api.get<{ lists: ContactList[] }>(`/workspaces/${workspace.id}/contact-lists`) });
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<string[]>(selected);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const all = lists.data?.lists ?? [];
  const shown = all.filter((l) => l.name.toLowerCase().includes(q.trim().toLowerCase()));
  const allChecked = shown.length > 0 && shown.every((l) => pending.includes(l.id));
  const byId = new Map(all.map((l) => [l.id, l]));
  const flip = (id: string) => setPending(pending.includes(id) ? pending.filter((x) => x !== id) : [...pending, id]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setPending(selected);
          setOpen(!open);
        }}
        className="flex w-full items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-left text-sm shadow-sm hover:bg-slate-50 disabled:opacity-60"
      >
        <Users className="size-4 text-slate-500" />
        <span className={cn('flex-1 truncate', !selected.length && 'text-slate-500')}>
          {selected.length ? selected.map((id) => byId.get(id)?.name ?? '…').join(', ') : 'Select contact lists...'}
        </span>
        <ChevronDown className="size-4 text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-xl border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
              <Input autoFocus aria-label="Search lists" placeholder="Search lists" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
            </div>
          </div>
          {lists.isPending ? (
            <Spinner />
          ) : all.length === 0 ? (
            <p className="p-4 text-center text-sm text-slate-500">
              No lists yet.{' '}
              <Link to={`/w/${workspace.id}/broadcast`} className="font-medium text-brand-700 underline">
                Create one in Contacts List
              </Link>
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto p-1">
              <label className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() => setPending(allChecked ? pending.filter((id) => !shown.some((l) => l.id === id)) : [...new Set([...pending, ...shown.map((l) => l.id)])])}
                />
                Select all
              </label>
              {shown.map((l) => (
                <label key={l.id} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-slate-50">
                  <input type="checkbox" checked={pending.includes(l.id)} onChange={() => flip(l.id)} />
                  <span className="flex-1 text-slate-800">{l.name}</span>
                  <span className="text-xs text-slate-500">{l.count}</span>
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2 border-t border-slate-100 p-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                onChange(pending);
                setOpen(false);
              }}
              className="bg-slate-700 hover:bg-slate-800"
            >
              OK
            </Button>
          </div>
        </div>
      )}
      {selected.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {selected.map((id) => (
            <span key={id} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-700">
              {byId.get(id)?.name ?? '…'} · {byId.get(id)?.count ?? 0}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function RetargetPicker({ audience, onChange, disabled }: { audience: Campaign['audience']; onChange: (a: Campaign['audience']) => void; disabled?: boolean }) {
  const { workspace } = useWorkspace();
  const source = useQuery({
    queryKey: ['campaign', workspace.id, audience.retarget?.campaignId],
    queryFn: () => api.get<{ campaign: Campaign }>(`/workspaces/${workspace.id}/campaigns/${audience.retarget!.campaignId}`),
    enabled: !!audience.retarget?.campaignId,
  });
  const outcomes = audience.retarget?.outcomes ?? [];
  const flip = (o: RetargetOutcome) =>
    onChange({ ...audience, retarget: { campaignId: audience.retarget?.campaignId ?? null, outcomes: outcomes.includes(o) ? outcomes.filter((x) => x !== o) : [...outcomes, o] } });
  return (
    <div className="space-y-3 text-sm">
      <p className="flex items-center gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-indigo-800">
        <Repeat className="size-4" /> Retargeting <strong>{source.data?.campaign.name ?? '…'}</strong>
        <Link to={`/w/${workspace.id}/broadcast/retarget`} className="ml-auto text-xs underline">
          Change
        </Link>
      </p>
      <p className="text-xs font-medium text-slate-500">Send to people whose message was</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {(Object.keys(RETARGET_INFO) as RetargetOutcome[]).map((o) => (
          <label key={o} className={cn('cursor-pointer rounded-xl border p-3', outcomes.includes(o) ? 'border-slate-600 bg-slate-50' : 'border-slate-200')}>
            <span className="flex items-center gap-2 font-medium text-slate-800">
              <input type="checkbox" disabled={disabled} checked={outcomes.includes(o)} onChange={() => flip(o)} /> {RETARGET_INFO[o].label}
            </span>
            <span className="mt-1 block text-xs text-slate-500">{RETARGET_INFO[o].hint}</span>
          </label>
        ))}
      </div>
      <p className="text-xs text-slate-500">Statuses come from WhatsApp delivery receipts. Waiting 24–48 hours after the original campaign gives people time to read it.</p>
    </div>
  );
}

function TeammatePicker({ selected, onChange, disabled }: { selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const { workspace, can } = useWorkspace();
  const members = useMembers(workspace.id, can('members:read'));
  if (!can('members:read')) return <p className="text-sm text-slate-500">You can't see the team list with your role.</p>;
  if (members.isPending) return <Spinner />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Handle this campaign: when a customer replies and their chat is unassigned, it's assigned to these teammates in turn.</p>
      <div className="flex flex-wrap gap-2">
        {members.data?.map((m) => (
          <label key={m.userId} className={cn('flex items-center gap-2 rounded-full border px-3 py-1 text-sm', selected.includes(m.userId) ? 'border-slate-600 bg-slate-50' : 'border-slate-200')}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={selected.includes(m.userId)}
              onChange={() => onChange(selected.includes(m.userId) ? selected.filter((x) => x !== m.userId) : [...selected, m.userId])}
            />
            {m.name}
            <span className="text-xs text-slate-400">{m.role}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ReviewDialog({
  campaign,
  draft,
  template,
  scheduledAt,
  onClose,
}: {
  campaign: Campaign;
  draft: Draft;
  template?: MessageTemplate;
  scheduledAt: string | null;
  onClose: () => void;
}) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const lists = useQuery({ queryKey: ['contact-lists', workspace.id, ''], queryFn: () => api.get<{ lists: ContactList[] }>(`/workspaces/${workspace.id}/contact-lists`) });
  const members = useMembers(workspace.id, draft.assigneeIds.length > 0);
  // Saving first means the server checks exactly what is about to be sent.
  const check = useQuery({
    queryKey: ['campaign-review', campaign.id, JSON.stringify(draft)],
    queryFn: async () => {
      await api.patch(`/workspaces/${workspace.id}/campaigns/${campaign.id}`, draft);
      return (await api.post<{ preview: CampaignPreview }>(`/workspaces/${workspace.id}/campaigns/${campaign.id}/preview`)).preview;
    },
    retry: false,
    staleTime: Infinity,
  });
  const launch = useMutation({
    mutationFn: () => api.post<{ campaign: Campaign }>(`/workspaces/${workspace.id}/campaigns/${campaign.id}/launch`, { scheduledAt }),
    onSuccess: ({ campaign: c }) => {
      queryClient.setQueryData(['campaign', workspace.id, campaign.id], { campaign: c });
      void queryClient.invalidateQueries({ queryKey: ['campaigns', workspace.id] });
    },
  });
  const p = check.data;
  const large = (p?.eligible ?? 0) > 100;
  const [ack, setAck] = useState(false);
  const a = draft.audience;
  const audienceText =
    a.type === 'list'
      ? (a.filter.listsAny ?? []).map((id) => lists.data?.lists.find((l) => l.id === id)?.name ?? '…').join(', ')
      : a.type === 'retarget'
        ? `Retarget: ${(a.retarget?.outcomes ?? []).map((o) => RETARGET_INFO[o].label).join(', ')}`
        : a.type === 'all'
          ? 'All contacts'
          : a.type === 'segment'
            ? 'Saved segment'
            : 'Tags & stages';

  const Row = ({ label, children }: { label: string; children: ReactNode }) => (
    <div className="flex gap-3 py-2 text-sm">
      <dt className="w-32 shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 flex-1 text-slate-800">{children}</dd>
    </div>
  );

  return (
    <Dialog
      icon={<Send className="size-4" />}
      title="Review & Send"
      subtitle="Check everything once more. Nothing is sent until you publish."
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Back to edit
          </Button>
          <Button onClick={() => launch.mutate()} loading={launch.isPending} disabled={!p || p.eligible === 0 || (large && !ack)} className="bg-slate-700 hover:bg-slate-800">
            {scheduledAt ? 'Schedule' : 'Publish'}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_16rem]">
        <div>
          <dl className="divide-y divide-slate-100">
            <Row label="Campaign">{draft.name}</Row>
            <Row label="Audience">{audienceText}</Row>
            <Row label="Template">{template ? `${template.name} (${template.language})` : '—'}</Row>
            <Row label="When">{scheduledAt ? formatInZone(scheduledAt, workspace.timezone) : 'Right after you publish'}</Row>
            <Row label="Teammates">{draft.assigneeIds.length ? draft.assigneeIds.map((id) => members.data?.find((m) => m.userId === id)?.name ?? '…').join(', ') : 'Not assigned'}</Row>
          </dl>
          <div className="mt-4 space-y-3 text-sm">
            {check.isPending && <Spinner label="Checking the audience…" />}
            {check.error != null && <Alert>{errorMessage(check.error)}</Alert>}
            {launch.error != null && <Alert>{errorMessage(launch.error)}</Alert>}
            {p && (
              <>
                <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">
                  <strong>{p.eligible}</strong> of {p.matched} contact(s) will receive this message.
                </p>
                {Object.keys(p.skipped).length > 0 && (
                  <ul className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    {Object.entries(p.skipped).map(([reason, n]) => (
                      <li key={reason}>
                        Skipped — {SKIP_LABEL[reason] ?? reason}: {n}
                      </li>
                    ))}
                  </ul>
                )}
                {p.eligible === 0 && <Alert>Nobody in this audience can receive the message.</Alert>}
                {large && (
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />I confirm sending to {p.eligible} contacts.
                  </label>
                )}
                <p className="text-xs text-slate-500">Messages WhatsApp has accepted can't be recalled, but you can pause or cancel the rest at any time.</p>
              </>
            )}
          </div>
        </div>
        <div className="space-y-2">
          {template && <TemplatePreview components={template.components} headerParams={draft.headerVariables.map(sampleValue)} bodyParams={draft.bodyVariables.map(sampleValue)} {...extrasPreview(draft.templateExtras ?? {})} />}
          {p?.samples[0] && (
            <p className="rounded-lg bg-slate-50 p-2.5 text-xs text-slate-600">
              <span className="font-medium text-slate-700">For {p.samples[0].contact}:</span> {p.samples[0].preview}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

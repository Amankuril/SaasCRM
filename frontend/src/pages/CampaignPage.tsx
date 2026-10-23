import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, ChevronLeft, ChevronRight, Pause, Play, Rocket, Save, Trash2, Users } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { TemplatePreview } from '../components/TemplatePreview';
import { VariableRow } from '../components/VariableRow';
import { Modal, STAGES, TagChip } from '../components/crm';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, cn, errorMessage, fieldError } from '../components/ui';
import { api, type AudienceFilter, type Campaign, type CampaignPreview, type MessageTemplate, type Segment, type VariableSpec } from '../lib/api';
import { useTags } from '../lib/hooks';
import { formatInZone, zonedLocalToIso } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';
import { CAMPAIGN_STATUS, funnel } from './CampaignsPage';

export function CampaignPage() {
  const { campaignId } = useParams();
  const { workspace } = useWorkspace();
  const query = useQuery({
    queryKey: ['campaign', workspace.id, campaignId],
    queryFn: () => api.get<{ campaign: Campaign }>(`/workspaces/${workspace.id}/campaigns/${campaignId}`),
    refetchInterval: (q) => (q.state.data && isLive(q.state.data.campaign) ? 3_000 : false),
  });

  if (query.isPending) return <Spinner />;
  if (query.error) return <Alert>{errorMessage(query.error)}</Alert>;
  const { campaign } = query.data;
  return campaign.status === 'draft' ? <CampaignEditor key={campaign.id} campaign={campaign} /> : <CampaignReport campaign={campaign} />;
}

/** Still worth polling: sending, or recently finished (receipts and replies keep arriving). */
function isLive(c: Campaign): boolean {
  if (c.status === 'running' || c.status === 'scheduled') return true;
  return !!c.completedAt && Date.now() - new Date(c.completedAt).getTime() < 15 * 60_000;
}

const SKIP_LABEL: Record<string, string> = {
  opted_out: 'Opted out',
  no_opt_in: 'No opt-in',
  missing_variable: 'Missing a variable value',
  cancelled: 'Campaign cancelled',
};


type Draft = Omit<Campaign, 'id' | 'status' | 'templateName' | 'scheduledAt' | 'launchedAt' | 'completedAt' | 'failureReason' | 'createdAt' | 'stats'>;

function CampaignEditor({ campaign }: { campaign: Campaign }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const editable = can('campaigns:manage') && workspace.status !== 'suspended';
  const [draft, setDraft] = useState<Draft>(() => ({
    name: campaign.name,
    templateId: campaign.templateId,
    headerVariables: campaign.headerVariables,
    bodyVariables: campaign.bodyVariables,
    audience: campaign.audience,
    sendRatePerMinute: campaign.sendRatePerMinute,
    quietHours: campaign.quietHours,
  }));
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [scheduleLocal, setScheduleLocal] = useState('');
  const [confirming, setConfirming] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

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
    }));
  }, [template]);

  const save = useMutation({
    mutationFn: () => api.patch<{ campaign: Campaign }>(`/workspaces/${workspace.id}/campaigns/${campaign.id}`, draft),
    onSuccess: ({ campaign: c }) => queryClient.setQueryData(['campaign', workspace.id, campaign.id], { campaign: c }),
  });
  const preview = useMutation({
    mutationFn: async () => {
      await save.mutateAsync();
      return api.post<{ preview: CampaignPreview }>(`/workspaces/${workspace.id}/campaigns/${campaign.id}/preview`);
    },
  });
  const launch = useMutation({
    mutationFn: async () => {
      await save.mutateAsync();
      return api.post<{ campaign: Campaign }>(`/workspaces/${workspace.id}/campaigns/${campaign.id}/launch`, {
        scheduledAt: when === 'later' && scheduleLocal ? zonedLocalToIso(scheduleLocal, workspace.timezone) : null,
      });
    },
    onSuccess: ({ campaign: c }) => {
      setConfirming(false);
      queryClient.setQueryData(['campaign', workspace.id, campaign.id], { campaign: c });
      void queryClient.invalidateQueries({ queryKey: ['campaigns', workspace.id] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/workspaces/${workspace.id}/campaigns/${campaign.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaigns', workspace.id] });
      navigate(`/w/${workspace.id}/campaigns`);
    },
  });

  const error = save.error ?? preview.error ?? launch.error ?? remove.error;
  const p = preview.data?.preview;

  return (
    <>
      <BackLink />
      <PageHeader
        title={draft.name || 'Untitled campaign'}
        description="Draft. Nothing is sent until you launch."
        actions={
          editable && (
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => window.confirm('Delete this draft?') && remove.mutate()}>
                <Trash2 className="size-4" />
              </Button>
              <Button variant="secondary" loading={save.isPending && !preview.isPending && !launch.isPending} onClick={() => save.mutate()}>
                <Save className="size-4" /> Save draft
              </Button>
            </div>
          )
        }
      />
      {error != null && (
        <div className="mb-4">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Section step={1} title="Details">
            <Field label="Campaign name (internal)" htmlFor="c-name" error={fieldError(error, 'name')}>
              <Input id="c-name" disabled={!editable} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
          </Section>

          <Section step={2} title="Audience">
            <AudiencePicker audience={draft.audience} onChange={(audience) => set({ audience })} disabled={!editable} />
          </Section>

          <Section step={3} title="Message">
            {templates.data?.templates.length === 0 ? (
              <Alert tone="info">
                No approved templates.{' '}
                <Link to={`/w/${workspace.id}/templates`} className="font-medium underline">
                  Create or sync one
                </Link>{' '}
                first.
              </Alert>
            ) : (
              <div className="space-y-4">
                <Field label="Approved template" htmlFor="c-tpl" error={fieldError(error, 'templateId')}>
                  <Select id="c-tpl" disabled={!editable} value={draft.templateId ?? ''} onChange={(e) => set({ templateId: e.target.value || null, headerVariables: [], bodyVariables: [] })}>
                    <option value="">Choose a template</option>
                    {templates.data?.templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.language}, {t.category.toLowerCase()})
                      </option>
                    ))}
                  </Select>
                </Field>
                {template && (
                  <>
                    {draft.headerVariables.map((v, i) => (
                      <VariableRow key={`h${i}`} label={`Header {{${i + 1}}}`} spec={v} disabled={!editable} onChange={(spec) => set({ headerVariables: draft.headerVariables.map((x, j) => (j === i ? spec : x)) })} />
                    ))}
                    {draft.bodyVariables.map((v, i) => (
                      <VariableRow key={`b${i}`} label={`Body {{${i + 1}}}`} spec={v} disabled={!editable} onChange={(spec) => set({ bodyVariables: draft.bodyVariables.map((x, j) => (j === i ? spec : x)) })} />
                    ))}
                    {(fieldError(error, 'bodyVariables') || fieldError(error, 'headerVariables')) && (
                      <p className="text-xs text-red-600">{fieldError(error, 'bodyVariables') ?? fieldError(error, 'headerVariables')}</p>
                    )}
                    <TemplatePreview
                      components={template.components}
                      headerParams={draft.headerVariables.map(sampleValue)}
                      bodyParams={draft.bodyVariables.map(sampleValue)}
                    />
                  </>
                )}
              </div>
            )}
          </Section>

          <Section step={4} title="Sending">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Messages per minute" htmlFor="c-rate" hint="Stay within your WhatsApp messaging limit.">
                <Input
                  id="c-rate"
                  type="number"
                  min={1}
                  max={1000}
                  disabled={!editable}
                  value={draft.sendRatePerMinute}
                  onChange={(e) => set({ sendRatePerMinute: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })}
                />
              </Field>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                  <input type="checkbox" disabled={!editable} checked={draft.quietHours.enabled} onChange={(e) => set({ quietHours: { ...draft.quietHours, enabled: e.target.checked } })} />
                  Pause during quiet hours
                </label>
                <div className="flex items-center gap-2">
                  <Input aria-label="Quiet hours start" type="time" disabled={!editable || !draft.quietHours.enabled} value={draft.quietHours.start} onChange={(e) => set({ quietHours: { ...draft.quietHours, start: e.target.value } })} />
                  <span className="text-slate-400">to</span>
                  <Input aria-label="Quiet hours end" type="time" disabled={!editable || !draft.quietHours.enabled} value={draft.quietHours.end} onChange={(e) => set({ quietHours: { ...draft.quietHours, end: e.target.value } })} />
                </div>
                <p className="text-xs text-slate-500">In {workspace.timezone}.</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" checked={when === 'now'} onChange={() => setWhen('now')} /> Send now
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={when === 'later'} onChange={() => setWhen('later')} /> Schedule
              </label>
              {when === 'later' && (
                <div className="flex items-center gap-2">
                  <Input aria-label="Send at" type="datetime-local" value={scheduleLocal} onChange={(e) => setScheduleLocal(e.target.value)} className="w-56" />
                  <span className="text-xs text-slate-500">{workspace.timezone}</span>
                </div>
              )}
            </div>
            {fieldError(error, 'scheduledAt') && <p className="mt-1 text-xs text-red-600">{fieldError(error, 'scheduledAt')}</p>}
          </Section>
        </div>

        <div className="lg:col-span-2">
          <Card className="sticky top-6 p-5">
            <h2 className="text-sm font-semibold text-ink">Review</h2>
            <p className="mt-1 text-sm text-slate-500">See exactly who will get the message before launching.</p>
            <Button variant="secondary" className="mt-4 w-full" loading={preview.isPending} onClick={() => preview.mutate()}>
              <Users className="size-4" /> Check audience
            </Button>
            {p && (
              <div className="mt-4 space-y-3 text-sm">
                <dl className="grid grid-cols-2 gap-2">
                  <Stat label="Matched contacts" value={p.matched} />
                  <Stat label="Will receive it" value={p.eligible} strong />
                </dl>
                {Object.keys(p.skipped).length > 0 && (
                  <div className="rounded-lg bg-amber-50 p-3 text-amber-900">
                    <p className="text-xs font-medium">Skipped</p>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {Object.entries(p.skipped).map(([reason, n]) => (
                        <li key={reason}>
                          {SKIP_LABEL[reason] ?? reason}: {n}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {p.samples.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-slate-500">Sample messages</p>
                    <ul className="space-y-2">
                      {p.samples.map((s) => (
                        <li key={s.phone} className="rounded-lg bg-slate-50 p-2.5 text-xs">
                          <p className="font-medium text-slate-700">{s.contact}</p>
                          <p className="mt-0.5 whitespace-pre-wrap text-slate-600">{s.preview}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {editable && (
              <Button className="mt-5 w-full" disabled={!draft.templateId || (when === 'later' && !scheduleLocal)} onClick={() => preview.mutateAsync().then(() => setConfirming(true))}>
                <Rocket className="size-4" /> {when === 'later' ? 'Schedule broadcast' : 'Launch broadcast'}
              </Button>
            )}
          </Card>
        </div>
      </div>

      {confirming && p && (
        <ConfirmLaunch
          preview={p}
          when={when === 'later' && scheduleLocal ? formatInZone(zonedLocalToIso(scheduleLocal, workspace.timezone), workspace.timezone) : null}
          loading={launch.isPending}
          error={launch.error}
          onCancel={() => setConfirming(false)}
          onConfirm={() => launch.mutate()}
        />
      )}
    </>
  );
}

function sampleValue(v: VariableSpec) {
  if (v.source === 'static') return v.value;
  const sample: Record<string, string> = { first_name: 'Priya', name: 'Priya Sharma', phone: '+919811112222', email: 'priya@example.com' };
  return sample[v.value] ?? (v.value.startsWith('custom.') ? `[${v.value.slice(7)}]` : '');
}

function AudiencePicker({ audience, onChange, disabled }: { audience: Draft['audience']; onChange: (a: Draft['audience']) => void; disabled: boolean }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const tags = useTags(workspace.id);
  const segments = useQuery({
    queryKey: ['segments', workspace.id],
    queryFn: () => api.get<{ segments: Segment[] }>(`/workspaces/${workspace.id}/segments`),
    select: (d) => d.segments,
  });
  const filter = audience.type === 'segment' ? segments.data?.find((s) => s.id === audience.segmentId)?.filter : audience.type === 'filter' ? audience.filter : undefined;
  const countFilter: AudienceFilter = filter ?? { tagsAny: [], excludeTags: [], stages: [], requireOptIn: false };
  const filterKey = JSON.stringify(countFilter);
  const count = useQuery({
    queryKey: ['audience-count', workspace.id, filterKey],
    queryFn: () => api.post<{ matched: number; reachable: number; optedOut: number }>(`/workspaces/${workspace.id}/segments/count`, countFilter),
    placeholderData: keepPreviousData,
  });
  const [segmentName, setSegmentName] = useState('');
  const saveSegment = useMutation({
    mutationFn: () => api.post<{ segment: Segment }>(`/workspaces/${workspace.id}/segments`, { name: segmentName, filter: audience.filter }),
    onSuccess: ({ segment }) => {
      setSegmentName('');
      void queryClient.invalidateQueries({ queryKey: ['segments', workspace.id] });
      onChange({ ...audience, type: 'segment', segmentId: segment.id });
    },
  });

  const tagById = useMemo(() => new Map((tags.data ?? []).map((t) => [t.id, t])), [tags.data]);
  const setFilter = (patch: Partial<AudienceFilter>) => onChange({ ...audience, type: 'filter', filter: { ...audience.filter, ...patch } });
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap gap-2">
        {(
          [
            ['all', 'All contacts'],
            ['segment', 'Saved segment'],
            ['filter', 'Tags & stages'],
          ] as const
        ).map(([type, label]) => (
          <button
            key={type}
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...audience, type })}
            className={cn('rounded-lg border px-3 py-1.5 font-medium', audience.type === type ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}
          >
            {label}
          </button>
        ))}
      </div>

      {audience.type === 'segment' && (
        <Field label="Segment" htmlFor="c-seg">
          <Select id="c-seg" disabled={disabled} value={audience.segmentId ?? ''} onChange={(e) => onChange({ ...audience, segmentId: e.target.value || null })}>
            <option value="">{segments.data?.length ? 'Choose a segment' : 'No saved segments yet'}</option>
            {segments.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {audience.type === 'filter' && (
        <div className="space-y-3">
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-500">Has any of these tags</p>
            <TagPicker tags={tags.data ?? []} selected={audience.filter.tagsAny} disabled={disabled} onToggle={(id) => setFilter({ tagsAny: toggle(audience.filter.tagsAny, id) })} />
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-500">Exclude contacts with these tags</p>
            <TagPicker tags={tags.data ?? []} selected={audience.filter.excludeTags} disabled={disabled} onToggle={(id) => setFilter({ excludeTags: toggle(audience.filter.excludeTags, id) })} />
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-500">Lifecycle stage (any)</p>
            <div className="flex flex-wrap gap-1.5">
              {STAGES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => setFilter({ stages: toggle(audience.filter.stages, s.value) as AudienceFilter['stages'] })}
                  className={cn('rounded-full border px-2.5 py-0.5 text-xs', audience.filter.stages.includes(s.value) ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600')}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={disabled} checked={audience.filter.requireOptIn} onChange={(e) => setFilter({ requireOptIn: e.target.checked })} />
            Only contacts who have opted in
          </label>
          {can('campaigns:manage') && !disabled && (
            <div className="flex gap-2">
              <Input aria-label="Segment name" placeholder="Save as segment…" value={segmentName} onChange={(e) => setSegmentName(e.target.value)} className="max-w-xs" />
              <Button variant="secondary" disabled={!segmentName.trim()} loading={saveSegment.isPending} onClick={() => saveSegment.mutate()}>
                Save
              </Button>
            </div>
          )}
          {saveSegment.error != null && <Alert>{errorMessage(saveSegment.error)}</Alert>}
        </div>
      )}

      {audience.type === 'segment' && filter && (
        <div className="flex flex-wrap gap-1.5">
          {filter.tagsAny.map((id) => tagById.get(id) && <TagChip key={id} tag={tagById.get(id)!} />)}
          {filter.stages.map((s) => (
            <Badge key={s}>{STAGES.find((x) => x.value === s)?.label}</Badge>
          ))}
        </div>
      )}

      {count.data && (audience.type !== 'segment' || audience.segmentId) && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-slate-700">
          <strong>{count.data.reachable}</strong> reachable of {count.data.matched} matching contacts
          {count.data.optedOut > 0 && ` (${count.data.optedOut} opted out)`}
        </p>
      )}
    </div>
  );
}

function TagPicker({ tags, selected, onToggle, disabled }: { tags: { id: string; name: string; color: never | string }[]; selected: string[]; onToggle: (id: string) => void; disabled: boolean }) {
  if (tags.length === 0) return <p className="text-xs text-slate-400">No tags yet.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <button
          key={t.id}
          type="button"
          disabled={disabled}
          onClick={() => onToggle(t.id)}
          className={cn('rounded-full border px-2.5 py-0.5 text-xs', selected.includes(t.id) ? 'border-brand-500 bg-brand-50 font-medium text-brand-700' : 'border-slate-200 text-slate-600')}
        >
          {t.name}
        </button>
      ))}
    </div>
  );
}

function ConfirmLaunch({
  preview,
  when,
  loading,
  error,
  onCancel,
  onConfirm,
}: {
  preview: CampaignPreview;
  when: string | null;
  loading: boolean;
  error: unknown;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const large = preview.eligible > 100;
  const [ack, setAck] = useState(!large);
  return (
    <Modal title={when ? 'Schedule this broadcast?' : 'Send this broadcast now?'} onClose={onCancel}>
      <div className="space-y-4 text-sm">
        {error != null && <Alert>{errorMessage(error)}</Alert>}
        <p className="text-slate-700">
          <strong>{preview.eligible}</strong> contact(s) will receive this message{when ? ` on ${when}` : ' starting now'}.
          {preview.matched - preview.eligible > 0 && ` ${preview.matched - preview.eligible} will be skipped.`}
        </p>
        <p className="text-slate-500">Messages already accepted by WhatsApp can't be recalled, but you can pause or cancel the rest at any time.</p>
        {large && (
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
            I confirm sending to {preview.eligible} contacts.
          </label>
        )}
        {preview.eligible === 0 && <Alert>Nobody in this audience can receive the message.</Alert>}
        <div className="flex gap-2">
          <Button loading={loading} disabled={!ack || preview.eligible === 0} onClick={onConfirm}>
            {when ? 'Schedule' : 'Send now'}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const RECIPIENT_TONE = { pending: 'gray', queued: 'gray', submitted: 'gray', sent: 'blue', delivered: 'blue', read: 'green', failed: 'red', skipped: 'amber' } as const;

interface RecipientRow {
  id: string;
  name: string | null;
  phone: string;
  status: keyof typeof RECIPIENT_TONE;
  skipReason: string | null;
  error: { code: string; title: string; message: string } | null;
  repliedAt: string | null;
}

function CampaignReport({ campaign }: { campaign: Campaign }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const f = funnel(campaign.stats);
  const manage = can('campaigns:manage') && workspace.status !== 'suspended';

  const recipients = useQuery({
    queryKey: ['campaign-recipients', workspace.id, campaign.id, status, page],
    queryFn: () =>
      api.get<{ recipients: RecipientRow[]; total: number; pages: number }>(
        `/workspaces/${workspace.id}/campaigns/${campaign.id}/recipients?page=${page}&limit=25${status ? `&status=${status}` : ''}`,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: isLive(campaign) ? 3_000 : false,
  });
  const action = useMutation({
    mutationFn: (a: 'pause' | 'resume' | 'cancel') => api.post<{ campaign: Campaign }>(`/workspaces/${workspace.id}/campaigns/${campaign.id}/${a}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaign', workspace.id, campaign.id] });
      void queryClient.invalidateQueries({ queryKey: ['campaigns', workspace.id] });
    },
  });
  const pct = (v: number, of: number) => (of ? `${Math.round((v / of) * 100)}%` : '—');
  const done = f.total - f.pending;

  return (
    <>
      <BackLink />
      <PageHeader
        title={campaign.name}
        description={[
          campaign.templateName && `Template ${campaign.templateName}`,
          campaign.status === 'scheduled' && campaign.scheduledAt ? `Sends ${formatInZone(campaign.scheduledAt, workspace.timezone)}` : null,
          campaign.launchedAt && campaign.status !== 'scheduled' ? `Launched ${formatInZone(campaign.launchedAt, workspace.timezone)}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={CAMPAIGN_STATUS[campaign.status].tone}>{CAMPAIGN_STATUS[campaign.status].label}</Badge>
            {manage && ['running', 'scheduled'].includes(campaign.status) && (
              <Button variant="secondary" loading={action.isPending} onClick={() => action.mutate('pause')}>
                <Pause className="size-4" /> Pause
              </Button>
            )}
            {manage && campaign.status === 'paused' && (
              <Button loading={action.isPending} onClick={() => action.mutate('resume')}>
                <Play className="size-4" /> Resume
              </Button>
            )}
            {manage && ['running', 'scheduled', 'paused'].includes(campaign.status) && (
              <Button variant="danger" loading={action.isPending} onClick={() => window.confirm('Cancel this broadcast? Messages not yet sent will be dropped.') && action.mutate('cancel')}>
                <Ban className="size-4" /> Cancel
              </Button>
            )}
          </div>
        }
      />
      {campaign.failureReason && campaign.status === 'paused' && (
        <div className="mb-4">
          <Alert>Paused automatically: {campaign.failureReason}</Alert>
        </div>
      )}
      {action.error != null && (
        <div className="mb-4">
          <Alert>{errorMessage(action.error)}</Alert>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Stat label="Recipients" value={f.total} />
        <Stat label="Sent" value={f.sent} />
        <Stat label="Delivered" value={f.delivered} sub={pct(f.delivered, f.sent)} />
        <Stat label="Read" value={f.read} sub={pct(f.read, f.sent)} />
        <Stat label="Replied" value={f.replied} sub={pct(f.replied, f.sent)} />
        <Stat label="Failed" value={f.failed} />
        <Stat label="Skipped" value={f.skipped} />
      </div>

      {f.total > 0 && (
        <div className="mb-6">
          <div className="mb-1 flex justify-between text-xs text-slate-500">
            <span>Progress</span>
            <span>
              {done} / {f.total} processed{f.pending ? ` · ${f.pending} waiting` : ''}
            </span>
          </div>
          <div className="flex h-2 overflow-hidden rounded-full bg-slate-100">
            <div className="bg-emerald-500" style={{ width: `${(f.read / f.total) * 100}%` }} />
            <div className="bg-sky-400" style={{ width: `${((f.delivered - f.read) / f.total) * 100}%` }} />
            <div className="bg-slate-400" style={{ width: `${((f.sent - f.delivered) / f.total) * 100}%` }} />
            <div className="bg-red-400" style={{ width: `${(f.failed / f.total) * 100}%` }} />
            <div className="bg-amber-300" style={{ width: `${(f.skipped / f.total) * 100}%` }} />
          </div>
        </div>
      )}

      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 p-4">
          <h2 className="text-sm font-semibold text-ink">Recipients</h2>
          <div className="w-40">
            <Select
              aria-label="Filter recipients"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {Object.keys(RECIPIENT_TONE).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {recipients.isPending ? (
          <Spinner />
        ) : recipients.error ? (
          <div className="p-4">
            <Alert>{errorMessage(recipients.error)}</Alert>
          </div>
        ) : recipients.data.recipients.length === 0 ? (
          <EmptyState icon={<Users className="size-5" />} title="No recipients with this status" />
        ) : (
          <>
            <ul className="divide-y divide-slate-100">
              {recipients.data.recipients.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-slate-800">{r.name ?? r.phone}</p>
                    {r.name && <p className="text-xs text-slate-500">{r.phone}</p>}
                    {r.error && (
                      <p className="text-xs text-red-600">
                        {r.error.title}: {r.error.message}
                      </p>
                    )}
                    {r.skipReason && <p className="text-xs text-amber-700">{SKIP_LABEL[r.skipReason] ?? r.skipReason}</p>}
                  </div>
                  {r.repliedAt && <Badge tone="green">Replied</Badge>}
                  <Badge tone={RECIPIENT_TONE[r.status]}>{r.status}</Badge>
                </li>
              ))}
            </ul>
            {recipients.data.pages > 1 && (
              <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm">
                <span className="text-slate-500">
                  Page {page} of {recipients.data.pages}
                </span>
                <div className="flex gap-2">
                  <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button variant="secondary" disabled={page >= recipients.data.pages} onClick={() => setPage(page + 1)} aria-label="Next page">
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

function BackLink() {
  const { workspace } = useWorkspace();
  return (
    <Link to={`/w/${workspace.id}/campaigns`} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
      <ArrowLeft className="size-4" /> Broadcasts
    </Link>
  );
}

function Section({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink">
        <span className="flex size-6 items-center justify-center rounded-full bg-brand-50 text-xs text-brand-700">{step}</span>
        {title}
      </h2>
      {children}
    </Card>
  );
}

function Stat({ label, value, sub, strong }: { label: string; value: number; sub?: string; strong?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cn('mt-1 text-xl font-semibold', strong ? 'text-brand-700' : 'text-ink')}>{value}</p>
      {sub && <p className="text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

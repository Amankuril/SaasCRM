import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Info, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { MediaInput, TemplateExtrasFields, emptyExtras, extrasPreview } from '../../components/TemplateSendFields';
import { TemplatePreview } from '../../components/TemplatePreview';
import { Alert, Button, Input, Select, Spinner, cn, errorMessage, fieldError } from '../../components/ui';
import { VariableRow } from '../../components/VariableRow';
import {
  ApiError,
  api,
  type AiSettings,
  type AutoReply,
  type AutoReplyActionType,
  type AutoReplyEvent,
  type AutoReplyMatch,
  type FlowSummary,
  type MessageSource,
  type MessageTemplate,
  type TemplateExtras,
  type VariableSpec,
  type WaForm,
} from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { useActionNames, Toggle } from './AutoRepliesPage';
import { ACTION_INFO, COOLDOWNS, EVENT_LABEL, PhonePreview, SOURCE_LABEL } from './shared';

type Config = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- per action type

interface Draft {
  name: string;
  active: boolean;
  match: AutoReplyMatch;
  keywords: string[];
  event: AutoReplyEvent;
  sources: MessageSource[];
  cooldownMinutes: number;
  actionType: AutoReplyActionType;
  /** Config per action type, so switching types and back keeps what was typed. */
  configs: Partial<Record<AutoReplyActionType, Config>>;
}

const DEFAULT_CONFIG: Record<AutoReplyActionType, Config> = {
  text: { text: '' },
  file: { mediaType: 'image' },
  quick_reply: { text: '', buttons: [{ title: '' }] },
  cta_url: { text: '', buttonText: '', url: '' },
  form: { formId: '' },
  chatbot: { flowId: '' },
  ai_chatbot: {},
  location: { name: '', address: '' },
  address: { text: 'Please share your delivery address.', country: 'IN' },
  template: { templateId: '', headerVariables: [], bodyVariables: [], buttonVariables: [], templateExtras: {} },
  unsubscribe: { text: "You've been unsubscribed and won't receive offers from us. Reply START anytime to subscribe again." },
};

function fromRule(r?: AutoReply): Draft {
  return {
    name: r?.name ?? '',
    active: r?.active ?? true,
    match: r?.match ?? 'equals',
    keywords: r?.keywords ?? [],
    event: r?.event ?? 'first_message',
    sources: r?.sources ?? [],
    cooldownMinutes: r?.cooldownMinutes ?? 0,
    actionType: r?.action.type ?? 'text',
    configs: r ? { [r.action.type]: r.action.config } : {},
  };
}

/** Drops empty optional strings so the API's optional fields stay absent. */
function clean(config: Config): Config {
  return Object.fromEntries(Object.entries(config).filter(([, v]) => v !== '' && v !== undefined && !(typeof v === 'number' && Number.isNaN(v))));
}

/** /auto-replies/new and /auto-replies/:autoReplyId */
export function AutoReplyEditorPage() {
  const { autoReplyId } = useParams();
  const { workspace } = useWorkspace();
  const existing = useQuery({
    queryKey: ['auto-replies', workspace.id, 'one', autoReplyId],
    queryFn: () => api.get<{ autoReply: AutoReply }>(`/workspaces/${workspace.id}/auto-replies/${autoReplyId}`),
    enabled: !!autoReplyId,
    staleTime: Infinity,
  });
  if (autoReplyId && existing.isPending) return <Spinner />;
  if (existing.error) return <Alert>{errorMessage(existing.error)}</Alert>;
  return <Editor key={autoReplyId ?? 'new'} rule={existing.data?.autoReply} />;
}

function Card({ step, title, hint, children }: { step: number; title: string; hint: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4">
        <span className="flex size-7 items-center justify-center rounded-full bg-slate-700 text-sm font-semibold text-white">{step}</span>
        <div>
          <h2 className="font-semibold text-ink">{title}</h2>
          <p className="text-xs text-slate-500">{hint}</p>
        </div>
      </div>
      <div className="space-y-5 p-5">{children}</div>
    </section>
  );
}

function Label({ children, htmlFor, required }: { children: ReactNode; htmlFor?: string; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-slate-600">
      {children}
      {required && <span className="text-red-500"> *</span>}
    </label>
  );
}

const textareaClass = 'block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/40 focus:outline-none';

function Editor({ rule }: { rule?: AutoReply }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(() => fromRule(rule));
  const [keywordInput, setKeywordInput] = useState('');
  const [addingKeyword, setAddingKeyword] = useState(false);
  const [showSources, setShowSources] = useState((rule?.sources.length ?? 0) > 0);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const config: Config = draft.configs[draft.actionType] ?? DEFAULT_CONFIG[draft.actionType];
  const setConfig = (patch: Config) => setDraft((d) => ({ ...d, configs: { ...d.configs, [d.actionType]: { ...(d.configs[d.actionType] ?? DEFAULT_CONFIG[d.actionType]), ...patch } } }));
  const listPath = `/w/${workspace.id}/auto-replies`;

  const addKeyword = () => {
    const k = keywordInput.trim();
    if (k && !draft.keywords.some((x) => x.toLowerCase() === k.toLowerCase())) set({ keywords: [...draft.keywords, k] });
    setKeywordInput('');
  };
  const onKeywordKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addKeyword();
    } else if (e.key === 'Escape') setAddingKeyword(false);
  };

  const fallbackName = draft.match === 'event' ? EVENT_LABEL[draft.event] : (draft.keywords[0] ?? '');
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: draft.name.trim() || fallbackName,
        active: draft.active,
        match: draft.match,
        keywords: draft.match === 'event' ? [] : draft.keywords,
        event: draft.match === 'event' ? draft.event : null,
        sources: showSources ? draft.sources : [],
        cooldownMinutes: draft.cooldownMinutes,
        action: { type: draft.actionType, config: clean(config) },
      };
      return rule ? api.put<{ autoReply: AutoReply }>(`/workspaces/${workspace.id}/auto-replies/${rule.id}`, body) : api.post<{ autoReply: AutoReply }>(`/workspaces/${workspace.id}/auto-replies`, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['auto-replies', workspace.id] });
      navigate(listPath);
    },
  });
  const err = save.error;
  const isFieldError = err instanceof ApiError && err.code === 'VALIDATION_ERROR';
  const action = { type: draft.actionType, config };
  const names = useActionNames(action);
  const sample = draft.match === 'event' ? (draft.event === 'first_message' ? 'Hi! 👋' : 'Hello') : (draft.keywords[0] ?? 'your keyword');

  return (
    <div className="-mx-4 -my-6 min-h-full bg-white sm:-mx-6 lg:-mx-8">
      <div className="flex items-center gap-4 border-b border-slate-200 px-6 py-4">
        <Link to={listPath} className="inline-flex items-center gap-1 text-slate-500 hover:text-ink">
          <ChevronLeft className="size-4" /> Back
        </Link>
        <h1 className="font-semibold text-ink">{rule ? 'Edit Auto Reply' : 'Create Auto Reply'}</h1>
      </div>

      <div className="space-y-4 p-4 sm:p-6">
        {err != null && <Alert>{isFieldError ? 'Some fields need attention — see below.' : errorMessage(err)}</Alert>}

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <div className="space-y-5">
            <Card step={1} title="Trigger Condition" hint="When should this auto reply fire?">
              <div>
                <Label>Match type</Label>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ['contains', 'Contains'],
                      ['equals', 'Equal to'],
                      ['event', 'Trigger On Events'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => set({ match: value })}
                      className={cn('rounded-lg border px-3.5 py-1.5 text-sm font-medium', draft.match === value ? 'border-slate-700 bg-slate-700 text-white' : 'border-slate-200 text-slate-700 hover:bg-slate-50')}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  {draft.match === 'equals'
                    ? 'Fires when the whole message is exactly a keyword (case and extra spaces ignored).'
                    : draft.match === 'contains'
                      ? 'Fires when a keyword appears anywhere in the message.'
                      : 'Fires on an event instead of a keyword. Keyword triggers still win when both match.'}
                </p>
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={showSources} onChange={(e) => setShowSources(e.target.checked)} /> Add Source
                  <span title="Only fire for messages from certain places, e.g. people who clicked your Click-to-WhatsApp ad.">
                    <Info className="size-4 text-slate-400" />
                  </span>
                </label>
                {showSources && (
                  <div className="mt-2 flex flex-wrap gap-2 pl-6">
                    {(Object.keys(SOURCE_LABEL) as MessageSource[]).map((s) => (
                      <label key={s} className={cn('flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm', draft.sources.includes(s) ? 'border-slate-500 bg-slate-50' : 'border-slate-200')}>
                        <input
                          type="checkbox"
                          checked={draft.sources.includes(s)}
                          onChange={() => set({ sources: draft.sources.includes(s) ? draft.sources.filter((x) => x !== s) : [...draft.sources, s] })}
                        />
                        {SOURCE_LABEL[s]}
                      </label>
                    ))}
                    <p className="w-full text-xs text-slate-500">None ticked means any source.</p>
                  </div>
                )}
              </div>

              {draft.match === 'event' ? (
                <div>
                  <Label>Event</Label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(Object.keys(EVENT_LABEL) as AutoReplyEvent[]).map((ev) => (
                      <label key={ev} className={cn('cursor-pointer rounded-lg border p-3 text-sm', draft.event === ev ? 'border-slate-600 bg-slate-50' : 'border-slate-200')}>
                        <span className="flex items-center gap-2 font-medium text-slate-800">
                          <input type="radio" name="ar-event" checked={draft.event === ev} onChange={() => set({ event: ev })} /> {EVENT_LABEL[ev]}
                        </span>
                        <span className="mt-1 block text-xs text-slate-500">
                          {ev === 'first_message' ? 'A brand-new customer writes to you for the first time.' : 'Any message no keyword trigger answered.'}
                        </span>
                      </label>
                    ))}
                  </div>
                  {fieldError(err, 'event') && <p className="mt-1 text-xs text-red-600">{fieldError(err, 'event')}</p>}
                </div>
              ) : (
                <div>
                  <Label>Keywords</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    {draft.keywords.map((k) => (
                      <span key={k} className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-1 pr-1.5 pl-3 text-sm text-slate-800">
                        {k}
                        <button type="button" onClick={() => set({ keywords: draft.keywords.filter((x) => x !== k) })} className="rounded-full p-0.5 text-slate-500 hover:bg-slate-200" aria-label={`Remove ${k}`}>
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                    {addingKeyword ? (
                      <Input
                        autoFocus
                        aria-label="New keyword"
                        placeholder="Type and press Enter"
                        maxLength={100}
                        value={keywordInput}
                        onChange={(e) => setKeywordInput(e.target.value)}
                        onKeyDown={onKeywordKey}
                        onBlur={() => {
                          addKeyword();
                          setAddingKeyword(false);
                        }}
                        className="w-48 rounded-full py-1"
                      />
                    ) : (
                      <button type="button" onClick={() => setAddingKeyword(true)} className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-3 py-1 text-sm text-slate-600 hover:bg-slate-50">
                        <Plus className="size-3.5" /> Add Keyword
                      </button>
                    )}
                  </div>
                  {draft.keywords.length === 0 && !addingKeyword && <p className="mt-2 text-xs text-slate-500">No keywords added yet. Click "+ Add Keyword" to begin.</p>}
                  {fieldError(err, 'keywords') && <p className="mt-1 text-xs text-red-600">{fieldError(err, 'keywords')}</p>}
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="ar-name">Flow name</Label>
                  <Input id="ar-name" maxLength={120} placeholder={fallbackName || 'e.g. Price list'} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
                  {fieldError(err, 'name') && <p className="mt-1 text-xs text-red-600">{fieldError(err, 'name')}</p>}
                </div>
                <div>
                  <Label htmlFor="ar-cool">Reply to the same customer</Label>
                  <Select id="ar-cool" value={draft.cooldownMinutes} onChange={(e) => set({ cooldownMinutes: Number(e.target.value) })}>
                    {COOLDOWNS.map((c) => (
                      <option key={c.minutes} value={c.minutes}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Toggle checked={draft.active} onChange={() => set({ active: !draft.active })} label="Active" />
                <span className="text-sm text-slate-700">{draft.active ? 'Active — replies as soon as you save' : 'Off — saved but not replying'}</span>
              </div>
            </Card>

            <div className="hidden lg:block">
              <p className="mb-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">Preview</p>
              <PhonePreview customerText={sample} trigger={draft.match === 'event' ? EVENT_LABEL[draft.event] : sample} action={action} names={names} />
            </div>
          </div>

          <Card step={2} title="Add Action" hint="What should happen when triggered?">
            <div>
              <Label>Response type</Label>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2">
                {ACTION_INFO.map((a) => (
                  <button
                    key={a.type}
                    type="button"
                    disabled={a.soon}
                    title={a.soon ? 'Coming soon (needs WhatsApp Payments)' : undefined}
                    onClick={() => !a.soon && set({ actionType: a.type as AutoReplyActionType })}
                    className={cn(
                      'relative flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 text-center text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                      draft.actionType === a.type ? 'border-slate-400 bg-slate-100 text-ink' : 'border-slate-200 text-slate-600 hover:bg-slate-50',
                    )}
                  >
                    <a.icon className="size-5" />
                    {a.label}
                    {a.soon && <span className="absolute top-1 right-1 rounded bg-slate-100 px-1 text-[9px] text-slate-500">Soon</span>}
                  </button>
                ))}
              </div>
            </div>
            <hr className="border-slate-200" />
            <ActionFields type={draft.actionType} config={config} setConfig={setConfig} err={err} />
            {fieldError(err, 'action') && <p className="text-sm text-red-600">{fieldError(err, 'action')}</p>}
          </Card>
        </div>

        <div className="lg:hidden">
          <p className="mb-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">Preview</p>
          <PhonePreview customerText={sample} trigger={sample} action={action} names={names} />
        </div>
      </div>

      <div className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white px-6 py-3">
        <Button variant="secondary" onClick={() => navigate(listPath)}>
          Cancel
        </Button>
        <Button onClick={() => save.mutate()} loading={save.isPending} className="bg-slate-700 hover:bg-slate-800">
          {rule ? 'Save changes' : 'Create auto reply'}
        </Button>
      </div>
    </div>
  );
}

const PLACEHOLDERS = ['{{first_name}}', '{{name}}', '{{phone}}'];

function BodyText({ value, onChange, label = 'Body Text', id = 'ar-body', max = 1024 }: { value: string; onChange: (v: string) => void; label?: string; id?: string; max?: number }) {
  return (
    <div>
      <Label htmlFor={id} required>
        {label}
      </Label>
      <textarea id={id} rows={5} maxLength={max} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="Write your message here..." className={textareaClass} />
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
        Insert:
        {PLACEHOLDERS.map((p) => (
          <button key={p} type="button" className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700 hover:bg-slate-200" onClick={() => onChange(`${value ?? ''}${p}`)}>
            {p}
          </button>
        ))}
        <span className="ml-auto">
          {(value ?? '').length}/{max}
        </span>
      </div>
    </div>
  );
}

function HeaderFooter({ config, setConfig }: { config: Config; setConfig: (p: Config) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <Label htmlFor="ar-header">Header (optional)</Label>
        <Input id="ar-header" maxLength={60} value={config.header ?? ''} onChange={(e) => setConfig({ header: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="ar-footer">Footer (optional)</Label>
        <Input id="ar-footer" maxLength={60} value={config.footer ?? ''} onChange={(e) => setConfig({ footer: e.target.value })} />
      </div>
    </div>
  );
}

function ActionFields({ type, config, setConfig, err }: { type: AutoReplyActionType; config: Config; setConfig: (p: Config) => void; err: unknown }) {
  const { workspace } = useWorkspace();
  switch (type) {
    case 'text':
    case 'unsubscribe':
      return (
        <>
          {type === 'unsubscribe' && <Alert tone="info">Sends this message, then marks the customer as opted out so they stop receiving broadcasts.</Alert>}
          <BodyText value={config.text} onChange={(text) => setConfig({ text })} max={type === 'text' ? 4096 : 1024} />
        </>
      );
    case 'file': {
      const kind = (config.mediaType ?? 'image') as 'image' | 'video' | 'document' | 'audio';
      return (
        <>
          <div>
            <Label htmlFor="ar-media-type">File type</Label>
            <Select id="ar-media-type" value={kind} onChange={(e) => setConfig({ mediaType: e.target.value, link: undefined, id: undefined, filename: undefined })}>
              <option value="image">Image (JPG, PNG)</option>
              <option value="video">Video (MP4)</option>
              <option value="document">Document (PDF)</option>
              <option value="audio">Audio (MP3, OGG, AAC)</option>
            </Select>
          </div>
          <MediaInput
            key={kind}
            id="ar-media"
            label="File"
            format={kind.toUpperCase() as 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'AUDIO'}
            value={config.link || config.id ? { link: config.link, id: config.id, filename: config.filename } : undefined}
            onChange={(m) => setConfig({ link: m?.link, id: m?.id, filename: m?.filename ?? config.filename })}
          />
          <p className="-mt-3 text-xs text-amber-700">Uploaded files expire on WhatsApp after 30 days. For a reply that runs for months, use a public link.</p>
          {kind === 'document' && (
            <div>
              <Label htmlFor="ar-filename">File name shown to the customer</Label>
              <Input id="ar-filename" placeholder="Brochure.pdf" value={config.filename ?? ''} onChange={(e) => setConfig({ filename: e.target.value })} />
            </div>
          )}
          {kind !== 'audio' && (
            <div>
              <Label htmlFor="ar-caption">Caption (optional)</Label>
              <textarea id="ar-caption" rows={3} maxLength={1024} value={config.caption ?? ''} onChange={(e) => setConfig({ caption: e.target.value })} className={textareaClass} />
            </div>
          )}
        </>
      );
    }
    case 'quick_reply': {
      const buttons: { title: string }[] = config.buttons ?? [];
      return (
        <>
          <HeaderFooter config={config} setConfig={setConfig} />
          <BodyText value={config.text} onChange={(text) => setConfig({ text })} />
          <div>
            <Label>Buttons (up to 3)</Label>
            <div className="space-y-2">
              {buttons.map((b, i) => (
                <div key={i} className="flex gap-2">
                  <Input aria-label={`Button ${i + 1}`} maxLength={20} placeholder={`Button ${i + 1}`} value={b.title} onChange={(e) => setConfig({ buttons: buttons.map((x, j) => (j === i ? { title: e.target.value } : x)) })} />
                  {buttons.length > 1 && (
                    <button type="button" onClick={() => setConfig({ buttons: buttons.filter((_, j) => j !== i) })} className="rounded p-2 text-slate-400 hover:text-red-600" aria-label={`Remove button ${i + 1}`}>
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {buttons.length < 3 && (
              <Button type="button" variant="ghost" className="mt-2" onClick={() => setConfig({ buttons: [...buttons, { title: '' }] })}>
                <Plus className="size-4" /> Add button
              </Button>
            )}
            <p className="mt-1 text-xs text-slate-500">Tip: create keyword triggers for each button title so taps get their own answer.</p>
          </div>
        </>
      );
    }
    case 'cta_url':
      return (
        <>
          <HeaderFooter config={config} setConfig={setConfig} />
          <BodyText value={config.text} onChange={(text) => setConfig({ text })} />
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <div>
              <Label htmlFor="ar-btn" required>
                Button text
              </Label>
              <Input id="ar-btn" maxLength={20} value={config.buttonText ?? ''} onChange={(e) => setConfig({ buttonText: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="ar-url" required>
                Link
              </Label>
              <Input id="ar-url" placeholder="https://" value={config.url ?? ''} onChange={(e) => setConfig({ url: e.target.value.trim() })} />
            </div>
          </div>
        </>
      );
    case 'form':
      return <FormFields config={config} setConfig={setConfig} />;
    case 'chatbot':
      return <ChatbotFields config={config} setConfig={setConfig} />;
    case 'ai_chatbot':
      return <AiFields />;
    case 'location':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ar-lat" required>
              Latitude
            </Label>
            <Input id="ar-lat" type="number" step="any" value={config.latitude ?? ''} onChange={(e) => setConfig({ latitude: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </div>
          <div>
            <Label htmlFor="ar-lng" required>
              Longitude
            </Label>
            <Input id="ar-lng" type="number" step="any" value={config.longitude ?? ''} onChange={(e) => setConfig({ longitude: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </div>
          <div>
            <Label htmlFor="ar-place">Place name</Label>
            <Input id="ar-place" maxLength={100} value={config.name ?? ''} onChange={(e) => setConfig({ name: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="ar-addr">Address</Label>
            <Input id="ar-addr" maxLength={300} value={config.address ?? ''} onChange={(e) => setConfig({ address: e.target.value })} />
          </div>
          <p className="text-xs text-slate-500 sm:col-span-2">Tip: in Google Maps, right-click your shop and click the numbers to copy latitude and longitude.</p>
        </div>
      );
    case 'address':
      return (
        <>
          <Alert tone="info">Asks the customer to fill in a delivery address form inside WhatsApp. Available for Indian and Singapore numbers.</Alert>
          <BodyText value={config.text} onChange={(text) => setConfig({ text })} />
          <div className="w-48">
            <Label htmlFor="ar-country">Country</Label>
            <Select id="ar-country" value={config.country ?? 'IN'} onChange={(e) => setConfig({ country: e.target.value })}>
              <option value="IN">India</option>
              <option value="SG">Singapore</option>
            </Select>
          </div>
        </>
      );
    case 'template':
      return <TemplateFields workspaceId={workspace.id} config={config} setConfig={setConfig} err={err} />;
  }
}

function FormFields({ config, setConfig }: { config: Config; setConfig: (p: Config) => void }) {
  const { workspace } = useWorkspace();
  const forms = useQuery({ queryKey: ['forms', workspace.id], queryFn: () => api.get<{ forms: WaForm[] }>(`/workspaces/${workspace.id}/forms`) });
  const published = forms.data?.forms.filter((f) => f.status === 'published') ?? [];
  return (
    <>
      <div>
        <Label htmlFor="ar-form" required>
          Form
        </Label>
        <Select id="ar-form" value={config.formId ?? ''} onChange={(e) => setConfig({ formId: e.target.value })}>
          <option value="">{forms.isPending ? 'Loading…' : published.length ? 'Choose a published form' : 'No published forms yet'}</option>
          {published.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-slate-500">
          Build forms under{' '}
          <Link to={`/w/${workspace.id}/forms`} className="underline">
            Forms
          </Link>
          .
        </p>
      </div>
      <div>
        <Label htmlFor="ar-form-text">Message (optional)</Label>
        <textarea id="ar-form-text" rows={3} maxLength={1024} placeholder="Defaults to the form's intro" value={config.text ?? ''} onChange={(e) => setConfig({ text: e.target.value })} className={textareaClass} />
      </div>
    </>
  );
}

function ChatbotFields({ config, setConfig }: { config: Config; setConfig: (p: Config) => void }) {
  const { workspace } = useWorkspace();
  const flows = useQuery({ queryKey: ['flows', workspace.id], queryFn: () => api.get<{ flows: FlowSummary[] }>(`/workspaces/${workspace.id}/flows`) });
  const usable = flows.data?.flows.filter((f) => f.publishedVersion > 0) ?? [];
  const chosen = usable.find((f) => f.id === config.flowId);
  return (
    <div>
      <Label htmlFor="ar-flow" required>
        Chatbot flow
      </Label>
      <Select id="ar-flow" value={config.flowId ?? ''} onChange={(e) => setConfig({ flowId: e.target.value })}>
        <option value="">{flows.isPending ? 'Loading…' : usable.length ? 'Choose a published flow' : 'No published flows yet'}</option>
        {usable.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
            {f.status !== 'active' ? ' (inactive)' : ''}
          </option>
        ))}
      </Select>
      {chosen && chosen.status !== 'active' && <p className="mt-1 text-xs text-amber-700">This flow is inactive. Turn it on in Flow Builder or the auto reply will not answer.</p>}
      <p className="mt-1 text-xs text-slate-500">
        The flow starts for the customer as if they triggered it. Build flows in{' '}
        <Link to={`/w/${workspace.id}/flows`} className="underline">
          Flow Builder
        </Link>
        .
      </p>
    </div>
  );
}

function AiFields() {
  const { workspace } = useWorkspace();
  const settings = useQuery({ queryKey: ['ai-settings', workspace.id], queryFn: () => api.get<{ settings: AiSettings }>(`/workspaces/${workspace.id}/ai/settings`) });
  const enabled = settings.data?.settings.enabled;
  return (
    <div className="space-y-3 text-sm text-slate-600">
      <p>Your AI agent answers the message from your knowledge base and hands over to a teammate when it isn't sure.</p>
      {settings.data && !enabled && (
        <Alert>
          The AI agent is off.{' '}
          <Link to={`/w/${workspace.id}/ai`} className="font-medium underline">
            Set it up
          </Link>{' '}
          before using this reply.
        </Alert>
      )}
    </div>
  );
}

const blankSpec = (): VariableSpec => ({ source: 'static', value: '', fallback: '' });

function TemplateFields({ workspaceId, config, setConfig, err }: { workspaceId: string; config: Config; setConfig: (p: Config) => void; err: unknown }) {
  const templates = useQuery({
    queryKey: ['templates', workspaceId, 'APPROVED'],
    queryFn: () => api.get<{ templates: MessageTemplate[] }>(`/workspaces/${workspaceId}/templates?status=APPROVED`),
  });
  const template = templates.data?.templates.find((t) => t.id === config.templateId);
  const fit = (list: VariableSpec[] = [], n: number) => Array.from({ length: n }, (_, i) => list[i] ?? { source: 'field' as const, value: 'first_name', fallback: 'there' });

  // A template saved before its requirements changed gets its slots resized.
  useEffect(() => {
    if (!template) return;
    const r = template.requirements;
    if ((config.headerVariables ?? []).length !== r.header || (config.bodyVariables ?? []).length !== r.body || (config.buttonVariables ?? []).length !== r.buttons.length) {
      setConfig({ headerVariables: fit(config.headerVariables, r.header), bodyVariables: fit(config.bodyVariables, r.body), buttonVariables: Array.from({ length: r.buttons.length }, (_, i) => config.buttonVariables?.[i] ?? blankSpec()) });
    }
  }, [template]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the template changes

  const update = (key: 'headerVariables' | 'bodyVariables' | 'buttonVariables', i: number, spec: VariableSpec) =>
    setConfig({ [key]: (config[key] as VariableSpec[]).map((x, j) => (j === i ? spec : x)) });

  return (
    <>
      <div>
        <Label htmlFor="ar-tpl" required>
          Approved template
        </Label>
        <Select
          id="ar-tpl"
          value={config.templateId ?? ''}
          onChange={(e) => {
            const t = templates.data?.templates.find((x) => x.id === e.target.value);
            setConfig({
              templateId: e.target.value,
              headerVariables: fit([], t?.requirements.header ?? 0),
              bodyVariables: fit([], t?.requirements.body ?? 0),
              buttonVariables: Array.from({ length: t?.requirements.buttons.length ?? 0 }, blankSpec),
              templateExtras: emptyExtras(t?.requirements),
            });
          }}
        >
          <option value="">{templates.data?.templates.length === 0 ? 'No approved templates' : 'Choose a template'}</option>
          {templates.data?.templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.language})
            </option>
          ))}
        </Select>
      </div>
      {template && (
        <>
          {(config.headerVariables ?? []).map((v: VariableSpec, i: number) => (
            <VariableRow key={`h${i}`} label={`Header {{${i + 1}}}`} spec={v} disabled={false} onChange={(s) => update('headerVariables', i, s)} />
          ))}
          {(config.bodyVariables ?? []).map((v: VariableSpec, i: number) => (
            <VariableRow key={`b${i}`} label={`Body {{${i + 1}}}`} spec={v} disabled={false} onChange={(s) => update('bodyVariables', i, s)} />
          ))}
          {template.requirements.buttons.map((b, i) => (
            <VariableRow
              key={`btn${i}`}
              label={b.type === 'COPY_CODE' ? 'Offer code' : `“${b.text}” link`}
              spec={config.buttonVariables?.[i] ?? blankSpec()}
              disabled={false}
              onChange={(s) => update('buttonVariables', i, s)}
            />
          ))}
          <TemplateExtrasFields requirements={template.requirements} value={(config.templateExtras ?? {}) as TemplateExtras} onChange={(templateExtras) => setConfig({ templateExtras })} error={err} shared />
          <TemplatePreview components={template.components} {...extrasPreview((config.templateExtras ?? {}) as TemplateExtras)} />
        </>
      )}
    </>
  );
}

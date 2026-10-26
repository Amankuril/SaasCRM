import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bold,
  ChevronLeft,
  Copy,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Italic,
  Loader2,
  MapPin,
  MessageSquareDashed,
  MousePointerClick,
  Phone,
  Plus,
  Reply,
  Strikethrough,
  Trash2,
  Type,
  Upload,
  Video,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { TemplatePreview } from '../../components/TemplatePreview';
import { Alert, Button, Input, Select, Spinner, cn, errorMessage, fieldError } from '../../components/ui';
import { ApiError, api, type MessageTemplate, type TemplateType, type WaForm } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import {
  BUTTON_LIMITS,
  CATEGORY_LABEL,
  LANGUAGES,
  TYPE_INFO,
  buttonTypesFor,
  componentsToForm,
  defaultButtonText,
  emptyCard,
  emptyForm,
  examplesFor,
  fixedCategory,
  headerFormatsFor,
  previewComponents,
  toDraft,
  toPayload,
  typeInfo,
  variableCount,
  type ButtonDraft,
  type ButtonType,
  type CardDraft,
  type HeaderFormat,
  type TemplateForm,
} from './templateForm';
import { NotConnectedAlert, StatusPill, TemplatesHeader, useConnection } from './shared';

/** /templates/new (type picker, then builder) and /templates/:templateId/edit. */
export function CreateTemplatePage() {
  const { templateId } = useParams();
  const { workspace } = useWorkspace();
  const location = useLocation();
  const prefill = (location.state as { prefill?: TemplateForm } | null)?.prefill;
  const [form, setForm] = useState<TemplateForm | null>(prefill ?? null);

  const existing = useQuery({
    queryKey: ['templates', workspace.id, 'one', templateId],
    queryFn: () => api.get<{ template: MessageTemplate }>(`/workspaces/${workspace.id}/templates/${templateId}`),
    enabled: !!templateId,
    staleTime: Infinity,
  });

  if (templateId) {
    if (existing.isPending) return <Spinner />;
    if (existing.error) {
      return (
        <div className="p-6">
          <Alert>{errorMessage(existing.error)}</Alert>
        </div>
      );
    }
    const t = existing.data.template;
    const initial = t.status === 'DRAFT' && t.draft ? { ...emptyForm((t.draft.type as TemplateType) ?? t.type), ...(t.draft as Partial<TemplateForm>) } : componentsToForm(t);
    return <Builder key={t.id} initial={initial} existing={t} />;
  }

  if (!form) return <TypePicker onPick={(type) => setForm(emptyForm(type))} />;
  return <Builder key={form.type} initial={form} onChangeType={() => setForm(null)} />;
}

function BackToAll() {
  const { workspace } = useWorkspace();
  return (
    <Link to={`/w/${workspace.id}/templates`} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
      <ChevronLeft className="size-4" /> All Templates
    </Link>
  );
}

function TypePicker({ onPick }: { onPick: (type: TemplateType) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TemplatesHeader title="Create Template" description="Design a new template — choose from 8 types including carousel, OTP, and more" actions={<BackToAll />} />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mb-4 flex items-center gap-3">
            <StepNumber n={1} />
            <div>
              <h2 className="font-semibold text-ink">Choose a template type</h2>
              <p className="text-xs text-slate-500">Click a type below to get started</p>
            </div>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {TYPE_INFO.map((t) => (
              <button
                key={t.type}
                onClick={() => onPick(t.type)}
                className="group flex flex-col items-center rounded-xl border border-slate-200 bg-white p-4 text-center transition hover:border-sky-300 hover:bg-sky-50/40 hover:shadow-sm"
              >
                <span className={cn('mb-3 rounded-xl p-2.5', t.tint)}>
                  <t.icon className="size-5" />
                </span>
                <span className="text-sm font-semibold text-slate-800 group-hover:text-sky-700">{t.label}</span>
                <span className="mt-1 text-xs text-slate-500">{t.description}</span>
              </button>
            ))}
          </div>
        </div>
        <PreviewPanel>
          <div className="wa-wallpaper flex aspect-[4/5] flex-col items-center justify-center gap-2 rounded-xl text-center text-xs text-slate-400">
            <MessageSquareDashed className="size-6" />
            Type in the form to see
            <br />
            your template preview
          </div>
        </PreviewPanel>
      </div>
    </div>
  );
}

function PreviewPanel({ children }: { children: ReactNode }) {
  return (
    <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-slate-200 bg-white p-4 lg:block xl:w-80">
      <p className="mb-3 text-center text-xs font-semibold tracking-wider text-slate-500 uppercase">Preview</p>
      {children}
      <p className="mt-3 text-center text-xs text-slate-500">This needs to be approved by WhatsApp before sending.</p>
    </aside>
  );
}

function StepNumber({ n }: { n: number }) {
  return <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-700 text-xs font-semibold text-white">{n}</span>;
}

function Section({ n, title, optional, children }: { n: number; title: string; optional?: boolean; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex size-6 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{n}</span>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
        </div>
        {optional && <span className="text-xs text-slate-400">optional</span>}
      </div>
      {children}
    </section>
  );
}

function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-slate-600">
      {children}
    </label>
  );
}

function FieldErr({ err, field }: { err: unknown; field: string }) {
  const msg = fieldError(err, field);
  return msg ? <p className="mt-2 text-xs text-red-600">{msg}</p> : null;
}

const HEADER_ICONS: Record<HeaderFormat, LucideIcon | null> = { NONE: null, TEXT: Type, IMAGE: ImageIcon, VIDEO: Video, DOCUMENT: FileText, LOCATION: MapPin };

const BUTTON_CHIPS: Record<ButtonType, { label: string; icon: LucideIcon; style: string }> = {
  URL: { label: 'Website URL', icon: ExternalLink, style: 'border-sky-200 bg-sky-50 text-sky-700' },
  PHONE_NUMBER: { label: 'Phone Number', icon: Phone, style: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  COPY_CODE: { label: 'Copy Code', icon: Copy, style: 'border-orange-200 bg-orange-50 text-orange-700' },
  QUICK_REPLY: { label: 'Quick Reply', icon: Reply, style: 'border-violet-200 bg-violet-50 text-violet-700' },
  FLOW: { label: 'Form', icon: Workflow, style: 'border-indigo-200 bg-indigo-50 text-indigo-700' },
};

function Builder({ initial, existing, onChangeType }: { initial: TemplateForm; existing?: MessageTemplate; onChangeType?: () => void }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const connection = useConnection();
  const [form, setForm] = useState<TemplateForm>(initial);
  const set = (patch: Partial<TemplateForm>) => setForm((f) => ({ ...f, ...patch }));

  const isDraft = !existing || existing.status === 'DRAFT';
  const submitted = !!existing && !isDraft;
  const canManage = can('templates:manage') && workspace.status !== 'suspended';
  const info = typeInfo(form.type);
  const lockedCategory = fixedCategory(form.type);
  const headerFormats = headerFormatsFor(form.type);
  const listPath = `/w/${workspace.id}/templates`;

  const done = (flash: string) => {
    void queryClient.invalidateQueries({ queryKey: ['templates', workspace.id] });
    navigate(listPath, { state: { flash } });
  };
  const submit = useMutation({
    mutationFn: () =>
      submitted
        ? api.put<{ template: MessageTemplate }>(`/workspaces/${workspace.id}/templates/${existing.id}`, toPayload(form))
        : api.post<{ template: MessageTemplate }>(`/workspaces/${workspace.id}/templates${existing ? `?draftId=${existing.id}` : ''}`, toPayload(form)),
    onSuccess: ({ template }) => done(`"${template.name}" was ${submitted ? 'updated and resubmitted' : 'submitted'} for WhatsApp review.`),
  });
  const saveDraft = useMutation({
    mutationFn: () => api.post<{ template: MessageTemplate }>(`/workspaces/${workspace.id}/templates/drafts${existing ? `?draftId=${existing.id}` : ''}`, toDraft(form)),
    onSuccess: ({ template }) => done(`Draft "${template.name}" saved.`),
  });
  const err = submit.error ?? saveDraft.error;
  const isFieldError = err instanceof ApiError && err.code === 'VALIDATION_ERROR';

  const preview = (
    <TemplatePreview
      components={previewComponents(form)}
      headerParams={[form.headerExample]}
      bodyParams={examplesFor(form.body, form.bodyExamples)}
      mediaUrl={form.headerPreviewUrl}
      cardMediaUrls={form.cards.map((c) => c.previewUrl)}
      cardBodyParams={form.cards.map((c) => examplesFor(c.body, c.examples))}
    />
  );

  let step = 1;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TemplatesHeader
        title={existing ? (isDraft ? 'Edit Draft' : 'Edit Template') : 'Create Template'}
        description={
          submitted ? 'Edits are sent to WhatsApp for review again. Name and language cannot change.' : 'Design a new template — choose from 8 types including carousel, OTP, and more'
        }
        actions={<BackToAll />}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
            <div className="flex flex-wrap items-center gap-3">
              <span className={cn('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium', info.tint)}>
                <info.icon className="size-4" /> {info.label}
              </span>
              {onChangeType && (
                <button onClick={onChangeType} className="text-sm text-slate-500 hover:text-ink hover:underline">
                  Change type
                </button>
              )}
              {existing && <StatusPill status={existing.status} />}
            </div>

            {connection.loaded && !connection.connected && <NotConnectedAlert />}
            {existing?.rejectedReason && <Alert>Rejected by WhatsApp: {existing.rejectedReason.replace(/_/g, ' ').toLowerCase()}. Fix the content and resubmit.</Alert>}
            {err != null && !isFieldError && <Alert>{errorMessage(err)}</Alert>}
            {isFieldError && <Alert>Some fields need attention — see the highlighted sections below.</Alert>}

            <Section n={step++} title="Template Details">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <Label htmlFor="tpl-name">
                    Template name * <span className="float-right font-normal text-slate-400">{form.name.length}/512</span>
                  </Label>
                  <Input
                    id="tpl-name"
                    placeholder="my_template_name"
                    maxLength={512}
                    value={form.name}
                    disabled={submitted}
                    invalid={!!fieldError(err, 'name')}
                    onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
                  />
                  <FieldErr err={err} field="name" />
                </div>
                <div>
                  <Label htmlFor="tpl-cat">Category</Label>
                  <Select
                    id="tpl-cat"
                    value={form.category}
                    disabled={!!lockedCategory || existing?.status === 'APPROVED'}
                    onChange={(e) => set({ category: e.target.value as TemplateForm['category'] })}
                  >
                    {(lockedCategory ? [lockedCategory] : (['MARKETING', 'UTILITY'] as const)).map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABEL[c]}
                      </option>
                    ))}
                  </Select>
                  <FieldErr err={err} field="category" />
                </div>
                <div>
                  <Label htmlFor="tpl-lang">Language</Label>
                  <Select id="tpl-lang" value={form.language} disabled={submitted} onChange={(e) => set({ language: e.target.value })}>
                    {!LANGUAGES.some((l) => l.code === form.language) && <option value={form.language}>{form.language}</option>}
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              {form.category === 'MARKETING' && form.type === 'CUSTOM' && (
                <p className="mt-3 text-xs text-slate-500">Marketing templates are for offers and promotions. Use Utility for order updates, reminders and alerts.</p>
              )}
            </Section>

            {form.type === 'AUTHENTICATION' ? (
              <OtpSection n={step++} form={form} set={set} err={err} />
            ) : (
              <>
                {headerFormats.length > 0 && (
                  <Section n={step++} title="Header" optional={headerFormats.includes('NONE')}>
                    <Label>Format{headerFormats.includes('NONE') ? ' (optional)' : ''}</Label>
                    <div className="flex flex-wrap gap-2">
                      {headerFormats.map((f) => {
                        const Icon = HEADER_ICONS[f];
                        return (
                          <button
                            key={f}
                            type="button"
                            onClick={() => set({ headerFormat: f, headerHandle: '', headerPreviewUrl: undefined, headerFileName: undefined })}
                            className={cn(
                              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors',
                              form.headerFormat === f ? 'border-slate-600 bg-slate-600 text-white' : 'border-slate-200 text-slate-600 hover:bg-slate-50',
                            )}
                          >
                            {Icon && <Icon className="size-3.5" />}
                            {f === 'NONE' ? 'None' : f.charAt(0) + f.slice(1).toLowerCase()}
                          </button>
                        );
                      })}
                    </div>

                    {form.headerFormat === 'TEXT' && (
                      <div className="mt-4 space-y-3">
                        <div>
                          <Label htmlFor="tpl-header">
                            Header text <span className="float-right font-normal text-slate-400">{form.headerText.length}/60</span>
                          </Label>
                          <div className="flex gap-2">
                            <Input id="tpl-header" maxLength={60} value={form.headerText} onChange={(e) => set({ headerText: e.target.value })} placeholder="e.g. Your order is on its way" />
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={variableCount(form.headerText) > 0 || form.headerText.length > 54}
                              onClick={() => set({ headerText: `${form.headerText}{{1}}` })}
                              title="Add variable"
                            >
                              <Plus className="size-4" /> Variable
                            </Button>
                          </div>
                        </div>
                        {variableCount(form.headerText) > 0 && (
                          <div>
                            <Label htmlFor="tpl-hex">Example for {'{{1}}'}</Label>
                            <Input id="tpl-hex" value={form.headerExample} onChange={(e) => set({ headerExample: e.target.value })} placeholder="e.g. Priya" />
                          </div>
                        )}
                      </div>
                    )}
                    {(form.headerFormat === 'IMAGE' || form.headerFormat === 'VIDEO' || form.headerFormat === 'DOCUMENT') && (
                      <div className="mt-4">
                        <MediaUpload
                          format={form.headerFormat}
                          handle={form.headerHandle}
                          previewUrl={form.headerPreviewUrl}
                          fileName={form.headerFileName}
                          disabled={!connection.connected}
                          onChange={(m) => set({ headerHandle: m.handle, headerPreviewUrl: m.previewUrl, headerFileName: m.fileName })}
                        />
                      </div>
                    )}
                    {form.headerFormat === 'LOCATION' && (
                      <p className="mt-4 text-xs text-slate-500">The location (latitude, longitude, name and address) is chosen when you send the template.</p>
                    )}
                    <FieldErr err={err} field="header" />
                  </Section>
                )}

                {form.type === 'LIMITED_TIME_OFFER' && (
                  <Section n={step++} title="Offer">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="tpl-offer">
                          Offer headline * <span className="float-right font-normal text-slate-400">{form.offerText.length}/16</span>
                        </Label>
                        <Input id="tpl-offer" maxLength={16} value={form.offerText} onChange={(e) => set({ offerText: e.target.value })} placeholder="e.g. Flash sale!" />
                      </div>
                      <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700">
                        <input type="checkbox" checked={form.offerHasExpiration} onChange={(e) => set({ offerHasExpiration: e.target.checked })} className="size-4 rounded border-slate-300" />
                        Show a countdown (expiry is set when sending)
                      </label>
                    </div>
                    <FieldErr err={err} field="offer" />
                  </Section>
                )}

                <Section n={step++} title="Message">
                  <BodyEditor
                    id="tpl-body"
                    label={`Body * (max ${form.type === 'LIMITED_TIME_OFFER' ? 600 : 1024} chars)`}
                    max={form.type === 'LIMITED_TIME_OFFER' ? 600 : 1024}
                    text={form.body}
                    examples={form.bodyExamples}
                    onText={(body) => set({ body })}
                    onExamples={(bodyExamples) => set({ bodyExamples })}
                  />
                  <FieldErr err={err} field="body" />
                  {!['LIMITED_TIME_OFFER', 'CAROUSEL'].includes(form.type) && (
                    <div className="mt-4">
                      <Label htmlFor="tpl-footer">Footer (optional, max 60 chars)</Label>
                      <Input id="tpl-footer" maxLength={60} value={form.footer} onChange={(e) => set({ footer: e.target.value })} />
                      {form.category === 'MARKETING' && <p className="mt-1 text-xs text-slate-500">Default opt-out text — recommended for compliance.</p>}
                      <FieldErr err={err} field="footer" />
                    </div>
                  )}
                </Section>

                {form.type === 'CAROUSEL' ? (
                  <CardsSection n={step++} form={form} set={set} err={err} disabled={!connection.connected} />
                ) : (
                  <Section n={step++} title="Buttons" optional={!['FLOW', 'LIMITED_TIME_OFFER'].includes(form.type)}>
                    {form.type === 'FLOW' ? (
                      <FlowButton button={form.buttons[0] ?? { type: 'FLOW', text: 'Open form', formId: '' }} onChange={(b) => set({ buttons: [b] })} />
                    ) : form.type === 'CATALOG' || form.type === 'MULTI_PRODUCT' ? (
                      <p className="text-sm text-slate-600">
                        A <strong>{form.type === 'CATALOG' ? 'View catalog' : 'View items'}</strong> button is added automatically. It opens products from the catalog connected to your WhatsApp
                        Business account; {form.type === 'MULTI_PRODUCT' ? 'the products are chosen when you send.' : 'the thumbnail product is chosen when you send.'}
                      </p>
                    ) : form.type === 'CALL_PERMISSION' ? (
                      <p className="text-sm text-slate-600">WhatsApp adds an “Allow calls” prompt under the message. Customers who accept can receive business calls from you.</p>
                    ) : (
                      <ButtonsEditor buttons={form.buttons} allowed={buttonTypesFor(form.type)} onChange={(buttons) => set({ buttons })} />
                    )}
                    <FieldErr err={err} field="buttons" />
                  </Section>
                )}
              </>
            )}

            <div className="lg:hidden">
              <p className="mb-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">Preview</p>
              {preview}
            </div>
          </div>

          {canManage && (
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 bg-white px-4 py-3 sm:px-6">
              {isDraft && (
                <Button variant="secondary" onClick={() => saveDraft.mutate()} loading={saveDraft.isPending} disabled={submit.isPending}>
                  Save as Draft
                </Button>
              )}
              <Button
                onClick={() => submit.mutate()}
                loading={submit.isPending}
                disabled={saveDraft.isPending || !connection.connected}
                className="bg-slate-700 hover:bg-slate-800"
              >
                {submitted ? 'Save & Resubmit' : 'Submit for Approval'}
              </Button>
              {!connection.connected && connection.loaded && <span className="text-xs text-slate-500">Connect WhatsApp to submit. You can still save a draft.</span>}
            </div>
          )}
        </div>
        <PreviewPanel>{preview}</PreviewPanel>
      </div>
    </div>
  );
}

/** Body textarea with formatting/variable toolbar and one example input per variable. */
function BodyEditor({
  id,
  label,
  max,
  text,
  examples,
  onText,
  onExamples,
}: {
  id: string;
  label: string;
  max: number;
  text: string;
  examples: string[];
  onText: (text: string) => void;
  onExamples: (examples: string[]) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const values = examplesFor(text, examples);

  const wrap = (mark: string) => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const selected = text.slice(s, e) || 'text';
    onText(`${text.slice(0, s)}${mark}${selected}${mark}${text.slice(e)}`);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + mark.length, s + mark.length + selected.length);
    });
  };
  const addVariable = () => {
    const el = ref.current;
    const at = el?.selectionStart ?? text.length;
    const token = `{{${variableCount(text) + 1}}}`;
    onText(`${text.slice(0, at)}${token}${text.slice(at)}`);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const tool = 'rounded p-1.5 text-slate-500 hover:bg-slate-200 hover:text-ink';
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="overflow-hidden rounded-lg border border-slate-300 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/40">
        <div className="flex items-center gap-0.5 border-b border-slate-200 bg-slate-50 px-1.5 py-1">
          <button type="button" className={tool} onClick={() => wrap('*')} title="Bold" aria-label="Bold">
            <Bold className="size-3.5" />
          </button>
          <button type="button" className={tool} onClick={() => wrap('_')} title="Italic" aria-label="Italic">
            <Italic className="size-3.5" />
          </button>
          <button type="button" className={tool} onClick={() => wrap('~')} title="Strikethrough" aria-label="Strikethrough">
            <Strikethrough className="size-3.5" />
          </button>
          <span className="mx-1 h-4 w-px bg-slate-300" />
          <button type="button" className="rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200" onClick={addVariable}>
            + Add variable
          </button>
        </div>
        <textarea
          ref={ref}
          id={id}
          rows={5}
          maxLength={max}
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder="Hi {{1}}, thanks for your order! ..."
          className="block w-full resize-y border-0 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
        />
        <div className="flex justify-between border-t border-slate-100 bg-slate-50 px-3 py-1.5 text-xs text-slate-500">
          <span>Use {'{{1}}'}, {'{{2}}'} for variables</span>
          <span>
            {text.length}/{max}
          </span>
        </div>
      </div>
      {values.length > 0 && (
        <div className="mt-3 rounded-lg bg-slate-50 p-3">
          <p className="mb-2 text-xs font-medium text-slate-600">Sample values (shown to WhatsApp reviewers)</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {values.map((v, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-10 shrink-0 font-mono text-xs text-slate-500">{`{{${i + 1}}}`}</span>
                <Input aria-label={`Example for {{${i + 1}}}`} value={v} onChange={(e) => onExamples(values.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Sample ${i + 1}`} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ButtonsEditor({ buttons, allowed, onChange }: { buttons: ButtonDraft[]; allowed: ButtonType[]; onChange: (b: ButtonDraft[]) => void }) {
  const count = (t: ButtonType) => buttons.filter((b) => b.type === t).length;
  const canAdd = (t: ButtonType) => buttons.length < 10 && count(t) < (BUTTON_LIMITS[t] ?? 10);
  const update = (i: number, patch: Partial<ButtonDraft>) => onChange(buttons.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  return (
    <div>
      <div className="flex flex-wrap justify-center gap-2">
        {allowed.map((t) => {
          const chip = BUTTON_CHIPS[t];
          return (
            <button
              key={t}
              type="button"
              disabled={!canAdd(t)}
              onClick={() => onChange([...buttons, { type: t, text: '', ...(t === 'URL' ? { url: '' } : t === 'PHONE_NUMBER' ? { phone: '' } : {}) }])}
              className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40', chip.style)}
            >
              <chip.icon className="size-3.5" /> {chip.label}
            </button>
          );
        })}
      </div>
      {buttons.length === 0 ? (
        <div className="flex flex-col items-center py-6 text-center">
          <span className="mb-2 rounded-full bg-slate-100 p-2.5 text-slate-500">
            <MousePointerClick className="size-5" />
          </span>
          <p className="text-sm font-semibold text-slate-800">No buttons added yet</p>
          <p className="mt-1 text-xs text-slate-500">Max 10 total · 2 URL · 1 Call · 1 Copy Code · 10 Quick Reply</p>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {buttons.map((b, i) => (
            <ButtonRow key={i} button={b} onChange={(patch) => update(i, patch)} onRemove={() => onChange(buttons.filter((_, j) => j !== i))} />
          ))}
          {buttons.length > 3 && <p className="text-xs text-slate-500">With more than 3 buttons, WhatsApp shows the first two and a “See all options” list.</p>}
        </div>
      )}
    </div>
  );
}

function ButtonRow({ button: b, onChange, onRemove, removable = true }: { button: ButtonDraft; onChange: (patch: Partial<ButtonDraft>) => void; onRemove: () => void; removable?: boolean }) {
  const chip = BUTTON_CHIPS[b.type];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-2">
      <span className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium', chip.style)}>
        <chip.icon className="size-3" /> {chip.label}
      </span>
      {b.type === 'COPY_CODE' ? (
        <Input aria-label="Offer code" placeholder="Offer code, e.g. SAVE20" maxLength={15} value={b.example ?? ''} className="min-w-40 flex-1" onChange={(e) => onChange({ example: e.target.value })} />
      ) : (
        <Input aria-label="Button text" placeholder={defaultButtonText(b.type)} maxLength={25} value={b.text} className="w-40" onChange={(e) => onChange({ text: e.target.value })} />
      )}
      {b.type === 'URL' && (
        <>
          <Input aria-label="URL" placeholder="https://example.com/{{1}}" value={b.url ?? ''} className="min-w-48 flex-1" onChange={(e) => onChange({ url: e.target.value.trim() })} />
          {!b.url?.includes('{{1}}') ? (
            <button type="button" className="text-xs font-medium text-sky-700 hover:underline" onClick={() => onChange({ url: `${b.url ?? ''}{{1}}` })} title="Personalise the end of the link">
              + Variable
            </button>
          ) : (
            <Input aria-label="URL variable example" placeholder="Example for {{1}}" value={b.example ?? ''} className="w-40" onChange={(e) => onChange({ example: e.target.value })} />
          )}
        </>
      )}
      {b.type === 'PHONE_NUMBER' && (
        <Input aria-label="Phone" placeholder="+919876543210" value={b.phone ?? ''} className="min-w-40 flex-1" onChange={(e) => onChange({ phone: e.target.value.replace(/[^\d+]/g, '') })} />
      )}
      {removable && (
        <button type="button" onClick={onRemove} className="ml-auto rounded p-1 text-slate-400 hover:text-red-600" aria-label="Remove button">
          <Trash2 className="size-4" />
        </button>
      )}
    </div>
  );
}

function FlowButton({ button, onChange }: { button: ButtonDraft; onChange: (b: ButtonDraft) => void }) {
  const { workspace } = useWorkspace();
  const forms = useQuery({ queryKey: ['forms', workspace.id], queryFn: () => api.get<{ forms: WaForm[] }>(`/workspaces/${workspace.id}/forms`) });
  const published = forms.data?.forms.filter((f) => f.status === 'published') ?? [];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <Label htmlFor="tpl-flow-form">Form (WhatsApp Flow) *</Label>
        <Select id="tpl-flow-form" value={button.formId ?? ''} onChange={(e) => onChange({ ...button, formId: e.target.value })}>
          <option value="">{forms.isPending ? 'Loading…' : published.length ? 'Choose a published form' : 'No published forms yet'}</option>
          {published.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-slate-500">
          Build and publish forms under{' '}
          <Link to={`/w/${workspace.id}/forms`} className="underline">
            Forms
          </Link>
          .
        </p>
      </div>
      <div>
        <Label htmlFor="tpl-flow-text">Button text *</Label>
        <Input id="tpl-flow-text" maxLength={25} value={button.text} onChange={(e) => onChange({ ...button, text: e.target.value })} placeholder="Open form" />
      </div>
    </div>
  );
}

function OtpSection({ n, form, set, err }: { n: number; form: TemplateForm; set: (p: Partial<TemplateForm>) => void; err: unknown }) {
  return (
    <Section n={n} title="Code delivery">
      <p className="mb-4 text-sm text-slate-600">
        WhatsApp writes the message for you: “<strong>123456</strong> is your verification code.” You choose how the code is delivered and what is added.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {(
          [
            ['COPY_CODE', 'Copy code', 'Customer taps a button to copy the code.'],
            ['ONE_TAP', 'One-tap autofill', 'Your Android app fills the code in automatically.'],
          ] as const
        ).map(([value, title, hint]) => (
          <label key={value} className={cn('cursor-pointer rounded-lg border p-3', form.otpType === value ? 'border-slate-600 bg-slate-50' : 'border-slate-200')}>
            <span className="flex items-center gap-2 text-sm font-medium text-slate-800">
              <input type="radio" name="otp-type" checked={form.otpType === value} onChange={() => set({ otpType: value })} />
              {title}
            </span>
            <span className="mt-1 block text-xs text-slate-500">{hint}</span>
          </label>
        ))}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="otp-btn">Button text</Label>
          <Input id="otp-btn" maxLength={25} value={form.otpButtonText} onChange={(e) => set({ otpButtonText: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="otp-exp">Code expires after (minutes, optional)</Label>
          <Input id="otp-exp" type="number" min={1} max={90} value={form.expiryMinutes} onChange={(e) => set({ expiryMinutes: e.target.value })} />
        </div>
        {form.otpType === 'ONE_TAP' && (
          <>
            <div>
              <Label htmlFor="otp-pkg">Android package name *</Label>
              <Input id="otp-pkg" placeholder="com.example.app" value={form.packageName} onChange={(e) => set({ packageName: e.target.value.trim() })} />
            </div>
            <div>
              <Label htmlFor="otp-hash">App signature hash *</Label>
              <Input id="otp-hash" placeholder="11-character hash" maxLength={11} value={form.signatureHash} onChange={(e) => set({ signatureHash: e.target.value.trim() })} />
            </div>
            <div>
              <Label htmlFor="otp-fill">Autofill button text</Label>
              <Input id="otp-fill" maxLength={25} value={form.autofillText} onChange={(e) => set({ autofillText: e.target.value })} />
            </div>
          </>
        )}
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={form.securityRecommendation} onChange={(e) => set({ securityRecommendation: e.target.checked })} className="size-4 rounded border-slate-300" />
        Add “For your security, do not share this code.”
      </label>
      <FieldErr err={err} field="otp" />
    </Section>
  );
}

function CardsSection({ n, form, set, err, disabled }: { n: number; form: TemplateForm; set: (p: Partial<TemplateForm>) => void; err: unknown; disabled: boolean }) {
  const cards = form.cards;
  const updateCard = (i: number, patch: Partial<CardDraft>) => set({ cards: cards.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  // Every card must share the same media type and button layout, so those change on all cards at once.
  const layout = cards[0]?.buttons.map((b) => b.type) ?? [];
  const addButton = (t: ButtonType) => set({ cards: cards.map((c) => ({ ...c, buttons: [...c.buttons, { type: t, text: '', ...(t === 'URL' ? { url: '' } : t === 'PHONE_NUMBER' ? { phone: '' } : {}) }] })) });
  const removeButton = (k: number) => set({ cards: cards.map((c) => ({ ...c, buttons: c.buttons.filter((_, j) => j !== k) })) });
  const setFormat = (format: CardDraft['format']) => set({ cards: cards.map((c) => ({ ...c, format, handle: '', previewUrl: undefined })) });

  return (
    <Section n={n} title={`Cards (${cards.length}/10)`}>
      <div className="mb-4 flex flex-wrap items-center gap-4 rounded-lg bg-slate-50 p-3 text-sm">
        <span className="text-xs font-medium text-slate-600">All cards use</span>
        <div className="flex gap-1">
          {(['IMAGE', 'VIDEO'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFormat(f)}
              className={cn('rounded-full border px-3 py-0.5 text-xs', cards[0]?.format === f ? 'border-slate-600 bg-slate-600 text-white' : 'border-slate-200 bg-white text-slate-600')}
            >
              {f === 'IMAGE' ? 'Images' : 'Videos'}
            </button>
          ))}
        </div>
        <span className="text-xs font-medium text-slate-600">Buttons</span>
        <div className="flex flex-wrap gap-1">
          {layout.map((t, k) => (
            <span key={k} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs', BUTTON_CHIPS[t].style)}>
              {BUTTON_CHIPS[t].label}
              {layout.length > 1 && (
                <button type="button" onClick={() => removeButton(k)} aria-label={`Remove ${BUTTON_CHIPS[t].label}`}>
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
          {layout.length < 2 &&
            (['QUICK_REPLY', 'URL', 'PHONE_NUMBER'] as const)
              .filter((t) => !(t === 'PHONE_NUMBER' && layout.includes(t)))
              .map((t) => (
                <button key={t} type="button" onClick={() => addButton(t)} className="rounded-full border border-dashed border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50">
                  + {BUTTON_CHIPS[t].label}
                </button>
              ))}
        </div>
      </div>

      <div className="space-y-4">
        {cards.map((card, i) => (
          <div key={i} className="rounded-lg border border-slate-200 p-3">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-700">Card {i + 1}</p>
              {cards.length > 2 && (
                <button type="button" onClick={() => set({ cards: cards.filter((_, j) => j !== i) })} className="rounded p-1 text-slate-400 hover:text-red-600" aria-label={`Remove card ${i + 1}`}>
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
            <div className="grid gap-3 md:grid-cols-[180px_1fr]">
              <MediaUpload
                format={card.format}
                handle={card.handle}
                previewUrl={card.previewUrl}
                disabled={disabled}
                compact
                onChange={(m) => updateCard(i, { handle: m.handle, previewUrl: m.previewUrl })}
              />
              <div className="space-y-2">
                <BodyEditor
                  id={`card-body-${i}`}
                  label="Card text * (max 160 chars)"
                  max={160}
                  text={card.body}
                  examples={card.examples}
                  onText={(body) => updateCard(i, { body })}
                  onExamples={(examples) => updateCard(i, { examples })}
                />
                {card.buttons.map((b, k) => (
                  <ButtonRow key={k} button={b} removable={false} onRemove={() => {}} onChange={(patch) => updateCard(i, { buttons: card.buttons.map((x, j) => (j === k ? { ...x, ...patch } : x)) })} />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      {cards.length < 10 && (
        <Button
          type="button"
          variant="secondary"
          className="mt-3"
          onClick={() => set({ cards: [...cards, { ...emptyCard(), format: cards[0]?.format ?? 'IMAGE', buttons: (cards[0]?.buttons ?? []).map((b) => ({ ...b, text: '', url: b.url ? '' : undefined, example: undefined })) }] })}
        >
          <Plus className="size-4" /> Add card
        </Button>
      )}
      <FieldErr err={err} field="cards" />
    </Section>
  );
}

const MEDIA_ACCEPT: Record<string, { accept: string; maxMb: number; hint: string }> = {
  IMAGE: { accept: 'image/jpeg,image/png', maxMb: 5, hint: 'JPG or PNG, up to 5 MB' },
  VIDEO: { accept: 'video/mp4', maxMb: 16, hint: 'MP4, up to 16 MB' },
  DOCUMENT: { accept: 'application/pdf', maxMb: 16, hint: 'PDF, up to 16 MB' },
};

/** Uploads a sample file to WhatsApp (Meta needs one for review) and keeps a local preview. */
function MediaUpload({
  format,
  handle,
  previewUrl,
  fileName,
  disabled,
  compact = false,
  onChange,
}: {
  format: string;
  handle: string;
  previewUrl?: string;
  fileName?: string;
  disabled?: boolean;
  compact?: boolean;
  onChange: (m: { handle: string; previewUrl?: string; fileName?: string }) => void;
}) {
  const { workspace } = useWorkspace();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const spec = MEDIA_ACCEPT[format] ?? MEDIA_ACCEPT.IMAGE!;
  const upload = useMutation({
    mutationFn: (file: File) => api.upload<{ handle: string }>(`/workspaces/${workspace.id}/templates/media`, file),
  });

  // Release object URLs we created when they are replaced.
  useEffect(() => () => void (previewUrl?.startsWith('blob:') && URL.revokeObjectURL(previewUrl)), [previewUrl]);

  const pick = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!spec.accept.split(',').includes(file.type)) return setError(`Use ${spec.hint.split(',')[0]}.`);
    if (file.size > spec.maxMb * 1024 * 1024) return setError(`The file is larger than ${spec.maxMb} MB.`);
    upload.mutate(file, {
      onSuccess: ({ handle }) => onChange({ handle, previewUrl: format === 'DOCUMENT' ? undefined : URL.createObjectURL(file), fileName: file.name }),
      onError: (e) => setError(errorMessage(e)),
    });
  };

  const hasFile = !!handle;
  return (
    <div>
      <input ref={input} type="file" accept={spec.accept} className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? undefined)} />
      <button
        type="button"
        disabled={disabled || upload.isPending}
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!disabled) pick(e.dataTransfer.files[0]);
        }}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-1.5 overflow-hidden rounded-lg border-2 border-dashed text-center text-xs text-slate-500 transition-colors hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-60',
          compact ? 'aspect-square' : 'py-6',
          hasFile ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-300',
        )}
      >
        {upload.isPending ? (
          <>
            <Loader2 className="size-5 animate-spin" /> Uploading to WhatsApp…
          </>
        ) : hasFile && previewUrl && format === 'IMAGE' ? (
          <img src={previewUrl} alt="" className="max-h-40 rounded object-contain" />
        ) : hasFile ? (
          <>
            <FileText className="size-5 text-emerald-600" />
            <span className="font-medium text-slate-700">{fileName ?? 'Sample uploaded'}</span>
            <span>Click to replace</span>
          </>
        ) : (
          <>
            <Upload className="size-5" />
            <span className="font-medium text-slate-700">Upload sample {format.toLowerCase()}</span>
            <span>{spec.hint}</span>
          </>
        )}
      </button>
      {disabled && !hasFile && <p className="mt-1 text-xs text-slate-500">Connect WhatsApp to upload media.</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

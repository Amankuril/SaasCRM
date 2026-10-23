import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, ChevronLeft, ChevronRight, Plus, Send, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Modal } from '../components/crm';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, cn, errorMessage } from '../components/ui';
import { ApiError, api, type FormField, type FormFieldType, type WaForm } from '../lib/api';
import { formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';
import { FORM_STATUS } from './FormsPage';

const FIELD_TYPES: { value: FormFieldType; label: string }[] = [
  { value: 'short_text', label: 'Short text' },
  { value: 'long_text', label: 'Paragraph' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'number', label: 'Number' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'radio', label: 'Single choice' },
  { value: 'checkbox', label: 'Multiple choice' },
  { value: 'date', label: 'Date' },
  { value: 'opt_in', label: 'Consent checkbox' },
];
const HAS_OPTIONS = new Set<FormFieldType>(['dropdown', 'radio', 'checkbox']);
const slug = (s: string, fallback: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 30) || fallback;

export function FormBuilderPage() {
  const { formId } = useParams();
  const { workspace } = useWorkspace();
  const query = useQuery({ queryKey: ['form', workspace.id, formId], queryFn: () => api.get<{ form: WaForm }>(`/workspaces/${workspace.id}/forms/${formId}`) });
  if (query.isPending) return <Spinner />;
  if (query.error) return <Alert>{errorMessage(query.error)}</Alert>;
  return <Builder key={query.data.form.id} initial={query.data.form} />;
}

function Builder({ initial }: { initial: WaForm }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const editable = can('forms:manage') && workspace.status !== 'suspended';
  const [form, setForm] = useState(initial);
  const [tab, setTab] = useState<'build' | 'submissions'>('build');
  const [issues, setIssues] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const set = (patch: Partial<WaForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setNotice(null);
  };
  const setField = (i: number, patch: Partial<FormField>) => set({ fields: form.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  const body = () => ({
    name: form.name,
    intro: form.intro,
    ctaText: form.ctaText,
    screenTitle: form.screenTitle,
    submitLabel: form.submitLabel,
    successMessage: form.successMessage,
    fields: form.fields,
  });
  const store = (f: WaForm) => {
    setForm(f);
    queryClient.setQueryData(['form', workspace.id, f.id], { form: f });
    void queryClient.invalidateQueries({ queryKey: ['forms', workspace.id] });
  };
  const save = useMutation({ mutationFn: () => api.patch<{ form: WaForm }>(`/workspaces/${workspace.id}/forms/${form.id}`, body()), onSuccess: ({ form: f }) => store(f) });
  const publish = useMutation({
    mutationFn: async () => {
      await save.mutateAsync();
      return api.post<{ form: WaForm }>(`/workspaces/${workspace.id}/forms/${form.id}/publish`);
    },
    onSuccess: ({ form: f }) => {
      store(f);
      setIssues([]);
      setNotice(`Published version ${f.version} to WhatsApp. New sends use it; old submissions keep their meaning.`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'FORM_INVALID') setIssues((err.details as unknown as { issues: string[] }).issues);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/workspaces/${workspace.id}/forms/${form.id}`),
    onSuccess: () => navigate(`/w/${workspace.id}/forms`),
  });
  const error = save.error ?? (publish.error instanceof ApiError && publish.error.code === 'FORM_INVALID' ? null : publish.error) ?? remove.error;

  const addField = () => {
    const n = form.fields.length + 1;
    set({ fields: [...form.fields, { key: `field_${n}`, label: `Question ${n}`, type: 'short_text', required: false, options: [], saveTo: null }] });
  };
  const move = (i: number, dir: -1 | 1) => {
    const fields = [...form.fields];
    const [f] = fields.splice(i, 1);
    fields.splice(i + dir, 0, f!);
    set({ fields });
  };

  return (
    <>
      <Link to={`/w/${workspace.id}/forms`} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="size-4" /> Forms
      </Link>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-72">
          <Input aria-label="Form name" value={form.name} disabled={!editable} onChange={(e) => set({ name: e.target.value })} className="text-base font-semibold" />
        </div>
        <Badge tone={FORM_STATUS[form.status].tone}>
          {FORM_STATUS[form.status].label}
          {form.version > 0 && ` · v${form.version}`}
        </Badge>
        <div className="ml-auto flex flex-wrap gap-2">
          <div className="mr-2 flex rounded-lg bg-slate-100 p-0.5 text-sm">
            {(['build', 'submissions'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cn('rounded-md px-3 py-1 font-medium capitalize', tab === t ? 'bg-white shadow-sm' : 'text-slate-500')}>
                {t}
              </button>
            ))}
          </div>
          {editable && (
            <>
              <Button variant="ghost" onClick={() => window.confirm('Delete this form? Its submissions are kept.') && remove.mutate()}>
                <Trash2 className="size-4" />
              </Button>
              <Button variant="secondary" loading={save.isPending && !publish.isPending} onClick={() => save.mutate()}>
                Save
              </Button>
              {form.status === 'published' && (
                <Button variant="secondary" onClick={() => setSending(true)}>
                  <Send className="size-4" /> Send
                </Button>
              )}
              <Button loading={publish.isPending} onClick={() => publish.mutate()}>
                <Upload className="size-4" /> Publish
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mb-4 space-y-2">
        {error != null && <Alert>{errorMessage(error)}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        {issues.length > 0 && (
          <Alert>
            <p className="font-medium">Fix these before publishing:</p>
            <ul className="mt-1 list-disc pl-5">
              {issues.map((i, k) => (
                <li key={k}>{i}</li>
              ))}
            </ul>
          </Alert>
        )}
        {form.publishError && issues.length === 0 && <Alert>Last publish failed: {form.publishError}</Alert>}
      </div>

      {tab === 'submissions' ? (
        <Submissions formId={form.id} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-5">
          <fieldset disabled={!editable} className="space-y-6 lg:col-span-3">
            <Card className="space-y-4 p-5">
              <h2 className="text-sm font-semibold text-ink">Chat message</h2>
              <Field label="Message shown with the button" htmlFor="f-intro">
                <Input id="f-intro" value={form.intro} onChange={(e) => set({ intro: e.target.value })} placeholder="Book your appointment in a few taps" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Button text" htmlFor="f-cta" hint="Max 20 characters">
                  <Input id="f-cta" maxLength={20} value={form.ctaText} onChange={(e) => set({ ctaText: e.target.value })} />
                </Field>
                <Field label="Form title" htmlFor="f-title" hint="Max 30 characters">
                  <Input id="f-title" maxLength={30} value={form.screenTitle} onChange={(e) => set({ screenTitle: e.target.value })} />
                </Field>
                <Field label="Submit button" htmlFor="f-submit" hint="Max 35 characters">
                  <Input id="f-submit" maxLength={35} value={form.submitLabel} onChange={(e) => set({ submitLabel: e.target.value })} />
                </Field>
              </div>
              <Field label="Reply after a submission" htmlFor="f-ok">
                <Input id="f-ok" value={form.successMessage} onChange={(e) => set({ successMessage: e.target.value })} />
              </Field>
            </Card>

            <Card className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink">Fields</h2>
                <span className="text-xs text-slate-500">{form.fields.length} / 20 · labels up to 20 characters</span>
              </div>
              <div className="space-y-3">
                {form.fields.map((f, i) => (
                  <div key={i} className="rounded-lg border border-slate-200 p-3">
                    <div className="grid gap-2 sm:grid-cols-[1fr_10rem_auto]">
                      <Input
                        aria-label="Label"
                        value={f.label}
                        maxLength={f.type === 'opt_in' ? 120 : 20}
                        onChange={(e) => setField(i, { label: e.target.value, ...(f.key.startsWith('field_') ? { key: slug(e.target.value, f.key) } : {}) })}
                      />
                      <Select aria-label="Type" value={f.type} onChange={(e) => setField(i, { type: e.target.value as FormFieldType, options: HAS_OPTIONS.has(e.target.value as FormFieldType) && !f.options.length ? [{ id: 'option_1', title: 'Option 1' }] : f.options })}>
                        {FIELD_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </Select>
                      <div className="flex items-center gap-1">
                        <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-30" aria-label="Move up">
                          <ArrowUp className="size-4" />
                        </button>
                        <button type="button" disabled={i === form.fields.length - 1} onClick={() => move(i, 1)} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-30" aria-label="Move down">
                          <ArrowDown className="size-4" />
                        </button>
                        <button type="button" onClick={() => set({ fields: form.fields.filter((_, j) => j !== i) })} className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Remove field">
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Required
                      </label>
                      <span className="text-slate-400">Key: <code>{f.key}</code></span>
                      <span className="flex items-center gap-1.5 text-slate-500">
                        Save to contact
                        <select
                          aria-label="Save to contact"
                          value={f.saveTo ?? ''}
                          onChange={(e) => setField(i, { saveTo: e.target.value === 'custom' ? `custom.${f.key}` : e.target.value || null })}
                          className="rounded border border-slate-300 bg-white px-1.5 py-0.5"
                        >
                          <option value="">Don't save</option>
                          <option value="name">Name</option>
                          <option value="email">Email</option>
                          <option value="custom">{f.saveTo?.startsWith('custom.') ? f.saveTo : 'Custom field'}</option>
                        </select>
                      </span>
                    </div>
                    {HAS_OPTIONS.has(f.type) && (
                      <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2">
                        {f.options.map((o, k) => (
                          <div key={k} className="flex gap-2">
                            <Input
                              aria-label={`Option ${k + 1}`}
                              maxLength={30}
                              value={o.title}
                              onChange={(e) => setField(i, { options: f.options.map((x, j) => (j === k ? { id: slug(e.target.value, x.id), title: e.target.value } : x)) })}
                            />
                            <button type="button" onClick={() => setField(i, { options: f.options.filter((_, j) => j !== k) })} className="rounded p-2 text-slate-400 hover:text-red-600" aria-label="Remove option">
                              <Trash2 className="size-4" />
                            </button>
                          </div>
                        ))}
                        <button type="button" onClick={() => setField(i, { options: [...f.options, { id: `option_${f.options.length + 1}`, title: `Option ${f.options.length + 1}` }] })} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
                          <Plus className="size-3" /> Add option
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {form.fields.length < 20 && (
                  <Button type="button" variant="secondary" onClick={addField}>
                    <Plus className="size-4" /> Add field
                  </Button>
                )}
              </div>
            </Card>
          </fieldset>

          <div className="lg:col-span-2">
            <div className="sticky top-6">
              <p className="mb-2 text-sm font-medium text-slate-700">Preview</p>
              <FormPreview form={form} />
            </div>
          </div>
        </div>
      )}
      {sending && <SendModal formId={form.id} onClose={() => setSending(false)} />}
    </>
  );
}

/** Approximate look of the form inside WhatsApp. */
function FormPreview({ form }: { form: WaForm }) {
  return (
    <div className="space-y-3 rounded-2xl bg-[#e5ddd5] p-4">
      <div className="max-w-xs rounded-lg rounded-tl-none bg-white p-2.5 text-sm shadow-sm">
        <p>{form.intro || form.name}</p>
        <div className="mt-2 border-t border-slate-100 pt-2 text-center text-sm font-medium text-sky-600">{form.ctaText || 'Open form'}</div>
      </div>
      <div className="overflow-hidden rounded-xl bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-3 text-center text-sm font-semibold">{form.screenTitle}</div>
        <div className="space-y-3 p-4">
          {form.fields.map((f, i) => (
            <div key={i} className="text-sm">
              {f.type === 'opt_in' ? (
                <label className="flex items-start gap-2 text-slate-700">
                  <input type="checkbox" disabled className="mt-0.5" /> {f.label}
                </label>
              ) : (
                <>
                  <p className="mb-1 text-xs text-slate-500">
                    {f.label}
                    {!f.required && ' (optional)'}
                  </p>
                  {f.type === 'radio' || f.type === 'checkbox' ? (
                    <div className="space-y-1">
                      {f.options.map((o) => (
                        <label key={o.id} className="flex items-center gap-2 text-slate-700">
                          <input type={f.type === 'radio' ? 'radio' : 'checkbox'} disabled /> {o.title}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-md border border-slate-300 px-3 py-2 text-slate-400">
                      {f.type === 'dropdown' ? `${f.options[0]?.title ?? 'Select'} ▾` : f.type === 'date' ? 'dd/mm/yyyy' : f.type === 'long_text' ? 'Type here…\n\n' : ''}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
          <div className="rounded-full bg-emerald-600 py-2 text-center text-sm font-medium text-white">{form.submitLabel}</div>
        </div>
      </div>
    </div>
  );
}

function SendModal({ formId, onClose }: { formId: string; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const [phone, setPhone] = useState('');
  const send = useMutation({ mutationFn: () => api.post(`/workspaces/${workspace.id}/forms/${formId}/send`, { phone }) });
  useEffect(() => {
    if (send.isSuccess) setTimeout(onClose, 1200);
  }, [send.isSuccess, onClose]);
  return (
    <Modal title="Send this form" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">The contact must have messaged you within the last 24 hours. To send forms automatically, use a "Send form" step in a flow.</p>
        {send.error != null && <Alert>{errorMessage(send.error)}</Alert>}
        {send.isSuccess && <Alert tone="success">Form sent.</Alert>}
        <Field label="Contact phone" htmlFor="send-phone">
          <Input id="send-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Button loading={send.isPending} disabled={!phone.trim()} onClick={() => send.mutate()}>
          Send form
        </Button>
      </div>
    </Modal>
  );
}

interface SubmissionPage {
  columns: { key: string; label: string }[];
  submissions: { id: string; contact: { id: string; name: string; phone: string } | null; values: Record<string, string>; valid: boolean; issues: string[]; formVersion: number; submittedAt: string }[];
  total: number;
  pages: number;
}

function Submissions({ formId }: { formId: string }) {
  const { workspace } = useWorkspace();
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['form-submissions', workspace.id, formId, page],
    queryFn: () => api.get<SubmissionPage>(`/workspaces/${workspace.id}/forms/${formId}/submissions?page=${page}`),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
  if (query.isPending) return <Spinner />;
  if (query.error) return <Alert>{errorMessage(query.error)}</Alert>;
  const { columns, submissions, total, pages } = query.data;
  return (
    <Card>
      {submissions.length === 0 ? (
        <EmptyState title="No submissions yet">Published forms collect answers here as customers submit them in WhatsApp.</EmptyState>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Contact</th>
                  {columns.map((c) => (
                    <th key={c.key} className="px-4 py-2.5 font-medium whitespace-nowrap">
                      {c.label}
                    </th>
                  ))}
                  <th className="px-4 py-2.5 font-medium">Submitted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {submissions.map((s) => (
                  <tr key={s.id} className={s.valid ? '' : 'bg-red-50/50'}>
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-slate-800">{s.contact?.name ?? '—'}</p>
                      <p className="text-xs text-slate-500">{s.contact?.phone}</p>
                      {!s.valid && <p className="text-xs text-red-600">{s.issues.join(' ')}</p>}
                    </td>
                    {columns.map((c) => (
                      <td key={c.key} className="px-4 py-2.5 text-slate-700">
                        {s.values[c.key] || '—'}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap text-slate-500">
                      {formatDate(s.submittedAt, true)} · v{s.formVersion}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-500">
            <span>{total} submission(s)</span>
            {pages > 1 && (
              <div className="flex gap-2">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
                  <ChevronLeft className="size-4" />
                </Button>
                <Button variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

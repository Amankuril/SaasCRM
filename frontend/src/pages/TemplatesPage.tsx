import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { TemplatePreview, templateTone } from '../components/TemplatePreview';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, cn, errorMessage, fieldError } from '../components/ui';
import { ApiError, api, type ConnectionPayload, type MessageTemplate, type TemplateComponent } from '../lib/api';
import { formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';

const STATUSES = ['', 'APPROVED', 'PENDING', 'REJECTED', 'PAUSED'];

export function TemplatesPage() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const canManage = can('templates:manage') && workspace.status !== 'suspended';

  const connection = useQuery({
    queryKey: ['whatsapp', workspace.id],
    queryFn: () => api.get<ConnectionPayload>(`/workspaces/${workspace.id}/whatsapp/connection`),
  });
  const list = useQuery({
    queryKey: ['templates', workspace.id, status, q],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (q.trim()) params.set('q', q.trim());
      return api.get<{ templates: MessageTemplate[] }>(`/workspaces/${workspace.id}/templates?${params}`);
    },
    // Pending reviews update via webhook; poll gently while any are pending.
    refetchInterval: (query) => (query.state.data?.templates.some((t) => t.status === 'PENDING') ? 5_000 : false),
  });
  const sync = useMutation({
    mutationFn: () => api.post<{ synced: number; removed: number }>(`/workspaces/${workspace.id}/templates/sync`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['templates', workspace.id] }),
  });

  const connected = !!connection.data?.connection;
  const selectedTemplate = list.data?.templates.find((t) => t.id === selected);

  return (
    <>
      <PageHeader
        title="Message templates"
        description="Pre-approved messages for broadcasts, reminders and anything sent outside the 24-hour window."
        actions={
          canManage &&
          connected && (
            <div className="flex gap-2">
              <Button variant="secondary" loading={sync.isPending} onClick={() => sync.mutate()}>
                <RefreshCw className="size-4" /> Sync from WhatsApp
              </Button>
              <Button onClick={() => setCreating(true)}>
                <Plus className="size-4" /> New template
              </Button>
            </div>
          )
        }
      />

      {connection.data && !connected && (
        <div className="mb-6">
          <Alert tone="info">
            Connect a WhatsApp number first.{' '}
            <Link to={`/w/${workspace.id}/whatsapp`} className="font-medium underline">
              Go to WhatsApp setup
            </Link>
          </Alert>
        </div>
      )}
      {sync.error != null && (
        <div className="mb-4">
          <Alert>{errorMessage(sync.error)}</Alert>
        </div>
      )}
      {sync.data && (
        <div className="mb-4">
          <Alert tone="success">
            Synced {sync.data.synced} template(s){sync.data.removed ? `, removed ${sync.data.removed} deleted on WhatsApp` : ''}.
          </Alert>
        </div>
      )}

      {creating && (
        <div className="mb-6">
          <CreateTemplateCard
            onClose={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              setSelected(id);
            }}
          />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
            <Input aria-label="Search templates" placeholder="Search by name…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
            <div className="w-40">
              <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s ? s.charAt(0) + s.slice(1).toLowerCase() : 'All statuses'}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {list.isPending ? (
            <Spinner />
          ) : list.error ? (
            <div className="p-4">
              <Alert>{errorMessage(list.error)}</Alert>
            </div>
          ) : list.data.templates.length === 0 ? (
            <EmptyState icon={<FileText className="size-5" />} title="No templates">
              {connected ? 'Sync your existing templates from WhatsApp or create a new one.' : 'Templates appear here once WhatsApp is connected.'}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {list.data.templates.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => setSelected(t.id)}
                    className={cn('flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-slate-50', selected === t.id && 'bg-brand-50/60')}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-slate-800">{t.name}</p>
                      <p className="text-xs text-slate-500">
                        {t.language} · {t.category.toLowerCase()}
                        {t.variables.header + t.variables.body > 0 && ` · ${t.variables.header + t.variables.body} variable(s)`}
                      </p>
                    </div>
                    <Badge tone={templateTone(t.status)}>{t.status.toLowerCase()}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="lg:col-span-2">
          {selectedTemplate ? (
            <Card className="p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-semibold text-ink">{selectedTemplate.name}</h2>
                  <p className="text-xs text-slate-500">
                    {selectedTemplate.language} · {selectedTemplate.category.toLowerCase()}
                    {selectedTemplate.syncedAt && ` · synced ${formatDate(selectedTemplate.syncedAt, true)}`}
                  </p>
                </div>
                <Badge tone={templateTone(selectedTemplate.status)}>{selectedTemplate.status.toLowerCase()}</Badge>
              </div>
              {selectedTemplate.rejectedReason && (
                <div className="mt-3">
                  <Alert>Rejected: {selectedTemplate.rejectedReason}</Alert>
                </div>
              )}
              <div className="mt-4">
                <TemplatePreview components={selectedTemplate.components} />
              </div>
            </Card>
          ) : (
            <Card className="p-5">
              <EmptyState icon={<FileText className="size-5" />} title="Select a template to preview it" />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

type ButtonDraft = { type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'; text: string; url?: string; phone?: string };

function CreateTemplateCard({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('en');
  const [category, setCategory] = useState<'UTILITY' | 'MARKETING'>('UTILITY');
  const [header, setHeader] = useState('');
  const [headerExample, setHeaderExample] = useState('');
  const [body, setBody] = useState('');
  const [examples, setExamples] = useState<string[]>([]);
  const [footer, setFooter] = useState('');
  const [buttons, setButtons] = useState<ButtonDraft[]>([]);

  const bodyVarCount = useMemo(() => {
    const nums = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    return nums.length ? Math.max(...nums) : 0;
  }, [body]);
  const headerHasVar = /\{\{1\}\}/.test(header);
  const exampleValues = Array.from({ length: bodyVarCount }, (_, i) => examples[i] ?? '');

  const components: TemplateComponent[] = [
    ...(header ? [{ type: 'HEADER' as const, format: 'TEXT', text: header }] : []),
    { type: 'BODY', text: body },
    ...(footer ? [{ type: 'FOOTER' as const, text: footer }] : []),
    ...(buttons.length ? [{ type: 'BUTTONS' as const, buttons }] : []),
  ];

  const create = useMutation({
    mutationFn: () =>
      api.post<{ template: MessageTemplate }>(`/workspaces/${workspace.id}/templates`, {
        name,
        language,
        category,
        ...(header ? { header: { text: header, ...(headerHasVar ? { example: headerExample } : {}) } } : {}),
        body: { text: body, examples: exampleValues },
        ...(footer ? { footer: { text: footer } } : {}),
        buttons,
      }),
    onSuccess: ({ template }) => {
      void queryClient.invalidateQueries({ queryKey: ['templates', workspace.id] });
      onCreated(template.id);
    },
  });
  const err = create.error;
  const isFieldError = err instanceof ApiError && err.code === 'VALIDATION_ERROR';

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">New template</h2>
        <button onClick={onClose} className="rounded-md p-1 text-slate-500 hover:bg-slate-100" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>
      <p className="mt-1 text-sm text-slate-500">Meta reviews every template, usually within minutes to a day. It can be used once approved.</p>

      <form onSubmit={onSubmit} className="mt-5 grid gap-6 lg:grid-cols-2" noValidate>
        <div className="space-y-4">
          {err != null && !isFieldError && <Alert>{errorMessage(err)}</Alert>}
          <Field label="Name" htmlFor="tpl-name" error={fieldError(err, 'name')} hint="Lowercase letters, numbers and underscores, e.g. appointment_reminder">
            <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Category" htmlFor="tpl-cat">
              <Select id="tpl-cat" value={category} onChange={(e) => setCategory(e.target.value as 'UTILITY' | 'MARKETING')}>
                <option value="UTILITY">Utility (updates, reminders)</option>
                <option value="MARKETING">Marketing (offers, promotions)</option>
              </Select>
            </Field>
            <Field label="Language" htmlFor="tpl-lang" error={fieldError(err, 'language')}>
              <Select id="tpl-lang" value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="en">English</option>
                <option value="en_US">English (US)</option>
                <option value="hi">Hindi</option>
                <option value="mr">Marathi</option>
                <option value="gu">Gujarati</option>
                <option value="ta">Tamil</option>
                <option value="te">Telugu</option>
                <option value="bn">Bengali</option>
              </Select>
            </Field>
          </div>
          <Field label="Header (optional)" htmlFor="tpl-header" error={fieldError(err, 'header')} hint="Up to 60 characters. May contain one variable, {{1}}.">
            <Input id="tpl-header" maxLength={60} value={header} onChange={(e) => setHeader(e.target.value)} />
          </Field>
          {headerHasVar && (
            <Field label="Header example for {{1}}" htmlFor="tpl-hex">
              <Input id="tpl-hex" value={headerExample} onChange={(e) => setHeaderExample(e.target.value)} />
            </Field>
          )}
          <Field label="Body" htmlFor="tpl-body" error={fieldError(err, 'body')} hint="Use {{1}}, {{2}}… for personalised values. Cannot start or end with a variable.">
            <textarea
              id="tpl-body"
              rows={4}
              maxLength={1024}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/40 focus:outline-none"
            />
          </Field>
          {exampleValues.map((v, i) => (
            <Field key={i} label={`Example for {{${i + 1}}}`} htmlFor={`tpl-ex-${i}`}>
              <Input id={`tpl-ex-${i}`} value={v} onChange={(e) => setExamples(exampleValues.map((x, j) => (j === i ? e.target.value : x)))} />
            </Field>
          ))}
          <Field label="Footer (optional)" htmlFor="tpl-footer" error={fieldError(err, 'footer')}>
            <Input id="tpl-footer" maxLength={60} value={footer} onChange={(e) => setFooter(e.target.value)} />
          </Field>

          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">Buttons (optional)</p>
            {buttons.map((b, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-2">
                <Badge>{b.type === 'QUICK_REPLY' ? 'Quick reply' : b.type === 'URL' ? 'Website' : 'Call'}</Badge>
                <Input aria-label="Button text" placeholder="Button text" maxLength={25} value={b.text} className="w-36" onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                {b.type === 'URL' && (
                  <Input aria-label="URL" placeholder="https://…" value={b.url ?? ''} className="min-w-40 flex-1" onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
                )}
                {b.type === 'PHONE_NUMBER' && (
                  <Input aria-label="Phone" placeholder="+919876543210" value={b.phone ?? ''} className="min-w-40 flex-1" onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))} />
                )}
                <button type="button" onClick={() => setButtons(buttons.filter((_, j) => j !== i))} className="ml-auto rounded p-1 text-slate-400 hover:text-red-600" aria-label="Remove button">
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
            {buttons.length < 10 && (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="ghost" onClick={() => setButtons([...buttons, { type: 'QUICK_REPLY', text: '' }])}>
                  + Quick reply
                </Button>
                <Button type="button" variant="ghost" onClick={() => setButtons([...buttons, { type: 'URL', text: '', url: '' }])}>
                  + Website link
                </Button>
                <Button type="button" variant="ghost" onClick={() => setButtons([...buttons, { type: 'PHONE_NUMBER', text: '', phone: '' }])}>
                  + Call button
                </Button>
              </div>
            )}
            {fieldError(err, 'buttons') && <p className="text-xs text-red-600">{fieldError(err, 'buttons')}</p>}
          </div>

          <div className="flex gap-2 pt-2">
            <Button type="submit" loading={create.isPending}>
              Submit for review
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-slate-700">Preview</p>
          <TemplatePreview components={components} headerParams={headerHasVar ? [headerExample] : []} bodyParams={exampleValues} />
        </div>
      </form>
    </Card>
  );
}

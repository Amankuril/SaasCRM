import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Library, Search } from 'lucide-react';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Modal } from '../../components/crm';
import { TemplatePreview } from '../../components/TemplatePreview';
import { Alert, Button, EmptyState, Field, Input, Select, Spinner, errorMessage, fieldError } from '../../components/ui';
import { api, type LibraryTemplate, type MessageTemplate, type TemplateComponent } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { LANGUAGES } from './templateForm';
import { NotConnectedAlert, TemplatesHeader, humanize, useConnection } from './shared';

// Filter values Meta's Template Library accepts.
const INDUSTRIES = ['E_COMMERCE', 'FINANCIAL_SERVICES'];
const TOPICS = ['ACCOUNT_UPDATE', 'CUSTOMER_FEEDBACK', 'ORDER_MANAGEMENT', 'PAYMENTS'];
const USECASES = [
  'ACCOUNT_CREATION_CONFIRMATION',
  'AUTO_PAY_REMINDER',
  'DELIVERY_CONFIRMATION',
  'DELIVERY_FAILED',
  'DELIVERY_UPDATE',
  'FEEDBACK_SURVEY',
  'FRAUD_ALERT',
  'LOW_BALANCE_WARNING',
  'ORDER_ACTION_NEEDED',
  'ORDER_CONFIRMATION',
  'ORDER_DELAY',
  'ORDER_OR_TRANSACTION_CANCEL',
  'ORDER_PICK_UP',
  'PAYMENT_ACTION_REQUIRED',
  'PAYMENT_CONFIRMATION',
  'PAYMENT_DUE_REMINDER',
  'PAYMENT_OVERDUE',
  'PAYMENT_REJECT_FAIL',
  'PAYMENT_SCHEDULED',
  'RECEIPT_ATTACHMENT',
  'RETURN_CONFIRMATION',
  'SHIPMENT_CONFIRMATION',
  'STATEMENT_ATTACHMENT',
  'STATEMENT_AVAILABLE',
  'TRANSACTION_ALERT',
];

export function libraryComponents(t: LibraryTemplate): TemplateComponent[] {
  return [
    ...(t.header ? [{ type: 'HEADER' as const, format: 'TEXT', text: t.header }] : []),
    { type: 'BODY', text: t.body },
    ...(t.buttons.length ? [{ type: 'BUTTONS' as const, buttons: t.buttons }] : []),
  ];
}

export function MetaLibraryPage() {
  const { workspace, can } = useWorkspace();
  const connection = useConnection();
  const [search, setSearch] = useState('');
  const [industry, setIndustry] = useState('');
  const [topic, setTopic] = useState('');
  const [usecase, setUsecase] = useState('');
  const [language, setLanguage] = useState('en_US');
  const [using, setUsing] = useState<LibraryTemplate | null>(null);
  const deferredSearch = useDeferredValue(search.trim());

  const list = useQuery({
    queryKey: ['template-library', workspace.id, { deferredSearch, industry, topic, usecase, language }],
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ search: deferredSearch, industry, topic, usecase, language })) if (v) params.set(k, v);
      return api.get<{ templates: LibraryTemplate[] }>(`/workspaces/${workspace.id}/templates/library?${params}`);
    },
    enabled: connection.connected,
    staleTime: 5 * 60_000,
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <TemplatesHeader title="Meta Library" description="Pre-written utility templates from Meta. They are approved instantly once you fill in your links and numbers." />
      <div className="space-y-4 px-4 py-4 sm:px-6">
        {connection.loaded && !connection.connected && <NotConnectedAlert />}
        <div className="flex flex-wrap gap-2">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <Input aria-label="Search library" placeholder="Search templates..." value={search} onChange={(e) => setSearch(e.target.value)} className="rounded-full pl-9" />
          </div>
          <FilterSelect label="Industry" all="All industries" value={industry} onChange={setIndustry} options={INDUSTRIES} />
          <FilterSelect label="Topic" all="All topics" value={topic} onChange={setTopic} options={TOPICS} />
          <FilterSelect label="Use case" all="All use cases" value={usecase} onChange={setUsecase} options={USECASES} wide />
          <Select aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value)} className="w-40!">
            <option value="">All languages</option>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </Select>
        </div>

        {!connection.connected ? null : list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <Alert>{errorMessage(list.error)}</Alert>
        ) : list.data.templates.length === 0 ? (
          <EmptyState icon={<Library className="size-5" />} title="No library templates match">
            Try clearing a filter or searching for something else.
          </EmptyState>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.data.templates.map((t) => (
              <div key={`${t.id}-${t.language}`} className="flex flex-col rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3">
                  <p className="truncate font-medium text-slate-800" title={t.name}>
                    {t.name}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {[t.topic, t.usecase, ...t.industry].filter(Boolean).map((tag) => (
                      <span key={tag} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                        {humanize(tag!)}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex-1">
                  <TemplatePreview components={libraryComponents(t)} bodyParams={t.bodyParams} />
                </div>
                {can('templates:manage') && (
                  <Button className="mt-3 w-full bg-slate-700 hover:bg-slate-800" onClick={() => setUsing(t)}>
                    Use template
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {using && <UseLibraryModal template={using} onClose={() => setUsing(null)} />}
    </div>
  );
}

function FilterSelect({ label, all, value, onChange, options, wide }: { label: string; all: string; value: string; onChange: (v: string) => void; options: string[]; wide?: boolean }) {
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={wide ? "w-56!" : "w-44!"}>
      <option value="">{all}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {humanize(o)}
        </option>
      ))}
    </Select>
  );
}

/** Library templates only need a name plus the business's own links/phone for their buttons. */
function UseLibraryModal({ template, onClose }: { template: LibraryTemplate; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(template.name);
  const inputs = template.buttons.filter((b) => b.type === 'URL' || b.type === 'PHONE_NUMBER');
  const [values, setValues] = useState<{ url: string; suffix: string; phone: string }[]>(inputs.map(() => ({ url: '', suffix: '', phone: '' })));

  const create = useMutation({
    mutationFn: () =>
      api.post<{ template: MessageTemplate }>(`/workspaces/${workspace.id}/templates/library`, {
        name,
        language: template.language,
        libraryTemplateName: template.name,
        buttonInputs: inputs.map((b, i) =>
          b.type === 'URL'
            ? { type: 'URL', url: { base_url: values[i]!.url, ...(values[i]!.url.includes('{{1}}') ? { url_suffix_example: values[i]!.suffix } : {}) } }
            : { type: 'PHONE_NUMBER', phone_number: values[i]!.phone },
        ),
      }),
    onSuccess: ({ template: created }) => {
      void queryClient.invalidateQueries({ queryKey: ['templates', workspace.id] });
      navigate(`/w/${workspace.id}/templates`, { state: { flash: `"${created.name}" was submitted from the Meta library.` } });
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const update = (i: number, patch: Partial<(typeof values)[number]>) => setValues(values.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  return (
    <Modal title="Use library template" onClose={onClose} wide>
      <form onSubmit={onSubmit} className="grid gap-5 sm:grid-cols-2" noValidate>
        <div className="space-y-4">
          {create.error != null && !fieldError(create.error, 'name') && !fieldError(create.error, 'buttonInputs') && <Alert>{errorMessage(create.error)}</Alert>}
          <Field label="Template name" htmlFor="lib-name" error={fieldError(create.error, 'name')} hint="Lowercase letters, numbers and underscores.">
            <Input id="lib-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
          </Field>
          {inputs.map((b, i) =>
            b.type === 'URL' ? (
              <div key={i} className="space-y-2">
                <Field label={`“${b.text}” link`} htmlFor={`lib-url-${i}`} hint="Add {{1}} at the end to personalise the link per message.">
                  <Input id={`lib-url-${i}`} placeholder="https://yourstore.com/orders/{{1}}" value={values[i]!.url} onChange={(e) => update(i, { url: e.target.value.trim() })} />
                </Field>
                {values[i]!.url.includes('{{1}}') && (
                  <Field label="Example value for {{1}}" htmlFor={`lib-sfx-${i}`}>
                    <Input id={`lib-sfx-${i}`} value={values[i]!.suffix} onChange={(e) => update(i, { suffix: e.target.value })} />
                  </Field>
                )}
              </div>
            ) : (
              <Field key={i} label={`“${b.text}” phone number`} htmlFor={`lib-ph-${i}`}>
                <Input id={`lib-ph-${i}`} placeholder="+919876543210" value={values[i]!.phone} onChange={(e) => update(i, { phone: e.target.value.replace(/[^\d+]/g, '') })} />
              </Field>
            ),
          )}
          {fieldError(create.error, 'buttonInputs') && <p className="text-xs text-red-600">{fieldError(create.error, 'buttonInputs')}</p>}
          <p className="text-xs text-slate-500">Category: Utility · Language: {template.language}. The text itself cannot be changed.</p>
          <div className="flex gap-2">
            <Button type="submit" loading={create.isPending} className="bg-slate-700 hover:bg-slate-800">
              Submit template
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
        <TemplatePreview components={libraryComponents(template)} bodyParams={template.bodyParams} />
      </form>
    </Modal>
  );
}

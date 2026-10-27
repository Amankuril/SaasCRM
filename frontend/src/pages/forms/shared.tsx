import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, Code2, Copy, Download, Send, Table2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { Alert, Button, EmptyState, Field, Input, Spinner, errorMessage } from '../../components/ui';
import { api, type FormCategory, type WaForm } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';

export const FORM_STATUS = {
  draft: { label: 'Draft', tone: 'gray' },
  published: { label: 'Published', tone: 'green' },
  failed: { label: 'Publish failed', tone: 'red' },
} as const;

export const CATEGORY_LABEL: Record<FormCategory, string> = {
  SIGN_UP: 'Sign up',
  SIGN_IN: 'Sign in',
  APPOINTMENT_BOOKING: 'Appointment booking',
  LEAD_GENERATION: 'Lead generation',
  CONTACT_US: 'Contact us',
  CUSTOMER_SUPPORT: 'Customer support',
  SURVEY: 'Survey',
  OTHER: 'Other',
};

const fileName = (name: string) => `${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'form'}.json`;

/** Saves JSON in the browser as a file. */
export function saveJson(name: string, json: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName(name) });
  a.click();
  URL.revokeObjectURL(url);
}

interface FlowJsonView {
  draft: unknown;
  published: unknown;
  flowId: string | null;
}

export const fetchFlowJson = (workspaceId: string, formId: string) => api.get<FlowJsonView>(`/workspaces/${workspaceId}/forms/${formId}/flow-json`);

/** The `</>` view: the Flow JSON WhatsApp gets, with copy and download. */
export function FlowJsonDialog({ form, onClose }: { form: Pick<WaForm, 'id' | 'name'>; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const query = useQuery({ queryKey: ['form-json', workspace.id, form.id], queryFn: () => fetchFlowJson(workspace.id, form.id) });
  const [which, setWhich] = useState<'draft' | 'published'>('draft');
  const [copied, setCopied] = useState(false);
  const json = query.data ? (which === 'published' && query.data.published ? query.data.published : query.data.draft) : null;
  const text = json ? JSON.stringify(json, null, 2) : '';
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Dialog
      icon={<Code2 className="size-5" />}
      title="Flow JSON"
      subtitle={form.name}
      width="max-w-3xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" disabled={!json} onClick={copy}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button disabled={!json} onClick={() => saveJson(form.name, json)}>
            <Download className="size-4" /> Download
          </Button>
        </>
      }
    >
      {query.isPending ? (
        <Spinner />
      ) : query.error ? (
        <Alert>{errorMessage(query.error)}</Alert>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            {query.data.published != null && (
              <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
                {(['draft', 'published'] as const).map((w) => (
                  <button key={w} type="button" onClick={() => setWhich(w)} className={`rounded-md px-2.5 py-1 font-medium capitalize ${which === w ? 'bg-white text-ink shadow-sm' : ''}`}>
                    {w === 'draft' ? 'Current draft' : 'Live on WhatsApp'}
                  </button>
                ))}
              </div>
            )}
            {query.data.flowId && (
              <span>
                Flow ID <code className="text-slate-700">{query.data.flowId}</code>
              </span>
            )}
          </div>
          <pre className="max-h-[55vh] overflow-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-emerald-100">{text}</pre>
        </>
      )}
    </Dialog>
  );
}

export function SendFormDialog({ formId, onClose }: { formId: string; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const [phone, setPhone] = useState('');
  const send = useMutation({ mutationFn: () => api.post(`/workspaces/${workspace.id}/forms/${formId}/send`, { phone }) });
  useEffect(() => {
    if (!send.isSuccess) return;
    const t = setTimeout(onClose, 1200);
    return () => clearTimeout(t);
  }, [send.isSuccess, onClose]);
  return (
    <Dialog
      icon={<Send className="size-5" />}
      title="Send this form"
      subtitle="Opens inside the customer's WhatsApp"
      onClose={onClose}
      footer={
        <Button loading={send.isPending} disabled={!phone.trim()} onClick={() => send.mutate()}>
          Send form
        </Button>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">The contact must have messaged you within the last 24 hours. To send forms automatically, use a "Send form" step in a flow.</p>
        {send.error != null && <Alert>{errorMessage(send.error)}</Alert>}
        {send.isSuccess && <Alert tone="success">Form sent.</Alert>}
        <Field label="Contact phone" htmlFor="send-phone">
          <Input id="send-phone" type="tel" placeholder="+91 98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

interface SubmissionPage {
  columns: { key: string; label: string }[];
  submissions: { id: string; contact: { id: string; name: string; phone: string } | null; values: Record<string, string>; valid: boolean; issues: string[]; formVersion: number; submittedAt: string }[];
  total: number;
  pages: number;
}

/** "View Data": everything customers submitted through a form. */
export function SubmissionsDialog({ form, onClose }: { form: Pick<WaForm, 'id' | 'name'>; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['form-submissions', workspace.id, form.id, page],
    queryFn: () => api.get<SubmissionPage>(`/workspaces/${workspace.id}/forms/${form.id}/submissions?page=${page}`),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
  return (
    <Dialog icon={<Table2 className="size-5" />} title="Submission data" subtitle={form.name} width="max-w-5xl" onClose={onClose}>
      {query.isPending ? (
        <Spinner />
      ) : query.error ? (
        <Alert>{errorMessage(query.error)}</Alert>
      ) : query.data.submissions.length === 0 ? (
        <EmptyState title="No submissions yet">Published forms collect answers here as customers submit them in WhatsApp.</EmptyState>
      ) : (
        <>
          <div className="-mx-5 -mt-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Contact</th>
                  {query.data.columns.map((c) => (
                    <th key={c.key} className="px-4 py-2.5 font-medium whitespace-nowrap">
                      {c.label}
                    </th>
                  ))}
                  <th className="px-4 py-2.5 font-medium">Submitted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {query.data.submissions.map((s) => (
                  <tr key={s.id} className={s.valid ? '' : 'bg-red-50/50'}>
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-slate-800">{s.contact?.name || '—'}</p>
                      <p className="text-xs text-slate-500">{s.contact?.phone}</p>
                      {!s.valid && <p className="text-xs text-red-600">{s.issues.join(' ')}</p>}
                    </td>
                    {query.data.columns.map((c) => (
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
          <div className="-mx-5 -mb-5 flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-500">
            <span>{query.data.total} submission(s)</span>
            {query.data.pages > 1 && (
              <div className="flex gap-2">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
                  <ChevronLeft className="size-4" />
                </Button>
                <Button variant="secondary" disabled={page >= query.data.pages} onClick={() => setPage(page + 1)} aria-label="Next page">
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}

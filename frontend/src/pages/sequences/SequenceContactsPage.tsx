import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Code2, Search, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { relativeTime } from '../../components/crm';
import { Dialog } from '../../components/Dialog';
import { ConfirmDialog, useToast } from '../../components/feedback';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, LoadError, PageHeader, Select, Spinner, Tabs, cn, errorMessage } from '../../components/ui';
import { api, type ContactList, type EnrollmentStatus, type SequenceContactRow, type SequenceDetail, type SequenceFunnelStep } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { ENROLLMENT_BADGE, OUTCOME_LABEL, StatusBadge } from './shared';

type Filter = EnrollmentStatus | 'all';
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');

export function SequenceContactsPage() {
  const { sequenceId } = useParams();
  const { workspace, can } = useWorkspace();
  const base = `/workspaces/${workspace.id}/sequences/${sequenceId}`;
  const [status, setStatus] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showApi, setShowApi] = useState(false);

  const seq = useQuery({ queryKey: ['sequence', workspace.id, sequenceId], queryFn: () => api.get<{ sequence: SequenceDetail }>(base), select: (d) => d.sequence });
  const funnel = useQuery({ queryKey: ['sequence-funnel', sequenceId], queryFn: () => api.get<{ steps: SequenceFunnelStep[] }>(`${base}/funnel`), select: (d) => d.steps });
  const params = new URLSearchParams({ status, page: String(page), ...(q.trim() ? { q: q.trim() } : {}) }).toString();
  const contacts = useQuery({
    queryKey: ['sequence-contacts', sequenceId, params],
    queryFn: () => api.get<{ contacts: SequenceContactRow[]; total: number; page: number; pages: number; paused: boolean }>(`${base}/contacts?${params}`),
    placeholderData: keepPreviousData,
  });

  if (seq.isPending) return <Spinner />;
  if (seq.error) return <LoadError error={seq.error} onRetry={() => void seq.refetch()} what="this sequence" />;
  const s = seq.data;
  const manual = s.trigger.type === 'manual';

  return (
    <>
      <Link to={`/w/${workspace.id}/sequences/${s.id}`} className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900">
        <ArrowLeft className="size-4" /> Back to the builder
      </Link>
      <PageHeader
        title={s.name}
        description="Who is in this sequence, where they are, and how each message did."
        actions={
          <>
            <StatusBadge status={s.status} />
            <Button variant="secondary" onClick={() => setShowApi(true)}>
              <Code2 className="size-4" /> API
            </Button>
            {manual && can('sequences:manage') && s.status === 'active' && (
              <Button onClick={() => setAdding(true)}>
                <UserPlus className="size-4" /> Add contacts
              </Button>
            )}
          </>
        }
      />

      {s.status === 'paused' && <div className="mb-4"><Alert tone="info">This sequence is paused: contacts keep their place and nothing is sent until you resume it.</Alert></div>}

      {/* Funnel per message */}
      {funnel.data && funnel.data.length > 0 && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {funnel.data.map((f) => (
            <Card key={f.stepId} className="p-4">
              <p className="truncate text-sm font-medium text-ink">{f.label}</p>
              <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                {[
                  ['Sent', f.sent, null],
                  ['Delivered', f.delivered, pct(f.delivered, f.sent)],
                  ['Read', f.read, pct(f.read, f.sent)],
                  ['Replied', f.replied, pct(f.replied, f.sent)],
                ].map(([label, n, p]) => (
                  <div key={label as string}>
                    <p className="text-lg font-semibold text-ink tabular-nums">{(n as number).toLocaleString('en-IN')}</p>
                    <p className="text-[11px] text-slate-500">{label}</p>
                    {p && <p className="text-[11px] text-slate-400">{p}</p>}
                  </div>
                ))}
              </div>
              <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div className="bg-brand-600" style={{ width: pct(f.read, f.sent) === '—' ? 0 : pct(f.read, f.sent) }} />
                <div className="bg-brand-300" style={{ width: f.sent ? `${((f.delivered - f.read) / f.sent) * 100}%` : 0 }} />
              </div>
              {f.failed > 0 && <p className="mt-2 text-xs text-red-600">{f.failed} failed</p>}
            </Card>
          ))}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <Tabs
          label="Status"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          tabs={[
            { value: 'all', label: 'All' },
            { value: 'in_progress', label: 'In progress' },
            { value: 'needs_attention', label: 'Needs attention' },
            { value: 'completed', label: 'Completed' },
            { value: 'dropped', label: 'Dropped' },
            { value: 'error', label: 'Error' },
          ]}
        />
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <Input aria-label="Search contacts" className="w-64 pl-9" placeholder="Name or number" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />
        </div>
      </div>

      {contacts.isPending ? (
        <Spinner />
      ) : contacts.error ? (
        <LoadError error={contacts.error} onRetry={() => void contacts.refetch()} />
      ) : contacts.data.contacts.length === 0 ? (
        <Card>
          <EmptyState icon={<Users className="size-6" strokeWidth={1.5} />} title={status === 'all' && !q ? 'Nobody has joined yet' : 'No contacts match'}>
            {status === 'all' && !q ? (manual ? 'Add contacts here or through the API.' : 'Contacts join when the trigger happens after you published.') : 'Try another status or search.'}
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Contact</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Where they are</th>
                  <th className="px-4 py-2.5 font-medium">Next</th>
                  <th className="px-4 py-2.5 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {contacts.data.contacts.map((r) => {
                  const badge = r.status === 'in_progress' && contacts.data.paused ? { label: 'Paused', tone: 'amber' as const } : ENROLLMENT_BADGE[r.status];
                  return (
                    <tr key={r.enrollmentId} onClick={() => setOpen(r.enrollmentId)} className="cursor-pointer hover:bg-slate-50">
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-ink">{r.contact?.name ?? r.contact?.phone ?? 'Deleted contact'}</p>
                        {r.contact?.name && <p className="text-xs text-slate-500">{r.contact.phone}</p>}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </td>
                      <td className="max-w-72 px-4 py-2.5 text-slate-600">
                        {r.attention ? <span className="text-amber-700">{r.attention.message}</span> : r.currentStep ?? (r.outcome ? `${OUTCOME_LABEL[r.outcome] ?? r.outcome}${r.exitReason && !OUTCOME_LABEL[r.outcome]?.startsWith(r.exitReason) ? `: ${r.exitReason}` : ''}` : '—')}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">{r.nextRunAt ? formatDate(r.nextRunAt, true) : '—'}</td>
                      <td className="px-4 py-2.5 text-slate-500">{relativeTime(r.enrolledAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2.5 text-xs text-slate-500">
            <span>{contacts.data.total.toLocaleString('en-IN')} contacts</span>
            {contacts.data.pages > 1 && (
              <span className="flex items-center gap-2">
                <Button variant="ghost" className="min-h-7 px-2 text-xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                {page} / {contacts.data.pages}
                <Button variant="ghost" className="min-h-7 px-2 text-xs" disabled={page >= contacts.data.pages} onClick={() => setPage(page + 1)}>
                  Next
                </Button>
              </span>
            )}
          </div>
        </Card>
      )}

      {open && <HistoryDrawer sequenceId={s.id} enrollmentId={open} onClose={() => setOpen(null)} />}
      {adding && <AddContactsDialog sequenceId={s.id} onClose={() => setAdding(false)} />}
      {showApi && <ApiDialog seq={s} onClose={() => setShowApi(false)} />}
    </>
  );
}

interface History {
  enrollment: { id: string; status: EnrollmentStatus; outcome: string | null; enrolledAt: string; exitedAt: string | null; exitReason: string | null; nextRunAt: string | null; currentStep: string | null; data: Record<string, unknown>; versionNo: number | null; attention: { message: string } | null };
  contact: { id: string; name: string | null; phone: string } | null;
  history: { at: string; step: string | null; type: string; result: string; reason: string | null }[];
  messages: { step: string; status: string; sentAt: string; deliveredAt: string | null; readAt: string | null; repliedAt: string | null; errorCode: string | null }[];
}

const RESULT_TEXT: Record<string, string> = {
  joined: 'Joined',
  sent: 'Sent',
  waiting: 'Waiting',
  skipped: 'Skipped',
  postponed: 'Postponed',
  replanned: 'Date changed',
  took: 'Went',
  done: 'Done',
  failed: 'Failed',
  error: 'Error',
  retry_scheduled: 'Retry scheduled',
};

function HistoryDrawer({ sequenceId, enrollmentId, onClose }: { sequenceId: string; enrollmentId: string; onClose: () => void }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const base = `/workspaces/${workspace.id}/sequences/${sequenceId}/contacts/${enrollmentId}`;
  const query = useQuery({ queryKey: ['sequence-history', enrollmentId], queryFn: () => api.get<History>(base) });
  const remove = useMutation({
    mutationFn: () => api.post(`${base}/remove`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sequence-contacts', sequenceId] });
      void queryClient.invalidateQueries({ queryKey: ['sequence-history', enrollmentId] });
      setConfirm(false);
      toast.success('Removed from the sequence.');
    },
    onError: (err) => toast.error(err),
  });
  const d = query.data;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onClick={onClose}>
      <aside className="flex h-full w-full max-w-md flex-col bg-white shadow-xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Contact history">
        <div className="flex items-start gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-ink">{d?.contact?.name ?? d?.contact?.phone ?? 'Contact'}</h2>
            {d?.contact?.name && <p className="text-xs text-slate-500">{d.contact.phone}</p>}
          </div>
          <button onClick={onClose} className="rounded-full p-1 text-slate-500 ring-1 ring-slate-300 hover:bg-slate-50" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {query.isPending ? (
            <Spinner />
          ) : query.error ? (
            <Alert>{errorMessage(query.error)}</Alert>
          ) : (
            d && (
              <div className="space-y-5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={ENROLLMENT_BADGE[d.enrollment.status].tone}>{ENROLLMENT_BADGE[d.enrollment.status].label}</Badge>
                  {d.enrollment.versionNo && <span className="text-xs text-slate-500">on version {d.enrollment.versionNo}</span>}
                </div>
                {d.enrollment.attention && <Alert>{d.enrollment.attention.message}</Alert>}
                {d.enrollment.nextRunAt && (
                  <p className="text-slate-600">
                    Next: <strong className="font-medium text-ink">{d.enrollment.currentStep ?? 'next step'}</strong> at {formatDate(d.enrollment.nextRunAt, true)}
                  </p>
                )}
                {Object.keys(d.enrollment.data).length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-slate-500">Joined with</p>
                    <div className="rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700">
                      {Object.entries(d.enrollment.data).map(([k, v]) => (
                        <p key={k}>
                          {k}: {String(v)}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <p className="mb-2 text-xs font-medium text-slate-500">History</p>
                  <ol className="space-y-2.5 border-l border-slate-200 pl-4">
                    {d.history.map((h, i) => (
                      <li key={i} className="relative">
                        <span className={cn('absolute top-1.5 -left-[21px] size-2 rounded-full ring-2 ring-white', h.result === 'skipped' || h.result === 'postponed' ? 'bg-slate-300' : ['error', 'failed'].includes(h.result) ? 'bg-red-500' : h.type === 'exited' ? 'bg-slate-700' : 'bg-brand-500')} />
                        <p className="text-slate-800">
                          <span className="font-medium">{h.type === 'exited' ? `Left: ${OUTCOME_LABEL[h.result] ?? h.result}` : RESULT_TEXT[h.result] ?? h.result}</span>
                          {h.step && h.type !== 'exited' && <span className="text-slate-600"> · {h.step}</span>}
                        </p>
                        {h.reason && <p className="text-xs text-slate-500">{h.result === 'skipped' ? `Skipped: ${h.reason.charAt(0).toLowerCase()}${h.reason.slice(1)}` : h.reason}</p>}
                        <p className="text-[11px] text-slate-400">{formatDate(h.at, true)}</p>
                      </li>
                    ))}
                  </ol>
                </div>
                {d.messages.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-medium text-slate-500">Messages</p>
                    <ul className="space-y-1.5">
                      {d.messages.map((m, i) => (
                        <li key={i} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
                          <span className="truncate text-slate-700">{m.step}</span>
                          <span className="shrink-0 text-xs text-slate-500">{m.repliedAt ? 'Replied' : m.readAt ? 'Read' : m.deliveredAt ? 'Delivered' : m.status === 'failed' ? `Failed${m.errorCode ? ` (${m.errorCode})` : ''}` : m.status}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )
          )}
        </div>
        {d && ['in_progress', 'needs_attention'].includes(d.enrollment.status) && can('sequences:manage') && (
          <div className="border-t border-slate-200 px-5 py-3">
            <Button variant="danger" onClick={() => setConfirm(true)}>
              <UserMinus className="size-4" /> Remove from sequence
            </Button>
          </div>
        )}
      </aside>
      {confirm && (
        <ConfirmDialog title="Remove this contact?" confirmLabel="Remove" loading={remove.isPending} onConfirm={() => remove.mutate()} onClose={() => setConfirm(false)}>
          They get no more messages from this sequence. Their history stays.
        </ConfirmDialog>
      )}
    </div>
  );
}

function AddContactsDialog({ sequenceId, onClose }: { sequenceId: string; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [phones, setPhones] = useState('');
  const [listId, setListId] = useState('');
  const lists = useQuery({ queryKey: ['contact-lists', workspace.id, ''], queryFn: () => api.get<{ lists: ContactList[] }>(`/workspaces/${workspace.id}/contact-lists`), select: (d) => d.lists });
  const add = useMutation({
    mutationFn: () =>
      api.post<{ results: Record<string, number> }>(`/workspaces/${workspace.id}/sequences/${sequenceId}/enroll`, {
        phones: phones.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean),
        listId: listId || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sequence-contacts', sequenceId] });
      void queryClient.invalidateQueries({ queryKey: ['sequences', workspace.id] });
    },
  });
  const r = add.data?.results;
  const LABELS: Record<string, string> = { enrolled: 'joined', already_in: 'already in it', opted_out: 'opted out', blocked: 'blocked', filtered: "didn't match the filter", not_again_yet: 'joined before', capped: 'over the cap', limit_reached: 'over the monthly limit', invalid: 'invalid numbers' };
  return (
    <Dialog
      icon={<UserPlus className="size-5" strokeWidth={1.5} />}
      title="Add contacts"
      subtitle="Paste numbers or pick a contact list. Opted-out contacts are never added."
      onClose={onClose}
      footer={
        r ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={add.isPending} disabled={!phones.trim() && !listId} onClick={() => add.mutate()}>
              Add to sequence
            </Button>
          </>
        )
      }
    >
      {r ? (
        <ul className="space-y-1 text-sm">
          {Object.entries(r)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => (
              <li key={k} className={k === 'enrolled' ? 'font-medium text-brand-700' : 'text-slate-600'}>
                {n.toLocaleString('en-IN')} {LABELS[k] ?? k}
              </li>
            ))}
          {Object.values(r).every((n) => n === 0) && <li className="text-slate-600">Nobody to add.</li>}
        </ul>
      ) : (
        <div className="space-y-3">
          {add.error != null && <Alert>{errorMessage(add.error)}</Alert>}
          <Field label="Phone numbers" htmlFor="seq-add-phones" hint="One per line, or separated by commas.">
            <textarea id="seq-add-phones" rows={5} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-600 focus:ring-3 focus:ring-brand-600/15 focus:outline-none" placeholder={'+91 98765 43210\n+91 91234 56789'} value={phones} onChange={(e) => setPhones(e.target.value)} />
          </Field>
          <Field label="Or everyone in a list" htmlFor="seq-add-list">
            <Select id="seq-add-list" value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">No list</option>
              {(lists.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.count})
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </Dialog>
  );
}

function ApiDialog({ seq, onClose }: { seq: SequenceDetail; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const origin = window.location.origin;
  const key = 'YOUR_API_KEY';
  const dateKey = seq.dateMode === 'per_contact' && seq.dateKey ? seq.dateKey : null;
  const sample = dateKey ? `{"${dateKey}":"2026-12-10T00:00:00+05:30"}` : '{"order_no":"A-1042"}';
  const commands = [
    {
      title: 'Add contacts (up to 100 per call)',
      code: `curl -X POST ${origin}/api/v1/sequences/${seq.id}/enroll \\\n  -H "X-API-Key: ${key}" -H "Content-Type: application/json" \\\n  -d '{"contacts":[{"phone":"+919876543210","name":"Ravi","data":${sample}}]}'`,
    },
    {
      title: 'Send an event (becomes a tag; new data moves dated reminders)',
      code: `curl -X POST ${origin}/api/v1/sequences/events \\\n  -H "X-API-Key: ${key}" -H "Content-Type: application/json" \\\n  -d '{"phone":"+919876543210","event":"upgraded","data":{}}'`,
    },
    {
      title: 'Remove a contact',
      code: `curl -X POST ${origin}/api/v1/sequences/${seq.id}/exit \\\n  -H "X-API-Key: ${key}" -H "Content-Type: application/json" \\\n  -d '{"phone":"+919876543210","reason":"order_cancelled"}'`,
    },
    { title: 'Where is a contact?', code: `curl ${origin}/api/v1/sequences/${seq.id}/contacts/+919876543210 \\\n  -H "X-API-Key: ${key}"` },
  ];
  return (
    <Dialog icon={<Code2 className="size-5" strokeWidth={1.5} />} title="Use this sequence from your systems" subtitle="Same API keys as the rest of Zeta Connect (scope: sequences:run)." width="max-w-2xl" onClose={onClose}>
      <div className="space-y-4">
        {seq.trigger.type !== 'manual' && <Alert tone="info">This sequence also adds people by its own trigger. API enrolls work for any live sequence.</Alert>}
        {commands.map((c) => (
          <div key={c.title}>
            <p className="mb-1 text-sm font-medium text-slate-800">{c.title}</p>
            <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3 py-2.5 text-xs leading-relaxed text-slate-100">{c.code}</pre>
          </div>
        ))}
        <p className="text-xs text-slate-500">
          Create a key under{' '}
          <Link to={`/w/${workspace.id}/developer`} className="text-brand-700 hover:underline">
            Developers
          </Link>
          . Results per contact: enrolled, already_in, opted_out, invalid, and more.
        </p>
      </div>
    </Dialog>
  );
}

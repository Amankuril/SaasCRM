import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, MessageSquare, Plus, Tags, Upload, Users, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ContactDetails } from '../components/ContactDetails';
import { ImportContactsModal } from '../components/ImportContactsModal';
import { TagsModal } from '../components/TagsModal';
import { CONSENT_LABEL, Modal, useStageOptions, StageBadge, TagChip } from '../components/crm';
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, errorMessage, fieldError } from '../components/ui';
import { ApiError, api, type Contact } from '../lib/api';
import { useTags } from '../lib/hooks';
import { formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';

interface ContactPage {
  contacts: Contact[];
  total: number;
  page: number;
  pages: number;
}

export function ContactsPage() {
  const STAGES = useStageOptions();
  const { workspace, can } = useWorkspace();
  const writable = workspace.status !== 'suspended';
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [stage, setStage] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [modal, setModal] = useState<'new' | 'import' | 'tags' | null>(null);
  const [exportError, setExportError] = useState<unknown>(null);
  const tags = useTags(workspace.id);
  const tagById = new Map((tags.data ?? []).map((t) => [t.id, t]));

  const list = useQuery({
    queryKey: ['contacts', workspace.id, { q, tag, stage, page }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: '25' });
      if (q.trim()) params.set('q', q.trim());
      if (tag) params.set('tag', tag);
      if (stage) params.set('stage', stage);
      return api.get<ContactPage>(`/workspaces/${workspace.id}/contacts?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  const resetPage = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="Contacts"
        description="Everyone who has messaged you or been added to this workspace."
        actions={
          <div className="flex flex-wrap gap-2">
            {can('tags:manage') && writable && (
              <Button variant="secondary" onClick={() => setModal('tags')}>
                <Tags className="size-4" /> Tags
              </Button>
            )}
            {can('contacts:export') && (
              <Button
                variant="secondary"
                onClick={() => {
                  setExportError(null);
                  api.download(`/workspaces/${workspace.id}/contacts/export`, 'contacts.csv').catch(setExportError);
                }}
              >
                <Download className="size-4" /> Export
              </Button>
            )}
            {can('contacts:import') && writable && (
              <Button variant="secondary" onClick={() => setModal('import')}>
                <Upload className="size-4" /> Import CSV
              </Button>
            )}
            {can('contacts:manage') && writable && (
              <Button onClick={() => setModal('new')}>
                <Plus className="size-4" /> New contact
              </Button>
            )}
          </div>
        }
      />
      {exportError != null && (
        <div className="mb-4">
          <Alert>{errorMessage(exportError)}</Alert>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
          <Input aria-label="Search contacts" placeholder="Search name, phone or email…" value={q} onChange={(e) => resetPage(setQ)(e.target.value)} className="max-w-xs" />
          <div className="w-40">
            <Select aria-label="Filter by tag" value={tag} onChange={(e) => resetPage(setTag)(e.target.value)}>
              <option value="">All tags</option>
              {tags.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-40">
            <Select aria-label="Filter by stage" value={stage} onChange={(e) => resetPage(setStage)(e.target.value)}>
              <option value="">All stages</option>
              {STAGES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          {list.data && <span className="ml-auto self-center text-sm text-slate-500">{list.data.total} contacts</span>}
        </div>

        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <Alert>{errorMessage(list.error)}</Alert>
          </div>
        ) : list.data.contacts.length === 0 ? (
          <EmptyState icon={<Users className="size-5" />} title={q || tag || stage ? 'No contacts match these filters' : 'No contacts yet'}>
            {!q && !tag && !stage && 'Contacts are created automatically when customers message you, or you can add and import them.'}
          </EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Contact</th>
                    <th className="hidden px-4 py-2.5 font-medium md:table-cell">Tags</th>
                    <th className="px-4 py-2.5 font-medium">Stage</th>
                    <th className="hidden px-4 py-2.5 font-medium lg:table-cell">Consent</th>
                    <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Added</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.data.contacts.map((c) => (
                    <tr key={c.id} onClick={() => setSelected(c.id)} className="cursor-pointer hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-800">{c.displayName}</p>
                        <p className="text-xs text-slate-500">{c.phone}</p>
                      </td>
                      <td className="hidden px-4 py-3 md:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {c.tags.slice(0, 3).map((id) => {
                            const t = tagById.get(id);
                            return t ? <TagChip key={id} tag={t} /> : null;
                          })}
                          {c.tags.length > 3 && <span className="text-xs text-slate-400">+{c.tags.length - 3}</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <StageBadge stage={c.lifecycleStage} />
                      </td>
                      <td className="hidden px-4 py-3 text-slate-600 lg:table-cell">{CONSENT_LABEL[c.consent.status]}</td>
                      <td className="hidden px-4 py-3 text-slate-500 sm:table-cell">{formatDate(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.data.pages > 1 && (
              <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm">
                <span className="text-slate-500">
                  Page {list.data.page} of {list.data.pages}
                </span>
                <div className="flex gap-2">
                  <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button variant="secondary" disabled={page >= list.data.pages} onClick={() => setPage(page + 1)} aria-label="Next page">
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      {selected && <ContactDrawer contactId={selected} onClose={() => setSelected(null)} />}
      {modal === 'new' && <NewContactModal onClose={() => setModal(null)} onCreated={(id) => { setModal(null); setSelected(id); }} />}
      {modal === 'import' && <ImportContactsModal onClose={() => setModal(null)} />}
      {modal === 'tags' && <TagsModal onClose={() => setModal(null)} />}
    </>
  );
}

function ContactDrawer({ contactId, onClose }: { contactId: string; onClose: () => void }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['contact', workspace.id, contactId],
    queryFn: () => api.get<{ contact: Contact; conversation: { id: string; status: string } | null }>(`/workspaces/${workspace.id}/contacts/${contactId}`),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/workspaces/${workspace.id}/contacts/${contactId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['contacts', workspace.id] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onClick={onClose}>
      <aside className="flex h-full w-full max-w-md flex-col bg-white shadow-xl" onClick={(e) => e.stopPropagation()} aria-label="Contact details">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 className="truncate font-semibold text-ink">{query.data?.contact.displayName ?? 'Contact'}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-slate-500 hover:bg-slate-100" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {query.isPending ? (
            <Spinner />
          ) : query.error ? (
            <Alert>{errorMessage(query.error)}</Alert>
          ) : (
            <div className="space-y-5">
              {query.data.conversation && (
                <Link to={`/w/${workspace.id}/inbox?c=${query.data.conversation.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
                  <MessageSquare className="size-4" /> Open conversation
                </Link>
              )}
              <ContactDetails contact={query.data.contact} compact />
              {can('contacts:delete') && workspace.status !== 'suspended' && (
                <div className="border-t border-slate-100 pt-4">
                  {remove.error != null && <Alert>{errorMessage(remove.error)}</Alert>}
                  <Button
                    variant="danger"
                    loading={remove.isPending}
                    onClick={() => window.confirm('Delete this contact and their entire conversation history? This cannot be undone.') && remove.mutate()}
                  >
                    Delete contact
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function NewContactModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ phone: '', name: '', email: '' });
  const create = useMutation({
    mutationFn: () => api.post<{ contact: Contact }>(`/workspaces/${workspace.id}/contacts`, { phone: form.phone, name: form.name || null, email: form.email || null }),
    onSuccess: ({ contact }) => {
      void queryClient.invalidateQueries({ queryKey: ['contacts', workspace.id] });
      onCreated(contact.id);
    },
  });
  const err = create.error;
  const isFieldError = err instanceof ApiError && err.code === 'VALIDATION_ERROR';

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <Modal title="New contact" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {err != null && !isFieldError && <Alert>{errorMessage(err)}</Alert>}
        <Field label="Phone number" htmlFor="nc-phone" error={fieldError(err, 'phone')} hint={`Without a country code it's read as a ${workspace.country} number.`}>
          <Input id="nc-phone" type="tel" autoFocus value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Name" htmlFor="nc-name" error={fieldError(err, 'name')}>
          <Input id="nc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Email" htmlFor="nc-email" error={fieldError(err, 'email')}>
          <Input id="nc-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Button type="submit" loading={create.isPending}>
          Add contact
        </Button>
      </form>
    </Modal>
  );
}

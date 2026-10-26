import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleHelp, Eye, FilePlus2, ListChecks, Plus, RefreshCw, Search, Trash2, UserMinus, UserPlus, Users } from 'lucide-react';
import { useDeferredValue, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { TagChip } from '../../components/crm';
import { Alert, Button, EmptyState, Input, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type Contact, type ContactList } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { AddContactDialog, AssignListsDialog, NewListDialog } from './ListDialogs';
import { ListDetailView } from './ListDetailView';
import { initialsOf, longDate, toneFor } from './listUi';

type Tab = 'lists' | 'contacts' | 'unsubscribed';

export function ContactListsPage() {
  const { workspace, can } = useWorkspace();
  const navigate = useNavigate();
  const canManage = can('contacts:manage') && workspace.status !== 'suspended';
  const [tab, setTab] = useState<Tab>('lists');
  const [q, setQ] = useState('');
  const deferredQ = useDeferredValue(q.trim());
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState<ContactList | null>(null);
  const [viewing, setViewing] = useState<ContactList | null>(null);
  // Animate the lists table back in only when returning from a list.
  const [cameBack, setCameBack] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setSelected(new Set()), [tab]);

  const lists = useQuery({
    queryKey: ['contact-lists', workspace.id, deferredQ],
    queryFn: () => api.get<{ lists: ContactList[] }>(`/workspaces/${workspace.id}/contact-lists?${new URLSearchParams(deferredQ ? { q: deferredQ } : {})}`),
    placeholderData: (prev) => prev,
  });
  const allLists = useQuery({ queryKey: ['contact-lists', workspace.id, ''], queryFn: () => api.get<{ lists: ContactList[] }>(`/workspaces/${workspace.id}/contact-lists`), enabled: tab !== 'lists' });
  const listName = new Map((allLists.data?.lists ?? lists.data?.lists ?? []).map((l) => [l.id, l.name]));

  const contacts = useQuery({
    queryKey: ['contacts', workspace.id, 'broadcast', tab, deferredQ],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' });
      if (deferredQ) params.set('q', deferredQ);
      if (tab === 'unsubscribed') params.set('consent', 'opted_out');
      return api.get<{ contacts: Contact[]; total: number }>(`/workspaces/${workspace.id}/contacts?${params}`);
    },
    enabled: tab !== 'lists',
    placeholderData: (prev) => prev,
  });

  const queryClient = useQueryClient();
  const deleteLists = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await api.delete(`/workspaces/${workspace.id}/contact-lists/${id}`);
    },
    onSettled: () => {
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['contact-lists', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['contacts', workspace.id] });
    },
  });

  const refresh = () => void (tab === 'lists' ? lists.refetch() : contacts.refetch());
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const rows = tab === 'lists' ? (lists.data?.lists ?? []) : (contacts.data?.contacts ?? []);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const fetching = tab === 'lists' ? lists.isFetching : contacts.isFetching;

  const TabButton = ({ value, icon: Icon, label }: { value: Tab; icon: typeof Users; label: string }) => (
    <button type="button" onClick={() => setTab(value)} className={cn('inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium', tab === value ? 'bg-white text-ink shadow-sm' : 'text-slate-600 hover:text-ink')}>
      <Icon className="size-4" /> {label}
    </button>
  );

  return (
    <>
      <div className="mb-6 flex items-start gap-3">
        <span className="rounded-xl bg-sky-50 p-2.5 text-sky-600 ring-1 ring-sky-100">
          <Users className="size-5" />
        </span>
        <div className="relative">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-ink">
            Contacts List
            <button type="button" onClick={() => setHowOpen(!howOpen)} className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100">
              <CircleHelp className="size-3.5" /> How it works
            </button>
          </h1>
          <p className="text-sm text-slate-500">Organize your audience into lists, contacts and tags.</p>
          {howOpen && (
            <div className="absolute top-full left-0 z-20 mt-2 w-96 max-w-[90vw] rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-lg">
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>Create a list for each audience, e.g. “Diwali Leads”.</li>
                <li>Add people with the add-contact icon: one by one, or upload a CSV (optionally with tags).</li>
                <li>A person can be in several lists but is stored once; deleting a list keeps its contacts.</li>
                <li>In Create Campaign, choose “Contact list” as the audience. Unsubscribers are always skipped.</li>
              </ol>
              <div className="mt-3 flex gap-4 text-xs font-medium">
                <Link to={`/w/${workspace.id}/broadcast/guide#contacts`} className="text-brand-700 hover:underline">
                  Read the full guide →
                </Link>
                <button className="text-slate-500" onClick={() => setHowOpen(false)}>
                  Got it
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {viewing ? (
        <ListDetailView key={viewing.id} list={viewing} onBack={() => (setViewing(null), setCameBack(true))} />
      ) : (
        <div className={cameBack ? 'animate-slide-in-left' : undefined}>
        <div className="mb-4 inline-flex gap-1 rounded-xl bg-slate-100 p-1">
          <TabButton value="lists" icon={ListChecks} label="All Lists" />
          <TabButton value="contacts" icon={Users} label="All Contacts" />
          <TabButton value="unsubscribed" icon={UserMinus} label="Unsubscribers" />
        </div>

        <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <Input aria-label="Search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <Button variant="secondary" onClick={refresh} aria-label="Refresh" title="Refresh">
            <RefreshCw className={cn('size-4', fetching && 'animate-spin')} />
          </Button>
          {canManage && tab === 'lists' && selected.size > 0 && (
            <Button
              variant="danger"
              loading={deleteLists.isPending}
              onClick={() => window.confirm(`Delete ${selected.size} list(s)? Their contacts stay in Contacts.`) && deleteLists.mutate([...selected])}
            >
              <Trash2 className="size-4" /> Delete ({selected.size})
            </Button>
          )}
          {canManage && (
            <>
              <Button onClick={() => setCreating(true)} className="bg-slate-700 hover:bg-slate-800">
                <Plus className="size-4" /> New List
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  if (tab !== 'contacts' || !selected.size) {
                    setTab('contacts');
                    setNotice('Tick the contacts you want, then click Assign Lists again.');
                  } else setAssigning(true);
                }}
              >
                <Users className="size-4" /> Assign Lists{tab === 'contacts' && selected.size ? ` (${selected.size})` : ''}
              </Button>
            </>
          )}
          <Button variant="secondary" onClick={() => navigate(`/w/${workspace.id}/templates/new`)}>
            <FilePlus2 className="size-4" /> Create Template
          </Button>
        </div>
        {deleteLists.error != null && (
          <div className="mb-3">
            <Alert>{errorMessage(deleteLists.error)}</Alert>
          </div>
        )}
        {notice && tab === 'contacts' && !selected.size && (
          <div className="mb-3">
            <Alert tone="info">{notice}</Alert>
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {tab === 'lists' ? (
            lists.isPending ? (
              <Spinner />
            ) : lists.error ? (
              <div className="p-4">
                <Alert>{errorMessage(lists.error)}</Alert>
              </div>
            ) : lists.data.lists.length === 0 ? (
              <EmptyState icon={<ListChecks className="size-5" />} title={q ? 'No lists match' : 'No contact lists yet'}>
                {q ? 'Try another search.' : 'Create a list, then add contacts to it one by one or from a CSV.'}
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="bg-slate-50 text-left text-slate-600">
                    <tr>
                      <th className="w-12 px-4 py-3">
                        <input type="checkbox" aria-label="Select all lists" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} />
                      </th>
                      <th className="px-3 py-3 font-medium">List Name</th>
                      <th className="px-3 py-3 font-medium">Count</th>
                      <th className="px-3 py-3 font-medium">Created On</th>
                      <th className="px-3 py-3 font-medium">Tags</th>
                      <th className="px-3 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lists.data.lists.map((l) => (
                      <tr key={l.id} className="hover:bg-slate-50/60">
                        <td className="px-4 py-3">
                          <input type="checkbox" aria-label={`Select ${l.name}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                        </td>
                        <td className="px-3 py-3">
                          <button className="flex items-center gap-3 text-left" onClick={() => setViewing(l)}>
                            <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold', toneFor(l.id))}>{initialsOf(l.name) || '?'}</span>
                            <span className="font-medium text-slate-800 hover:underline">{l.name}</span>
                          </button>
                        </td>
                        <td className="px-3 py-3 text-slate-700">{l.count}</td>
                        <td className="px-3 py-3 text-slate-600">{longDate(l.createdAt)}</td>
                        <td className="px-3 py-3">
                          {l.tags.length ? (
                            <div className="flex flex-wrap gap-1">
                              {l.tags.map((t) => (
                                <TagChip key={t.id} tag={t} />
                              ))}
                            </div>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex justify-end gap-1">
                            <button onClick={() => setViewing(l)} className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100" aria-label={`View ${l.name}`} title="View contacts">
                              <Eye className="size-4" />
                            </button>
                            {canManage && (
                              <button onClick={() => setAdding(l)} className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100" aria-label={`Add contacts to ${l.name}`} title="Add contacts">
                                <UserPlus className="size-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : contacts.isPending ? (
            <Spinner />
          ) : contacts.error ? (
            <div className="p-4">
              <Alert>{errorMessage(contacts.error)}</Alert>
            </div>
          ) : contacts.data.contacts.length === 0 ? (
            <EmptyState icon={<Users className="size-5" />} title={tab === 'unsubscribed' ? 'No unsubscribers' : q ? 'No contacts match' : 'No contacts yet'}>
              {tab === 'unsubscribed' ? 'People who reply STOP or are unsubscribed by an auto reply show up here. They never receive broadcasts.' : 'Add contacts to a list to see them here.'}
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-slate-50 text-left text-slate-600">
                  <tr>
                    {tab === 'contacts' && (
                      <th className="w-12 px-4 py-3">
                        <input type="checkbox" aria-label="Select all contacts" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} />
                      </th>
                    )}
                    <th className="px-3 py-3 font-medium">Name</th>
                    <th className="px-3 py-3 font-medium">WhatsApp number</th>
                    <th className="px-3 py-3 font-medium">Lists</th>
                    <th className="px-3 py-3 font-medium">{tab === 'unsubscribed' ? 'Unsubscribed' : 'Added'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {contacts.data.contacts.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50/60">
                      {tab === 'contacts' && (
                        <td className="px-4 py-3">
                          <input type="checkbox" aria-label={`Select ${c.displayName}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                        </td>
                      )}
                      <td className="px-3 py-3 font-medium text-slate-800">{c.name || c.profileName || <span className="font-normal text-slate-400">—</span>}</td>
                      <td className="px-3 py-3 font-mono text-xs text-slate-600">{c.phone}</td>
                      <td className="px-3 py-3">
                        {c.lists.length ? (
                          <div className="flex flex-wrap gap-1">
                            {c.lists.map((id) => (
                              <span key={id} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                                {listName.get(id) ?? 'List'}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-slate-600">{formatDate(tab === 'unsubscribed' ? (c.consent.updatedAt ?? c.createdAt) : c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {contacts.data.total > contacts.data.contacts.length && (
                <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
                  Showing the latest {contacts.data.contacts.length} of {contacts.data.total}. Search to find others, or see everyone in Contacts.
                </p>
              )}
            </div>
          )}
        </div>
        </div>
      )}

      {creating && <NewListDialog onClose={() => setCreating(false)} onCreated={(l) => setAdding(l)} />}
      {adding && <AddContactDialog list={adding} onClose={() => setAdding(null)} />}
      {assigning && (
        <AssignListsDialog
          contactIds={[...selected]}
          onClose={() => setAssigning(false)}
          onDone={() => {
            setAssigning(false);
            setSelected(new Set());
            setNotice(null);
          }}
        />
      )}
    </>
  );
}

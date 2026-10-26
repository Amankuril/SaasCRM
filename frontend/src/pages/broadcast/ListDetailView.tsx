import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download, MoreVertical, Pencil, RefreshCw, Search, Trash2, UserMinus, UserPen, UserPlus, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { TagChip } from '../../components/crm';
import { Dialog } from '../../components/Dialog';
import { Alert, Button, Input, Select, Spinner, cn, errorMessage, fieldError } from '../../components/ui';
import { ApiError, api, type ConsentStatus, type Contact, type ContactList } from '../../lib/api';
import { useTags } from '../../lib/hooks';
import { useWorkspace } from '../../layouts/workspaceContext';
import { AddContactDialog, AssignListsDialog } from './ListDialogs';
import { initialsOf, longDate, toneFor } from './listUi';

type SortKey = 'name' | 'phone' | 'createdAt';
const PAGE_SIZE = 25;

/** One contact list opened in place of the lists table ("👁" in Contacts List). */
export function ListDetailView({ list, onBack }: { list: ContactList; onBack: () => void }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const canManage = can('contacts:manage') && workspace.status !== 'suspended';
  const [name, setName] = useState(list.name);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'createdAt', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const tags = useTags(workspace.id);
  const tagById = new Map((tags.data ?? []).map((t) => [t.id, t]));

  useEffect(() => setPage(1), [q, sort]);

  const members = useQuery({
    queryKey: ['contacts', workspace.id, 'list', list.id, q.trim(), sort, page],
    queryFn: () =>
      api.get<{ contacts: Contact[]; total: number; pages: number }>(
        `/workspaces/${workspace.id}/contact-lists/${list.id}/contacts?${new URLSearchParams({ q: q.trim(), page: String(page), limit: String(PAGE_SIZE), sort: sort.key, dir: sort.dir })}`,
      ),
    placeholderData: keepPreviousData,
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['contacts', workspace.id] });
    void queryClient.invalidateQueries({ queryKey: ['contact-lists', workspace.id] });
  };

  const removeFromList = useMutation({
    mutationFn: (contactIds: string[]) => api.post(`/workspaces/${workspace.id}/contact-lists/${list.id}/remove`, { contactIds }),
    onSuccess: () => {
      setSelected(new Set());
      invalidate();
    },
  });
  const deleteContacts = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await api.delete(`/workspaces/${workspace.id}/contacts/${id}`);
    },
    onSettled: () => {
      setSelected(new Set());
      invalidate();
    },
  });
  const exportAll = useMutation({ mutationFn: () => api.download(`/workspaces/${workspace.id}/contacts/export?list=${list.id}`, `${list.name}.csv`) });
  const rename = useMutation({
    mutationFn: () => api.patch<{ list: ContactList }>(`/workspaces/${workspace.id}/contact-lists/${list.id}`, { name }),
    onSuccess: () => {
      setRenaming(false);
      invalidate();
    },
  });
  const deleteList = useMutation({
    mutationFn: () => api.delete(`/workspaces/${workspace.id}/contact-lists/${list.id}`),
    onSuccess: () => {
      invalidate();
      onBack();
    },
  });
  const error = removeFromList.error ?? deleteContacts.error ?? exportAll.error ?? rename.error ?? deleteList.error;

  const rows = members.data?.contacts ?? [];
  const total = members.data?.total ?? list.count;
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'createdAt' ? 'desc' : 'asc' }));
  const SortHeader = ({ k, label }: { k: SortKey; label: string }) => {
    const Icon = sort.key !== k ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
    return (
      <button type="button" onClick={() => toggleSort(k)} className="inline-flex items-center gap-1.5 font-medium hover:text-ink" aria-label={`Sort by ${label}`}>
        {label} <Icon className={cn('size-3.5', sort.key === k ? 'text-ink' : 'text-slate-400')} />
      </button>
    );
  };

  return (
    <div className="animate-slide-in-right">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={onBack}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        {renaming ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              rename.mutate();
            }}
          >
            <Input aria-label="List name" autoFocus maxLength={255} value={name} onChange={(e) => setName(e.target.value)} className="w-64" />
            <Button type="submit" loading={rename.isPending} disabled={!name.trim()}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => (setRenaming(false), setName(list.name))}>
              Cancel
            </Button>
          </form>
        ) : (
          <h2 className="text-lg font-semibold text-ink">{rename.isSuccess ? name : list.name}</h2>
        )}
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
          {total} contact{total === 1 ? '' : 's'}
        </span>
        {canManage && !renaming && <ListMenu open={menuOpen} setOpen={setMenuOpen} onRename={() => setRenaming(true)} onDelete={() => window.confirm(`Delete the list "${list.name}"? Its contacts stay in Contacts.`) && deleteList.mutate()} />}
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
          <Input aria-label="Search this list" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <Button variant="secondary" onClick={() => void members.refetch()} aria-label="Refresh" title="Refresh">
          <RefreshCw className={cn('size-4', members.isFetching && 'animate-spin')} />
        </Button>
        {canManage && (
          <Button onClick={() => setAdding(true)} className="bg-slate-700 hover:bg-slate-800">
            <UserPlus className="size-4" /> Add Contact
          </Button>
        )}
        {can('contacts:export') && (
          <Button variant="secondary" onClick={() => exportAll.mutate()} loading={exportAll.isPending}>
            <Download className="size-4" /> Export All
          </Button>
        )}
      </div>

      {error != null && (
        <div className="mb-3">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      )}
      {selected.size > 0 && canManage && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          <span className="font-medium text-slate-700">{selected.size} selected</span>
          <Button variant="secondary" onClick={() => setAssigning(true)}>
            <Users className="size-4" /> Add to lists
          </Button>
          <Button variant="secondary" loading={removeFromList.isPending} onClick={() => removeFromList.mutate([...selected])}>
            <UserMinus className="size-4" /> Remove from list
          </Button>
          {can('contacts:delete') && (
            <Button
              variant="danger"
              loading={deleteContacts.isPending}
              onClick={() => window.confirm(`Delete ${selected.size} contact(s) everywhere, including their chat history? This can't be undone.`) && deleteContacts.mutate([...selected])}
            >
              <Trash2 className="size-4" /> Delete contacts
            </Button>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {members.isPending ? (
          <Spinner />
        ) : members.error ? (
          <div className="p-4">
            <Alert>{errorMessage(members.error)}</Alert>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <span className="mb-3 rounded-full bg-slate-100 p-3 text-slate-500">
              <Users className="size-5" />
            </span>
            <p className="text-sm font-medium text-slate-800">{q ? 'No contacts match' : 'This list is empty'}</p>
            <p className="mt-1 text-sm text-slate-500">{q ? 'Try another name or number.' : 'Add contacts one by one or upload a CSV.'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="w-12 px-4 py-3">
                    <input type="checkbox" aria-label="Select all on this page" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} />
                  </th>
                  <th className="px-3 py-3">
                    <SortHeader k="name" label="Name" />
                  </th>
                  <th className="px-3 py-3">
                    <SortHeader k="phone" label="Number" />
                  </th>
                  <th className="px-3 py-3">
                    <SortHeader k="createdAt" label="Created On" />
                  </th>
                  <th className="px-3 py-3 font-medium">Tags</th>
                  <th className="px-3 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((c) => {
                  const display = c.name || c.profileName || c.phone;
                  return (
                    <tr key={c.id} className="hover:bg-slate-50/60">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${display}`}
                          checked={selected.has(c.id)}
                          onChange={() => {
                            const next = new Set(selected);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-3">
                          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold', toneFor(c.id))}>{initialsOf(display) || '?'}</span>
                          <span className="max-w-64 truncate font-medium text-slate-800" title={display}>
                            {display}
                          </span>
                          {c.consent.status === 'opted_out' && <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-600">Unsubscribed</span>}
                        </div>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-slate-700">{c.phone}</td>
                      <td className="px-3 py-3 text-slate-600">{longDate(c.createdAt)}</td>
                      <td className="px-3 py-3">
                        {c.tags.length ? (
                          <div className="flex flex-wrap gap-1">
                            {c.tags.slice(0, 3).map((id) => tagById.get(id) && <TagChip key={id} tag={tagById.get(id)!} />)}
                            {c.tags.length > 3 && <span className="text-xs text-slate-400">+{c.tags.length - 3}</span>}
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {canManage && (
                          <button onClick={() => setEditing(c)} className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100" aria-label={`Edit ${display}`} title="Edit contact">
                            <Pencil className="size-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {members.data && members.data.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
            <span>
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, members.data.total)} of {members.data.total}
            </span>
            {members.data.pages > 1 && (
              <div className="flex items-center gap-2">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
                  <ChevronLeft className="size-4" />
                </Button>
                <span>
                  {page} / {members.data.pages}
                </span>
                <Button variant="secondary" disabled={page >= members.data.pages} onClick={() => setPage(page + 1)} aria-label="Next page">
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {adding && <AddContactDialog list={list} onClose={() => setAdding(false)} />}
      {assigning && <AssignListsDialog contactIds={[...selected]} onClose={() => setAssigning(false)} onDone={() => (setAssigning(false), setSelected(new Set()))} />}
      {editing && <EditContactDialog contact={editing} onClose={() => setEditing(null)} onSaved={invalidate} />}
    </div>
  );
}

function ListMenu({ open, setOpen, onRename, onDelete }: { open: boolean; setOpen: (v: boolean) => void; onRename: () => void; onDelete: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, setOpen]);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100" aria-label="List options">
        <MoreVertical className="size-4" />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 z-20 mt-1 w-40 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
          <button role="menuitem" onClick={() => (setOpen(false), onRename())} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            <Pencil className="size-4" /> Rename list
          </button>
          <button role="menuitem" onClick={() => (setOpen(false), onDelete())} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-red-600 hover:bg-red-50">
            <Trash2 className="size-4" /> Delete list
          </button>
        </div>
      )}
    </div>
  );
}

const CONSENT_LABEL: Record<ConsentStatus, string> = { unknown: 'Subscribed', opted_in: 'Opted in', opted_out: 'Unsubscribed' };

function EditContactDialog({ contact, onClose, onSaved }: { contact: Contact; onClose: () => void; onSaved: () => void }) {
  const { workspace } = useWorkspace();
  const tags = useTags(workspace.id);
  const [form, setForm] = useState({ name: contact.name ?? '', phone: contact.phone, email: contact.email ?? '', tags: contact.tags, consentStatus: contact.consent.status });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const save = useMutation({
    mutationFn: () =>
      api.patch<{ contact: Contact }>(`/workspaces/${workspace.id}/contacts/${contact.id}`, {
        name: form.name.trim() || null,
        ...(form.phone.trim() !== contact.phone ? { phone: form.phone.trim() } : {}),
        email: form.email.trim(),
        tags: form.tags,
        ...(form.consentStatus !== contact.consent.status ? { consentStatus: form.consentStatus } : {}),
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  const err = save.error;
  const isField = err instanceof ApiError && err.code === 'VALIDATION_ERROR';
  const label = 'mb-1.5 block text-sm font-medium text-slate-600';

  return (
    <Dialog
      icon={<UserPen className="size-4" />}
      title="Edit Contact"
      subtitle={contact.profileName ? `WhatsApp name: ${contact.profileName}` : contact.phone}
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} className="bg-slate-700 hover:bg-slate-800">
            Save Changes
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {err != null && !isField && <Alert>{errorMessage(err)}</Alert>}
        <div>
          <label htmlFor="ec-name" className={label}>
            Customer name
          </label>
          <Input id="ec-name" maxLength={200} value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div>
          <label htmlFor="ec-phone" className={label}>
            WhatsApp number
          </label>
          <Input id="ec-phone" type="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} invalid={!!fieldError(err, 'phone')} />
          <p className={cn('mt-1 text-xs', fieldError(err, 'phone') ? 'text-red-600' : 'text-slate-500')}>{fieldError(err, 'phone') ?? 'With country code, e.g. +91 98765 43210.'}</p>
        </div>
        <div>
          <label htmlFor="ec-email" className={label}>
            Email (optional)
          </label>
          <Input id="ec-email" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} invalid={!!fieldError(err, 'email')} />
          {fieldError(err, 'email') && <p className="mt-1 text-xs text-red-600">{fieldError(err, 'email')}</p>}
        </div>
        <div>
          <p className={label}>Tags</p>
          {tags.data?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {tags.data.map((t) => {
                const on = form.tags.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => set({ tags: on ? form.tags.filter((x) => x !== t.id) : [...form.tags, t.id] })}
                    className={cn('rounded-full border px-2.5 py-0.5 text-xs', on ? 'border-slate-600 bg-slate-700 text-white' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-slate-500">No tags yet. Upload with “Bulk (with Tags)” or create tags in Contacts.</p>
          )}
        </div>
        <div>
          <label htmlFor="ec-consent" className={label}>
            Broadcast subscription
          </label>
          <Select id="ec-consent" value={form.consentStatus} onChange={(e) => set({ consentStatus: e.target.value as ConsentStatus })}>
            {(Object.keys(CONSENT_LABEL) as ConsentStatus[]).map((s) => (
              <option key={s} value={s}>
                {CONSENT_LABEL[s]}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-slate-500">Unsubscribed contacts are skipped by every campaign.</p>
        </div>
      </form>
    </Dialog>
  );
}

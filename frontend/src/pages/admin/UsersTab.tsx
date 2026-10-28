import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type LucideIcon, KeyRound, LogOut, ShieldCheck, ShieldOff, Trash2, UserCheck, UserX, Users, Wand2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { Modal, initials } from '../../components/crm';
import { AButton, IconButton, Panel, Segmented, useConfirm } from '../../components/admin';
import { Alert, Badge, EmptyState, Field, Input, Spinner, errorMessage } from '../../components/ui';
import { SearchInput } from '../AdminPage';
import { api, type Role } from '../../lib/api';
import { ROLE_INFO, formatDate } from '../../lib/options';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  isPlatformAdmin: boolean;
  emailVerified: boolean;
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
  createdAt: string;
  workspaceCount: number;
  activeSessions: number;
}

interface UserDetail {
  user: AdminUser;
  memberships: { workspaceId: string; name: string; status: string | null; role: Role; joinedAt: string }[];
  sessions: { id: string; portal: string; ip: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string; expiresAt: string }[];
}

export function UsersTab() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['admin', 'users', q, status, page],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page) });
      if (q.trim()) p.set('q', q.trim());
      if (status === 'admins') p.set('admins', '1');
      else if (status) p.set('status', status);
      return api.get<{ users: AdminUser[]; total: number; pageSize: number }>(`/admin/users?${p}`);
    },
  });
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <Panel flush>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3">
        <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search by email or name…" />
        <Segmented
          value={status}
          onChange={(v) => { setStatus(v); setPage(1); }}
          options={[
            { value: '', label: 'All' },
            { value: 'active', label: 'Active' },
            { value: 'disabled', label: 'Disabled' },
            { value: 'admins', label: 'Admins' },
          ]}
        />
        {list.data && <p className="ml-auto text-xs text-slate-500">{list.data.total.toLocaleString('en-IN')} user{list.data.total === 1 ? '' : 's'}</p>}
      </div>
      {list.isPending ? (
        <Spinner />
      ) : list.error ? (
        <div className="p-4"><Alert>{errorMessage(list.error)}</Alert></div>
      ) : list.data.users.length === 0 ? (
        <EmptyState icon={<Users className="size-5" />} title="No users found" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50/70 text-left text-[11px] tracking-wide text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-2.5 font-medium">User</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Businesses</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Last login</th>
                <th className="hidden px-4 py-2.5 font-medium lg:table-cell">Joined</th>
                <th className="w-px px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.users.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50/60">
                  <td className="px-5 py-3">
                    <button onClick={() => setOpen(u.id)} className="flex items-center gap-3 text-left">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700">{initials(u.name)}</span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-slate-900 hover:underline">{u.name}</span>
                        <span className="block truncate text-xs text-slate-500">{u.email}</span>
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={u.status === 'active' ? 'green' : 'red'}>{u.status}</Badge>
                      {u.isPlatformAdmin && <Badge tone="blue">admin</Badge>}
                      {!u.emailVerified && <Badge tone="amber">unverified</Badge>}
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 text-slate-600 md:table-cell">{u.workspaceCount}</td>
                  <td className="hidden px-4 py-3 text-slate-500 md:table-cell">
                    {u.lastLoginAt ? formatDate(u.lastLoginAt, true) : '—'}
                    {u.activeSessions > 0 && <p className="text-[11px] text-emerald-700">{u.activeSessions} live session(s)</p>}
                  </td>
                  <td className="hidden px-4 py-3 text-slate-500 lg:table-cell">{formatDate(u.createdAt)}</td>
                  <td className="px-5 py-3 text-right">
                    <AButton size="sm" onClick={() => setOpen(u.id)}>Manage</AButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-5 py-3 text-sm">
          <span className="text-slate-500">Page {page} of {pages}</span>
          <div className="flex gap-2">
            <AButton size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</AButton>
            <AButton size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</AButton>
          </div>
        </div>
      )}
      {open && <UserModal id={open} onClose={() => setOpen(null)} />}
    </Panel>
  );
}

function UserModal({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const confirm = useConfirm();
  const detail = useQuery({ queryKey: ['admin', 'user', id], queryFn: () => api.get<UserDetail>(`/admin/users/${id}`) });
  const [form, setForm] = useState<{ name: string; email: string } | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin'] });
  const update = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/admin/users/${id}`, body), onSuccess: () => { setForm(null); void refresh(); } });
  const password = useMutation({
    mutationFn: (pw?: string) => api.post<{ password: string | null }>(`/admin/users/${id}/password`, pw ? { password: pw } : {}),
    onSuccess: (r) => { setNewPassword(''); setNotice(r.password ? `Temporary password (shown once): ${r.password}` : 'Password changed. They were signed out everywhere.'); void refresh(); },
  });
  const logoutAll = useMutation({ mutationFn: () => api.post<{ revoked: number }>(`/admin/users/${id}/logout`), onSuccess: (r) => { setNotice(`Signed out of ${r.revoked} session(s).`); void refresh(); } });
  const revokeOne = useMutation({ mutationFn: (sid: string) => api.delete(`/admin/users/${id}/sessions/${sid}`), onSuccess: () => void refresh() });
  const remove = useMutation({ mutationFn: () => api.delete(`/admin/users/${id}`), onSuccess: () => { void refresh(); onClose(); } });
  const err = update.error ?? password.error ?? logoutAll.error ?? revokeOne.error ?? remove.error;

  if (detail.isPending || detail.error) {
    return <Modal title="User" onClose={onClose}>{detail.error ? <Alert>{errorMessage(detail.error)}</Alert> : <Spinner />}</Modal>;
  }
  const { user: u, memberships, sessions } = detail.data;
  const self = me?.id === u.id;

  return (
    <Modal title={u.name} onClose={onClose} wide>
      <div className="space-y-5 text-sm">
        {err != null && <Alert>{errorMessage(err)}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}

        <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">{initials(u.name)}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-slate-900">{u.email}</p>
            <p className="text-xs text-slate-500">Joined {formatDate(u.createdAt)}{u.lastLoginAt ? ` · last login ${formatDate(u.lastLoginAt, true)}` : ''}</p>
          </div>
          <div className="flex flex-wrap justify-end gap-1">
            <Badge tone={u.status === 'active' ? 'green' : 'red'}>{u.status}</Badge>
            {u.isPlatformAdmin && <Badge tone="blue">admin</Badge>}
            {!u.emailVerified && <Badge tone="amber">unverified</Badge>}
          </div>
        </div>

        <Block title="Profile">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="um-name">
              <Input id="um-name" value={form?.name ?? u.name} onChange={(e) => setForm({ name: e.target.value, email: form?.email ?? u.email })} />
            </Field>
            <Field label="Email" htmlFor="um-email">
              <Input id="um-email" type="email" value={form?.email ?? u.email} onChange={(e) => setForm({ name: form?.name ?? u.name, email: e.target.value })} />
            </Field>
          </div>
          {form && (
            <div className="mt-3 flex justify-end gap-2">
              <AButton size="sm" variant="subtle" onClick={() => setForm(null)}>Discard</AButton>
              <AButton size="sm" variant="primary" loading={update.isPending} onClick={() => update.mutate(form)}>Save profile</AButton>
            </div>
          )}
        </Block>

        <Block title="Access">
          <div className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
            <Row
              icon={u.status === 'active' ? UserCheck : UserX}
              title={u.status === 'active' ? 'Account is active' : 'Account is disabled'}
              text={u.status === 'active' ? 'Disabling signs them out at once and blocks login.' : 'They cannot sign in until re-enabled.'}
              action={
                u.status === 'active' ? (
                  <AButton size="sm" variant="danger-outline" disabled={self} onClick={async () => (await confirm({ title: `Disable ${u.email}?`, message: 'They are signed out everywhere and cannot log in until you re-enable the account.', confirmLabel: 'Disable account', tone: 'danger' })) !== null && update.mutate({ status: 'disabled' })}>Disable</AButton>
                ) : (
                  <AButton size="sm" onClick={() => update.mutate({ status: 'active' })}>Re-enable</AButton>
                )
              }
            />
            <Row icon={ShieldCheck} title={u.emailVerified ? 'Email verified' : 'Email not verified'} text="Override the verification status by hand." action={<AButton size="sm" onClick={() => update.mutate({ emailVerified: !u.emailVerified })}>{u.emailVerified ? 'Mark unverified' : 'Mark verified'}</AButton>} />
            <Row
              icon={u.isPlatformAdmin ? ShieldCheck : ShieldOff}
              title={u.isPlatformAdmin ? 'Platform admin' : 'Not a platform admin'}
              text="Platform admins can open and change every business."
              action={
                <AButton
                  size="sm"
                  disabled={self && u.isPlatformAdmin}
                  onClick={async () =>
                    (await confirm(u.isPlatformAdmin ? { title: `Remove admin from ${u.email}?`, confirmLabel: 'Remove admin', tone: 'danger' } : { title: `Make ${u.email} a platform admin?`, message: 'They get full access to every business on the platform.', confirmLabel: 'Grant admin' })) !== null &&
                    update.mutate({ isPlatformAdmin: !u.isPlatformAdmin })
                  }
                >
                  {u.isPlatformAdmin ? 'Remove admin' : 'Grant admin'}
                </AButton>
              }
            />
          </div>
        </Block>

        <Block title="Password">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1">
              <Field label="New password" htmlFor="um-pw" hint="At least 8 characters. Signs them out everywhere.">
                <Input id="um-pw" type="text" autoComplete="off" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              </Field>
            </div>
            <div className="flex gap-2 pb-6">
              <AButton icon={KeyRound} disabled={newPassword.length < 8} loading={password.isPending} onClick={() => password.mutate(newPassword)}>Set</AButton>
              <AButton icon={Wand2} loading={password.isPending} onClick={() => password.mutate(undefined)}>Generate</AButton>
            </div>
          </div>
        </Block>

        <Block title={`Businesses · ${memberships.length}`}>
          {memberships.length === 0 ? (
            <p className="text-slate-500">Not a member of any business.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
              {memberships.map((m) => (
                <li key={m.workspaceId}>
                  <Link to={`/admin/workspaces/${m.workspaceId}`} className="flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-slate-50">
                    <span className="font-medium text-slate-800">{m.name}</span>
                    <span className="text-xs text-slate-500">{ROLE_INFO[m.role].label} · joined {formatDate(m.joinedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block title={`Live sessions · ${sessions.length}`} action={sessions.length > 0 && <AButton size="sm" variant="subtle" icon={LogOut} loading={logoutAll.isPending} onClick={() => logoutAll.mutate()}>Sign out everywhere</AButton>}>
          {sessions.length === 0 ? (
            <p className="text-slate-500">Not signed in anywhere.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-slate-700">{s.portal === 'admin' ? 'Super Admin' : 'Business app'} · {s.ip ?? 'unknown IP'}</p>
                    <p className="truncate text-xs text-slate-400" title={s.userAgent ?? ''}>{s.userAgent ?? 'Unknown device'} · seen {formatDate(s.lastSeenAt, true)}</p>
                  </div>
                  <IconButton icon={LogOut} label="Revoke session" onClick={() => revokeOne.mutate(s.id)} />
                </li>
              ))}
            </ul>
          )}
        </Block>

        <div className="flex items-center justify-between gap-3 rounded-xl bg-red-50/50 px-4 py-3 ring-1 ring-red-100">
          <div>
            <p className="font-medium text-red-700">Delete account</p>
            <p className="text-xs text-slate-500">Removes the login and all memberships. Refused while they are a business's only owner.</p>
          </div>
          <AButton
            size="sm"
            variant="danger"
            icon={Trash2}
            disabled={self}
            loading={remove.isPending}
            onClick={async () => (await confirm({ title: 'Delete this account permanently?', message: 'This cannot be undone.', confirmLabel: 'Delete account', tone: 'danger', input: { label: `Type ${u.email} to confirm`, match: u.email } })) !== null && remove.mutate()}
          >
            Delete
          </AButton>
        </div>
      </div>
    </Modal>
  );
}

function Block({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-medium tracking-wide text-slate-400 uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text: string; action: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Icon className="size-4 shrink-0 text-slate-400" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-slate-800">{title}</p>
        <p className="text-xs text-slate-500">{text}</p>
      </div>
      {action}
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { Modal } from '../../components/crm';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, errorMessage } from '../../components/ui';
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
    <Card>
      <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
        <Input aria-label="Search users" placeholder="Search by email or name…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-xs" />
        <div className="w-44">
          <Select aria-label="Filter users" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All users</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
            <option value="admins">Platform admins</option>
          </Select>
        </div>
        {list.data && <p className="ml-auto self-center text-xs text-slate-500">{list.data.total.toLocaleString('en-IN')} user(s)</p>}
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
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">User</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Businesses</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Last login</th>
                <th className="hidden px-4 py-2.5 font-medium lg:table-cell">Joined</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-800">{u.name}</p>
                    <p className="text-xs text-slate-500">{u.email}</p>
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
                  <td className="px-4 py-3 text-right">
                    <Button variant="secondary" onClick={() => setOpen(u.id)}>Manage</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 p-3 text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
          <span className="text-slate-500">Page {page} of {pages}</span>
          <Button variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      )}
      {open && <UserModal id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function UserModal({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
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

        <section className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="um-name">
            <Input id="um-name" value={form?.name ?? u.name} onChange={(e) => setForm({ name: e.target.value, email: form?.email ?? u.email })} />
          </Field>
          <Field label="Email" htmlFor="um-email">
            <Input id="um-email" type="email" value={form?.email ?? u.email} onChange={(e) => setForm({ name: form?.name ?? u.name, email: e.target.value })} />
          </Field>
          {form && (
            <div className="flex gap-2 sm:col-span-2">
              <Button loading={update.isPending} onClick={() => update.mutate(form)}>Save details</Button>
              <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            </div>
          )}
        </section>

        <section className="flex flex-wrap gap-2">
          {u.status === 'active' ? (
            <Button variant="danger" disabled={self} onClick={() => window.confirm(`Disable ${u.email}? They are signed out at once and cannot log in.`) && update.mutate({ status: 'disabled' })}>Disable account</Button>
          ) : (
            <Button variant="secondary" onClick={() => update.mutate({ status: 'active' })}>Re-enable account</Button>
          )}
          <Button variant="secondary" onClick={() => update.mutate({ emailVerified: !u.emailVerified })}>{u.emailVerified ? 'Mark email unverified' : 'Mark email verified'}</Button>
          <Button variant="secondary" disabled={self && u.isPlatformAdmin} onClick={() => window.confirm(u.isPlatformAdmin ? `Remove platform admin from ${u.email}?` : `Make ${u.email} a platform admin? They get full access to every business.`) && update.mutate({ isPlatformAdmin: !u.isPlatformAdmin })}>
            {u.isPlatformAdmin ? 'Remove platform admin' : 'Make platform admin'}
          </Button>
          <Button variant="secondary" loading={logoutAll.isPending} onClick={() => logoutAll.mutate()}>Sign out everywhere</Button>
        </section>

        <section>
          <h3 className="mb-2 font-semibold text-ink">Password</h3>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-64">
              <Field label="Set a new password" htmlFor="um-pw" hint="At least 8 characters. Signs them out everywhere.">
                <Input id="um-pw" type="text" autoComplete="off" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              </Field>
            </div>
            <Button variant="secondary" disabled={newPassword.length < 8} loading={password.isPending} onClick={() => password.mutate(newPassword)}>Set password</Button>
            <Button variant="secondary" loading={password.isPending} onClick={() => password.mutate(undefined)}>Generate temporary</Button>
          </div>
        </section>

        <section>
          <h3 className="mb-2 font-semibold text-ink">Businesses ({memberships.length})</h3>
          {memberships.length === 0 ? (
            <p className="text-slate-500">Not a member of any business.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {memberships.map((m) => (
                <li key={m.workspaceId} className="flex items-center justify-between gap-2 px-3 py-2">
                  <Link to={`/admin/workspaces/${m.workspaceId}`} className="font-medium text-slate-800 hover:text-brand-700 hover:underline">{m.name}</Link>
                  <span className="text-xs text-slate-500">{ROLE_INFO[m.role].label} · joined {formatDate(m.joinedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="mb-2 font-semibold text-ink">Live sessions ({sessions.length})</h3>
          {sessions.length === 0 ? (
            <p className="text-slate-500">Not signed in anywhere.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-slate-700">{s.portal === 'admin' ? 'Super Admin' : 'App'} · {s.ip ?? 'unknown IP'}</p>
                    <p className="truncate text-xs text-slate-400" title={s.userAgent ?? ''}>{s.userAgent ?? 'Unknown device'} · seen {formatDate(s.lastSeenAt, true)}</p>
                  </div>
                  <Button variant="ghost" onClick={() => revokeOne.mutate(s.id)}>Revoke</Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex items-center justify-between border-t border-slate-100 pt-4">
          <p className="text-xs text-slate-500">Joined {formatDate(u.createdAt)}{u.lastLoginAt ? ` · last login ${formatDate(u.lastLoginAt, true)}` : ''}</p>
          <Button variant="danger" disabled={self} loading={remove.isPending} onClick={() => window.prompt(`Type DELETE to permanently delete ${u.email}:`) === 'DELETE' && remove.mutate()}>Delete account</Button>
        </section>
      </div>
    </Modal>
  );
}

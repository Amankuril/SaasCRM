import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, UserPlus, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, errorMessage, fieldError } from '../components/ui';
import { ApiError, ROLES, api, type Role } from '../lib/api';
import { ROLE_INFO, formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';

interface Member {
  id: string;
  userId: string;
  name: string;
  email: string | null;
  role: Role;
  joinedAt: string;
}

interface Invitation {
  id: string;
  email: string;
  role: Role;
  status: 'pending' | 'expired';
  expiresAt: string;
}

export function TeamPage() {
  const { workspace, membership, can } = useWorkspace();
  const canManage = can('members:manage') && workspace.status !== 'suspended';
  const base = `/workspaces/${workspace.id}`;

  const members = useQuery({ queryKey: ['members', workspace.id], queryFn: () => api.get<{ members: Member[] }>(`${base}/members`) });

  return (
    <>
      <PageHeader title="Team" description="Who can access this workspace, and what they can do." />
      <div className="space-y-6">
        {canManage && <InviteCard actorRole={membership.role} />}

        <Card>
          <div className="border-b border-slate-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-ink">Members</h2>
          </div>
          {members.isPending ? (
            <Spinner />
          ) : members.error ? (
            <div className="p-5">
              <Alert>{errorMessage(members.error)}</Alert>
            </div>
          ) : (
            <MemberTable members={members.data.members} canManage={canManage} />
          )}
        </Card>

        {canManage && <PendingInvitations />}
      </div>
    </>
  );
}

function MemberTable({ members, canManage }: { members: Member[]; canManage: boolean }) {
  const { user, reload } = useAuth();
  const { workspace, membership } = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) => api.patch(`/workspaces/${workspace.id}/members/${id}`, { role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members', workspace.id] }),
    onError: setError,
  });

  const remove = useMutation({
    mutationFn: (member: Member) => api.delete(`/workspaces/${workspace.id}/members/${member.id}`),
    onSuccess: async (_data, member) => {
      if (member.userId === user?.id) {
        const remaining = await reload();
        navigate(remaining[0] ? `/w/${remaining[0].id}` : '/onboarding');
      } else {
        await queryClient.invalidateQueries({ queryKey: ['members', workspace.id] });
      }
    },
    onError: setError,
  });

  const ownerCount = members.filter((m) => m.role === 'owner').length;
  const assignable = (target: Member) =>
    ROLES.filter((r) => (r === 'owner' || target.role === 'owner' ? membership.role === 'owner' : true));

  return (
    <>
      {error != null && (
        <div className="px-5 pt-4">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="px-5 py-2.5 font-medium">Name</th>
              <th className="px-5 py-2.5 font-medium">Role</th>
              <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Joined</th>
              <th className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {members.map((m) => {
              const isSelf = m.userId === user?.id;
              const editable = canManage && !isSelf && (m.role !== 'owner' || membership.role === 'owner');
              const canLeave = isSelf && !(m.role === 'owner' && ownerCount <= 1);
              return (
                <tr key={m.id}>
                  <td className="px-5 py-3">
                    <p className="font-medium text-slate-800">
                      {m.name} {isSelf && <span className="font-normal text-slate-400">(you)</span>}
                    </p>
                    <p className="text-xs text-slate-500">{m.email}</p>
                  </td>
                  <td className="px-5 py-3">
                    {editable ? (
                      <div className="w-36">
                        <Select
                          aria-label={`Role for ${m.name}`}
                          value={m.role}
                          disabled={changeRole.isPending}
                          onChange={(e) => {
                            setError(null);
                            changeRole.mutate({ id: m.id, role: e.target.value as Role });
                          }}
                        >
                          {assignable(m).map((r) => (
                            <option key={r} value={r}>
                              {ROLE_INFO[r].label}
                            </option>
                          ))}
                        </Select>
                      </div>
                    ) : (
                      <Badge tone={m.role === 'owner' ? 'green' : 'gray'}>{ROLE_INFO[m.role].label}</Badge>
                    )}
                  </td>
                  <td className="hidden px-5 py-3 text-slate-500 sm:table-cell">{formatDate(m.joinedAt)}</td>
                  <td className="px-5 py-3 text-right">
                    {(editable || canLeave) && (
                      <Button
                        variant="ghost"
                        className="text-red-600 hover:bg-red-50"
                        disabled={remove.isPending}
                        onClick={() => {
                          const prompt = isSelf ? `Leave ${workspace.name}? You will lose access.` : `Remove ${m.name} from ${workspace.name}?`;
                          if (window.confirm(prompt)) {
                            setError(null);
                            remove.mutate(m);
                          }
                        }}
                      >
                        {isSelf ? 'Leave' : 'Remove'}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function InviteCard({ actorRole }: { actorRole: Role }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('agent');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invite = useMutation({
    mutationFn: () => api.post<{ acceptUrl: string }>(`/workspaces/${workspace.id}/invitations`, { email, role }),
    onSuccess: (res) => {
      setLink(res.acceptUrl);
      setEmail('');
      void queryClient.invalidateQueries({ queryKey: ['invitations', workspace.id] });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLink(null);
    setCopied(false);
    invite.mutate();
  }

  const roles = ROLES.filter((r) => r !== 'owner' || actorRole === 'owner');
  const err = invite.error;
  const isFieldError = err instanceof ApiError && err.code === 'VALIDATION_ERROR';

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <UserPlus className="size-4" /> Invite a teammate
      </h2>
      <form onSubmit={onSubmit} className="mt-4 grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-start" noValidate>
        <Field label="Email" htmlFor="invite-email" error={fieldError(err, 'email')}>
          <Input id="invite-email" type="email" required placeholder="teammate@business.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Role" htmlFor="invite-role">
          <Select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_INFO[r].label}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" loading={invite.isPending} className="sm:mt-6.5">
          Send invite
        </Button>
      </form>
      <p className="mt-2 text-xs text-slate-500">{ROLE_INFO[role].description}</p>

      {err != null && !isFieldError && (
        <div className="mt-4">
          <Alert>{errorMessage(err)}</Alert>
        </div>
      )}
      {link && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-sm text-emerald-800">Invitation created. Share this link with your teammate (valid for 7 days):</p>
          <div className="mt-2 flex gap-2">
            <Input readOnly value={link} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(link).then(() => setCopied(true));
              }}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function PendingInvitations() {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['invitations', workspace.id],
    queryFn: () => api.get<{ invitations: Invitation[] }>(`/workspaces/${workspace.id}/invitations`),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/workspaces/${workspace.id}/invitations/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invitations', workspace.id] }),
  });

  return (
    <Card>
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-ink">Pending invitations</h2>
      </div>
      {query.isPending ? (
        <Spinner />
      ) : query.error ? (
        <div className="p-5">
          <Alert>{errorMessage(query.error)}</Alert>
        </div>
      ) : query.data.invitations.length === 0 ? (
        <EmptyState icon={<Users className="size-5" />} title="No pending invitations" />
      ) : (
        <ul className="divide-y divide-slate-100">
          {query.data.invitations.map((inv) => (
            <li key={inv.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{inv.email}</span>
              <Badge>{ROLE_INFO[inv.role].label}</Badge>
              {inv.status === 'expired' ? <Badge tone="red">Expired</Badge> : <span className="text-xs text-slate-500">Expires {formatDate(inv.expiresAt)}</span>}
              <Button variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(inv.id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

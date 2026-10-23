import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Spinner, errorMessage } from '../components/ui';
import { api, type Role, type WorkspaceSummary } from '../lib/api';
import { ROLE_INFO } from '../lib/options';
import { AuthLayout } from '../layouts/AuthLayout';

interface InvitePreview {
  email: string;
  role: Role;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  workspaceName: string;
  invitedByName: string | null;
}

export function AcceptInvitePage() {
  const { token } = useParams();
  const { status, user, reload, logout } = useAuth();
  const navigate = useNavigate();

  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.get<{ invitation: InvitePreview }>(`/invitations/${token}`),
  });

  const accept = useMutation({
    mutationFn: () => api.post<{ workspace: WorkspaceSummary }>(`/invitations/${token}/accept`),
    onSuccess: async ({ workspace }) => {
      await reload();
      navigate(`/w/${workspace.id}`);
    },
  });

  if (preview.isPending) return <Spinner />;
  if (preview.error) {
    return (
      <AuthLayout title="Invitation not found">
        <p className="text-sm text-slate-600">This invitation link is invalid. Ask the workspace admin to send a new one.</p>
      </AuthLayout>
    );
  }

  const inv = preview.data.invitation;
  const next = encodeURIComponent(`/invite/${token}`);
  const email = encodeURIComponent(inv.email);

  if (inv.status !== 'pending') {
    return (
      <AuthLayout title={`This invitation is ${inv.status}`}>
        <p className="text-sm text-slate-600">Ask an admin of {inv.workspaceName} to send you a new invitation.</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={`Join ${inv.workspaceName}`}
      subtitle={`${inv.invitedByName ?? 'A teammate'} invited ${inv.email} to join as ${ROLE_INFO[inv.role].label}.`}
    >
      {status !== 'authenticated' ? (
        <div className="space-y-3">
          <Link to={`/signup?email=${email}&next=${next}`} className="block">
            <Button className="w-full">Create an account to accept</Button>
          </Link>
          <Link to={`/login?email=${email}&next=${next}`} className="block">
            <Button variant="secondary" className="w-full">
              I already have an account
            </Button>
          </Link>
        </div>
      ) : user?.email !== inv.email ? (
        <div className="space-y-4">
          <Alert tone="info">
            You are logged in as <strong>{user?.email}</strong>, but this invitation is for <strong>{inv.email}</strong>.
          </Alert>
          <Button variant="secondary" className="w-full" onClick={() => void logout(`/invite/${token}`)}>
            Log out and switch account
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {accept.error && <Alert>{errorMessage(accept.error)}</Alert>}
          <p className="text-sm text-slate-600">{ROLE_INFO[inv.role].description}</p>
          <Button className="w-full" loading={accept.isPending} onClick={() => accept.mutate()}>
            Accept invitation
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}

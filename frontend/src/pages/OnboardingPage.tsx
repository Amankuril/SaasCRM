import { useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { WorkspaceForm, defaultWorkspaceValues } from '../components/WorkspaceForm';
import { api, type WorkspaceSummary } from '../lib/api';
import { AuthLayout } from '../layouts/AuthLayout';

export function OnboardingPage() {
  const { reload, workspaces, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <AuthLayout
      title={workspaces.length ? 'Create another workspace' : 'Set up your business workspace'}
      subtitle="Each business gets its own private workspace with its own WhatsApp number, contacts and team."
    >
      <WorkspaceForm
        initial={defaultWorkspaceValues()}
        submitLabel="Create workspace"
        onSubmit={async (values) => {
          const { workspace } = await api.post<{ workspace: WorkspaceSummary }>('/workspaces', {
            ...values,
            industry: values.industry || null,
          });
          await reload();
          navigate(`/w/${workspace.id}`);
        }}
      />
      <div className="mt-6 flex justify-between text-sm">
        {workspaces[0] ? (
          <button onClick={() => navigate(`/w/${workspaces[0]!.id}`)} className="text-slate-500 hover:text-slate-700">
            ← Back to {workspaces[0].name}
          </button>
        ) : (
          <span />
        )}
        <button onClick={() => void logout()} className="text-slate-500 hover:text-slate-700">
          Log out
        </button>
      </div>
    </AuthLayout>
  );
}

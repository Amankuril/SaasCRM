import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { WorkspaceForm } from '../components/WorkspaceForm';
import { Alert, Card, PageHeader } from '../components/ui';
import { api, type WorkspaceContextPayload } from '../lib/api';
import { useWorkspace } from '../layouts/workspaceContext';

export function SettingsPage() {
  const { workspace, can } = useWorkspace();
  const { reload } = useAuth();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);
  const editable = can('workspace:update') && workspace.status !== 'suspended';

  return (
    <>
      <PageHeader title="Workspace settings" description="Business details used across inbox, campaigns and reports." />
      <Card className="max-w-2xl p-5 sm:p-6">
        {!editable && (
          <div className="mb-4">
            <Alert tone="info">Only workspace owners and admins can change these settings.</Alert>
          </div>
        )}
        {saved && (
          <div className="mb-4">
            <Alert tone="success">Settings saved.</Alert>
          </div>
        )}
        <WorkspaceForm
          key={workspace.id}
          disabled={!editable}
          submitLabel="Save changes"
          initial={{
            name: workspace.name,
            industry: workspace.industry ?? '',
            country: workspace.country,
            timezone: workspace.timezone,
            currency: workspace.currency,
          }}
          onSubmit={async (values) => {
            setSaved(false);
            const data = await api.patch<WorkspaceContextPayload>(`/workspaces/${workspace.id}`, {
              ...values,
              industry: values.industry || null,
            });
            queryClient.setQueryData(['workspace', workspace.id], data);
            await reload();
            setSaved(true);
          }}
        />
      </Card>
    </>
  );
}

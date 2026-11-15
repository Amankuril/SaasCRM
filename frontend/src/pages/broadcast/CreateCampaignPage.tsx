import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { Alert, Spinner, errorMessage } from '../../components/ui';
import { api, type Campaign } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { CampaignBuilder } from './CampaignBuilder';

/**
 * Broadcast › Create Campaign. The builder always edits a saved draft: `?draft=<id>` opens that
 * one, and a bare /new picks up the untouched blank draft or starts a fresh one.
 */
export function CreateCampaignPage() {
  const { workspace, can } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const draftId = params.get('draft');
  const canCreate = can('campaigns:manage') && workspace.status !== 'suspended';

  const start = useMutation({
    mutationFn: async () => {
      const { campaigns } = await api.get<{ campaigns: Campaign[] }>(`/workspaces/${workspace.id}/campaigns`);
      const blank = campaigns.find((c) => c.status === 'draft' && c.name === 'Untitled campaign' && !c.templateId && c.audience.type !== 'retarget');
      return blank ?? (await api.post<{ campaign: Campaign }>(`/workspaces/${workspace.id}/campaigns`, { name: 'Untitled campaign' })).campaign;
    },
    onSuccess: (campaign) => setParams({ draft: campaign.id }, { replace: true }),
  });
  // One draft per visit, even when React runs the effect twice in development.
  const started = useRef(false);
  const begin = start.mutate;
  useEffect(() => {
    if (draftId) started.current = false;
    else if (canCreate && !started.current) {
      started.current = true;
      begin();
    }
  }, [draftId, canCreate, begin]);

  const query = useQuery({
    queryKey: ['campaign', workspace.id, draftId],
    queryFn: () => api.get<{ campaign: Campaign }>(`/workspaces/${workspace.id}/campaigns/${draftId}`),
    enabled: !!draftId,
  });

  const campaign = draftId ? query.data?.campaign : undefined;
  // Once launched it is no longer a draft: show its report instead.
  if (campaign && campaign.status !== 'draft') return <Navigate to={`/w/${workspace.id}/broadcast/campaigns/${campaign.id}`} replace />;
  if (campaign) return <CampaignBuilder key={campaign.id} campaign={campaign} />;

  const error = start.error ?? query.error;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      {!canCreate && !draftId ? <Alert tone="info">You don’t have permission to create campaigns in this workspace.</Alert> : error ? <Alert>{errorMessage(error)}</Alert> : <Spinner label="Preparing your campaign…" />}
    </div>
  );
}

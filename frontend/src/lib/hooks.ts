import { useQuery } from '@tanstack/react-query';
import { api, type PipelineStage, type Member, type Tag } from './api';

export function useTags(workspaceId: string) {
  return useQuery({
    queryKey: ['tags', workspaceId],
    queryFn: () => api.get<{ tags: Tag[] }>(`/workspaces/${workspaceId}/tags`),
    select: (d) => d.tags,
  });
}

/** Team members (only loaded for roles that may see the member list). */
export function useMembers(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.get<{ members: Member[] }>(`/workspaces/${workspaceId}/members`),
    select: (d) => d.members,
    enabled,
  });
}

/** The workspace's pipeline stages, in order. */
export function useStages(workspaceId: string) {
  return useQuery({
    queryKey: ['pipeline-stages', workspaceId],
    queryFn: () => api.get<{ stages: PipelineStage[] }>(`/workspaces/${workspaceId}/pipeline-stages`),
    select: (d) => d.stages,
    staleTime: 60_000,
  });
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CannedReply, type InboxCounts, type TeamMate } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';

export function useInboxCounts() {
  const { workspace } = useWorkspace();
  return useQuery({ queryKey: ['conversation-counts', workspace.id], queryFn: () => api.get<InboxCounts>(`/workspaces/${workspace.id}/conversations/counts`), refetchInterval: 60_000 });
}

/** Teammates who can be @mentioned or assigned. */
export function useTeam() {
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: ['inbox-team', workspace.id],
    queryFn: () => api.get<{ team: TeamMate[] }>(`/workspaces/${workspace.id}/conversations/team`),
    select: (d) => d.team,
    staleTime: 5 * 60_000,
  });
}

export function useCannedReplies() {
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: ['canned-replies', workspace.id],
    queryFn: () => api.get<{ replies: CannedReply[] }>(`/workspaces/${workspace.id}/canned-replies`),
    select: (d) => d.replies,
  });
}

/** Refreshes everything the inbox shows after a change. */
export function useInboxRefresh() {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  return (conversationId?: string) => {
    void queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] });
    void queryClient.invalidateQueries({ queryKey: ['conversation-counts', workspace.id] });
    if (conversationId) void queryClient.invalidateQueries({ queryKey: ['conversation', workspace.id, conversationId] });
  };
}

/** Snooze presets: in an hour, this evening, tomorrow morning, next Monday morning. */
export function snoozeOptions(now = new Date()): { label: string; until: Date }[] {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const evening = at(0, 18);
  const nextMonday = at(((8 - now.getDay()) % 7) || 7, 9);
  return [
    { label: '1 hour', until: new Date(now.getTime() + 3600_000) },
    { label: '3 hours', until: new Date(now.getTime() + 3 * 3600_000) },
    ...(evening.getTime() - now.getTime() > 3600_000 ? [{ label: 'This evening (6 PM)', until: evening }] : []),
    { label: 'Tomorrow (9 AM)', until: at(1, 9) },
    { label: 'Next week (Mon 9 AM)', until: nextMonday },
  ];
}

export const snoozeLabel = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Inserts a canned reply, filling {{name}} with the customer's first name. */
export const fillCanned = (body: string, contactName?: string | null) => body.replace(/\{\{\s*(first_?name|name)\s*\}\}/gi, contactName?.split(/\s+/)[0] ?? '');

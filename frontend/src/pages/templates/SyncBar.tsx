import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, CircleHelp, RefreshCw, Stethoscope } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/feedback';
import { Alert, Button, Spinner, LoadError } from '../../components/ui';
import { api, type TemplateSyncCheck, type TemplateSyncStatus } from '../../lib/api';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';

export function useTemplateSync() {
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: ['template-sync', workspace.id],
    queryFn: () => api.get<{ sync: TemplateSyncStatus }>(`/workspaces/${workspace.id}/templates/sync-status`),
    select: (d) => d.sync,
    refetchInterval: 30_000,
  });
}

function ago(value: string | null): string {
  if (!value) return 'never';
  const min = Math.floor((Date.now() - new Date(value).getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`;
  return formatDate(value, true);
}

/** Whether the statuses on screen are current: last sync with Meta, visible errors, and the refresh action. */
export function SyncBar({ canManage, onSynced }: { canManage: boolean; onSynced: (message: string) => void }) {
  const { workspace } = useWorkspace();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useTemplateSync();
  const [checking, setChecking] = useState(false);
  // "4 min ago" keeps counting while the page is open.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const sync = useMutation({
    mutationFn: () => api.post<{ synced: number; added: number; updated: number; removed: number }>(`/workspaces/${workspace.id}/templates/sync`),
    onSuccess: (r) => {
      const parts = [r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} removed`].filter(Boolean);
      onSynced(`Checked ${r.synced} template${r.synced === 1 ? '' : 's'} with Meta: ${parts.length ? parts.join(', ') : 'everything is up to date'}.`);
    },
    onError: (e) => toast.error(e),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['templates', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['template-sync', workspace.id] });
    },
  });
  const s = query.data;
  if (!s || !s.connected) return null;

  return (
    <div className="space-y-3">
      {s.lastError && (
        <Alert>
          <span className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span className="min-w-0 flex-1">
              <strong className="font-medium">Statuses may be out of date.</strong> {s.lastError}
              {s.lastAttemptAt && ` Last tried ${ago(s.lastAttemptAt)}.`}
            </span>
            {canManage && (
              <button type="button" className="font-medium underline" onClick={() => sync.mutate()} disabled={sync.isPending}>
                Try again
              </button>
            )}
          </span>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-500">
        <span className="flex items-center gap-2" title={s.lastSyncedAt ? formatDate(s.lastSyncedAt, true) : undefined}>
          {s.lastError ? <CircleAlert className="size-4 text-red-600" strokeWidth={1.5} /> : <CircleCheck className="size-4 text-brand-600" strokeWidth={1.5} />}
          {s.lastSyncedAt ? `Synced with Meta ${ago(s.lastSyncedAt)}` : 'Not synced with Meta yet'}
        </span>
        {s.inReview > 0 && (
          <span>
            {s.inReview} in review, checked every {s.checkEveryMinutes} min
          </span>
        )}
        {canManage && (
          <span className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={() => setChecking(true)}>
              <Stethoscope className="size-4" strokeWidth={1.5} /> Check setup
            </Button>
            <Button variant="secondary" loading={sync.isPending || s.running} onClick={() => sync.mutate()}>
              {!(sync.isPending || s.running) && <RefreshCw className="size-4" strokeWidth={1.5} />} Sync now
            </Button>
          </span>
        )}
      </div>
      {checking && <CheckDialog onClose={() => setChecking(false)} />}
    </div>
  );
}

const STATE = {
  ok: { icon: CircleCheck, className: 'text-brand-600' },
  missing: { icon: CircleAlert, className: 'text-red-600' },
  unknown: { icon: CircleHelp, className: 'text-amber-600' },
} as const;

/** Asks Meta whether instant status updates can reach us, and names the exact missing piece. */
function CheckDialog({ onClose }: { onClose: () => void }) {
  const { workspace } = useWorkspace();
  const check = useQuery({
    queryKey: ['template-sync', workspace.id, 'check'],
    queryFn: () => api.post<{ check: TemplateSyncCheck }>(`/workspaces/${workspace.id}/templates/sync-check`),
    gcTime: 0,
    retry: false,
  });
  return (
    <Dialog icon={<Stethoscope className="size-4" strokeWidth={1.5} />} title="Template status setup" subtitle="How approvals reach Zeta Connect" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {check.isPending ? (
        <Spinner label="Asking Meta" />
      ) : check.error ? (
          <LoadError error={check.error} onRetry={() => void check.refetch()} />
        ) : (
        <div className="space-y-4">
          <ul className="space-y-4">
            {check.data.check.items.map((i) => {
              const { icon: Icon, className } = STATE[i.state];
              return (
                <li key={i.key} className="flex gap-3 text-sm">
                  <Icon className={`mt-0.5 size-4 shrink-0 ${className}`} strokeWidth={1.5} />
                  <span>
                    <span className="block font-medium text-ink">{i.label}</span>
                    <span className="block text-slate-600">{i.detail}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="border-t border-slate-200 pt-4 text-sm text-slate-500">
            {check.data.check.ok ? 'Approvals arrive within seconds of Meta’s decision.' : 'Until this is fixed, approvals still arrive: templates in review are checked with Meta every few minutes.'}
          </p>
        </div>
      )}
    </Dialog>
  );
}

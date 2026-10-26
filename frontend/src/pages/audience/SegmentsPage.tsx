import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Bookmark, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { STAGE_TONE, TagChip } from '../../components/crm';
import { Alert, Button, EmptyState, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type Segment } from '../../lib/api';
import { useStages, useTags } from '../../lib/hooks';
import { useWorkspace } from '../../layouts/workspaceContext';
import { SOURCE_INFO } from './shared';

/** Saved Audience filters, with live counts. Opening one applies it in Audience. */
export function SegmentsPage() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const stages = useStages(workspace.id);
  const tags = useTags(workspace.id);
  const segments = useQuery({ queryKey: ['segments', workspace.id], queryFn: () => api.get<{ segments: Segment[] }>(`/workspaces/${workspace.id}/segments`) });
  const remove = useMutation({
    mutationFn: (s: Segment) => api.delete(`/workspaces/${workspace.id}/segments/${s.id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['segments', workspace.id] }),
  });
  const stageOf = new Map((stages.data ?? []).map((s) => [s.key, s]));
  const tagOf = new Map((tags.data ?? []).map((t) => [t.id, t]));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
      <h1 className="text-xl font-semibold text-ink">Segments</h1>
      <p className="mt-0.5 mb-5 text-sm text-slate-500">Saved filters. Membership updates by itself; use them in Audience or as a campaign audience.</p>
      {remove.error != null && (
        <div className="mb-3">
          <Alert>{errorMessage(remove.error)}</Alert>
        </div>
      )}
      {segments.isPending ? (
        <Spinner />
      ) : segments.error ? (
        <Alert>{errorMessage(segments.error)}</Alert>
      ) : segments.data.segments.length === 0 ? (
        <EmptyState icon={<Bookmark className="size-5" />} title="No segments yet">
          In Audience, apply some filters and click Create Segment.
        </EmptyState>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {segments.data.segments.map((s) => {
            const f = s.filter;
            return (
              <div key={s.id} className="flex flex-col rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-start gap-2">
                  <Bookmark className="mt-0.5 size-4 text-indigo-500" />
                  <p className="flex-1 font-medium text-ink">{s.name}</p>
                  <SegmentCount id={s.id} />
                </div>
                <div className="mt-3 flex flex-1 flex-wrap content-start gap-1.5 text-xs">
                  {f.stages.map((k) => {
                    const st = stageOf.get(k);
                    return (
                      <span key={k} className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5', st ? STAGE_TONE[st.color].soft : 'bg-slate-100')}>
                        {st?.name ?? k}
                      </span>
                    );
                  })}
                  {f.tagsAny.map((id) => tagOf.get(id) && <TagChip key={id} tag={tagOf.get(id)!} />)}
                  {(f.sources ?? []).map((src) => (
                    <span key={src} className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">
                      {src === 'none' ? 'Unknown source' : SOURCE_INFO[src].label}
                    </span>
                  ))}
                  {f.addedWithinDays && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">Added in last {f.addedWithinDays} days</span>}
                  {f.unassigned && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">Unassigned</span>}
                  {(f.ownerIds?.length ?? 0) > 0 && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">{f.ownerIds!.length} owner(s)</span>}
                  {(f.campaignIds?.length ?? 0) > 0 && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">{f.campaignIds!.length} campaign(s)</span>}
                  {(f.listsAny?.length ?? 0) > 0 && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">{f.listsAny!.length} list(s)</span>}
                  {f.excludeTags.length > 0 && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">Excludes {f.excludeTags.length} tag(s)</span>}
                  {f.requireOptIn && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">Opted in only</span>}
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <Button variant="secondary" onClick={() => navigate(`/w/${workspace.id}/audience`, { state: { filter: f, segmentName: s.name } })}>
                    Open in Audience <ArrowRight className="size-4" />
                  </Button>
                  {can('campaigns:manage') && (
                    <Button variant="ghost" className="ml-auto" onClick={() => window.confirm(`Delete the segment "${s.name}"?`) && remove.mutate(s)} aria-label={`Delete ${s.name}`}>
                      <Trash2 className="size-4 text-red-500" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SegmentCount({ id }: { id: string }) {
  const { workspace } = useWorkspace();
  const count = useQuery({ queryKey: ['segment-count', workspace.id, id], queryFn: () => api.get<{ matched: number; reachable: number }>(`/workspaces/${workspace.id}/segments/${id}/count`) });
  return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{count.data ? `${count.data.matched} customers` : '…'}</span>;
}

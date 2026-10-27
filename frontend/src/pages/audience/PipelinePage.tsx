import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, GripVertical, Info, Phone, RefreshCw, Search, Settings2, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { STAGE_TONE } from '../../components/crm';
import { Alert, Button, Input, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type AudienceRow, type PipelineStage } from '../../lib/api';
import { useStages } from '../../lib/hooks';
import { useWorkspace } from '../../layouts/workspaceContext';
import { ContactPanel } from './AudiencePage';
import { EditStagesDialog, SourceBadge, avatarTone, initials } from './shared';
import { AddedMenu, EMPTY_FILTERS, type AudienceFilters } from './toolbar';

const PAGE = 30;

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  if (s < 365 * 86_400) return `${Math.floor(s / (30 * 86_400))}mo ago`;
  return `${Math.floor(s / (365 * 86_400))}y ago`;
}

/** Sales Pipeline: one column per stage; drag customers between stages. */
export function PipelinePage() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const editable = can('contacts:manage') && workspace.status !== 'suspended';
  const stages = useStages(workspace.id);
  const [filters, setFilters] = useState<AudienceFilters>(EMPTY_FILTERS);
  const [editingStages, setEditingStages] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ row: AudienceRow; from: string } | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [dragStage, setDragStage] = useState<string | null>(null);
  const [totals, setTotals] = useState<Record<string, number>>({});
  // Cards moved but not yet confirmed by the server, so they jump columns immediately.
  const [moved, setMoved] = useState<Record<string, { row: AudienceRow; to: string }>>({});

  const move = useMutation({
    mutationFn: ({ row, to }: { row: AudienceRow; to: string }) => api.patch(`/workspaces/${workspace.id}/contacts/${row.id}`, { lifecycleStage: to }),
    onSettled: async (_d, _e, { row }) => {
      await queryClient.invalidateQueries({ queryKey: ['audience', workspace.id] });
      setMoved(({ [row.id]: _, ...rest }) => rest);
    },
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.post(`/workspaces/${workspace.id}/pipeline-stages/reorder`, { ids }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['pipeline-stages', workspace.id] }),
  });

  const list = stages.data ?? [];
  const totalCustomers = Object.values(totals).reduce((a, b) => a + b, 0);

  const dropCard = (to: string) => {
    setOverColumn(null);
    if (!dragging || dragging.from === to) return setDragging(null);
    setMoved((m) => ({ ...m, [dragging.row.id]: { row: { ...dragging.row, lifecycleStage: to }, to } }));
    move.mutate({ row: dragging.row, to });
    setDragging(null);
  };
  const dropStage = (target: PipelineStage) => {
    if (!dragStage || dragStage === target.id) return setDragStage(null);
    const ids = list.map((s) => s.id).filter((id) => id !== dragStage);
    ids.splice(ids.indexOf(target.id), 0, dragStage);
    // Show the new order right away.
    queryClient.setQueryData(['pipeline-stages', workspace.id], { stages: ids.map((id, order) => ({ ...list.find((s) => s.id === id)!, order })) });
    reorder.mutate(ids);
    setDragStage(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 sm:px-6">
        <div>
          <h1 className="text-xl font-semibold text-ink">Sales Pipeline</h1>
          <p className="mt-0.5 max-w-md text-sm text-slate-500">Drag customers across lifecycle stages to track your sales pipeline</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => void queryClient.invalidateQueries({ queryKey: ['audience', workspace.id] })} aria-label="Refresh" title="Refresh">
            <RefreshCw className="size-4" />
          </Button>
          {editable && (
            <Button variant="secondary" onClick={() => setEditingStages(true)} aria-label="Edit stages" title="Edit stages">
              <Settings2 className="size-4" />
            </Button>
          )}
          <AddedMenu value={filters} onChange={setFilters} />
          <div className="relative w-56">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <Input aria-label="Search customers" placeholder="Search customers..." value={filters.q ?? ''} onChange={(e) => setFilters({ ...filters, q: e.target.value || undefined })} className="pl-9" />
          </div>
        </div>
      </div>
      <p className="px-4 pt-2 text-sm text-slate-600 sm:px-6">
        {totalCustomers} customers across {list.length} stages
      </p>
      <div className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900 sm:mx-6">
        <span className="flex items-center gap-1.5">
          <Info className="size-4" /> <strong>Click</strong> a card to view &amp; edit details.
        </span>
        <span>
          <strong>Drag</strong> a card to move stage.
        </span>
        <span>
          <strong>Drag</strong> the grip (⠿) on a column to reorder.
        </span>
      </div>
      {move.error != null && (
        <div className="mx-4 mt-3 sm:mx-6">
          <Alert>{errorMessage(move.error)}</Alert>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-x-auto px-4 py-4 sm:px-6">
        {stages.isPending ? (
          <Spinner />
        ) : (
          <div className="flex h-full min-h-[24rem] items-start gap-4">
            {list.map((stage) => (
              <PipelineColumn
                key={stage.key}
                stage={stage}
                filters={filters}
                editable={editable}
                moved={moved}
                highlighted={overColumn === stage.key && !!dragging && dragging.from !== stage.key}
                draggingColumn={dragStage === stage.id}
                onTotal={(n) => setTotals((t) => (t[stage.key] === n ? t : { ...t, [stage.key]: n }))}
                onOpen={setViewing}
                onCardDragStart={(row) => setDragging({ row, from: stage.key })}
                onCardDragEnd={() => setDragging(null)}
                onDragOver={() => dragging && setOverColumn(stage.key)}
                onDrop={() => (dragStage ? dropStage(stage) : dropCard(stage.key))}
                onGripDragStart={() => setDragStage(stage.id)}
              />
            ))}
          </div>
        )}
      </div>
      {editingStages && <EditStagesDialog onClose={() => setEditingStages(false)} />}
      {viewing && <ContactPanel contactId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function PipelineColumn({
  stage,
  filters,
  editable,
  moved,
  highlighted,
  draggingColumn,
  onTotal,
  onOpen,
  onCardDragStart,
  onCardDragEnd,
  onDragOver,
  onDrop,
  onGripDragStart,
}: {
  stage: PipelineStage;
  filters: AudienceFilters;
  editable: boolean;
  moved: Record<string, { row: AudienceRow; to: string }>;
  highlighted: boolean;
  draggingColumn: boolean;
  onTotal: (n: number) => void;
  onOpen: (id: string) => void;
  onCardDragStart: (row: AudienceRow) => void;
  onCardDragEnd: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onGripDragStart: () => void;
}) {
  const { workspace } = useWorkspace();
  const tone = STAGE_TONE[stage.color] ?? STAGE_TONE.gray;
  const query = useInfiniteQuery({
    queryKey: ['audience', workspace.id, 'pipeline', stage.key, filters],
    queryFn: ({ pageParam }) => {
      const body = { q: filters.q, addedFrom: filters.addedFrom, addedTo: filters.addedTo, filter: { stages: [stage.key] }, sort: 'createdAt', dir: 'desc', page: pageParam, limit: PAGE };
      return api.get<{ contacts: AudienceRow[]; total: number; pages: number }>(`/workspaces/${workspace.id}/audience?query=${encodeURIComponent(JSON.stringify(body))}`);
    },
    initialPageParam: 1,
    getNextPageParam: (last, all) => (all.length < last.pages ? all.length + 1 : undefined),
  });
  const total = query.data?.pages[0]?.total ?? 0;
  const loaded = !!query.data;
  useEffect(() => {
    if (loaded) onTotal(total);
  }, [loaded, total]); // eslint-disable-line react-hooks/exhaustive-deps -- onTotal is a fresh closure each render

  const incoming = Object.values(moved).filter((m) => m.to === stage.key).map((m) => m.row);
  const rows = [...incoming, ...(query.data?.pages.flatMap((p) => p.contacts) ?? []).filter((r) => !moved[r.id] && !incoming.some((i) => i.id === r.id))];
  const shownTotal = total + incoming.length - (query.data?.pages.flatMap((p) => p.contacts) ?? []).filter((r) => moved[r.id] && moved[r.id]!.to !== stage.key).length;

  return (
    <section
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      className={cn('flex max-h-full w-72 shrink-0 flex-col rounded-xl border bg-white transition', highlighted ? 'border-slate-500 ring-2 ring-slate-300' : 'border-slate-200', draggingColumn && 'opacity-50')}
    >
      <header className={cn('flex items-center gap-2 rounded-t-xl border-b border-slate-200 px-3 py-2.5', tone.soft)}>
        {editable && (
          <span draggable onDragStart={onGripDragStart} className="cursor-grab text-slate-400" title="Drag to reorder" aria-label={`Reorder ${stage.name}`}>
            <GripVertical className="size-4" />
          </span>
        )}
        <span className={cn('size-2 rounded-full', tone.dot)} />
        <h2 className="flex-1 truncate text-sm font-semibold text-ink">{stage.name}</h2>
        <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">{Math.max(0, shownTotal)}</span>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {query.isPending ? (
          <Spinner label="" />
        ) : rows.length === 0 ? (
          <div className="flex h-28 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-slate-200 text-sm text-slate-400">
            <Users className="size-4" /> Drop here
          </div>
        ) : (
          rows.map((row) => (
            <article
              key={row.id}
              draggable={editable}
              onDragStart={() => onCardDragStart(row)}
              onDragEnd={onCardDragEnd}
              onClick={() => onOpen(row.id)}
              className={cn('cursor-pointer rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-slate-300 hover:shadow', moved[row.id] && 'opacity-70')}
            >
              <div className="flex items-start gap-2.5">
                <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold', avatarTone(row.id))}>{initials(row.displayName)}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{row.displayName}</p>
                  <p className="flex items-center gap-1 font-mono text-xs text-slate-500">
                    <Phone className="size-3" /> {row.phone.replace(/^\+/, '')}
                  </p>
                </div>
                {row.attribution && row.attribution.source !== 'direct' && <SourceBadge source={row.attribution.source} />}
              </div>
              <div className="mt-2.5 flex items-center justify-between text-xs text-slate-500">
                <span className="truncate">{row.owner ? `by ${row.owner.name}` : 'Unassigned'}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <Clock className="size-3" /> {timeAgo(row.createdAt)}
                </span>
              </div>
            </article>
          ))
        )}
        {query.hasNextPage && (
          <Button variant="ghost" className="w-full text-xs" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            Load more
          </Button>
        )}
      </div>
    </section>
  );
}

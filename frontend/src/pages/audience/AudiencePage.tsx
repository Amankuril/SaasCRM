import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  GripVertical,
  ListPlus,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Tags,
  Trash2,
  Upload,
  UserPlus,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ContactDetails } from '../../components/ContactDetails';
import { ImportContactsModal } from '../../components/ImportContactsModal';
import { TagsModal } from '../../components/TagsModal';
import { STAGE_TONE, TagChip } from '../../components/crm';
import { Alert, Button, EmptyState, Input, Select, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type AudienceFilter, type AudienceQuery, type AudienceRow, type ContactList, type CustomFieldDef } from '../../lib/api';
import { useMembers, useStages, useTags } from '../../lib/hooks';
import { formatDate } from '../../lib/options';
import { useWorkspace } from '../../layouts/workspaceContext';
import { CustomCell, FollowUpCell, OwnerCell, TagsCell, useContactPatch, useInvalidateAudience } from './cells';
import { BASE_COLUMNS, PhoneCell, Popover, SourceBadge, StageSelect, avatarTone, initials, type ColumnId, type ColumnState } from './shared';
import { AddCustomerDialog, AddedMenu, ColumnsMenu, CreateSegmentDialog, EMPTY_FILTERS, FiltersDrawer, activeFilterCount, type AudienceFilters } from './toolbar';

const SORTABLE: Partial<Record<ColumnId, AudienceQuery['sort']>> = { customer: 'name', phone: 'phone', stage: 'stage', added: 'createdAt', lastMessage: 'lastInboundAt' };

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Remembering table settings is a nicety only.
  }
}

/** Column order/visibility: saved per workspace, with new custom fields appended. */
function useColumns(workspaceId: string, fields: CustomFieldDef[]) {
  const key = `audience.columns.${workspaceId}`;
  const [saved, setSaved] = useState<ColumnState[]>(() => load(key, []));
  const columns = useMemo(() => {
    const all: ColumnState[] = [...BASE_COLUMNS.map((c) => ({ id: c.id, visible: c.visible })), ...fields.map((f) => ({ id: `custom:${f.key}` as ColumnId, visible: true }))];
    const known = saved.filter((s) => all.some((a) => a.id === s.id));
    return [...known, ...all.filter((a) => !known.some((k) => k.id === a.id))];
  }, [saved, fields]);
  const update = (next: ColumnState[]) => {
    setSaved(next);
    store(key, next);
  };
  return [columns, update] as const;
}

/** Audience: every customer in one table — search, filter, edit inline, export. */
export function AudiencePage() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const editable = can('contacts:manage') && workspace.status !== 'suspended';
  const incoming = (location.state as { filter?: Partial<AudienceFilter>; segmentName?: string } | null) ?? null;

  const [filters, setFilters] = useState<AudienceFilters>(() => (incoming?.filter ? { ...EMPTY_FILTERS, filter: incoming.filter } : EMPTY_FILTERS));
  const [segmentName, setSegmentName] = useState<string | null>(incoming?.segmentName ?? null);
  const [sort, setSort] = useState<{ sort: AudienceQuery['sort']; dir: AudienceQuery['dir'] }>({ sort: 'createdAt', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(() => load(`audience.limit.${workspace.id}`, 25));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState(false);
  const [savingSegment, setSavingSegment] = useState(false);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [dragCol, setDragCol] = useState<ColumnId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [moreAnchor, setMoreAnchor] = useState<HTMLButtonElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [modal, setModal] = useState<'import' | 'tags' | null>(null);

  // A segment opened from Segments arrives as navigation state; clear it so refresh starts clean.
  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [filters, sort, limit]);

  const fields = useQuery({ queryKey: ['custom-fields', workspace.id], queryFn: () => api.get<{ fields: CustomFieldDef[] }>(`/workspaces/${workspace.id}/custom-fields`) });
  const fieldList = fields.data?.fields ?? [];
  const [columns, setColumns] = useColumns(workspace.id, fieldList);
  const visible = columns.filter((c) => c.visible);
  const lists = useQuery({ queryKey: ['contact-lists', workspace.id, ''], queryFn: () => api.get<{ lists: ContactList[] }>(`/workspaces/${workspace.id}/contact-lists`), enabled: visible.some((c) => c.id === 'lists') });
  const listName = new Map((lists.data?.lists ?? []).map((l) => [l.id, l.name]));

  const queryBody: AudienceQuery = { ...filters, ...sort, page, limit };
  const encoded = encodeURIComponent(JSON.stringify({ ...queryBody, addedPreset: undefined }));
  const audience = useQuery({
    queryKey: ['audience', workspace.id, encoded],
    queryFn: () => api.get<{ contacts: AudienceRow[]; total: number; pages: number }>(`/workspaces/${workspace.id}/audience?query=${encoded}`),
    placeholderData: keepPreviousData,
  });
  const invalidate = useInvalidateAudience();

  const sync = useMutation({
    mutationFn: () => api.post<{ broadcast: number; direct: number }>(`/workspaces/${workspace.id}/audience/sync-campaigns`),
    onSuccess: (r) => {
      setNotice(`Synced: ${r.broadcast} broadcast lead(s) and ${r.direct} direct chat(s) updated.`);
      invalidate();
    },
  });
  const exportCsv = useMutation({ mutationFn: () => api.download(`/workspaces/${workspace.id}/audience/export?query=${encoded}`, 'audience.csv') });
  const bulk = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ updated: number }>(`/workspaces/${workspace.id}/audience/bulk`, { ...body, contactIds: [...selected] }),
    onSuccess: (r, body) => {
      setNotice(`${r.updated} customer(s) ${body.action === 'delete' ? 'deleted' : 'updated'}.`);
      if (body.action === 'delete') setSelected(new Set());
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['contact-lists', workspace.id] });
    },
  });
  const error = audience.error ?? sync.error ?? exportCsv.error ?? bulk.error;

  const rows = audience.data?.contacts ?? [];
  const total = audience.data?.total ?? 0;
  const pages = audience.data?.pages ?? 1;
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const filterCount = activeFilterCount(filters);

  const toggleSort = (col: ColumnId) => {
    const key = SORTABLE[col];
    if (!key) return;
    setSort((s) => (s.sort === key ? { sort: key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { sort: key, dir: key === 'createdAt' || key === 'lastInboundAt' ? 'desc' : 'asc' }));
  };
  const dropColumn = (target: ColumnId) => {
    if (!dragCol || dragCol === target) return;
    const next = columns.filter((c) => c.id !== dragCol);
    next.splice(
      next.findIndex((c) => c.id === target),
      0,
      columns.find((c) => c.id === dragCol)!,
    );
    setColumns(next);
    setDragCol(null);
  };
  const header = (id: ColumnId) => BASE_COLUMNS.find((c) => c.id === id)?.label ?? fieldList.find((f) => `custom:${f.key}` === id)?.label ?? id;

  const cell = (row: AudienceRow, id: ColumnId): ReactNode => {
    switch (id) {
      case 'customer':
        return (
          <button type="button" onClick={() => setViewing(row.id)} className="flex items-center gap-3 text-left">
            <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold', avatarTone(row.id))}>{initials(row.displayName)}</span>
            <span className="max-w-40 font-medium text-slate-800 hover:underline">{row.displayName}</span>
          </button>
        );
      case 'phone':
        return <PhoneCell phone={row.phone} />;
      case 'source':
        return row.attribution ? <SourceBadge source={row.attribution.source} /> : <span className="text-slate-300">—</span>;
      case 'campaign':
        return row.attribution?.campaignName ? (
          <span className="block max-w-44 truncate text-slate-700" title={row.attribution.campaignName}>
            {row.attribution.campaignName}
          </span>
        ) : row.attribution?.adTitle ? (
          <span className="block max-w-44 truncate text-slate-500" title={row.attribution.adTitle}>
            Ad: {row.attribution.adTitle}
          </span>
        ) : (
          <span className="text-slate-300">—</span>
        );
      case 'stage':
        return <StageCell row={row} editable={editable} />;
      case 'tags':
        return <TagsCell row={row} editable={editable} />;
      case 'followUp':
        return <FollowUpCell row={row} editable={editable} />;
      case 'owner':
        return <OwnerCell row={row} editable={editable} />;
      case 'email':
        return row.email ? <span className="text-slate-700">{row.email}</span> : <span className="text-slate-300">—</span>;
      case 'lists':
        return row.lists.length ? (
          <div className="flex max-w-52 flex-wrap gap-1">
            {row.lists.map((l) => (
              <span key={l} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                {listName.get(l) ?? '…'}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-slate-300">—</span>
        );
      case 'subscription':
        return row.consent.status === 'opted_out' ? <span className="text-xs font-medium text-red-600">Unsubscribed</span> : <span className="text-xs text-slate-500">{row.consent.status === 'opted_in' ? 'Opted in' : 'Subscribed'}</span>;
      case 'lastMessage':
        return row.lastInboundAt ? <span className="whitespace-nowrap text-slate-600">{formatDate(row.lastInboundAt, true)}</span> : <span className="text-slate-300">—</span>;
      case 'added':
        return <span className="whitespace-nowrap text-slate-600">{formatDate(row.createdAt, true)}</span>;
      default: {
        const field = fieldList.find((f) => `custom:${f.key}` === id);
        return field ? <CustomCell row={row} field={field} editable={editable} /> : null;
      }
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-slate-200 bg-white px-4 pt-4 pb-3 sm:px-6">
        <h1 className="text-xl font-semibold text-ink">Audience</h1>
        <p className="mt-0.5 text-sm text-slate-500">List view of all customers across lifecycle stages — search, filter &amp; export</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative w-40 transition-[width] focus-within:w-64">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <Input aria-label="Search customers" placeholder="Search" value={filters.q ?? ''} onChange={(e) => setFilters({ ...filters, q: e.target.value || undefined })} className="pl-9" />
          </div>
          <Button variant="secondary" onClick={() => setDrawer(true)}>
            <SlidersHorizontal className="size-4" /> Filters
            {filterCount > 0 && <span className="rounded-full bg-slate-700 px-1.5 text-xs text-white">{filterCount}</span>}
          </Button>
          {can('campaigns:manage') && (
            <Button variant="secondary" onClick={() => setSavingSegment(true)}>
              <Bookmark className="size-4" /> Create Segment
            </Button>
          )}
          <AddedMenu value={filters} onChange={setFilters} />
          <Button variant="secondary" onClick={() => void audience.refetch()}>
            <RefreshCw className={cn('size-4', audience.isFetching && 'animate-spin')} /> Refresh
          </Button>
          {editable && (
            <Button variant="secondary" onClick={() => sync.mutate()} loading={sync.isPending} title="Mark people who replied to a broadcast as broadcast leads">
              {!sync.isPending && <RefreshCw className="size-4" />} Sync Campaigns
            </Button>
          )}
          <ColumnsMenu columns={columns} onChange={setColumns} fields={fieldList} />
          {can('contacts:export') && (
            <Button variant="secondary" onClick={() => exportCsv.mutate()} loading={exportCsv.isPending}>
              {!exportCsv.isPending && <Download className="size-4" />} Export
            </Button>
          )}
          {editable && (
            <Button onClick={() => setAdding(true)} className="bg-slate-700 hover:bg-slate-800">
              <UserPlus className="size-4" /> Customer
            </Button>
          )}
          <Button ref={setMoreAnchor} variant="ghost" onClick={() => setMoreOpen(!moreOpen)} aria-label="More actions">
            <MoreHorizontal className="size-4" />
          </Button>
          <Popover anchor={moreAnchor} open={moreOpen} onClose={() => setMoreOpen(false)} width={200} align="right">
            {can('contacts:import') && (
              <button type="button" onClick={() => (setMoreOpen(false), setModal('import'))} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-slate-50">
                <Upload className="size-4" /> Import CSV
              </button>
            )}
            <button type="button" onClick={() => (setMoreOpen(false), setModal('tags'))} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-slate-50">
              <Tags className="size-4" /> Manage tags
            </button>
          </Popover>
        </div>
        {(segmentName || filterCount > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            {segmentName && (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700">
                <Bookmark className="size-3" /> {segmentName}
              </span>
            )}
            {filterCount > 0 && <span>{filterCount} filter(s) applied</span>}
            <button
              className="font-medium text-slate-600 underline"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setSegmentName(null);
              }}
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {(error != null || notice) && (
        <div className="space-y-2 px-4 pt-3 sm:px-6">
          {error != null && <Alert>{errorMessage(error)}</Alert>}
          {notice && (
            <Alert tone="success">
              <span className="flex items-center justify-between gap-2">
                {notice}
                <button onClick={() => setNotice(null)} aria-label="Dismiss">
                  <X className="size-4" />
                </button>
              </span>
            </Alert>
          )}
        </div>
      )}

      {selected.size > 0 && editable && <BulkBar count={selected.size} busy={bulk.isPending} onAction={(body) => bulk.mutate(body)} onClear={() => setSelected(new Set())} />}

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3 sm:px-6">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {audience.isPending ? (
            <Spinner />
          ) : rows.length === 0 ? (
            <EmptyState icon={<Users className="size-5" />} title={filterCount || filters.q || filters.addedPreset !== 'all' ? 'No customers match' : 'No customers yet'}>
              {filterCount || filters.q ? 'Try clearing a filter.' : 'Customers appear here when they message you, are imported, or are added to a contact list.'}
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase">
                  <tr>
                    <th className="sticky left-0 z-10 w-10 bg-slate-50 px-3 py-3">
                      <input type="checkbox" aria-label="Select all on this page" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} />
                    </th>
                    <th className="w-10 px-2 py-3">#</th>
                    {visible.map((c) => {
                      const sortKey = SORTABLE[c.id];
                      return (
                        <th
                          key={c.id}
                          draggable
                          onDragStart={() => setDragCol(c.id)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => dropColumn(c.id)}
                          className={cn('border-l border-slate-100 px-3 py-3 whitespace-nowrap', dragCol === c.id && 'opacity-40')}
                        >
                          <span className="inline-flex items-center gap-1">
                            <GripVertical className="size-3.5 cursor-grab text-slate-300" />
                            {sortKey ? (
                              <button type="button" onClick={() => toggleSort(c.id)} className="inline-flex items-center gap-1 uppercase hover:text-ink">
                                {header(c.id)}
                                {sort.sort === sortKey && (sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                              </button>
                            ) : (
                              header(c.id)
                            )}
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row, i) => (
                    <tr key={row.id} className={cn('group hover:bg-slate-50/60', selected.has(row.id) && 'bg-sky-50/40')}>
                      <td className="sticky left-0 z-10 bg-inherit px-3 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.displayName}`}
                          checked={selected.has(row.id)}
                          onChange={() => {
                            const next = new Set(selected);
                            if (next.has(row.id)) next.delete(row.id);
                            else next.add(row.id);
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td className="px-2 py-3 text-xs text-slate-400">{(page - 1) * limit + i + 1}</td>
                      {visible.map((c) => (
                        <td key={c.id} className="border-l border-slate-50 px-3 py-2.5">
                          {cell(row, c.id)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 sm:px-6">
        <div className="flex items-center gap-3">
          <span>{total ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total} customers` : '0 customers'}</span>
          <div className="w-28">
            <Select
              aria-label="Rows per page"
              value={limit}
              onChange={(e) => {
                setLimit(Number(e.target.value));
                store(`audience.limit.${workspace.id}`, Number(e.target.value));
              }}
              className="py-1"
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </Select>
          </div>
        </div>
        <Pager page={page} pages={pages} onChange={setPage} />
      </div>

      {drawer && <FiltersDrawer value={filters} onChange={(f) => (setFilters(f), setSegmentName(null))} onClose={() => setDrawer(false)} />}
      {savingSegment && <CreateSegmentDialog value={filters} onClose={() => setSavingSegment(false)} onSaved={(s) => (setSegmentName(s.name), setNotice(`Segment "${s.name}" saved.`))} />}
      {adding && <AddCustomerDialog onClose={() => setAdding(false)} onCreated={(c) => (invalidate(), setNotice(`Added ${c.displayName}.`))} />}
      {modal === 'import' && <ImportContactsModal onClose={() => (setModal(null), invalidate())} />}
      {modal === 'tags' && <TagsModal onClose={() => setModal(null)} />}
      {viewing && <ContactPanel contactId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function StageCell({ row, editable }: { row: AudienceRow; editable: boolean }) {
  const patch = useContactPatch(row.id);
  return <StageSelect value={row.lifecycleStage} disabled={!editable || patch.isPending} onChange={(key) => patch.mutate({ lifecycleStage: key })} />;
}

function Pager({ page, pages, onChange }: { page: number; pages: number; onChange: (p: number) => void }) {
  const nums = [...new Set([1, page - 1, page, page + 1, pages])].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const btn = 'flex size-9 items-center justify-center rounded-lg border border-slate-200 text-sm hover:bg-slate-50 disabled:opacity-40';
  return (
    <div className="flex items-center gap-1">
      <button className={btn} disabled={page <= 1} onClick={() => onChange(1)} aria-label="First page">
        <ChevronsLeft className="size-4" />
      </button>
      <button className={btn} disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page">
        <ChevronLeft className="size-4" />
      </button>
      {nums.map((p, i) => (
        <span key={p} className="flex items-center gap-1">
          {i > 0 && p - nums[i - 1]! > 1 && <span className="px-1 text-slate-400">…</span>}
          <button className={cn(btn, p === page && 'border-slate-700 bg-slate-700 font-medium text-white hover:bg-slate-700')} onClick={() => onChange(p)} aria-current={p === page ? 'page' : undefined}>
            {p}
          </button>
        </span>
      ))}
      <button className={btn} disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="Next page">
        <ChevronRight className="size-4" />
      </button>
      <button className={btn} disabled={page >= pages} onClick={() => onChange(pages)} aria-label="Last page">
        <ChevronsRight className="size-4" />
      </button>
    </div>
  );
}

/** Actions for the ticked customers. */
function BulkBar({ count, busy, onAction, onClear }: { count: number; busy: boolean; onAction: (body: Record<string, unknown>) => void; onClear: () => void }) {
  const { workspace, can } = useWorkspace();
  const stages = useStages(workspace.id);
  const tags = useTags(workspace.id);
  const members = useMembers(workspace.id, can('members:read'));
  const lists = useQuery({ queryKey: ['contact-lists', workspace.id, ''], queryFn: () => api.get<{ lists: ContactList[] }>(`/workspaces/${workspace.id}/contact-lists`) });
  const [menu, setMenu] = useState<{ kind: 'stage' | 'tag' | 'owner' | 'list'; anchor: HTMLElement } | null>(null);
  const open = (kind: 'stage' | 'tag' | 'owner' | 'list') => (e: React.MouseEvent<HTMLButtonElement>) => setMenu({ kind, anchor: e.currentTarget });
  const item = (key: string, label: ReactNode, body: Record<string, unknown>) => (
    <button
      key={key}
      type="button"
      onClick={() => {
        setMenu(null);
        onAction(body);
      }}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-slate-50"
    >
      {label}
    </button>
  );
  return (
    <div className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm sm:mx-6">
      <span className="font-medium text-slate-700">{count} selected</span>
      <Button variant="secondary" onClick={open('stage')} disabled={busy}>
        Change stage
      </Button>
      <Button variant="secondary" onClick={open('tag')} disabled={busy}>
        <Tags className="size-4" /> Add tag
      </Button>
      <Button variant="secondary" onClick={open('owner')} disabled={busy}>
        <UserRound className="size-4" /> Assign
      </Button>
      <Button variant="secondary" onClick={open('list')} disabled={busy}>
        <ListPlus className="size-4" /> Add to list
      </Button>
      {can('contacts:delete') && (
        <Button variant="danger" disabled={busy} onClick={() => window.confirm(`Delete ${count} customer(s) and their chat history? This can't be undone.`) && onAction({ action: 'delete' })}>
          <Trash2 className="size-4" /> Delete
        </Button>
      )}
      <button className="ml-auto text-slate-500 hover:text-ink" onClick={onClear} aria-label="Clear selection">
        <X className="size-4" />
      </button>
      <Popover anchor={menu?.anchor ?? null} open={!!menu} onClose={() => setMenu(null)} width={220}>
        {menu?.kind === 'stage' &&
          (stages.data ?? []).map((s) =>
            item(
              s.key,
              <>
                <span className={cn('size-2 rounded-full', STAGE_TONE[s.color].dot)} /> {s.name}
              </>,
              { action: 'set_stage', stage: s.key },
            ),
          )}
        {menu?.kind === 'tag' && (tags.data?.length ? tags.data.map((t) => item(t.id, <TagChip tag={t} />, { action: 'add_tags', tagIds: [t.id] })) : <p className="p-2 text-xs text-slate-500">No tags yet.</p>)}
        {menu?.kind === 'owner' && [item('none', 'Unassigned', { action: 'set_owner', ownerId: null }), ...(members.data ?? []).filter((m) => m.role !== 'analyst').map((m) => item(m.userId, m.name, { action: 'set_owner', ownerId: m.userId }))]}
        {menu?.kind === 'list' &&
          (lists.data?.lists.length ? lists.data.lists.map((l) => item(l.id, l.name, { action: 'add_to_list', listId: l.id })) : <p className="p-2 text-xs text-slate-500">No contact lists yet.</p>)}
      </Popover>
    </div>
  );
}

/** Side panel with the full contact card (stage, consent, owner, custom fields, notes…). */
function ContactPanel({ contactId, onClose }: { contactId: string; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const contact = useQuery({
    queryKey: ['contact', workspace.id, contactId],
    queryFn: () => api.get<{ contact: AudienceRow; conversation: { id: string } | null }>(`/workspaces/${workspace.id}/contacts/${contactId}`),
  });
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/20" onClick={onClose}>
      <aside className="animate-slide-in-right flex h-full w-full max-w-md flex-col bg-white shadow-xl" onClick={(e) => e.stopPropagation()} aria-label="Customer">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <p className="font-semibold text-ink">{contact.data?.contact.displayName ?? 'Customer'}</p>
          <div className="flex items-center gap-1">
            {contact.data?.conversation && (
              <Link to={`/w/${workspace.id}/inbox?c=${contact.data.conversation.id}`} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-brand-700 hover:bg-brand-50">
                <MessageSquare className="size-4" /> Open chat
              </Link>
            )}
            <button onClick={onClose} className="rounded-full p-1 text-slate-500 hover:bg-slate-100" aria-label="Close">
              <X className="size-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{contact.isPending ? <Spinner /> : contact.error ? <Alert>{errorMessage(contact.error)}</Alert> : <ContactDetails contact={contact.data.contact} />}</div>
      </aside>
    </div>
  );
}

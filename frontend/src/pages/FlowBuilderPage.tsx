import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, CircleCheck, Eye, FlaskConical, Play, Power, Redo2, RotateCcw, Save, Settings2, Undo2, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Modal } from '../components/crm';
import { NODE_META, PALETTE_GROUPS, nodeOutputs, nodeSummary, paletteItems } from '../components/flow/meta';
import { NodeEditor } from '../components/flow/NodeEditor';
import { BuilderContext, StepNode } from '../components/flow/StepNode';
import { Alert, Badge, Button, EmptyState, Field, Input, Spinner, cn, errorMessage } from '../components/ui';
import { ApiError, api, type FlowDetail, type FlowExecution, type FlowGraph, type FlowIssue, type FlowNodeType, type MessageTemplate, type WaForm } from '../lib/api';
import { useMembers, useTags } from '../lib/hooks';
import { useWorkspace } from '../layouts/workspaceContext';
import { FLOW_STATUS } from './FlowsPage';

const nodeTypes = Object.fromEntries(Object.keys(NODE_META).map((t) => [t, StepNode]));

export function FlowBuilderPage() {
  const { flowId } = useParams();
  const { workspace } = useWorkspace();
  const query = useQuery({
    queryKey: ['flow', workspace.id, flowId],
    queryFn: () => api.get<{ flow: FlowDetail }>(`/workspaces/${workspace.id}/flows/${flowId}`),
  });
  if (query.isPending) return <Spinner />;
  if (query.error) {
    return (
      <div className="p-6">
        <Alert>{errorMessage(query.error)}</Alert>
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <Builder key={query.data.flow.id} flow={query.data.flow} />
    </ReactFlowProvider>
  );
}

function toRf(graph: FlowGraph): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data, deletable: n.type !== 'trigger' })),
    edges: graph.edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, animated: false })),
  };
}

function fromRf(nodes: Node[], edges: Edge[]): FlowGraph {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.type as FlowNodeType, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: n.data as Record<string, unknown> })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? 'next', target: e.target })),
  };
}

function Builder({ flow }: { flow: FlowDetail }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const rf = useReactFlow();
  const editable = can('flows:manage') && workspace.status !== 'suspended';
  const initial = useMemo(() => toRf(flow.draftGraph), [flow.draftGraph]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState(flow.name);
  const [issues, setIssues] = useState<FlowIssue[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<'build' | 'runs'>('build');
  const [modal, setModal] = useState<'test' | 'settings' | 'preview' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const tags = useTags(workspace.id);
  const members = useMembers(workspace.id, can('members:read'));
  const templates = useQuery({
    queryKey: ['templates', workspace.id, 'APPROVED'],
    queryFn: () => api.get<{ templates: MessageTemplate[] }>(`/workspaces/${workspace.id}/templates?status=APPROVED`),
    select: (d) => d.templates,
  });
  const forms = useQuery({
    queryKey: ['forms', workspace.id],
    queryFn: () => api.get<{ forms: WaForm[] }>(`/workspaces/${workspace.id}/forms`),
    select: (d) => d.forms,
  });
  const google = useQuery({
    queryKey: ['google-accounts', workspace.id],
    queryFn: () => api.get<{ google: { accounts: { id: string; email: string }[] } }>(`/workspaces/${workspace.id}/integrations/google-sheets`),
    select: (d) => d.google.accounts,
  });
  const runs = useQuery({
    queryKey: ['flow-runs', workspace.id, flow.id],
    queryFn: () => api.get<{ executions: FlowExecution[] }>(`/workspaces/${workspace.id}/flows/${flow.id}/executions?limit=50`),
    refetchInterval: 5_000,
  });

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Counts edits, so a save that finishes after a newer edit doesn't mark the draft as saved.
  const changeSeq = useRef(0);
  const failedSeq = useRef(-1);
  const markDirty = () => {
    changeSeq.current += 1;
    setDirty(true);
    setNotice(null);
  };

  // ---- Undo / redo ----
  const history = useRef<{ past: Snap[]; future: Snap[]; lastKey: string; lastAt: number }>({ past: [], future: [], lastKey: '', lastAt: 0 });
  const [, bumpHistory] = useState(0);
  /** Call before a change. Edits with the same key within a second (typing) share one undo step. */
  const snapshot = (key = '') => {
    const h = history.current;
    const now = Date.now();
    if (key && key === h.lastKey && now - h.lastAt < 1000) {
      h.lastAt = now;
      return;
    }
    h.past.push({ nodes, edges });
    if (h.past.length > 60) h.past.shift();
    h.future = [];
    h.lastKey = key;
    h.lastAt = now;
    bumpHistory((n) => n + 1);
  };
  const travel = (dir: 'undo' | 'redo') => {
    const h = history.current;
    const snap = (dir === 'undo' ? h.past : h.future).pop();
    if (!snap) return;
    (dir === 'undo' ? h.future : h.past).push({ nodes, edges });
    h.lastKey = '';
    setNodes(snap.nodes);
    setEdges(snap.edges);
    if (selected && !snap.nodes.some((n) => n.id === selected)) setSelected(null);
    markDirty();
    bumpHistory((n) => n + 1);
  };
  // Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y), outside text fields.
  useEffect(() => {
    if (!editable || tab !== 'build') return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      e.preventDefault();
      travel(k === 'y' || e.shiftKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const save = useMutation({
    mutationFn: async () => {
      const at = changeSeq.current;
      const r = await api.patch<{ flow: FlowDetail }>(`/workspaces/${workspace.id}/flows/${flow.id}`, { name, draftGraph: fromRf(nodes, edges) });
      return { ...r, at };
    },
    onError: () => {
      failedSeq.current = changeSeq.current;
    },
    onSuccess: ({ flow: f, at }) => {
      if (at === changeSeq.current) setDirty(false);
      queryClient.setQueryData(['flow', workspace.id, flow.id], { flow: { ...f, draftGraph: flow.draftGraph } });
      void queryClient.invalidateQueries({ queryKey: ['flows', workspace.id] });
    },
  });
  // Auto-save: the draft is stored shortly after the last edit (the live version only changes on Publish).
  useEffect(() => {
    if (!dirty || !editable || save.isPending || failedSeq.current === changeSeq.current) return;
    const timer = setTimeout(() => save.mutate(), 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, editable, nodes, edges, name, save.isPending]);

  const validate = useMutation({
    mutationFn: async () => {
      await save.mutateAsync();
      return api.post<{ issues: FlowIssue[] }>(`/workspaces/${workspace.id}/flows/${flow.id}/validate`);
    },
    onSuccess: (r) => {
      setIssues(r.issues);
      setNotice(r.issues.length ? null : 'Everything looks good. Ready to publish.');
    },
  });
  const publish = useMutation({
    mutationFn: async () => {
      await save.mutateAsync();
      return api.post<{ flow: FlowDetail }>(`/workspaces/${workspace.id}/flows/${flow.id}/publish`);
    },
    onSuccess: ({ flow: f }) => {
      setIssues(null);
      setNotice(`Published version ${f.publishedVersion}. New conversations use it now; running ones finish on their version.`);
      queryClient.setQueryData(['flow', workspace.id, flow.id], { flow: { ...f, draftGraph: flow.draftGraph } });
      void queryClient.invalidateQueries({ queryKey: ['flows', workspace.id] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'FLOW_INVALID') setIssues((err.details as unknown as { issues: FlowIssue[] }).issues);
    },
  });
  const toggle = useMutation({
    mutationFn: (action: 'activate' | 'deactivate') => api.post<{ flow: FlowDetail }>(`/workspaces/${workspace.id}/flows/${flow.id}/${action}`),
    onSuccess: ({ flow: f }) => {
      queryClient.setQueryData(['flow', workspace.id, flow.id], { flow: { ...f, draftGraph: flow.draftGraph } });
      void queryClient.invalidateQueries({ queryKey: ['flows', workspace.id] });
    },
  });

  const current = queryClient.getQueryData<{ flow: FlowDetail }>(['flow', workspace.id, flow.id])?.flow ?? flow;
  const error = save.error ?? validate.error ?? (publish.error instanceof ApiError && publish.error.code === 'FLOW_INVALID' ? null : publish.error) ?? toggle.error;

  const issueMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const i of issues ?? []) if (i.nodeId) m.set(i.nodeId, [...(m.get(i.nodeId) ?? []), i.message]);
    return m;
  }, [issues]);
  const activeNodes = useMemo(
    () => new Set((runs.data?.executions ?? []).filter((e) => e.status === 'waiting' || e.status === 'running').map((e) => e.currentNodeId ?? '')),
    [runs.data],
  );
  const ctx = useMemo(
    () => ({
      issues: issueMap,
      tagName: (id: string) => tags.data?.find((t) => t.id === id)?.name ?? 'Unknown tag',
      templateName: (id: string) => templates.data?.find((t) => t.id === id)?.name ?? 'Template',
      formName: (id: string) => forms.data?.find((f) => f.id === id)?.name ?? 'Form',
      activeNodes,
    }),
    [issueMap, tags.data, templates.data, forms.data, activeNodes],
  );

  const onConnect = (c: Connection) => {
    if (!editable || c.source === c.target) return;
    snapshot();
    // One connection per output: replace whatever that output pointed to.
    setEdges((eds) => addEdge({ ...c, id: `${c.source}-${c.sourceHandle}-${c.target}` }, eds.filter((e) => !(e.source === c.source && e.sourceHandle === c.sourceHandle))));
    markDirty();
  };

  const addNode = (type: FlowNodeType, position?: { x: number; y: number }) => {
    const id = `${type}_${Math.random().toString(36).slice(2, 7)}`;
    const anchor = nodes.find((n) => n.id === selected) ?? nodes.at(-1);
    const pos = position ?? (anchor ? { x: anchor.position.x, y: anchor.position.y + 180 } : { x: 0, y: 0 });
    snapshot();
    setNodes((ns) => [...ns, { id, type, position: pos, data: NODE_META[type].defaults() }]);
    setSelected(id);
    markDirty();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/zeta-node') as FlowNodeType;
    if (type && editable) addNode(type, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  const selectedNode = nodes.find((n) => n.id === selected);
  const status = FLOW_STATUS[current.status];

  return (
    <BuilderContext.Provider value={ctx}>
      <div className="flex h-full min-h-0 flex-col">
        {/* Toolbar */}
        <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
          <Link to={`/w/${workspace.id}/flows`} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Back to flows">
            <ArrowLeft className="size-4" />
          </Link>
          <div className="w-56">
            <Input
              aria-label="Flow name"
              value={name}
              disabled={!editable}
              onChange={(e) => {
                setName(e.target.value);
                markDirty();
              }}
              className="border-transparent font-semibold shadow-none hover:border-slate-300"
            />
          </div>
          <Badge tone={status.tone}>
            {status.label}
            {current.publishedVersion > 0 && ` · v${current.publishedVersion}`}
          </Badge>
          {editable && (
            <span className={cn('text-xs', save.isError && dirty ? 'text-red-600' : 'text-slate-400')} aria-live="polite">
              {save.isPending ? 'Saving…' : dirty ? (save.isError ? 'Not saved' : 'Unsaved changes') : current.hasUnpublishedChanges ? 'Draft saved' : 'All changes saved'}
            </span>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <div className="mr-2 flex rounded-lg bg-slate-100 p-0.5 text-sm">
              {(['build', 'runs'] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} className={cn('rounded-md px-3 py-1 font-medium', tab === t ? 'bg-white shadow-sm' : 'text-slate-500')}>
                  {t === 'build' ? 'Builder' : `Runs${runs.data ? ` (${runs.data.executions.length})` : ''}`}
                </button>
              ))}
            </div>
            <Button variant="secondary" onClick={() => setModal('preview')} title="Walk through the draft without sending anything">
              <Eye className="size-4" /> Preview
            </Button>
            {editable && (
              <>
                <Button variant="ghost" disabled={!history.current.past.length} onClick={() => travel('undo')} title="Undo (Ctrl+Z)" aria-label="Undo">
                  <Undo2 className="size-4" />
                </Button>
                <Button variant="ghost" disabled={!history.current.future.length} onClick={() => travel('redo')} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
                  <Redo2 className="size-4" />
                </Button>
                <Button variant="ghost" onClick={() => setModal('settings')} title="Flow settings">
                  <Settings2 className="size-4" />
                </Button>
                <Button variant="secondary" loading={save.isPending && !validate.isPending && !publish.isPending} onClick={() => save.mutate()}>
                  <Save className="size-4" /> Save
                </Button>
                <Button variant="secondary" loading={validate.isPending} onClick={() => validate.mutate()}>
                  <CircleCheck className="size-4" /> Check
                </Button>
                {current.status === 'active' && (
                  <Button variant="secondary" onClick={() => setModal('test')}>
                    <FlaskConical className="size-4" /> Test
                  </Button>
                )}
                {current.status === 'active' ? (
                  <Button variant="ghost" loading={toggle.isPending} onClick={() => window.confirm('Turn this flow off? Contacts currently inside it will exit.') && toggle.mutate('deactivate')}>
                    <Power className="size-4" /> Turn off
                  </Button>
                ) : current.status === 'inactive' && !current.hasUnpublishedChanges ? (
                  <Button variant="secondary" loading={toggle.isPending} onClick={() => toggle.mutate('activate')}>
                    <Play className="size-4" /> Turn on
                  </Button>
                ) : null}
                <Button loading={publish.isPending} onClick={() => publish.mutate()}>
                  <Upload className="size-4" /> Publish
                </Button>
              </>
            )}
          </div>
        </header>

        {(error != null || notice || (issues && issues.length > 0)) && (
          <div className="space-y-2 border-b border-slate-200 bg-white px-4 py-2">
            {error != null && <Alert>{errorMessage(error)}</Alert>}
            {notice && <Alert tone="success">{notice}</Alert>}
            {issues && issues.length > 0 && (
              <Alert>
                <p className="font-medium">Fix these before publishing:</p>
                <ul className="mt-1 list-disc pl-5">
                  {issues.map((i, k) => (
                    <li key={k}>
                      {i.nodeId ? (
                        <button className="underline" onClick={() => { setTab('build'); setSelected(i.nodeId); }}>
                          {NODE_META[(nodes.find((n) => n.id === i.nodeId)?.type ?? 'trigger') as FlowNodeType].label}
                        </button>
                      ) : (
                        'Flow'
                      )}
                      : {i.message}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
          </div>
        )}

        {tab === 'runs' ? (
          <RunsPanel executions={runs.data?.executions} loading={runs.isPending} nodeLabel={(id) => NODE_META[(nodes.find((n) => n.id === id)?.type ?? 'trigger') as FlowNodeType].label} />
        ) : (
          <div className="flex min-h-0 flex-1">
            {editable && (
              <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-3 md:block" aria-label="Steps">
                {PALETTE_GROUPS.map((group) => (
                  <div key={group} className="mb-4">
                    <p className="mb-1.5 text-xs font-medium text-slate-400">{group}</p>
                    <div className="space-y-1.5">
                      {paletteItems(group).map((t) => {
                          const m = NODE_META[t];
                          return (
                            <button
                              key={t}
                              draggable
                              onDragStart={(e) => e.dataTransfer.setData('application/zeta-node', t)}
                              onClick={() => addNode(t)}
                              className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-2 text-left text-sm hover:border-brand-500 hover:bg-brand-50/40"
                              title={m.description}
                            >
                              <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md ring-1', m.accent)}>
                                <m.icon className="size-3.5" />
                              </span>
                              <span className="font-medium text-slate-700">{m.label}</span>
                            </button>
                          );
                      })}
                    </div>
                  </div>
                ))}
                <p className="text-xs text-slate-400">Click or drag a step onto the canvas, then connect an output (bottom dot) to the next step.</p>
              </aside>
            )}

            <div className="min-w-0 flex-1 bg-slate-50" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={(changes) => {
                  if (changes.some((c) => c.type === 'remove')) snapshot();
                  onNodesChange(changes);
                  if (changes.some((c) => c.type === 'position' || c.type === 'remove')) markDirty();
                }}
                onEdgesChange={(changes) => {
                  if (changes.some((c) => c.type === 'remove')) snapshot('remove');
                  onEdgesChange(changes);
                  if (changes.some((c) => c.type === 'remove')) markDirty();
                }}
                onConnect={onConnect}
                onNodeDragStart={() => snapshot()}
                onNodeClick={(_, n) => setSelected(n.id)}
                onPaneClick={() => setSelected(null)}
                nodesDraggable={editable}
                nodesConnectable={editable}
                deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
                fitView
                fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
                defaultEdgeOptions={{ style: { strokeWidth: 2 } }}
              >
                <Background gap={20} />
                <Controls showInteractive={false} />
                <MiniMap pannable zoomable className="!hidden lg:!block" />
              </ReactFlow>
            </div>

            {selectedNode && (
              <aside className="w-80 shrink-0 border-l border-slate-200 bg-white" aria-label="Step settings">
                <NodeEditor
                  key={selectedNode.id}
                  node={{ id: selectedNode.id, type: selectedNode.type as FlowNodeType, position: selectedNode.position, data: selectedNode.data as Record<string, unknown> }}
                  deps={{ tags: tags.data ?? [], templates: templates.data ?? [], members: members.data, forms: forms.data ?? [], googleAccounts: google.data ?? [] }}
                  disabled={!editable}
                  onChange={(data) => {
                    snapshot(`edit:${selectedNode.id}`);
                    setNodes((ns) => ns.map((n) => (n.id === selectedNode.id ? { ...n, data } : n)));
                    // Buttons or options removed: drop connections from outputs that no longer exist.
                    const ids = new Set(nodeOutputs({ type: selectedNode.type as FlowNodeType, data }).map((o) => o.id));
                    setEdges((es) => (es.some((e) => e.source === selectedNode.id && !ids.has(e.sourceHandle ?? 'next')) ? es.filter((e) => e.source !== selectedNode.id || ids.has(e.sourceHandle ?? 'next')) : es));
                    markDirty();
                  }}
                  onDelete={() => {
                    snapshot();
                    setNodes((ns) => ns.filter((n) => n.id !== selectedNode.id));
                    setEdges((es) => es.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id));
                    setSelected(null);
                    markDirty();
                  }}
                  onClose={() => setSelected(null)}
                />
              </aside>
            )}
          </div>
        )}
      </div>

      {modal === 'test' && <TestModal flowId={flow.id} onClose={() => setModal(null)} onStarted={() => { setModal(null); setTab('runs'); void runs.refetch(); }} />}
      {modal === 'preview' && <PreviewModal graph={fromRf(nodes, edges)} names={{ tag: ctx.tagName, template: ctx.templateName, form: ctx.formName }} onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsModal flow={current} onClose={() => setModal(null)} />}
    </BuilderContext.Provider>
  );
}

type Snap = { nodes: Node[]; edges: Edge[] };

// ---- Preview: walk the draft like a customer would, without sending anything ----

type PreviewLine = { from: 'bot' | 'you' | 'note'; text: string };
type PreviewState = { lines: PreviewLine[]; pending: { nodeId: string; options: { id: string; label: string }[] } | null };
type Names = Parameters<typeof nodeSummary>[1];

/** Steps the customer doesn't see: shown as small notes between the messages. */
const SILENT = new Set<FlowNodeType>(['trigger', 'condition', 'delay', 'time_check', 'add_tags', 'set_stage', 'set_field', 'loop', 'create_ticket', 'update_contact', 'http_request', 'google_sheets', 'wait_reply', 'exit', 'handoff', 'ai_answer', 'resolve_chat']);

function walk(graph: FlowGraph, fromId: string | undefined, names: Names, lines: PreviewLine[]): PreviewState {
  let id = fromId;
  for (let steps = 0; id && steps < 60; steps++) {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) break;
    const meta = NODE_META[node.type];
    const summary = nodeSummary(node, names);
    lines.push(SILENT.has(node.type) ? { from: 'note', text: `${meta.label}: ${summary}` } : { from: 'bot', text: summary });
    const outputs = nodeOutputs(node);
    if (!outputs.length) return { lines: [...lines, { from: 'note', text: 'The flow ends here.' }], pending: null };
    if (outputs.length > 1) return { lines, pending: { nodeId: node.id, options: outputs } };
    id = graph.edges.find((e) => e.source === node.id && e.sourceHandle === outputs[0]!.id)?.target;
  }
  return { lines: [...lines, { from: 'note', text: id ? 'Preview stopped after 60 steps.' : 'Nothing is connected next: the flow ends here.' }], pending: null };
}

function PreviewModal({ graph, names, onClose }: { graph: FlowGraph; names: Names; onClose: () => void }) {
  const start = () => walk(graph, graph.nodes.find((n) => n.type === 'trigger')?.id, names, []);
  const [state, setState] = useState<PreviewState>(start);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Newer browsers return a promise from scrollIntoView: an effect must not return it.
    void end.current?.scrollIntoView({ block: 'end' });
  }, [state]);
  const choose = (option: { id: string; label: string }) => {
    if (!state.pending) return;
    const target = graph.edges.find((e) => e.source === state.pending!.nodeId && e.sourceHandle === option.id)?.target;
    setState(walk(graph, target, names, [...state.lines, { from: 'you', text: option.label }]));
  };
  return (
    <Modal title="Preview flow" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">A walk-through of the draft. Nothing is sent; pick a path wherever the flow branches.</p>
        <div className="h-80 space-y-2 overflow-y-auto rounded-xl bg-[#efeae2] p-3 text-sm">
          {state.lines.map((l, i) =>
            l.from === 'note' ? (
              <p key={i} className="mx-auto w-fit max-w-full rounded-md bg-white/70 px-2 py-0.5 text-center text-[11px] text-slate-500">
                {l.text}
              </p>
            ) : (
              <p key={i} className={cn('w-fit max-w-[80%] rounded-lg px-3 py-1.5 whitespace-pre-wrap shadow-sm', l.from === 'bot' ? 'bg-white text-slate-800' : 'ml-auto bg-[#d9fdd3] text-slate-800')}>
                {l.text}
              </p>
            ),
          )}
          <div ref={end} />
        </div>
        {state.pending ? (
          <div className="flex flex-wrap gap-1.5">
            {state.pending.options.map((o) => (
              <Button key={o.id} variant="secondary" className="py-1 text-xs" onClick={() => choose(o)}>
                {o.label}
              </Button>
            ))}
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setState(start())}>
            <RotateCcw className="size-4" /> Start again
          </Button>
        )}
      </div>
    </Modal>
  );
}

const RUN_TONE = { running: 'blue', waiting: 'blue', completed: 'green', exited: 'gray', failed: 'red' } as const;

function RunsPanel({ executions, loading, nodeLabel }: { executions: FlowExecution[] | undefined; loading: boolean; nodeLabel: (id: string) => string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (loading) return <Spinner />;
  if (!executions?.length) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState icon={<Play className="size-5" />} title="No runs yet">
          Runs appear here once the flow is live and a customer triggers it.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto p-4">
      <ul className="mx-auto max-w-4xl divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
        {executions.map((e) => (
          <li key={e.id}>
            <button onClick={() => setOpen(open === e.id ? null : e.id)} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left text-sm hover:bg-slate-50">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-800">{e.contact?.name ?? 'Unknown contact'}</p>
                <p className="text-xs text-slate-500">
                  {e.contact?.phone} · started by {e.trigger?.type?.replace('_', ' ')} · {new Date(e.createdAt).toLocaleString()}
                </p>
                {e.error && <p className="text-xs text-red-600">{e.error}</p>}
                {e.waiting && (
                  <p className="text-xs text-sky-700">
                    {e.waiting.kind === 'delay' ? 'Waiting' : 'Waiting for a reply'} at {nodeLabel(e.waiting.nodeId)} until {new Date(e.waiting.until).toLocaleString()}
                  </p>
                )}
              </div>
              {e.goal && <Badge tone="green">Goal: {e.goal}</Badge>}
              <Badge tone={RUN_TONE[e.status]}>{e.status === 'completed' && e.exitReason === 'handoff' ? 'handed off' : e.status}</Badge>
            </button>
            {open === e.id && (
              <ol className="space-y-1 border-t border-slate-100 bg-slate-50 px-6 py-3 text-xs">
                {e.log.map((l, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="w-16 shrink-0 text-slate-400">{new Date(l.at).toLocaleTimeString()}</span>
                    <span className="font-medium text-slate-700">{nodeLabel(l.nodeId)}</span>
                    <span className="text-slate-600">
                      {l.outcome}
                      {l.detail ? ` · ${l.detail}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TestModal({ flowId, onClose, onStarted }: { flowId: string; onClose: () => void; onStarted: () => void }) {
  const { workspace } = useWorkspace();
  const [phone, setPhone] = useState('');
  const test = useMutation({ mutationFn: () => api.post(`/workspaces/${workspace.id}/flows/${flowId}/test`, { phone }), onSuccess: onStarted });
  return (
    <Modal title="Test this flow" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          test.mutate();
        }}
      >
        <p className="text-sm text-slate-600">Runs the live version for one contact now, as if they had triggered it. Use your own number (message the business number from it first so the 24-hour window is open).</p>
        {test.error != null && <Alert>{errorMessage(test.error)}</Alert>}
        <Field label="Contact phone" htmlFor="test-phone">
          <Input id="test-phone" type="tel" autoFocus value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Button type="submit" loading={test.isPending} disabled={!phone.trim()}>
          Start test run
        </Button>
      </form>
    </Modal>
  );
}

function SettingsModal({ flow, onClose }: { flow: FlowDetail; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState(flow.settings);
  const save = useMutation({
    mutationFn: () => api.patch<{ flow: FlowDetail }>(`/workspaces/${workspace.id}/flows/${flow.id}`, { settings }),
    onSuccess: ({ flow: f }) => {
      queryClient.setQueryData(['flow', workspace.id, flow.id], { flow: { ...f, draftGraph: flow.draftGraph } });
      onClose();
    },
  });
  return (
    <Modal title="Flow settings" onClose={onClose}>
      <div className="space-y-4 text-sm">
        {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={settings.allowReentry} onChange={(e) => setSettings({ ...settings, allowReentry: e.target.checked })} />
          <span>
            <span className="font-medium text-slate-800">Allow re-entry</span>
            <span className="block text-slate-500">Start again for a contact who is already inside this flow.</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={settings.exitOnReply} onChange={(e) => setSettings({ ...settings, exitOnReply: e.target.checked })} />
          <span>
            <span className="font-medium text-slate-800">Exit when the contact replies during a wait</span>
            <span className="block text-slate-500">Useful for drip sequences: a reply stops later steps.</span>
          </span>
        </label>
        <p className="text-xs text-slate-500">Settings apply immediately, without publishing.</p>
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          Save settings
        </Button>
      </div>
    </Modal>
  );
}

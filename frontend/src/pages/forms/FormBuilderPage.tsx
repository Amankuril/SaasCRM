import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, Code2, Copy, Eye, FileJson, GripVertical, Info, PanelTop, Plus, Save, Send, Trash2, Upload, X } from 'lucide-react';
import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert, Badge, Button, Input, Select, Spinner, cn, errorMessage, fieldError } from '../../components/ui';
import { ApiError, FORM_CATEGORIES, api, type FormCategory, type FormComponent, type FormComponentType, type FormScreen, type WaForm } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { ELEMENT, ElementView, HAS_OPTIONS, INPUT_TYPES, LABEL_LIMITS, MAX_SCREENS, PALETTE_GROUPS, TEXT_LIMITS, keysOf, newComponent, slug, uid, uniqueKey } from './elements';
import { FormPreviewDialog } from './FormPreview';
import { CATEGORY_LABEL, FORM_STATUS, FlowJsonDialog, SendFormDialog } from './shared';

export function FormBuilderPage() {
  const { formId } = useParams();
  const { workspace } = useWorkspace();
  const query = useQuery({ queryKey: ['form', workspace.id, formId], queryFn: () => api.get<{ form: WaForm }>(`/workspaces/${workspace.id}/forms/${formId}`) });
  if (query.isPending) return <Spinner />;
  if (query.error) return <div className="p-6"><Alert>{errorMessage(query.error)}</Alert></div>;
  return <Builder key={query.data.form.id} initial={query.data.form} />;
}

/** What is being edited: a screen (no component) or one component on it. */
type Selection = { screen: string; component?: string } | null;
/** What is being dragged: a new element from the palette or an existing one. */
type Drag = { kind: 'new'; type: FormComponentType } | { kind: 'move'; screen: number; index: number };

const newScreen = (n: number, footerLabel = 'Submit'): FormScreen => ({ id: uid(), title: `Screen ${n}`, footerLabel, components: [] });

function Builder({ initial }: { initial: WaForm }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const editable = can('forms:manage') && workspace.status !== 'suspended';
  const [form, setForm] = useState(initial);
  const [screens, setScreensState] = useState<FormScreen[]>(initial.screens);
  // Imported Flow JSON the builder can't show as screens; edited as text.
  const [rawText, setRawText] = useState<string | null>(initial.rawFlowJson ? JSON.stringify(initial.rawFlowJson, null, 2) : null);
  const [selected, setSelected] = useState<Selection>(null);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'preview' | 'send' | 'code' | null>(null);
  const drag = useRef<Drag | null>(null);
  const [dropAt, setDropAt] = useState<{ screen: number; index: number } | null>(null);

  const touch = () => {
    setDirty(true);
    setNotice(null);
  };
  const setScreens = (next: FormScreen[]) => {
    setScreensState(next);
    touch();
  };
  const setMeta = (patch: Partial<WaForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    touch();
  };

  const sIndex = selected ? screens.findIndex((s) => s.id === selected.screen) : -1;
  const selScreen = screens[sIndex];
  const selComponent = selected?.component ? selScreen?.components.find((c) => c.id === selected.component) : undefined;

  // ---- Editing ----
  const addScreen = () => {
    if (screens.length >= MAX_SCREENS) return;
    // The old last screen now leads on to the new one.
    const next = screens.map((s, i) => (i === screens.length - 1 && s.footerLabel === 'Submit' ? { ...s, footerLabel: 'Continue' } : s));
    const screen = newScreen(screens.length + 1);
    setScreens([...next, screen]);
    setSelected({ screen: screen.id });
  };
  const insert = (type: FormComponentType, screenIndex: number, at: number) => {
    let list = screens;
    if (!list.length) list = [newScreen(1)];
    const target = Math.min(screenIndex, list.length - 1);
    const c = newComponent(type, list);
    setScreens(list.map((s, i) => (i === target ? { ...s, components: [...s.components.slice(0, at), c, ...s.components.slice(at)] } : s)));
    setSelected({ screen: list[target]!.id, component: c.id });
  };
  /** Palette click: after the selected element, else at the end of the selected (or last) screen. */
  const addFromPalette = (type: FormComponentType) => {
    const si = sIndex >= 0 ? sIndex : screens.length - 1;
    const s = screens[si];
    const after = s && selected?.component ? s.components.findIndex((c) => c.id === selected.component) : -1;
    insert(type, Math.max(si, 0), after >= 0 ? after + 1 : (s?.components.length ?? 0));
  };
  const moveComponent = (from: { screen: number; index: number }, to: { screen: number; index: number }) => {
    const c = screens[from.screen]?.components[from.index];
    if (!c) return;
    const without = screens.map((s, i) => (i === from.screen ? { ...s, components: s.components.filter((_, j) => j !== from.index) } : s));
    const at = from.screen === to.screen && to.index > from.index ? to.index - 1 : to.index;
    setScreens(without.map((s, i) => (i === to.screen ? { ...s, components: [...s.components.slice(0, at), c, ...s.components.slice(at)] } : s)));
    setSelected({ screen: screens[to.screen]!.id, component: c.id });
  };
  const updateComponent = (patch: Partial<FormComponent>) => {
    if (!selScreen || !selComponent) return;
    setScreens(screens.map((s) => (s.id === selScreen.id ? { ...s, components: s.components.map((c) => (c.id === selComponent.id ? { ...c, ...patch } : c)) } : s)));
  };
  const removeComponent = (screenId: string, id: string) => {
    setScreens(screens.map((s) => (s.id === screenId ? { ...s, components: s.components.filter((c) => c.id !== id) } : s)));
    setSelected({ screen: screenId });
  };
  const duplicateComponent = (screenId: string, id: string) => {
    const s = screens.find((x) => x.id === screenId)!;
    const i = s.components.findIndex((c) => c.id === id);
    const src = s.components[i]!;
    const copy: FormComponent = { ...src, id: uid(), ...(src.key ? { key: uniqueKey(src.key, keysOf(screens)) } : {}) };
    setScreens(screens.map((x) => (x.id === screenId ? { ...x, components: [...x.components.slice(0, i + 1), copy, ...x.components.slice(i + 1)] } : x)));
    setSelected({ screen: screenId, component: copy.id });
  };
  const updateScreen = (id: string, patch: Partial<FormScreen>) => setScreens(screens.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const moveScreen = (i: number, dir: -1 | 1) => {
    const next = [...screens];
    const [s] = next.splice(i, 1);
    next.splice(i + dir, 0, s!);
    setScreens(next);
  };
  const removeScreen = (i: number) => {
    const s = screens[i]!;
    if (s.components.length && !window.confirm(`Delete "${s.title || `Screen ${i + 1}`}" and its ${s.components.length} element(s)?`)) return;
    setScreens(screens.filter((_, j) => j !== i));
    setSelected(null);
  };

  // ---- Drag and drop ----
  const dragOver = (e: DragEvent, screen: number, index: number) => {
    if (!drag.current || !editable) return;
    e.preventDefault();
    e.stopPropagation();
    if (dropAt?.screen !== screen || dropAt.index !== index) setDropAt({ screen, index });
  };
  const overComponent = (e: DragEvent<HTMLElement>, screen: number, index: number) => {
    const r = e.currentTarget.getBoundingClientRect();
    dragOver(e, screen, e.clientY > r.top + r.height / 2 ? index + 1 : index);
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const d = drag.current;
    const at = dropAt;
    drag.current = null;
    setDropAt(null);
    if (!d || !at) return;
    if (d.kind === 'new') insert(d.type, at.screen, at.index);
    else moveComponent(d, at);
  };
  const endDrag = () => {
    drag.current = null;
    setDropAt(null);
  };

  // ---- Saving ----
  const store = (f: WaForm) => {
    setForm(f);
    setDirty(false);
    queryClient.setQueryData(['form', workspace.id, f.id], { form: f });
    void queryClient.invalidateQueries({ queryKey: ['forms', workspace.id] });
    void queryClient.invalidateQueries({ queryKey: ['form-json', workspace.id, f.id] });
  };
  const body = () => ({
    name: form.name.trim() || 'Untitled form',
    category: form.category,
    intro: form.intro,
    ctaText: form.ctaText,
    successMessage: form.successMessage,
    ...(rawText !== null ? { rawFlowJson: rawText } : { screens, rawFlowJson: null }),
  });
  const save = useMutation({
    mutationFn: () => api.patch<{ form: WaForm }>(`/workspaces/${workspace.id}/forms/${form.id}`, body()),
    onSuccess: ({ form: f }) => store(f),
  });
  const saveDraft = () =>
    save.mutate(undefined, {
      onSuccess: () => setNotice(form.status === 'published' ? 'Draft saved. Publish to send the changes to WhatsApp.' : 'Draft saved.'),
    });
  const publish = useMutation({
    mutationFn: async () => {
      setNotice(null);
      await save.mutateAsync();
      return api.post<{ form: WaForm }>(`/workspaces/${workspace.id}/forms/${form.id}/publish`);
    },
    onSuccess: ({ form: f }) => {
      store(f);
      setIssues([]);
      setNotice(`Published version ${f.version} to WhatsApp. New sends use it; earlier submissions keep their meaning.`);
    },
    onError: (err) => {
      // A failed publish marks the form on the server; show that on the list too.
      void queryClient.invalidateQueries({ queryKey: ['forms', workspace.id] });
      if (err instanceof ApiError && err.code === 'FORM_INVALID') setIssues((err.details as unknown as { issues: string[] }).issues);
    },
  });
  const showCode = async () => {
    if (dirty) await save.mutateAsync().catch(() => undefined);
    setDialog('code');
  };
  const cancel = () => {
    if (!dirty || window.confirm('Leave without saving your changes?')) navigate(`/w/${workspace.id}/forms`);
  };
  const error = (save.error && !fieldError(save.error, 'flowJson') ? save.error : null) ?? (publish.error instanceof ApiError && publish.error.code === 'FORM_INVALID' ? null : publish.error);

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
        <Link
          to={`/w/${workspace.id}/forms`}
          onClick={(e) => {
            if (dirty && !window.confirm('Leave without saving your changes?')) e.preventDefault();
          }}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-ink"
        >
          <ArrowLeft className="size-4" /> Back to Form list
        </Link>
        <Badge tone={FORM_STATUS[form.status].tone}>
          {FORM_STATUS[form.status].label}
          {form.version > 0 && ` · v${form.version}`}
        </Badge>
        {form.status === 'published' && (dirty || form.hasUnpublishedChanges) && <span className="text-xs text-amber-600">Unpublished changes</span>}
        {form.providerFlowId && <span className="ml-auto hidden font-mono text-xs text-slate-400 md:inline">Flow ID {form.providerFlowId}</span>}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* ---- Palette ---- */}
        <aside className="shrink-0 border-b border-slate-200 bg-white lg:w-60 lg:overflow-y-auto lg:border-r lg:border-b-0">
          {rawText !== null ? (
            <p className="p-4 text-xs text-slate-500">This form is edited as Flow JSON. Start over in the builder to use elements.</p>
          ) : (
            <fieldset disabled={!editable} className="divide-y divide-slate-100">
              <PaletteSection title="Containers">
                <PaletteButton icon={<PanelTop className="size-4" />} label="Add New Screen" disabled={screens.length >= MAX_SCREENS} onClick={addScreen} />
              </PaletteSection>
              {PALETTE_GROUPS.map((g) => (
                <PaletteSection key={g.title} title={g.title}>
                  {g.items.map((item) => (
                    <PaletteButton
                      key={item.type}
                      icon={<item.icon className="size-4" />}
                      label={item.label}
                      onClick={() => addFromPalette(item.type)}
                      onDragStart={(e) => {
                        drag.current = { kind: 'new', type: item.type };
                        e.dataTransfer.effectAllowed = 'copy';
                        e.dataTransfer.setData('text/plain', item.type);
                      }}
                      onDragEnd={endDrag}
                    />
                  ))}
                </PaletteSection>
              ))}
            </fieldset>
          )}
        </aside>

        {/* ---- Canvas ---- */}
        <main className="min-w-0 flex-1 lg:overflow-y-auto" onClick={() => setSelected(null)}>
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50/95 px-4 py-3 backdrop-blur" onClick={(e) => e.stopPropagation()}>
            <label className="flex min-w-64 flex-1 items-center gap-2 text-sm font-medium text-slate-600">
              <span className="shrink-0">Form Name:</span>
              <Input aria-label="Form name" value={form.name} maxLength={80} disabled={!editable} onChange={(e) => setMeta({ name: e.target.value })} className="max-w-xs font-semibold text-ink" />
            </label>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button variant="ghost" onClick={cancel}>
                CANCEL
              </Button>
              {editable && (
                <Button variant="secondary" loading={save.isPending && !publish.isPending} onClick={saveDraft}>
                  <Save className="size-4" /> SAVE AS DRAFT
                </Button>
              )}
              <Button variant="secondary" disabled={rawText !== null} title={rawText !== null ? 'Preview works for forms made in the builder' : undefined} onClick={() => setDialog('preview')}>
                <Eye className="size-4" /> PREVIEW
              </Button>
              <Button variant="secondary" onClick={() => void showCode()} aria-label="View Flow JSON" title="View Flow JSON">
                <Code2 className="size-4" />
              </Button>
              {form.status === 'published' && (
                <Button variant="secondary" onClick={() => setDialog('send')}>
                  <Send className="size-4" /> Send
                </Button>
              )}
              {editable && (
                <Button loading={publish.isPending} onClick={() => publish.mutate()}>
                  <Upload className="size-4" /> PUBLISH
                </Button>
              )}
            </div>
          </div>

          <div className="mx-auto max-w-2xl space-y-4 px-4 py-5" onClick={(e) => e.stopPropagation()}>
            {error != null && <Alert>{errorMessage(error)}</Alert>}
            {notice && <Alert tone="success">{notice}</Alert>}
            {issues.length > 0 && (
              <Alert>
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <p className="font-medium">Fix these before publishing:</p>
                    <ul className="mt-1 list-disc pl-5">
                      {issues.map((i, k) => (
                        <li key={k}>{i}</li>
                      ))}
                    </ul>
                  </div>
                  <button onClick={() => setIssues([])} aria-label="Dismiss" className="rounded p-0.5 hover:bg-red-100">
                    <X className="size-4" />
                  </button>
                </div>
              </Alert>
            )}
            {form.publishError && issues.length === 0 && <Alert>Last publish failed: {form.publishError}</Alert>}

            {rawText !== null ? (
              <RawJsonEditor
                value={rawText}
                error={fieldError(save.error, 'flowJson')}
                editable={editable}
                onChange={(v) => (setRawText(v), touch())}
                onStartOver={() => {
                  if (!window.confirm('Discard this Flow JSON and build the form with screens instead?')) return;
                  setRawText(null);
                  setScreens([newScreen(1)]);
                }}
              />
            ) : (
              <>
                {screens.map((s, si) => (
                  <section
                    key={s.id}
                    onClick={() => setSelected({ screen: s.id })}
                    className={cn('rounded-xl border bg-white shadow-sm transition', selected?.screen === s.id && !selected.component ? 'border-emerald-500 ring-2 ring-emerald-500/20' : 'border-slate-200')}
                  >
                    <header className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
                      <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700">SCREEN {si + 1}</span>
                      <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">{s.title || 'Untitled screen'}</p>
                      {editable && (
                        <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                          <MiniButton label="Move screen up" disabled={si === 0} onClick={() => moveScreen(si, -1)}>
                            <ArrowUp className="size-3.5" />
                          </MiniButton>
                          <MiniButton label="Move screen down" disabled={si === screens.length - 1} onClick={() => moveScreen(si, 1)}>
                            <ArrowDown className="size-3.5" />
                          </MiniButton>
                          <MiniButton label="Delete screen" danger onClick={() => removeScreen(si)}>
                            <Trash2 className="size-3.5" />
                          </MiniButton>
                        </div>
                      )}
                    </header>
                    <div className="min-h-24 space-y-1 p-3" onDragOver={(e) => dragOver(e, si, s.components.length)} onDrop={drop}>
                      {s.components.map((c, ci) => {
                        const active = selected?.component === c.id;
                        return (
                          <div key={c.id}>
                            {dropAt?.screen === si && dropAt.index === ci && <DropLine />}
                            <div
                              draggable={editable}
                              onDragStart={(e) => {
                                e.stopPropagation();
                                drag.current = { kind: 'move', screen: si, index: ci };
                                e.dataTransfer.effectAllowed = 'move';
                                e.dataTransfer.setData('text/plain', c.id);
                              }}
                              onDragEnd={endDrag}
                              onDragOver={(e) => overComponent(e, si, ci)}
                              onDrop={drop}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelected({ screen: s.id, component: c.id });
                              }}
                              className={cn('group relative flex gap-2 rounded-lg border px-2 py-2.5', active ? 'border-emerald-500 bg-emerald-50/30' : 'border-transparent hover:border-slate-200 hover:bg-slate-50/60')}
                            >
                              <GripVertical className={cn('mt-0.5 size-4 shrink-0 text-slate-300', editable && 'cursor-grab')} />
                              <div className="pointer-events-none min-w-0 flex-1">
                                <ElementView c={c} />
                              </div>
                              {editable && (
                                <div className={cn('absolute -top-3 right-2 items-center rounded-md border border-slate-200 bg-white shadow-sm', active ? 'flex' : 'hidden group-hover:flex')} onClick={(e) => e.stopPropagation()}>
                                  <span className="px-1.5 text-[10px] font-medium text-slate-500">{ELEMENT[c.type].label}</span>
                                  <MiniButton label="Duplicate" onClick={() => duplicateComponent(s.id, c.id)}>
                                    <Copy className="size-3.5" />
                                  </MiniButton>
                                  <MiniButton label="Remove element" danger onClick={() => removeComponent(s.id, c.id)}>
                                    <Trash2 className="size-3.5" />
                                  </MiniButton>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {dropAt?.screen === si && dropAt.index === s.components.length && <DropLine />}
                      {!s.components.length && <p className="py-6 text-center text-xs text-slate-400">Drag elements here, or click one in the left sidebar.</p>}
                    </div>
                    <footer className="border-t border-slate-100 px-4 py-3">
                      <div className="rounded-full bg-emerald-600 py-2 text-center text-sm font-medium text-white">{s.footerLabel || 'Continue'}</div>
                      <p className="mt-1.5 text-center text-[11px] text-slate-400">{si === screens.length - 1 ? 'Submits the form' : `Goes to screen ${si + 2}`}</p>
                    </footer>
                  </section>
                ))}
                {editable && screens.length < MAX_SCREENS && (
                  <button type="button" onClick={addScreen} className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 py-6 text-sm font-semibold tracking-wide text-slate-500 hover:border-emerald-400 hover:bg-emerald-50/40 hover:text-emerald-700">
                    <Plus className="size-4" /> ADD A SCREEN
                  </button>
                )}
                <p className="text-center text-xs text-slate-400">
                  {screens.length}/{MAX_SCREENS} screens · each screen's button goes to the next one; the last submits.
                </p>
              </>
            )}
          </div>
        </main>

        {/* ---- Properties ---- */}
        <aside className="shrink-0 border-t border-slate-200 bg-white lg:w-80 lg:overflow-y-auto lg:border-t-0 lg:border-l">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Edit Properties</h2>
          </div>
          <fieldset disabled={!editable} className="space-y-4 p-4">
            {selComponent && selScreen ? (
              <ComponentProps
                key={selComponent.id}
                c={selComponent}
                screens={screens}
                onChange={updateComponent}
                onRemove={() => removeComponent(selScreen.id, selComponent.id)}
              />
            ) : selScreen ? (
              <ScreenProps key={selScreen.id} screen={selScreen} index={sIndex} last={sIndex === screens.length - 1} onChange={(p) => updateScreen(selScreen.id, p)} />
            ) : (
              <>
                <div className="flex gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 ring-1 ring-amber-200">
                  <Info className="mt-0.5 size-4 shrink-0" />
                  <p>
                    <span className="font-semibold">Note!</span> You need to select a Component to edit properties.
                  </p>
                </div>
                <FormSettings form={form} onChange={setMeta} />
              </>
            )}
          </fieldset>
        </aside>
      </div>

      {dialog === 'preview' && <FormPreviewDialog form={form} screens={screens} onClose={() => setDialog(null)} />}
      {dialog === 'send' && <SendFormDialog formId={form.id} onClose={() => setDialog(null)} />}
      {dialog === 'code' && <FlowJsonDialog form={form} onClose={() => setDialog(null)} />}
    </div>
  );
}

function PaletteSection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="px-3 py-2.5">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between py-1 text-xs font-semibold tracking-wide text-slate-500 uppercase hover:text-slate-700">
        {title}
        <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
      </button>
      {open && <div className="mt-1.5 grid grid-cols-2 gap-1.5 lg:grid-cols-1">{children}</div>}
    </div>
  );
}

function PaletteButton({ icon, label, disabled, onClick, onDragStart, onDragEnd }: { icon: ReactNode; label: string; disabled?: boolean; onClick: () => void; onDragStart?: (e: DragEvent) => void; onDragEnd?: () => void }) {
  return (
    <button
      type="button"
      draggable={!!onDragStart && !disabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-left text-sm text-slate-700 transition hover:border-emerald-300 hover:bg-emerald-50/50 hover:text-emerald-800 disabled:opacity-40"
    >
      <span className="text-slate-400">{icon}</span>
      {label}
    </button>
  );
}

function MiniButton({ label, danger, disabled, onClick, children }: { label: string; danger?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className={cn('rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30', danger ? 'hover:text-red-600' : 'hover:text-slate-700')}>
      {children}
    </button>
  );
}

const DropLine = () => <div className="my-0.5 h-0.5 rounded-full bg-emerald-500" />;

// ---- Properties panel ----

function Prop({ label, htmlFor, count, max, hint, children }: { label: string; htmlFor: string; count?: number; max?: number; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-xs font-medium text-slate-700">
          {label}
        </label>
        {max !== undefined && <span className={cn('text-[11px] tabular-nums', (count ?? 0) > max ? 'font-semibold text-red-600' : 'text-slate-400')}>{`${count ?? 0}/${max}`}</span>}
      </div>
      {children}
      {hint && <p className="text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

const textareaClass = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none';

function FormSettings({ form, onChange }: { form: WaForm; onChange: (p: Partial<WaForm>) => void }) {
  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Form settings</h3>
      <Prop label="Category" htmlFor="fs-category">
        <Select id="fs-category" value={form.category} onChange={(e) => onChange({ category: e.target.value as FormCategory })}>
          {FORM_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </Select>
      </Prop>
      <Prop label="Message sent with the form" htmlFor="fs-intro" count={form.intro.length} max={1024}>
        <textarea id="fs-intro" rows={3} className={textareaClass} value={form.intro} placeholder="Book your appointment in a few taps" onChange={(e) => onChange({ intro: e.target.value })} />
      </Prop>
      <Prop label="Button text" htmlFor="fs-cta" count={form.ctaText.length} max={20}>
        <Input id="fs-cta" maxLength={20} value={form.ctaText} onChange={(e) => onChange({ ctaText: e.target.value })} />
      </Prop>
      <Prop label="Reply after a submission" htmlFor="fs-ok" hint={<>Use {'{{key}}'} to include an answer, e.g. {'{{name}}'}.</>}>
        <textarea id="fs-ok" rows={2} className={textareaClass} value={form.successMessage} onChange={(e) => onChange({ successMessage: e.target.value })} />
      </Prop>
    </div>
  );
}

function ScreenProps({ screen, index, last, onChange }: { screen: FormScreen; index: number; last: boolean; onChange: (p: Partial<FormScreen>) => void }) {
  return (
    <div className="space-y-4">
      <PropsTitle icon={<PanelTop className="size-4" />} title={`Screen ${index + 1}`} />
      <Prop label="Screen title" htmlFor="sp-title" count={screen.title.length} max={30}>
        <Input id="sp-title" value={screen.title} onChange={(e) => onChange({ title: e.target.value })} />
      </Prop>
      <Prop label="Button label" htmlFor="sp-footer" count={screen.footerLabel.length} max={35} hint={last ? 'This is the last screen: its button submits the form.' : `Goes to screen ${index + 2}.`}>
        <Input id="sp-footer" value={screen.footerLabel} onChange={(e) => onChange({ footerLabel: e.target.value })} />
      </Prop>
    </div>
  );
}

function PropsTitle({ icon, title, onRemove }: { icon: ReactNode; title: string; onRemove?: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="rounded-md bg-emerald-50 p-1.5 text-emerald-700">{icon}</span>
      <p className="flex-1 text-sm font-semibold text-ink">{title}</p>
      {onRemove && (
        <button type="button" onClick={onRemove} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Remove element" title="Remove element">
          <Trash2 className="size-4" />
        </button>
      )}
    </div>
  );
}

const MAX_IMAGE_BYTES = 290_000;

function ComponentProps({ c, screens, onChange, onRemove }: { c: FormComponent; screens: FormScreen[]; onChange: (p: Partial<FormComponent>) => void; onRemove: () => void }) {
  const el = ELEMENT[c.type];
  const [imageError, setImageError] = useState<string | null>(null);
  const textMax = TEXT_LIMITS[c.type];
  const labelMax = LABEL_LIMITS[c.type];
  const isInput = INPUT_TYPES.includes(c.type);
  const otherKeys = new Set([...keysOf(screens)].filter((k) => k !== c.key));
  const setLabel = (label: string) => {
    // Keep the answer key in step with the label until it is renamed by hand.
    const auto = !c.key || c.key === uniqueKey(slug(c.label ?? ''), otherKeys);
    onChange({ label, ...(auto ? { key: uniqueKey(slug(label), otherKeys) } : {}) });
  };
  const options = c.options ?? [];
  const setOption = (i: number, title: string) => {
    const ids = new Set(options.filter((_, j) => j !== i).map((o) => o.id));
    onChange({ options: options.map((o, j) => (j === i ? { id: uniqueKey(slug(title) || `option_${i + 1}`, ids), title } : o)) });
  };
  const pickImage = (file: File | undefined) => {
    setImageError(null);
    if (!file) return;
    if (!/^image\/(png|jpe?g)$/.test(file.type)) return setImageError('Use a PNG or JPEG image.');
    if (file.size > MAX_IMAGE_BYTES) return setImageError('Images must be under 290 KB.');
    const reader = new FileReader();
    reader.onload = () => onChange({ image: String(reader.result).split(',')[1] ?? '' });
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-4">
      <PropsTitle icon={<el.icon className="size-4" />} title={el.label} onRemove={onRemove} />

      {textMax !== undefined && (
        <Prop label={c.type === 'link' ? 'Link text' : 'Text'} htmlFor="cp-text" count={c.text?.length} max={textMax}>
          {c.type === 'body' || c.type === 'caption' ? (
            <textarea id="cp-text" rows={5} className={textareaClass} value={c.text ?? ''} onChange={(e) => onChange({ text: e.target.value })} />
          ) : (
            <Input id="cp-text" value={c.text ?? ''} onChange={(e) => onChange({ text: e.target.value })} />
          )}
        </Prop>
      )}

      {c.type === 'link' && (
        <Prop label="Opens this address" htmlFor="cp-url" hint="Must start with https://">
          <Input id="cp-url" type="url" value={c.url ?? ''} onChange={(e) => onChange({ url: e.target.value })} />
        </Prop>
      )}

      {c.type === 'image' && (
        <>
          <Prop label="Image" htmlFor="cp-image" hint="PNG or JPEG, under 290 KB.">
            {c.image && <img src={`data:image/png;base64,${c.image}`} alt="" className="mb-2 max-h-40 w-full rounded-lg bg-slate-50 object-contain" />}
            <input id="cp-image" type="file" accept="image/png,image/jpeg" onChange={(e) => pickImage(e.target.files?.[0])} className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-medium" />
            {imageError && <p className="text-xs text-red-600">{imageError}</p>}
          </Prop>
          <Prop label="Height (px)" htmlFor="cp-height">
            <Input id="cp-height" type="number" min={50} max={600} value={c.height ?? 160} onChange={(e) => onChange({ height: Math.min(600, Math.max(50, Number(e.target.value) || 160)) })} />
          </Prop>
        </>
      )}

      {isInput && (
        <Prop label="Label" htmlFor="cp-label" count={c.label?.length} max={labelMax}>
          {c.type === 'opt_in' ? (
            <textarea id="cp-label" rows={3} className={textareaClass} value={c.label ?? ''} onChange={(e) => setLabel(e.target.value)} />
          ) : (
            <Input id="cp-label" value={c.label ?? ''} onChange={(e) => setLabel(e.target.value)} />
          )}
        </Prop>
      )}

      {c.type === 'text_input' && (
        <Prop label="Input type" htmlFor="cp-input-type">
          <Select id="cp-input-type" value={c.inputType ?? 'text'} onChange={(e) => onChange({ inputType: e.target.value as FormComponent['inputType'] })}>
            <option value="text">Text</option>
            <option value="email">Email</option>
            <option value="phone">Phone</option>
            <option value="number">Number</option>
            <option value="password">Password</option>
            <option value="passcode">Passcode</option>
          </Select>
        </Prop>
      )}

      {(c.type === 'text_input' || c.type === 'text_area' || c.type === 'date') && (
        <Prop label="Helper text" htmlFor="cp-helper" count={c.helperText?.length} max={80}>
          <Input id="cp-helper" value={c.helperText ?? ''} placeholder="Optional hint under the field" onChange={(e) => onChange({ helperText: e.target.value || undefined })} />
        </Prop>
      )}

      {HAS_OPTIONS.has(c.type) && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-slate-700">Options</p>
          {options.map((o, i) => (
            <div key={i} className="flex gap-1.5">
              <Input aria-label={`Option ${i + 1}`} maxLength={30} value={o.title} onChange={(e) => setOption(i, e.target.value)} />
              <button type="button" disabled={options.length <= 1} onClick={() => onChange({ options: options.filter((_, j) => j !== i) })} className="rounded p-2 text-slate-400 hover:text-red-600 disabled:opacity-30" aria-label={`Remove option ${i + 1}`}>
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
          {options.length < 20 && (
            <button
              type="button"
              onClick={() => onChange({ options: [...options, { id: uniqueKey(`option_${options.length + 1}`, new Set(options.map((o) => o.id))), title: `Option ${options.length + 1}` }] })}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
            >
              <Plus className="size-3" /> Add option
            </button>
          )}
        </div>
      )}

      {isInput && (
        <>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="accent-emerald-600" checked={!!c.required} onChange={(e) => onChange({ required: e.target.checked })} /> Required
          </label>
          <Prop label="Answer key" htmlFor="cp-key" hint={<>Column in submission data; use {'{{' + (c.key || 'key') + '}}'} in the reply.</>}>
            <Input id="cp-key" className="font-mono text-xs" value={c.key ?? ''} onChange={(e) => onChange({ key: slug(e.target.value) })} />
            {c.key && otherKeys.has(c.key) && <p className="text-xs text-red-600">Another element already uses this key.</p>}
          </Prop>
          {c.type !== 'opt_in' && (
            <Prop label="Save answer to contact" htmlFor="cp-save">
              <Select id="cp-save" value={c.saveTo?.startsWith('custom.') ? 'custom' : (c.saveTo ?? '')} onChange={(e) => onChange({ saveTo: e.target.value === 'custom' ? `custom.${c.key}` : e.target.value || null })}>
                <option value="">Don't save</option>
                <option value="name">Name</option>
                <option value="email">Email</option>
                <option value="custom">{c.saveTo?.startsWith('custom.') ? `Custom field (${c.saveTo.slice(7)})` : 'Custom field'}</option>
              </Select>
            </Prop>
          )}
        </>
      )}
    </div>
  );
}

function RawJsonEditor({ value, error, editable, onChange, onStartOver }: { value: string; error?: string; editable: boolean; onChange: (v: string) => void; onStartOver: () => void }) {
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="rounded-lg bg-slate-100 p-2 text-slate-600">
          <FileJson className="size-5" />
        </span>
        <div className="flex-1 text-sm">
          <p className="font-semibold text-ink">Flow JSON</p>
          <p className="text-slate-500">This form uses Flow features the visual builder can’t show (such as a data endpoint or dynamic screens). Edit the JSON directly; it is published to WhatsApp as-is.</p>
        </div>
      </div>
      <textarea
        aria-label="Flow JSON"
        value={value}
        readOnly={!editable}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        rows={24}
        className={cn('w-full rounded-lg border bg-slate-900 p-3 font-mono text-xs leading-relaxed text-emerald-100 focus:outline-none', error ? 'border-red-400' : 'border-slate-700')}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      {editable && (
        <button type="button" onClick={onStartOver} className="text-xs font-medium text-slate-500 hover:text-red-600 hover:underline">
          Start over in the visual builder
        </button>
      )}
    </div>
  );
}

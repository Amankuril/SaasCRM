import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, BookOpen, FlaskConical, Globe, MessageSquareText, RefreshCw, Send, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, cn, errorMessage, fieldError } from '../components/ui';
import { ApiError, api, type AgentDecision, type AiSettings, type KnowledgeSource } from '../lib/api';
import { formatDate } from '../lib/options';
import { useWorkspace } from '../layouts/workspaceContext';

const textarea =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/40 focus:outline-none disabled:bg-slate-100';

type Tab = 'settings' | 'knowledge' | 'test';

export function AiAgentPage() {
  const { workspace, can } = useWorkspace();
  const [tab, setTab] = useState<Tab>('settings');
  const query = useQuery({
    queryKey: ['ai-settings', workspace.id],
    queryFn: () => api.get<{ settings: AiSettings; provider: string }>(`/workspaces/${workspace.id}/ai/settings`),
  });
  const usage = useQuery({
    queryKey: ['ai-usage', workspace.id],
    queryFn: () => api.get<{ total: number; byOutcome: Record<string, number>; inputTokens: number; outputTokens: number }>(`/workspaces/${workspace.id}/ai/usage`),
    enabled: can('ai:manage'),
  });

  if (query.isPending) return <Spinner />;
  if (query.error) return <Alert>{errorMessage(query.error)}</Alert>;
  const { settings, provider } = query.data;
  const u = usage.data;

  return (
    <>
      <PageHeader
        title="AI Agent"
        description="Answers customer questions from your knowledge base and hands off to the team when it isn't sure."
        actions={settings.enabled ? <Badge tone="green">{settings.autoReply ? 'On · auto-replying' : 'On · drafts & flows only'}</Badge> : <Badge>Off</Badge>}
      />
      {provider === 'sandbox' && (
        <div className="mb-4">
          <Alert tone="info">
            <strong>Sandbox AI.</strong> The server uses a simulated model that replies with the best matching knowledge snippet. Set <code>AI_PROVIDER=anthropic</code> to use Claude.
          </Alert>
        </div>
      )}

      {u && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="AI calls (30d)" value={u.total} />
          <Stat label="Answered" value={u.byOutcome.answered ?? 0} />
          <Stat label="Handed off" value={(u.byOutcome.handoff ?? 0) + (u.byOutcome.escalated ?? 0) + (u.byOutcome.capped ?? 0)} />
          <Stat label="Errors" value={u.byOutcome.error ?? 0} />
          <Stat label="Tokens in / out" value={`${(u.inputTokens / 1000).toFixed(1)}k / ${(u.outputTokens / 1000).toFixed(1)}k`} />
        </div>
      )}

      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {(
          [
            ['settings', 'Settings', Bot],
            ['knowledge', 'Knowledge', BookOpen],
            ['test', 'Test chat', FlaskConical],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn('-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium', tab === id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}
          >
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'settings' && <SettingsTab settings={settings} provider={provider} />}
      {tab === 'knowledge' && <KnowledgeTab />}
      {tab === 'test' && <TestTab />}
    </>
  );
}

function SettingsTab({ settings, provider }: { settings: AiSettings; provider: string }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const editable = can('ai:manage') && workspace.status !== 'suspended';
  const [form, setForm] = useState(settings);
  const [keywords, setKeywords] = useState(settings.escalationKeywords.join(', '));
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setForm(settings);
    setKeywords(settings.escalationKeywords.join(', '));
  }, [settings]);
  const set = (patch: Partial<AiSettings>) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: (extra: { apiKey?: string | null } = {}) =>
      api.put<{ settings: AiSettings }>(`/workspaces/${workspace.id}/ai/settings`, {
        enabled: form.enabled,
        autoReply: form.autoReply,
        name: form.name,
        tone: form.tone,
        language: form.language,
        businessContext: form.businessContext,
        instructions: form.instructions,
        fallbackMessage: form.fallbackMessage,
        handoffMessage: form.handoffMessage,
        escalationKeywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
        maxRepliesPerConversation: form.maxRepliesPerConversation,
        model: form.model,
        ...extra,
      }),
    onSuccess: ({ settings: s }) => {
      setApiKey('');
      setSaved(true);
      queryClient.setQueryData(['ai-settings', workspace.id], (old: { provider: string } | undefined) => ({ provider: old?.provider ?? provider, settings: s }));
    },
  });
  const err = save.error;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    save.mutate(apiKey ? { apiKey } : {});
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-6 lg:grid-cols-3" noValidate>
      <fieldset disabled={!editable} className="space-y-6 lg:col-span-2">
        {err != null && !(err instanceof ApiError && err.code === 'VALIDATION_ERROR') && <Alert>{errorMessage(err)}</Alert>}
        {saved && <Alert tone="success">AI settings saved.</Alert>}

        <Card className="space-y-4 p-5">
          <Toggle label="Turn on the AI agent" description="Lets flows and the inbox use AI answers." checked={form.enabled} onChange={(enabled) => set({ enabled })} />
          <Toggle
            label="Auto-reply to customers"
            description="Answers messages that no flow handles. Off = AI only suggests replies in the inbox and runs inside flows."
            checked={form.autoReply}
            disabled={!form.enabled}
            onChange={(autoReply) => set({ autoReply })}
          />
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-ink">Personality</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Assistant name" htmlFor="ai-name">
              <Input id="ai-name" value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Tone" htmlFor="ai-tone">
              <Select id="ai-tone" value={form.tone} onChange={(e) => set({ tone: e.target.value as AiSettings['tone'] })}>
                <option value="friendly">Friendly</option>
                <option value="professional">Professional</option>
                <option value="concise">Concise</option>
              </Select>
            </Field>
            <Field label="Language" htmlFor="ai-lang" hint='"auto" replies in the customer’s language.'>
              <Input id="ai-lang" value={form.language} onChange={(e) => set({ language: e.target.value })} />
            </Field>
          </div>
          <Field label="About your business" htmlFor="ai-ctx" hint="What you do, where you are, hours, policies. The AI can use this to answer.">
            <textarea id="ai-ctx" rows={4} className={textarea} value={form.businessContext} onChange={(e) => set({ businessContext: e.target.value })} />
          </Field>
          <Field label="Extra instructions" htmlFor="ai-ins" hint="e.g. Always suggest booking via the form. Never discuss competitor prices.">
            <textarea id="ai-ins" rows={3} className={textarea} value={form.instructions} onChange={(e) => set({ instructions: e.target.value })} />
          </Field>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-ink">Handoff to humans</h2>
          <Field label="Message when handing off" htmlFor="ai-ho">
            <Input id="ai-ho" value={form.handoffMessage} onChange={(e) => set({ handoffMessage: e.target.value })} />
          </Field>
          <Field label="Message if the AI is unavailable" htmlFor="ai-fb">
            <Input id="ai-fb" value={form.fallbackMessage} onChange={(e) => set({ fallbackMessage: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Escalation words" htmlFor="ai-kw" hint="Comma separated. These go straight to a human.">
              <Input id="ai-kw" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
            </Field>
            <Field label="Max auto-replies per conversation" htmlFor="ai-max">
              <Input id="ai-max" type="number" min={1} max={50} value={form.maxRepliesPerConversation} onChange={(e) => set({ maxRepliesPerConversation: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} />
            </Field>
          </div>
        </Card>
      </fieldset>

      <fieldset disabled={!editable} className="space-y-6">
        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-ink">Model &amp; API key</h2>
          <Field label="Claude model" htmlFor="ai-model" hint="Opus is the most capable; Sonnet and Haiku are faster and cheaper.">
            <Select id="ai-model" value={form.model} onChange={(e) => set({ model: e.target.value as AiSettings['model'] })}>
              <option value="claude-opus-5-5">Claude Opus 5.5</option>
              <option value="claude-sonnet-5-5">Claude Sonnet 5.5</option>
              <option value="claude-haiku-5-5">Claude Haiku 5.5</option>
            </Select>
          </Field>
          <div className="space-y-1.5 text-sm">
            <p className="font-medium text-slate-700">Anthropic API key</p>
            <p className="text-slate-600">
              {form.apiKey?.source === 'workspace'
                ? `Your key ending in …${form.apiKey.last4} is in use.`
                : form.apiKey?.source === 'platform'
                  ? 'Using the platform key.'
                  : provider === 'sandbox'
                    ? 'Not needed in sandbox mode.'
                    : 'No key yet. Add one to turn the AI on.'}
            </p>
            <Input aria-label="New API key" type="password" autoComplete="off" placeholder="sk-ant-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            {fieldError(err, 'apiKey') && <p className="text-xs text-red-600">{fieldError(err, 'apiKey')}</p>}
            <p className="text-xs text-slate-500">Stored encrypted and never shown again. Usage is billed to this key.</p>
            {form.apiKey?.source === 'workspace' && (
              <button type="button" className="text-xs font-medium text-red-600 hover:underline" onClick={() => save.mutate({ apiKey: null })}>
                Remove my key
              </button>
            )}
          </div>
        </Card>
        {editable && (
          <Button type="submit" className="w-full" loading={save.isPending}>
            Save settings
          </Button>
        )}
      </fieldset>
    </form>
  );
}

function KnowledgeTab() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const editable = can('ai:manage') && workspace.status !== 'suspended';
  const [kind, setKind] = useState<'faq' | 'text' | 'url'>('faq');
  const [form, setForm] = useState({ question: '', answer: '', title: '', content: '', url: '' });
  const list = useQuery({
    queryKey: ['ai-knowledge', workspace.id],
    queryFn: () => api.get<{ sources: KnowledgeSource[] }>(`/workspaces/${workspace.id}/ai/knowledge`),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['ai-knowledge', workspace.id] });
  const add = useMutation({
    mutationFn: () =>
      api.post(
        `/workspaces/${workspace.id}/ai/knowledge`,
        kind === 'faq' ? { type: 'faq', question: form.question, answer: form.answer } : kind === 'text' ? { type: 'text', title: form.title, content: form.content } : { type: 'url', url: form.url },
      ),
    onSuccess: () => {
      setForm({ question: '', answer: '', title: '', content: '', url: '' });
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/workspaces/${workspace.id}/ai/knowledge/${id}`), onSuccess: refresh });
  const reload = useMutation({ mutationFn: (id: string) => api.post(`/workspaces/${workspace.id}/ai/knowledge/${id}/refresh`), onSuccess: refresh });
  const err = add.error;

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      {editable && (
        <Card className="space-y-4 p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold text-ink">Add knowledge</h2>
          <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm">
            {(
              [
                ['faq', 'Q & A'],
                ['text', 'Text'],
                ['url', 'Web page'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setKind(k)} className={cn('flex-1 rounded-md px-2 py-1.5 font-medium', kind === k ? 'bg-white shadow-sm' : 'text-slate-500')}>
                {l}
              </button>
            ))}
          </div>
          {err != null && !(err instanceof ApiError && err.code === 'VALIDATION_ERROR') && <Alert>{errorMessage(err)}</Alert>}
          {kind === 'faq' && (
            <>
              <Field label="Question" htmlFor="kq" error={fieldError(err, 'question')}>
                <Input id="kq" value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} placeholder="What are your timings?" />
              </Field>
              <Field label="Answer" htmlFor="ka" error={fieldError(err, 'answer')}>
                <textarea id="ka" rows={3} className={textarea} value={form.answer} onChange={(e) => setForm({ ...form, answer: e.target.value })} />
              </Field>
            </>
          )}
          {kind === 'text' && (
            <>
              <Field label="Title" htmlFor="kt" error={fieldError(err, 'title')}>
                <Input id="kt" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Price list, policies, services…" />
              </Field>
              <Field label="Content" htmlFor="kc" error={fieldError(err, 'content')}>
                <textarea id="kc" rows={8} className={textarea} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
              </Field>
            </>
          )}
          {kind === 'url' && (
            <Field label="Page URL" htmlFor="ku" error={fieldError(err, 'url')} hint="Public https:// pages only. We read the text once; use refresh to update.">
              <Input id="ku" type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://yourbusiness.com/faq" />
            </Field>
          )}
          <Button loading={add.isPending} onClick={() => add.mutate()}>
            Add to knowledge
          </Button>
        </Card>
      )}

      <Card className={editable ? 'lg:col-span-3' : 'lg:col-span-5'}>
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <Alert>{errorMessage(list.error)}</Alert>
          </div>
        ) : list.data.sources.length === 0 ? (
          <EmptyState icon={<BookOpen className="size-5" />} title="No knowledge yet">
            Add FAQs, policies or your website. The AI only answers from what's here and your business description.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data.sources.map((s) => (
              <li key={s.id} className="flex gap-3 px-4 py-3 text-sm">
                <span className="mt-0.5 text-slate-400">{s.type === 'url' ? <Globe className="size-4" /> : s.type === 'faq' ? <MessageSquareText className="size-4" /> : <BookOpen className="size-4" />}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-slate-800">{s.title}</p>
                  {s.status === 'failed' ? <p className="text-xs text-red-600">{s.error}</p> : <p className="line-clamp-2 text-xs text-slate-500">{s.preview}</p>}
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {s.chunkCount} chunk(s){s.lastIngestedAt && ` · updated ${formatDate(s.lastIngestedAt, true)}`}
                  </p>
                </div>
                {editable && (
                  <div className="flex shrink-0 items-start gap-1">
                    {s.type === 'url' && (
                      <button onClick={() => reload.mutate(s.id)} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Refresh page">
                        <RefreshCw className="size-4" />
                      </button>
                    )}
                    <button onClick={() => window.confirm(`Delete "${s.title}"?`) && remove.mutate(s.id)} className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Delete">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function TestTab() {
  const { workspace, can } = useWorkspace();
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<{ q: string; d: AgentDecision }[]>([]);
  const test = useMutation({
    mutationFn: (q: string) => api.post<{ decision: AgentDecision }>(`/workspaces/${workspace.id}/ai/test`, { question: q }),
    onSuccess: ({ decision }, q) => {
      setHistory((h) => [...h, { q, d: decision }]);
      setQuestion('');
    },
  });

  if (!can('ai:manage')) return <Alert tone="info">Only owners and admins can test the AI agent.</Alert>;
  return (
    <Card className="mx-auto max-w-2xl">
      <div className="max-h-[28rem] space-y-3 overflow-y-auto bg-slate-50 p-4">
        {history.length === 0 && <p className="py-8 text-center text-sm text-slate-500">Ask something a customer would ask. Nothing is sent to anyone.</p>}
        {history.map(({ q, d }, i) => (
          <div key={i} className="space-y-1.5">
            <div className="flex justify-end">
              <p className="max-w-[80%] rounded-xl rounded-tr-sm bg-white px-3 py-2 text-sm shadow-sm">{q}</p>
            </div>
            <div className="flex justify-start">
              <div className={cn('max-w-[80%] rounded-xl rounded-tl-sm px-3 py-2 text-sm shadow-sm', d.outcome === 'answered' ? 'bg-emerald-100' : 'border border-amber-200 bg-amber-50')}>
                {d.outcome === 'answered' ? <p className="whitespace-pre-wrap">{d.answer}</p> : <p className="font-medium text-amber-800">Would hand off to a teammate</p>}
                <p className="mt-1 text-[11px] text-slate-500">{d.reason}</p>
                {d.sources.length > 0 && <p className="mt-0.5 text-[11px] text-slate-500">Sources: {d.sources.map((s) => s.title).join(', ')}</p>}
              </div>
            </div>
          </div>
        ))}
      </div>
      <form
        className="flex gap-2 border-t border-slate-200 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim()) test.mutate(question.trim());
        }}
      >
        <Input aria-label="Test question" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Do you have parking?" />
        <Button type="submit" loading={test.isPending}>
          <Send className="size-4" />
        </Button>
      </form>
      {test.error != null && (
        <div className="px-3 pb-3">
          <Alert>{errorMessage(test.error)}</Alert>
        </div>
      )}
    </Card>
  );
}

function Toggle({ label, description, checked, disabled, onChange }: { label: string; description: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={cn('flex items-start gap-3', disabled && 'opacity-50')}>
      <input type="checkbox" className="mt-1 size-4 accent-emerald-600" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        <span className="block text-xs text-slate-500">{description}</span>
      </span>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
    </div>
  );
}

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, Check, CheckCheck, Clock, Inbox, Lock, MessageSquare, RotateCcw, Search, StickyNote } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ContactDetails } from '../components/ContactDetails';
import { TemplatePreview } from '../components/TemplatePreview';
import { initials, relativeTime, TagChip } from '../components/crm';
import { Alert, Badge, Button, EmptyState, Input, Select, Spinner, cn, errorMessage } from '../components/ui';
import { api, type AgentDecision, type Contact, type ConversationStatus, type ConversationSummary, type MessageTemplate, type TimelineItem } from '../lib/api';
import { useMembers, useTags } from '../lib/hooks';
import { useAuth } from '../auth/AuthContext';
import { useWorkspace } from '../layouts/workspaceContext';

type View = 'all' | 'mine' | 'unassigned';

export function InboxPage() {
  const { workspace } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const selected = params.get('c');
  const [view, setView] = useState<View>('all');
  const [status, setStatus] = useState<ConversationStatus | 'all'>('open');
  const [q, setQ] = useState('');

  const select = (id: string | null) => setParams(id ? { c: id } : {}, { replace: true });

  return (
    <div className="flex h-full min-h-0">
      <section className={cn('flex w-full flex-col border-r border-slate-200 bg-white md:w-80 md:shrink-0', selected && 'hidden md:flex')}>
        <ConversationList view={view} setView={setView} status={status} setStatus={setStatus} q={q} setQ={setQ} selected={selected} onSelect={select} />
      </section>
      <section className={cn('min-w-0 flex-1 flex-col', selected ? 'flex' : 'hidden md:flex')}>
        {selected ? (
          <ConversationPanel key={selected} id={selected} onBack={() => select(null)} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState icon={<Inbox className="size-5" />} title="Select a conversation">
              Customer messages to {workspace.name}&apos;s WhatsApp number appear here in real time.
            </EmptyState>
          </div>
        )}
      </section>
    </div>
  );
}

function ConversationList({
  view,
  setView,
  status,
  setStatus,
  q,
  setQ,
  selected,
  onSelect,
}: {
  view: View;
  setView: (v: View) => void;
  status: ConversationStatus | 'all';
  setStatus: (s: ConversationStatus | 'all') => void;
  q: string;
  setQ: (q: string) => void;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { workspace } = useWorkspace();
  const counts = useQuery({
    queryKey: ['conversation-counts', workspace.id],
    queryFn: () => api.get<Record<View, number>>(`/workspaces/${workspace.id}/conversations/counts`),
  });
  const list = useInfiniteQuery({
    queryKey: ['conversations', workspace.id, { view, status, q }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ view, status });
      if (q.trim()) params.set('q', q.trim());
      if (pageParam) params.set('before', pageParam);
      return api.get<{ conversations: ConversationSummary[]; nextBefore: string | null }>(`/workspaces/${workspace.id}/conversations?${params}`);
    },
    getNextPageParam: (last) => last.nextBefore,
  });
  const conversations = list.data?.pages.flatMap((p) => p.conversations) ?? [];

  return (
    <>
      <div className="space-y-3 border-b border-slate-200 p-3">
        <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm">
          {(['all', 'mine', 'unassigned'] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn('flex-1 rounded-md px-2 py-1.5 font-medium capitalize', view === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700')}
            >
              {v}
              {counts.data && counts.data[v] > 0 && <span className="ml-1 text-xs text-slate-400">{counts.data[v]}</span>}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-400" />
            <Input aria-label="Search conversations" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <div className="w-28">
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as ConversationStatus | 'all')}>
              <option value="open">Open</option>
              <option value="pending">Pending</option>
              <option value="resolved">Resolved</option>
              <option value="all">All</option>
            </Select>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-3">
            <Alert>{errorMessage(list.error)}</Alert>
          </div>
        ) : conversations.length === 0 ? (
          <EmptyState icon={<MessageSquare className="size-5" />} title="No conversations here" />
        ) : (
          <ul>
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => onSelect(c.id)}
                  className={cn('flex w-full gap-3 border-b border-slate-100 px-3 py-3 text-left hover:bg-slate-50', selected === c.id && 'bg-brand-50/70 hover:bg-brand-50')}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600">
                    {initials(c.contact?.name ?? '?')}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={cn('truncate text-sm', c.unreadCount ? 'font-semibold text-slate-900' : 'font-medium text-slate-800')}>{c.contact?.name}</span>
                      <span className="shrink-0 text-xs text-slate-400">{relativeTime(c.lastMessageAt)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-2">
                      <span className={cn('truncate text-sm', c.unreadCount ? 'text-slate-700' : 'text-slate-500')}>
                        {c.lastMessageDirection === 'outbound' && <span className="text-slate-400">You: </span>}
                        {c.lastMessagePreview}
                      </span>
                      {c.unreadCount > 0 && (
                        <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold text-white">{c.unreadCount}</span>
                      )}
                    </span>
                    <span className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                      {c.assignee ? <span className="truncate">→ {c.assignee.name}</span> : <span className="text-amber-600">Unassigned</span>}
                      {c.priority === 'high' && <span className="font-medium text-red-600">High</span>}
                      {c.status !== 'open' && <span className="capitalize">{c.status}</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <div className="p-3 text-center">
            <Button variant="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

interface ConversationDetail {
  conversation: ConversationSummary;
  contact: Contact | null;
  canReply: boolean;
}

function ConversationPanel({ id, onBack }: { id: string; onBack: () => void }) {
  const { workspace, can } = useWorkspace();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const tags = useTags(workspace.id);
  const canAssignOthers = can('conversations:assign');
  const members = useMembers(workspace.id, canAssignOthers);

  const detail = useQuery({
    queryKey: ['conversation', workspace.id, id],
    queryFn: () => api.get<ConversationDetail>(`/workspaces/${workspace.id}/conversations/${id}`),
  });
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/workspaces/${workspace.id}/conversations/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', workspace.id, id] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['conversation-counts', workspace.id] });
    },
  });

  // Opening an unread conversation marks it read.
  const unread = detail.data?.conversation.unreadCount ?? 0;
  useEffect(() => {
    if (unread > 0) {
      void api.post(`/workspaces/${workspace.id}/conversations/${id}/read`).then(() => {
        void queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] });
        void queryClient.invalidateQueries({ queryKey: ['conversation', workspace.id, id] });
      });
    }
  }, [unread, id, workspace.id, queryClient]);

  if (detail.isPending) return <Spinner />;
  if (detail.error) {
    return (
      <div className="p-6">
        <Alert>{errorMessage(detail.error)}</Alert>
      </div>
    );
  }

  const { conversation: conv, contact, canReply } = detail.data;
  const mine = conv.assignee?.id === user?.id;
  const tagById = new Map((tags.data ?? []).map((t) => [t.id, t]));
  const writable = workspace.status !== 'suspended' && canReply;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col bg-slate-50">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-white px-4 py-3">
          <button onClick={onBack} className="rounded-md p-1 text-slate-500 hover:bg-slate-100 md:hidden" aria-label="Back to conversations">
            <ArrowLeft className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-ink">{conv.contact?.name}</p>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              <span>{conv.contact?.phone}</span>
              {conv.contact?.tags.slice(0, 3).map((t) => {
                const tag = tagById.get(t);
                return tag ? <TagChip key={t} tag={tag} /> : null;
              })}
            </div>
          </div>

          {conv.botPaused && (
            <span className="flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800" title="A flow handed this chat to the team; automations are paused">
              Bot paused
              {writable && (
                <button className="underline" onClick={() => update.mutate({ botPaused: false })}>
                  Resume
                </button>
              )}
            </span>
          )}
          {canAssignOthers && members.data ? (
            <div className="w-40">
              <Select aria-label="Assignee" value={conv.assignee?.id ?? ''} disabled={!writable || update.isPending} onChange={(e) => update.mutate({ assigneeId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {members.data
                  .filter((m) => m.role !== 'analyst')
                  .map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
              </Select>
            </div>
          ) : writable && !conv.assignee ? (
            <Button variant="secondary" loading={update.isPending} onClick={() => update.mutate({ assigneeId: user!.id })}>
              Assign to me
            </Button>
          ) : writable && mine ? (
            <Button variant="ghost" loading={update.isPending} onClick={() => update.mutate({ assigneeId: null })}>
              Unassign me
            </Button>
          ) : (
            conv.assignee && <Badge>{conv.assignee.name}</Badge>
          )}

          {writable && (
            <div className="flex gap-1.5">
              <Button
                variant="ghost"
                className={conv.priority === 'high' ? 'text-red-600' : ''}
                onClick={() => update.mutate({ priority: conv.priority === 'high' ? 'normal' : 'high' })}
                title="Toggle high priority"
              >
                <AlertCircle className="size-4" />
              </Button>
              {conv.status === 'resolved' ? (
                <Button variant="secondary" onClick={() => update.mutate({ status: 'open' })}>
                  <RotateCcw className="size-4" /> Reopen
                </Button>
              ) : (
                <>
                  {conv.status !== 'pending' && (
                    <Button variant="secondary" onClick={() => update.mutate({ status: 'pending' })} title="Waiting on the customer">
                      <Clock className="size-4" /> Pending
                    </Button>
                  )}
                  <Button onClick={() => update.mutate({ status: 'resolved' })}>
                    <Check className="size-4" /> Resolve
                  </Button>
                </>
              )}
            </div>
          )}
        </header>
        {update.error != null && (
          <div className="px-4 pt-3">
            <Alert>{errorMessage(update.error)}</Alert>
          </div>
        )}

        <Timeline id={id} />
        {writable ? (
          <Composer id={id} windowOpen={conv.serviceWindowOpen} />
        ) : (
          <div className="flex items-center gap-2 border-t border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
            <Lock className="size-4" />
            {workspace.status === 'suspended' ? 'This workspace is suspended.' : canReply ? '' : 'Read-only: you can view this conversation but not reply.'}
          </div>
        )}
      </div>

      {contact && (
        <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-slate-200 bg-white p-4 xl:block" aria-label="Contact">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Contact</h3>
            <Link to={`/w/${workspace.id}/contacts`} className="text-xs text-brand-700 hover:underline">
              All contacts
            </Link>
          </div>
          <ContactDetails contact={contact} compact />
        </aside>
      )}
    </div>
  );
}

function Timeline({ id }: { id: string }) {
  const { workspace } = useWorkspace();
  const bottom = useRef<HTMLDivElement>(null);
  const query = useInfiniteQuery({
    queryKey: ['timeline', workspace.id, id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<{ items: TimelineItem[]; nextBefore: string | null }>(
        `/workspaces/${workspace.id}/conversations/${id}/timeline${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextBefore,
  });
  // Pages arrive newest-first; each page is already oldest-to-newest.
  const items = useMemo(() => [...(query.data?.pages ?? [])].reverse().flatMap((p) => p.items), [query.data]);
  const lastId = items.at(-1)?.id;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [lastId]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      {query.hasNextPage && (
        <div className="mb-3 text-center">
          <Button variant="ghost" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            Load earlier messages
          </Button>
        </div>
      )}
      {query.isPending ? (
        <Spinner />
      ) : query.error ? (
        <Alert>{errorMessage(query.error)}</Alert>
      ) : (
        <ol className="space-y-2">
          {items.map((item) => (
            <li key={item.id}>{item.kind === 'note' ? <NoteBubble item={item} /> : <MessageBubble item={item} />}</li>
          ))}
        </ol>
      )}
      <div ref={bottom} />
    </div>
  );
}

function MessageBubble({ item }: { item: Extract<TimelineItem, { kind: 'message' }> }) {
  const out = item.direction === 'outbound';
  const c = item.content as { text?: string; preview?: string; caption?: string; title?: string; template?: { name: string } };
  const isFormReply = item.type === 'interactive' && item.content.interactiveType === 'nfm_reply';
  const body = item.type === 'template' ? c.preview : isFormReply ? '📝 Form submitted' : (c.text ?? c.caption ?? c.title ?? `[${item.type} message]`);
  const time = new Date(item.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={cn('flex', out ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[75%] rounded-xl px-3 py-2 text-sm shadow-sm', out ? 'rounded-tr-sm bg-emerald-100 text-slate-900' : 'rounded-tl-sm bg-white text-slate-800')}>
        {item.type === 'template' && <p className="mb-0.5 text-[11px] font-medium text-emerald-800">Template · {c.template?.name}</p>}
        <p className="whitespace-pre-wrap break-words">{body}</p>
        {item.type === 'buttons' && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {((item.content.buttons as { id: string; title: string }[]) ?? []).map((b) => (
              <span key={b.id} className="rounded-md border border-emerald-300 bg-white/70 px-2 py-0.5 text-xs text-sky-700">
                {b.title}
              </span>
            ))}
          </div>
        )}
        {item.type === 'flow' && (
          <span className="mt-1.5 inline-block rounded-md border border-emerald-300 bg-white/70 px-2 py-0.5 text-xs text-sky-700">
            📝 {String(item.content.formName ?? 'Form')} · {String(item.content.ctaText ?? 'Open form')}
          </span>
        )}
        {item.type === 'cta_url' && (
          <a href={String(item.content.url)} target="_blank" rel="noreferrer" className="mt-1.5 inline-block rounded-md border border-emerald-300 bg-white/70 px-2 py-0.5 text-xs text-sky-700">
            {String(item.content.buttonText)} ↗
          </a>
        )}
        <p className="mt-1 flex items-center justify-end gap-1 text-[11px] text-slate-500">
          {out && item.sentBy && <span>{item.sentBy} ·</span>}
          {time}
          {out && <StatusTick status={item.status} />}
        </p>
        {item.error && (
          <p className="mt-1 text-xs text-red-600">
            {item.error.title}: {item.error.message}
          </p>
        )}
      </div>
    </div>
  );
}

function StatusTick({ status }: { status: string }) {
  if (status === 'failed') return <AlertCircle className="size-3.5 text-red-600" aria-label="Failed" />;
  if (status === 'read') return <CheckCheck className="size-3.5 text-sky-600" aria-label="Read" />;
  if (status === 'delivered') return <CheckCheck className="size-3.5" aria-label="Delivered" />;
  if (status === 'sent') return <Check className="size-3.5" aria-label="Sent" />;
  return <Clock className="size-3" aria-label="Sending" />;
}

function NoteBubble({ item }: { item: Extract<TimelineItem, { kind: 'note' }> }) {
  return (
    <div className="mx-auto max-w-[85%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <p className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-amber-700">
        <StickyNote className="size-3" /> Internal note · {item.author} · {new Date(item.createdAt).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}
      </p>
      <p className="whitespace-pre-wrap break-words">{item.body}</p>
    </div>
  );
}

function Composer({ id, windowOpen }: { id: string; windowOpen: boolean }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [headerParams, setHeaderParams] = useState<string[]>([]);
  const [bodyParams, setBodyParams] = useState<string[]>([]);
  const useTemplate = mode === 'reply' && !windowOpen;
  const [suggestion, setSuggestion] = useState<AgentDecision | null>(null);
  const suggest = useMutation({
    mutationFn: () => api.post<{ draft: AgentDecision }>(`/workspaces/${workspace.id}/conversations/${id}/ai-draft`),
    onSuccess: ({ draft }) => {
      setSuggestion(draft);
      if (draft.outcome === 'answered') setText(draft.answer);
    },
  });

  const templates = useQuery({
    queryKey: ['templates', workspace.id, 'APPROVED'],
    queryFn: () => api.get<{ templates: MessageTemplate[] }>(`/workspaces/${workspace.id}/templates?status=APPROVED`),
    enabled: useTemplate,
  });
  const template = templates.data?.templates.find((t) => t.id === templateId);

  const send = useMutation({
    mutationFn: () => {
      const base = `/workspaces/${workspace.id}/conversations/${id}`;
      if (mode === 'note') return api.post(`${base}/notes`, { body: text });
      return api.post(`${base}/messages`, useTemplate ? { type: 'template', templateId, headerParams, bodyParams } : { type: 'text', text });
    },
    onSuccess: () => {
      setText('');
      setSuggestion(null);
      setTemplateId('');
      void queryClient.invalidateQueries({ queryKey: ['timeline', workspace.id, id] });
      void queryClient.invalidateQueries({ queryKey: ['conversation', workspace.id, id] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] });
    },
  });

  const submit = () => {
    if (useTemplate ? templateId : text.trim()) send.mutate();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-1 text-sm">
        {(['reply', 'note'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              'rounded-md px-2.5 py-1 font-medium',
              mode === m ? (m === 'note' ? 'bg-amber-100 text-amber-800' : 'bg-brand-50 text-brand-700') : 'text-slate-500 hover:bg-slate-100',
            )}
          >
            {m === 'reply' ? 'Reply' : 'Internal note'}
          </button>
        ))}
        {mode === 'reply' && !windowOpen && <span className="ml-auto text-xs text-amber-700">24-hour window closed: send an approved template</span>}
        {mode === 'reply' && windowOpen && (
          <button onClick={() => suggest.mutate()} disabled={suggest.isPending} className="ml-auto rounded-md px-2.5 py-1 text-xs font-medium text-fuchsia-700 hover:bg-fuchsia-50 disabled:opacity-60">
            {suggest.isPending ? 'Thinking…' : '✨ Suggest reply'}
          </button>
        )}
      </div>
      {suggest.error != null && (
        <div className="mb-2">
          <Alert>{errorMessage(suggest.error)}</Alert>
        </div>
      )}
      {suggestion && (
        <p className={cn('mb-2 rounded-md px-2.5 py-1.5 text-xs', suggestion.outcome === 'answered' ? 'bg-fuchsia-50 text-fuchsia-800' : 'bg-amber-50 text-amber-800')}>
          {suggestion.outcome === 'answered'
            ? `AI draft added below. Review before sending.${suggestion.sources.length ? ` Sources: ${suggestion.sources.map((s) => s.title).join(', ')}` : ''}`
            : `The AI suggests a human answer this: ${suggestion.reason}`}
        </p>
      )}
      {send.error != null && (
        <div className="mb-2">
          <Alert>{errorMessage(send.error)}</Alert>
        </div>
      )}

      {useTemplate ? (
        <div className="space-y-3">
          <Select aria-label="Template" value={templateId} onChange={(e) => {
            const t = templates.data?.templates.find((x) => x.id === e.target.value);
            setTemplateId(e.target.value);
            setHeaderParams(Array(t?.variables.header ?? 0).fill(''));
            setBodyParams(Array(t?.variables.body ?? 0).fill(''));
          }}>
            <option value="">{templates.data?.templates.length === 0 ? 'No approved templates' : 'Choose an approved template'}</option>
            {templates.data?.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.language})
              </option>
            ))}
          </Select>
          {template && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                {headerParams.map((v, i) => (
                  <Input key={`h${i}`} aria-label={`Header {{${i + 1}}}`} placeholder={`Header {{${i + 1}}}`} value={v} onChange={(e) => setHeaderParams(headerParams.map((x, j) => (j === i ? e.target.value : x)))} />
                ))}
                {bodyParams.map((v, i) => (
                  <Input key={`b${i}`} aria-label={`Body {{${i + 1}}}`} placeholder={`Body {{${i + 1}}}`} value={v} onChange={(e) => setBodyParams(bodyParams.map((x, j) => (j === i ? e.target.value : x)))} />
                ))}
              </div>
              <TemplatePreview components={template.components} headerParams={headerParams} bodyParams={bodyParams} />
            </div>
          )}
          <Button loading={send.isPending} disabled={!templateId} onClick={submit}>
            Send template
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <textarea
            aria-label={mode === 'note' ? 'Internal note' : 'Reply'}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={mode === 'note' ? 'Only your team sees this…' : 'Type a reply… (Enter to send, Shift+Enter for a new line)'}
            className={cn(
              'block min-h-[42px] w-full resize-y rounded-lg border px-3 py-2 text-sm shadow-sm focus:ring-2 focus:outline-none',
              mode === 'note' ? 'border-amber-300 bg-amber-50/50 focus:ring-amber-400/40' : 'border-slate-300 focus:border-brand-500 focus:ring-brand-500/40',
            )}
          />
          <Button loading={send.isPending} disabled={!text.trim()} onClick={submit} className={mode === 'note' ? 'bg-amber-600 hover:bg-amber-700' : ''}>
            {mode === 'note' ? 'Add note' : 'Send'}
          </Button>
        </div>
      )}
    </div>
  );
}

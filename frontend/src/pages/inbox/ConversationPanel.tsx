import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, AlertCircle, ArrowLeft, Check, CheckCheck, Clock, Hourglass, Lock, RotateCcw, Star, StickyNote, UserRound, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { ContactDetails } from '../../components/ContactDetails';
import { TemplatePreview } from '../../components/TemplatePreview';
import { ButtonValueInputs, TemplateExtrasFields, emptyExtras, extrasPreview } from '../../components/TemplateSendFields';
import { Modal, TagChip } from '../../components/crm';
import { Alert, Badge, Button, Field, Input, Select, Spinner, cn, errorMessage, fieldError } from '../../components/ui';
import { ApiError, api, type AgentDecision, type Contact, type ConversationSummary, type MessageTemplate, type TemplateExtras, type TimelineItem } from '../../lib/api';
import { useMembers, useTags } from '../../lib/hooks';
import { useAuth } from '../../auth/AuthContext';
import { useWorkspace } from '../../layouts/workspaceContext';
import { Popover } from '../audience/shared';
import { CannedRepliesDialog } from './ChatTools';
import { fillCanned, snoozeLabel, snoozeOptions, useCannedReplies, useTeam } from './shared';

/** Header shortcuts ask the composer to switch mode and take focus. */
const COMPOSE_EVENT = 'zc:compose';

interface ConversationDetail {
  conversation: ConversationSummary;
  contact: Contact | null;
  canReply: boolean;
}

/** "+" in the chat list: open a chat with any number (creates the contact if new). */
export function NewChatModal({ onClose, onStarted }: { onClose: () => void; onStarted: (conversationId: string) => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const start = useMutation({
    mutationFn: () => api.post<{ conversation: ConversationSummary }>(`/workspaces/${workspace.id}/conversations`, { phone, name: name.trim() || undefined }),
    onSuccess: ({ conversation }) => {
      void queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['conversation-counts', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['contacts', workspace.id] });
      onStarted(conversation.id);
    },
  });
  const err = start.error;
  return (
    <Modal title="New chat" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          start.mutate();
        }}
      >
        {err != null && !(err instanceof ApiError && err.code === 'VALIDATION_ERROR') && <Alert>{errorMessage(err)}</Alert>}
        <Field label="WhatsApp number" htmlFor="nc-phone" error={fieldError(err, 'phone')} hint={`With country code, e.g. +91 98765 43210. Numbers without one are read as ${workspace.country}.`}>
          <Input id="nc-phone" type="tel" autoFocus value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" />
        </Field>
        <Field label="Name (optional)" htmlFor="nc-name" error={fieldError(err, 'name')}>
          <Input id="nc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name" />
        </Field>
        <p className="text-xs text-slate-500">If this customer hasn&apos;t messaged you in the last 24 hours, WhatsApp only allows an approved template as the first message.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={start.isPending} disabled={phone.trim().length < 5}>
            Start chat
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ConversationPanel({ id, onBack }: { id: string; onBack: () => void }) {
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

  const star = useMutation({
    mutationFn: (starred: boolean) => api.post(`/workspaces/${workspace.id}/conversations/${id}/star`, { starred }),
    onSuccess: () => update.reset(),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', workspace.id, id] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['conversation-counts', workspace.id] });
    },
  });
  const [snoozeAnchor, setSnoozeAnchor] = useState<HTMLElement | null>(null);
  // Below very wide screens the contact panel is a drawer opened from the header.
  const [showContact, setShowContact] = useState(false);

  // Esc closes, e resolves, s stars, r / n start a reply or a note.
  const conversation = detail.data?.conversation;
  const writableNow = workspace.status !== 'suspended' && !!detail.data?.canReply;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]') || e.metaKey || e.ctrlKey || e.altKey || !conversation) return;
      if (e.key === 'Escape') onBack();
      else if (e.key === 's') star.mutate(!conversation.starred);
      else if (e.key === 'e' && writableNow && conversation.status !== 'resolved') update.mutate({ status: 'resolved' });
      else if ((e.key === 'r' || e.key === 'n') && writableNow) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: e.key === 'r' ? 'reply' : 'note' }));
      } else return;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [conversation, writableNow, onBack, star, update]);

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

          {contact && (
            <button type="button" onClick={() => setShowContact(true)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 2xl:hidden" aria-label="Contact details" title="Contact details">
              <UserRound className="size-4" />
            </button>
          )}
          <button
            type="button"
            onClick={() => star.mutate(!conv.starred)}
            className={cn('rounded-lg p-2 hover:bg-slate-100', conv.starred ? 'text-amber-400' : 'text-slate-400 hover:text-slate-600')}
            aria-label={conv.starred ? 'Unstar' : 'Star'}
            title={conv.starred ? 'Unstar (s)' : 'Star (s)'}
          >
            <Star className={cn('size-4', conv.starred && 'fill-amber-400')} />
          </button>
          {conv.awaitingHuman && (
            <span className="flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800" title={`Handed over by ${conv.handoffSource === 'ai' ? 'the AI agent' : 'a flow'}; no one has replied yet`}>
              <Hourglass className="size-3.5" /> Waiting for a person
            </span>
          )}
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
              {conv.status !== 'resolved' &&
                (conv.snoozedUntil ? (
                  <Button variant="secondary" onClick={() => update.mutate({ snoozedUntil: null })} title="Bring it back now">
                    <AlarmClock className="size-4 text-violet-600" /> {snoozeLabel(conv.snoozedUntil)}
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={(e) => setSnoozeAnchor(e.currentTarget)} title="Snooze: hide until later">
                    <AlarmClock className="size-4" />
                  </Button>
                ))}
              <Popover anchor={snoozeAnchor} open={!!snoozeAnchor} onClose={() => setSnoozeAnchor(null)} width={220} align="right">
                <div className="p-1 text-sm">
                  <p className="px-3 pt-2 pb-1 text-xs font-semibold text-slate-500">Snooze until</p>
                  {snoozeOptions().map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      className="block w-full rounded-md px-3 py-2 text-left hover:bg-slate-50"
                      onClick={() => {
                        setSnoozeAnchor(null);
                        update.mutate({ snoozedUntil: o.until.toISOString() });
                      }}
                    >
                      {o.label}
                    </button>
                  ))}
                  <p className="px-3 pt-1 pb-2 text-[11px] text-slate-400">A new customer message brings it back early.</p>
                </div>
              </Popover>
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
                  <Button onClick={() => update.mutate({ status: 'resolved' })} title="Resolve (e)">
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
          <Composer id={id} windowOpen={conv.serviceWindowOpen} contactName={conv.contact?.name} />
        ) : (
          <div className="flex items-center gap-2 border-t border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
            <Lock className="size-4" />
            {workspace.status === 'suspended' ? 'This workspace is suspended.' : canReply ? '' : 'Read-only: you can view this conversation but not reply.'}
          </div>
        )}
      </div>

      {contact && showContact && <div className="fixed inset-0 z-30 bg-slate-900/20 2xl:hidden" onClick={() => setShowContact(false)} />}
      {contact && (
        <aside
          className={cn(
            'w-80 shrink-0 overflow-y-auto border-l border-slate-200 bg-white p-4',
            showContact ? 'fixed inset-y-0 right-0 z-40 block shadow-2xl 2xl:static 2xl:shadow-none' : 'hidden 2xl:block',
          )}
          aria-label="Contact"
        >
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Contact</h3>
            <span className="flex items-center gap-2">
              <Link to={`/w/${workspace.id}/contacts`} className="text-xs text-brand-700 hover:underline">
                All contacts
              </Link>
              <button type="button" onClick={() => setShowContact(false)} className="rounded p-1 text-slate-400 hover:bg-slate-100 2xl:hidden" aria-label="Close contact details">
                <X className="size-4" />
              </button>
            </span>
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

/** "/" (reply) or "@" (note) right before the caret opens a picker. */
type Picker = { kind: 'canned' | 'mention'; query: string; start: number };

function Composer({ id, windowOpen, contactName }: { id: string; windowOpen: boolean; contactName?: string | null }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [managing, setManaging] = useState(false);
  // Display name -> user id of teammates @mentioned in the note being written.
  const [mentioned, setMentioned] = useState<Map<string, string>>(new Map());
  const canned = useCannedReplies();
  const team = useTeam();

  useEffect(() => {
    const onCompose = (e: Event) => {
      setMode((e as CustomEvent<'reply' | 'note'>).detail);
      setTimeout(() => box.current?.focus(), 0);
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, []);

  const options = useMemo(() => {
    if (!picker) return [];
    const q = picker.query.toLowerCase();
    if (picker.kind === 'canned') return (canned.data ?? []).filter((r) => r.shortcut.includes(q) || r.body.toLowerCase().includes(q)).slice(0, 8).map((r) => ({ id: r.id, label: `/${r.shortcut}`, detail: r.body, value: r.body }));
    return (team.data ?? []).filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)).slice(0, 8).map((m) => ({ id: m.id, label: m.name, detail: m.email, value: m.name }));
  }, [picker, canned.data, team.data]);

  const detectPicker = (value: string, caret: number) => {
    const m = /(^|\s)([/@])([\w.-]*)$/.exec(value.slice(0, caret));
    const kind = m?.[2] === '/' ? 'canned' : m?.[2] === '@' ? 'mention' : null;
    if (m && kind && (kind === 'canned' ? mode === 'reply' : mode === 'note')) {
      setPicker({ kind, query: m[3]!, start: caret - m[3]!.length - 1 });
      setHighlight(0);
    } else setPicker(null);
  };
  const choose = (o: { id: string; value: string }) => {
    if (!picker) return;
    const caret = box.current?.selectionStart ?? text.length;
    const insert = picker.kind === 'canned' ? fillCanned(o.value, contactName) : `@${o.value} `;
    const next = text.slice(0, picker.start) + insert + text.slice(caret);
    setText(next);
    if (picker.kind === 'canned') void api.post(`/workspaces/${workspace.id}/canned-replies/${o.id}/used`).catch(() => undefined);
    else setMentioned(new Map(mentioned).set(o.value, o.id));
    setPicker(null);
    setTimeout(() => {
      const pos = picker.start + insert.length;
      box.current?.focus();
      box.current?.setSelectionRange(pos, pos);
    }, 0);
  };
  const [templateId, setTemplateId] = useState('');
  const [headerParams, setHeaderParams] = useState<string[]>([]);
  const [bodyParams, setBodyParams] = useState<string[]>([]);
  const [buttonParams, setButtonParams] = useState<string[]>([]);
  const [extras, setExtras] = useState<TemplateExtras>({});
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
      if (mode === 'note') return api.post(`${base}/notes`, { body: text, mentions: [...mentioned].filter(([name]) => text.includes(`@${name}`)).map(([, uid]) => uid) });
      return api.post(`${base}/messages`, useTemplate ? { type: 'template', templateId, headerParams, bodyParams, buttonParams, extras } : { type: 'text', text });
    },
    onSuccess: () => {
      setText('');
      setMentioned(new Map());
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
    if (picker && options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        choose(options[highlight] ?? options[0]!);
        return;
      }
    }
    if (picker && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setPicker(null);
      return;
    }
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
            setButtonParams(Array(t?.requirements.buttons.length ?? 0).fill(''));
            setExtras(emptyExtras(t?.requirements));
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
                <ButtonValueInputs requirements={template.requirements} values={buttonParams} onChange={setButtonParams} error={send.error} />
                <TemplateExtrasFields requirements={template.requirements} value={extras} onChange={setExtras} error={send.error} />
              </div>
              <TemplatePreview components={template.components} headerParams={headerParams} bodyParams={bodyParams} {...extrasPreview(extras)} />
            </div>
          )}
          <Button loading={send.isPending} disabled={!templateId} onClick={submit}>
            Send template
          </Button>
        </div>
      ) : (
        <div className="relative flex items-end gap-2">
          {picker && (
            <div className="absolute right-0 bottom-full left-0 z-20 mb-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg" role="listbox" aria-label={picker.kind === 'canned' ? 'Canned replies' : 'Teammates'}>
              <div className="flex items-center justify-between border-b border-slate-100 px-3 py-1.5 text-xs text-slate-500">
                <span>{picker.kind === 'canned' ? 'Canned replies' : 'Mention a teammate'} · ↑↓ to move, Enter to insert</span>
                {picker.kind === 'canned' && (
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => (setPicker(null), setManaging(true))} className="font-medium text-brand-700 hover:underline">
                    Manage
                  </button>
                )}
              </div>
              {options.length === 0 ? (
                <p className="px-3 py-3 text-sm text-slate-500">{picker.kind === 'canned' ? (canned.data?.length ? 'No shortcut matches.' : 'No canned replies yet. Click Manage to add some.') : 'No teammate matches.'}</p>
              ) : (
                <ul className="max-h-60 overflow-y-auto py-1">
                  {options.map((o, i) => (
                    <li key={o.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === highlight}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setHighlight(i)}
                        onClick={() => choose(o)}
                        className={cn('flex w-full items-baseline gap-3 px-3 py-2 text-left text-sm', i === highlight && 'bg-slate-100')}
                      >
                        <span className={cn('shrink-0 font-medium', picker.kind === 'canned' ? 'font-mono text-amber-800' : 'text-ink')}>{o.label}</span>
                        <span className="truncate text-slate-500">{o.detail}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {mode === 'reply' && (
            <button
              type="button"
              title="Canned replies (type /)"
              aria-label="Insert a canned reply"
              onClick={() => {
                const next = text && !/\s$/.test(text) ? `${text} /` : `${text}/`;
                setText(next);
                setPicker({ kind: 'canned', query: '', start: next.length - 1 });
                setHighlight(0);
                box.current?.focus();
              }}
              className="mb-1 rounded-lg p-2 text-amber-600 hover:bg-amber-50"
            >
              <Zap className="size-4" />
            </button>
          )}
          <textarea
            ref={box}
            aria-label={mode === 'note' ? 'Internal note' : 'Reply'}
            rows={2}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              detectPicker(e.target.value, e.target.selectionStart);
            }}
            onBlur={() => setTimeout(() => setPicker(null), 150)}
            onKeyDown={onKeyDown}
            placeholder={mode === 'note' ? 'Only your team sees this… type @ to mention a teammate' : 'Type a reply… / for canned replies (Enter to send, Shift+Enter for a new line)'}
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
      {managing && <CannedRepliesDialog onClose={() => setManaging(false)} />}
    </div>
  );
}

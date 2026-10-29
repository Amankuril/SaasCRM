import { useInfiniteQuery } from '@tanstack/react-query';
import { AlertCircle, Check, CheckCheck, ChevronDown, Clock, FileText, Lock, StickyNote } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { initials } from '../../components/crm';
import { Alert, Button, Spinner, cn, errorMessage } from '../../components/ui';
import { api, type TimelineItem } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';

const dayKey = (iso: string) => new Date(iso).toDateString();
function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function Timeline({ id, contactName }: { id: string; contactName: string }) {
  const { workspace } = useWorkspace();
  const scroller = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const query = useInfiniteQuery({
    queryKey: ['timeline', workspace.id, id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<{ items: TimelineItem[]; nextBefore: string | null }>(`/workspaces/${workspace.id}/conversations/${id}/timeline${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.nextBefore,
  });
  // Pages arrive newest-first; each page is already oldest-to-newest.
  const items = useMemo(() => [...(query.data?.pages ?? [])].reverse().flatMap((p) => p.items), [query.data]);
  const lastId = items.at(-1)?.id;

  useEffect(() => {
    if (atBottom) bottom.current?.scrollIntoView({ block: 'end' });
    // Only new messages (not scrolling) should move the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
        className="h-full overflow-y-auto bg-slate-50 bg-[radial-gradient(rgba(148,163,184,0.18)_1px,transparent_1px)] [background-size:18px_18px] px-4 py-4 sm:px-6"
      >
        {query.hasNextPage ? (
          <div className="mb-3 text-center">
            <Button variant="ghost" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              Load earlier messages
            </Button>
          </div>
        ) : (
          !query.isPending && (
            <div className="mb-4 flex flex-col items-center gap-3 pt-2">
              <p className="text-xs text-slate-400">Beginning of conversation</p>
              <p className="inline-flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-800 ring-1 ring-amber-100">
                <Lock className="size-3" /> Messages are end-to-end encrypted
              </p>
            </div>
          )
        )}
        {query.isPending ? (
          <Spinner />
        ) : query.error ? (
          <Alert>{errorMessage(query.error)}</Alert>
        ) : (
          <ol className="space-y-2">
            {items.map((item, i) => {
              const prev = items[i - 1];
              const newDay = !prev || dayKey(prev.createdAt) !== dayKey(item.createdAt);
              // The customer's avatar shows on the last message of each run of theirs.
              const next = items[i + 1];
              const runEnd = !next || next.kind !== 'message' || item.kind !== 'message' || next.direction !== item.direction || dayKey(next.createdAt) !== dayKey(item.createdAt);
              return (
                <Fragment key={item.id}>
                  {newDay && (
                    <li className="flex justify-center py-2" aria-label={dayLabel(item.createdAt)}>
                      <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 shadow-sm">{dayLabel(item.createdAt)}</span>
                    </li>
                  )}
                  <li>{item.kind === 'note' ? <NoteBubble item={item} /> : <MessageBubble item={item} contactName={contactName} showAvatar={runEnd} />}</li>
                </Fragment>
              );
            })}
          </ol>
        )}
        <div ref={bottom} />
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })}
          className="absolute right-5 bottom-4 flex size-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-md hover:bg-slate-50"
          aria-label="Jump to latest message"
        >
          <ChevronDown className="size-5" />
        </button>
      )}
    </div>
  );
}

function MessageBubble({ item, contactName, showAvatar }: { item: Extract<TimelineItem, { kind: 'message' }>; contactName: string; showAvatar: boolean }) {
  const out = item.direction === 'outbound';
  const c = item.content as { text?: string; preview?: string; caption?: string; title?: string; filename?: string; mediaType?: string; template?: { name: string } };
  const isFormReply = item.type === 'interactive' && item.content.interactiveType === 'nfm_reply';
  const isMedia = item.type === 'media' || ['image', 'video', 'document', 'audio', 'sticker'].includes(item.type);
  const body = item.type === 'template' ? c.preview : isFormReply ? '📝 Form submitted' : (c.text ?? c.caption ?? c.title ?? (isMedia ? null : `[${item.type} message]`));

  return (
    <div className={cn('flex items-end gap-2', out ? 'justify-end' : 'justify-start')}>
      {!out && (
        <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[11px] font-semibold text-emerald-700', !showAvatar && 'invisible')} aria-hidden>
          {initials(contactName)}
        </span>
      )}
      <div className={cn('flex max-w-[75%] flex-col', out ? 'items-end' : 'items-start')}>
        <div className={cn('rounded-2xl px-3.5 py-2.5 text-sm shadow-sm', out ? 'rounded-br-md bg-[#d9fdd3] text-slate-900' : 'rounded-bl-md bg-white text-slate-800 ring-1 ring-slate-100')}>
          {item.type === 'template' && <p className="mb-0.5 text-[11px] font-medium text-emerald-800">Template · {c.template?.name}</p>}
          {isMedia && (
            <p className="mb-1 inline-flex items-center gap-1.5 rounded-lg bg-black/5 px-2 py-1 text-xs text-slate-700">
              <FileText className="size-3.5" /> {c.filename ?? c.mediaType ?? item.type}
            </p>
          )}
          {body && <p className="break-words whitespace-pre-wrap">{body}</p>}
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
            {timeOf(item.createdAt)}
            {out && <StatusTick status={item.status} />}
          </p>
          {item.error && (
            <p className="mt-1 text-xs text-red-600">
              {item.error.title}: {item.error.message}
            </p>
          )}
        </div>
        {out && item.sentBy && <p className="mt-1 px-1 text-[11px] text-slate-400">{item.sentBy}</p>}
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
    <div className="mx-auto max-w-[85%] rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-sm text-amber-900">
      <p className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-amber-700">
        <StickyNote className="size-3" /> Internal note · {item.author} · {new Date(item.createdAt).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}
      </p>
      <p className="break-words whitespace-pre-wrap">{item.body}</p>
    </div>
  );
}

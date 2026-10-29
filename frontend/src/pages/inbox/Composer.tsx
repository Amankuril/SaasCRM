import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ChevronDown, CornerDownLeft, FileText, Loader2, MessageCircle, Paperclip, Smile, Sparkles, StickyNote, Type, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { TemplatePreview } from '../../components/TemplatePreview';
import { ButtonValueInputs, TemplateExtrasFields, emptyExtras, extrasPreview } from '../../components/TemplateSendFields';
import { Alert, Button, Input, Select, cn, errorMessage } from '../../components/ui';
import { api, type AgentDecision, type MessageTemplate, type TemplateExtras } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { Popover } from '../audience/shared';
import { CannedRepliesDialog } from './ChatTools';
import { fillCanned, useCannedReplies, useTeam } from './shared';

/** Header shortcuts and the actions menu ask the composer to switch mode and take focus. */
export const COMPOSE_EVENT = 'zc:compose';
/** Opens the canned-reply picker in the composer. */
export const CANNED_EVENT = 'zc:canned';

/** "/" (reply) or "@" (note) right before the caret opens a picker. */
type Picker = { kind: 'canned' | 'mention'; query: string; start: number };
type Attachment = { id: string; fileName: string; mediaType: 'image' | 'video' | 'document' | 'audio' };

const ENTER_KEY = 'zc.inbox.enterToSend';
const EMOJIS = ['😀', '😊', '😂', '🙂', '😉', '😍', '🥰', '😎', '🤔', '😅', '🙏', '👍', '👌', '👏', '🙌', '💪', '🎉', '🎁', '❤️', '💚', '🔥', '⭐', '✅', '❌', '⏰', '📅', '📍', '📞', '💬', '📦', '🚚', '💰', '🛒', '🦷', '🏥', '👋', '🤝', '✨', '😢', '😮'];
const MEDIA_ACCEPT = 'image/jpeg,image/png,video/mp4,application/pdf,audio/mpeg,audio/ogg,audio/aac';

const mediaTypeOf = (mime: string): Attachment['mediaType'] => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document');

export function Composer({ id, windowOpen, contactName, aiMode, onOpenActions }: { id: string; windowOpen: boolean; contactName?: string | null; aiMode: 'auto' | 'copilot' | 'off'; onOpenActions: () => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [managing, setManaging] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [anchor, setAnchor] = useState<{ el: HTMLElement; kind: 'mode' | 'emoji' | 'format' } | null>(null);
  const [enterToSend, setEnterToSend] = useState(() => {
    try {
      return localStorage.getItem(ENTER_KEY) !== '0';
    } catch {
      return true;
    }
  });
  // Display name -> user id of teammates @mentioned in the note being written.
  const [mentioned, setMentioned] = useState<Map<string, string>>(new Map());
  const canned = useCannedReplies();
  const team = useTeam();

  const [templateId, setTemplateId] = useState('');
  const [headerParams, setHeaderParams] = useState<string[]>([]);
  const [bodyParams, setBodyParams] = useState<string[]>([]);
  const [buttonParams, setButtonParams] = useState<string[]>([]);
  const [extras, setExtras] = useState<TemplateExtras>({});
  const useTemplate = mode === 'reply' && !windowOpen;
  const [suggestion, setSuggestion] = useState<AgentDecision | null>(null);

  const focusAt = (pos?: number) =>
    setTimeout(() => {
      box.current?.focus();
      if (pos !== undefined) box.current?.setSelectionRange(pos, pos);
    }, 0);

  useEffect(() => {
    const onCompose = (e: Event) => {
      setMode((e as CustomEvent<'reply' | 'note'>).detail);
      focusAt();
    };
    const onCanned = () => {
      setMode('reply');
      openCanned();
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    window.addEventListener(CANNED_EVENT, onCanned);
    return () => {
      window.removeEventListener(COMPOSE_EVENT, onCompose);
      window.removeEventListener(CANNED_EVENT, onCanned);
    };
  });

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

  const upload = useMutation({
    mutationFn: (file: File) => api.upload<{ mediaId: string; fileName: string }>(`/workspaces/${workspace.id}/messages/media`, file),
    onSuccess: ({ mediaId, fileName }, file) => setAttachment({ id: mediaId, fileName, mediaType: mediaTypeOf(file.type) }),
  });

  const send = useMutation({
    mutationFn: () => {
      const base = `/workspaces/${workspace.id}/conversations/${id}`;
      if (mode === 'note') return api.post(`${base}/notes`, { body: text, mentions: [...mentioned].filter(([name]) => text.includes(`@${name}`)).map(([, uid]) => uid) });
      if (useTemplate) return api.post(`${base}/messages`, { type: 'template', templateId, headerParams, bodyParams, buttonParams, extras });
      if (attachment) return api.post(`${base}/messages`, { type: 'media', mediaType: attachment.mediaType, id: attachment.id, filename: attachment.fileName, caption: text.trim() || undefined });
      return api.post(`${base}/messages`, { type: 'text', text });
    },
    onSuccess: () => {
      setText('');
      setMentioned(new Map());
      setAttachment(null);
      setSuggestion(null);
      setTemplateId('');
      void queryClient.invalidateQueries({ queryKey: ['timeline', workspace.id, id] });
      void queryClient.invalidateQueries({ queryKey: ['conversation', workspace.id, id] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] });
    },
  });

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
    setText(text.slice(0, picker.start) + insert + text.slice(caret));
    if (picker.kind === 'canned') void api.post(`/workspaces/${workspace.id}/canned-replies/${o.id}/used`).catch(() => undefined);
    else setMentioned(new Map(mentioned).set(o.value, o.id));
    setPicker(null);
    focusAt(picker.start + insert.length);
  };
  const openCanned = () => {
    const next = text && !/\s$/.test(text) ? `${text} /` : `${text}/`;
    setText(next);
    setPicker({ kind: 'canned', query: '', start: next.length - 1 });
    setHighlight(0);
    focusAt(next.length);
  };
  /** Inserts at the caret (emoji) or wraps the selection in WhatsApp formatting marks. */
  const insertAround = (before: string, after = '') => {
    const el = box.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const selected = text.slice(start, end);
    setText(text.slice(0, start) + before + selected + after + text.slice(end));
    focusAt(start + before.length + selected.length + (selected ? after.length : 0));
  };

  const canSend = mode === 'note' ? !!text.trim() : useTemplate ? !!templateId : !!attachment || !!text.trim();
  const submit = () => {
    if (canSend && !send.isPending) send.mutate();
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
    // Enter sends (or Ctrl/Cmd+Enter when "Enter to send" is off); Shift+Enter is a new line.
    if (e.key === 'Enter' && !e.shiftKey && (enterToSend || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
  const toggleEnter = () => {
    setEnterToSend(!enterToSend);
    try {
      localStorage.setItem(ENTER_KEY, enterToSend ? '0' : '1');
    } catch {
      /* per-browser preference */
    }
  };

  const tool = (label: string, icon: ReactNode, onClick: (el: HTMLElement) => void, opts: { active?: boolean; disabled?: boolean } = {}) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={opts.disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => onClick(e.currentTarget)}
      className={cn('rounded-lg p-2 transition hover:bg-slate-100 disabled:opacity-40', opts.active ? 'bg-slate-100 text-ink' : 'text-slate-500 hover:text-slate-800')}
    >
      {icon}
    </button>
  );

  const note = mode === 'note';
  return (
    <div className="px-4 pt-2 pb-4">
      {(suggest.error ?? send.error ?? upload.error) != null && (
        <div className="mb-2">
          <Alert>{errorMessage(suggest.error ?? send.error ?? upload.error)}</Alert>
        </div>
      )}
      {suggestion && (
        <p className={cn('mb-2 rounded-lg px-3 py-1.5 text-xs', suggestion.outcome === 'answered' ? 'bg-fuchsia-50 text-fuchsia-800' : 'bg-amber-50 text-amber-800')}>
          {suggestion.outcome === 'answered'
            ? `AI draft added below. Review before sending.${suggestion.sources.length ? ` Sources: ${suggestion.sources.map((s) => s.title).join(', ')}` : ''}`
            : `The AI suggests a human answer this: ${suggestion.reason}`}
        </p>
      )}

      <div className={cn('relative rounded-2xl border bg-white shadow-sm transition focus-within:shadow-md', note ? 'border-amber-300 bg-amber-50/40' : 'border-slate-200 focus-within:border-slate-300')}>
        <div className="flex items-center gap-2 px-4 pt-3">
          <button type="button" onClick={(e) => setAnchor({ el: e.currentTarget, kind: 'mode' })} className="inline-flex items-center gap-1.5 rounded-md text-sm font-semibold text-ink hover:text-slate-600">
            {note ? <StickyNote className="size-4 text-amber-600" /> : <WhatsAppGlyph />}
            {note ? 'Internal note' : 'WhatsApp'}
            <ChevronDown className="size-3.5 text-slate-400" />
          </button>
          {!note && !windowOpen && <span className="text-xs text-amber-700">24-hour window closed: send an approved template</span>}
          {!note && windowOpen && aiMode !== 'off' && (
            <button type="button" onClick={() => suggest.mutate()} disabled={suggest.isPending} className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-fuchsia-700 hover:bg-fuchsia-50 disabled:opacity-60">
              {suggest.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} {suggest.isPending ? 'Thinking…' : 'Suggest reply'}
            </button>
          )}
        </div>

        {useTemplate ? (
          <div className="space-y-3 p-4">
            <Select
              aria-label="Template"
              value={templateId}
              onChange={(e) => {
                const t = templates.data?.templates.find((x) => x.id === e.target.value);
                setTemplateId(e.target.value);
                setHeaderParams(Array(t?.variables.header ?? 0).fill(''));
                setBodyParams(Array(t?.variables.body ?? 0).fill(''));
                setButtonParams(Array(t?.requirements.buttons.length ?? 0).fill(''));
                setExtras(emptyExtras(t?.requirements));
              }}
            >
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
            <div className="flex justify-end">
              <Button loading={send.isPending} disabled={!templateId} onClick={submit}>
                Send template
              </Button>
            </div>
          </div>
        ) : (
          <>
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
            {attachment && !note && (
              <div className="mx-4 mt-2 inline-flex items-center gap-2 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs text-slate-700">
                <FileText className="size-3.5" /> {attachment.fileName}
                <button type="button" onClick={() => setAttachment(null)} className="rounded p-0.5 hover:bg-slate-200" aria-label="Remove attachment">
                  <X className="size-3" />
                </button>
              </div>
            )}
            <textarea
              ref={box}
              aria-label={note ? 'Internal note' : 'Reply'}
              rows={3}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                detectPicker(e.target.value, e.target.selectionStart);
              }}
              onPaste={(e) => {
                const file = e.clipboardData.files[0];
                if (file && !note) {
                  e.preventDefault();
                  upload.mutate(file);
                }
              }}
              onBlur={() => setTimeout(() => setPicker(null), 150)}
              onKeyDown={onKeyDown}
              placeholder={note ? 'Only your team sees this… type @ to mention a teammate' : attachment ? 'Add a caption (optional)' : 'Type your message... (Ctrl+V to paste image or file)'}
              className="block max-h-56 min-h-20 w-full resize-none bg-transparent px-4 py-2 text-sm text-ink placeholder:text-slate-400 focus:outline-none"
            />
            <div className="flex items-center gap-0.5 px-2.5 pb-2.5">
              {!note &&
                tool(upload.isPending ? 'Uploading…' : 'Attach a file', upload.isPending ? <Loader2 className="size-[18px] animate-spin" /> : <Paperclip className="size-[18px]" />, () => fileInput.current?.click(), { disabled: upload.isPending })}
              {tool('Emoji', <Smile className="size-[18px]" />, (el) => setAnchor({ el, kind: 'emoji' }))}
              {!note && tool('Canned replies (/)', <Zap className="size-[18px]" />, openCanned)}
              {tool('Formatting', <Type className="size-[18px]" />, (el) => setAnchor({ el, kind: 'format' }))}
              {tool(enterToSend ? 'Enter sends (click: Enter adds a new line, Ctrl+Enter sends)' : 'Enter adds a new line (click: Enter sends)', <CornerDownLeft className="size-[18px]" />, toggleEnter, { active: enterToSend })}
              <button type="button" onClick={onOpenActions} className="ml-1 hidden items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 @md:inline-flex" title="All actions (Ctrl+K)">
                <kbd className="rounded-md bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white">Ctrl+K</kbd> actions
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!canSend || send.isPending}
                aria-label={note ? 'Add note' : 'Send'}
                title={note ? 'Add note' : 'Send'}
                className={cn('ml-auto flex size-9 items-center justify-center rounded-full text-white transition disabled:bg-slate-200 disabled:text-slate-400', note ? 'bg-amber-500 hover:bg-amber-600' : 'bg-brand-600 hover:bg-brand-700')}
              >
                {send.isPending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept={MEDIA_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>

      <Popover anchor={anchor?.kind === 'mode' ? anchor.el : null} open={anchor?.kind === 'mode'} onClose={() => setAnchor(null)} width={230}>
        <div className="p-1 text-sm">
          {(
            [
              ['reply', 'WhatsApp', 'Reply to the customer', <MessageCircle key="w" className="size-4 text-emerald-600" />],
              ['note', 'Internal note', 'Only your team sees it', <StickyNote key="n" className="size-4 text-amber-600" />],
            ] as const
          ).map(([m, label, hint, icon]) => (
            <button key={m} type="button" onClick={() => (setMode(m), setAnchor(null), focusAt())} className={cn('flex w-full items-start gap-2.5 rounded-md px-3 py-2 text-left hover:bg-slate-50', mode === m && 'bg-slate-50')}>
              <span className="mt-0.5">{icon}</span>
              <span>
                <span className="block font-medium text-ink">{label}</span>
                <span className="block text-xs text-slate-500">{hint}</span>
              </span>
            </button>
          ))}
        </div>
      </Popover>
      <Popover anchor={anchor?.kind === 'emoji' ? anchor.el : null} open={anchor?.kind === 'emoji'} onClose={() => setAnchor(null)} width={264}>
        <div className="grid grid-cols-8 gap-0.5 p-2">
          {EMOJIS.map((em) => (
            <button key={em} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertAround(em)} className="rounded-md p-1 text-xl hover:bg-slate-100" aria-label={`Insert ${em}`}>
              {em}
            </button>
          ))}
        </div>
      </Popover>
      <Popover anchor={anchor?.kind === 'format' ? anchor.el : null} open={anchor?.kind === 'format'} onClose={() => setAnchor(null)} width={220}>
        <div className="p-1 text-sm">
          <p className="px-3 pt-1.5 pb-1 text-xs text-slate-500">Select text, then pick a style</p>
          {(
            [
              ['Bold', '*', '*', 'font-bold'],
              ['Italic', '_', '_', 'italic'],
              ['Strikethrough', '~', '~', 'line-through'],
              ['Monospace', '```', '```', 'font-mono'],
            ] as const
          ).map(([label, a, b, cls]) => (
            <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => (insertAround(a, b), setAnchor(null))} className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left hover:bg-slate-50">
              <span className={cls}>{label}</span>
              <code className="text-xs text-slate-400">
                {a}text{b}
              </code>
            </button>
          ))}
        </div>
      </Popover>
      {managing && <CannedRepliesDialog onClose={() => setManaging(false)} />}
    </div>
  );
}

export const WhatsAppGlyph = ({ className = 'size-4' }: { className?: string }) => (
  <svg viewBox="0 0 32 32" className={className} fill="#25D366" aria-hidden="true">
    <path d="M16 3a13 13 0 0 0-11.2 19.6L3 29l6.6-1.7A13 13 0 1 0 16 3zm0 23.7c-2 0-4-.6-5.7-1.6l-.4-.2-3.9 1 1-3.8-.3-.4A10.7 10.7 0 1 1 16 26.7zm5.9-8c-.3-.2-1.9-.9-2.2-1s-.5-.2-.7.2-.8 1-1 1.2-.4.2-.7.1a8.8 8.8 0 0 1-4.4-3.8c-.3-.6.3-.5 1-1.7.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4s-1.2 1.1-1.2 2.7 1.2 3.2 1.4 3.4 2.4 3.6 5.7 5c2.1.9 3 1 4 .8.7-.1 1.9-.8 2.2-1.5s.3-1.3.2-1.5-.3-.2-.6-.4z" />
  </svg>
);

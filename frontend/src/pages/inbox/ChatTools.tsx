import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Code2, Copy, Download, MessageCircle, Pencil, Plus, QrCode, Search, Trash2, Users, Wrench, Zap } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Dialog } from '../../components/Dialog';
import { Alert, Button, Input, Select, cn, errorMessage, fieldError } from '../../components/ui';
import { api, type CannedReply, type ConnectionPayload } from '../../lib/api';
import { useWorkspace } from '../../layouts/workspaceContext';
import { useCannedReplies } from './shared';

type Tool = 'canned' | 'qr' | 'widget';

export function ChatTools() {
  const [open, setOpen] = useState<Tool | null>(null);
  const cards: { key: Tool | 'subscriber'; icon: typeof Zap; tone: string; title: string; text: string }[] = [
    { key: 'canned', icon: Zap, tone: 'bg-amber-50 text-amber-600', title: 'Canned Shortcut Message', text: 'Create shortcut messages for quick replies in chat conversations' },
    { key: 'qr', icon: QrCode, tone: 'bg-sky-50 text-sky-600', title: 'Create QR Code', text: 'Generate QR codes to start WhatsApp conversations instantly' },
    { key: 'widget', icon: Code2, tone: 'bg-emerald-50 text-emerald-600', title: 'Create Chat Widget', text: 'Embed a WhatsApp chat button directly on your website' },
    { key: 'subscriber', icon: Users, tone: 'bg-violet-50 text-violet-600', title: 'Create Subscriber Widget', text: 'Build a subscriber opt-in widget for newsletters' },
  ];
  return (
    <div>
      <div className="flex items-center gap-3 border-b border-slate-200 px-6 py-5">
        <span className="rounded-xl bg-slate-100 p-2.5 text-slate-600">
          <Wrench className="size-5" />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-ink">Chat Tools</h1>
          <p className="text-sm text-slate-500">Manage your chat tools and integrations</p>
        </div>
      </div>
      <div className="grid gap-5 p-6 md:grid-cols-2">
        {cards.map((c) => {
          const soon = c.key === 'subscriber';
          return (
            <button
              key={c.key}
              type="button"
              disabled={soon}
              onClick={() => !soon && setOpen(c.key as Tool)}
              className={cn('flex min-h-52 flex-col rounded-2xl border border-slate-200 p-8 text-left transition', soon ? 'cursor-not-allowed opacity-70' : 'hover:border-slate-300 hover:shadow-md')}
            >
              <span className={cn('mb-auto flex size-12 items-center justify-center rounded-xl', c.tone)}>
                <c.icon className="size-6" />
              </span>
              <span className="mt-8 flex items-center gap-2 font-semibold text-ink">
                {c.title}
                {soon && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">Coming soon</span>}
              </span>
              <span className="mt-1.5 text-sm text-slate-500">{c.text}</span>
            </button>
          );
        })}
      </div>
      {open === 'canned' && <CannedRepliesDialog onClose={() => setOpen(null)} />}
      {open === 'qr' && <QrDialog onClose={() => setOpen(null)} />}
      {open === 'widget' && <WidgetDialog onClose={() => setOpen(null)} />}
    </div>
  );
}

// ---- Canned replies ----

export function CannedRepliesDialog({ onClose }: { onClose: () => void }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const replies = useCannedReplies();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<CannedReply | 'new' | null>(null);
  const canEdit = can('messages:send') && workspace.status !== 'suspended';
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/workspaces/${workspace.id}/canned-replies/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['canned-replies', workspace.id] }),
  });
  const term = q.trim().toLowerCase().replace(/^\//, '');
  const list = (replies.data ?? []).filter((r) => !term || r.shortcut.includes(term) || r.body.toLowerCase().includes(term));

  return (
    <Dialog
      icon={<Zap className="size-5" />}
      title="Canned shortcut messages"
      subtitle="Type / in the reply box to insert one"
      width="max-w-2xl"
      onClose={onClose}
      footer={
        canEdit && !editing ? (
          <Button onClick={() => setEditing('new')}>
            <Plus className="size-4" /> New shortcut
          </Button>
        ) : undefined
      }
    >
      {editing ? (
        <CannedForm reply={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
      ) : (
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <Input aria-label="Search shortcuts" placeholder="Search shortcuts" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          {remove.error != null && <Alert>{errorMessage(remove.error)}</Alert>}
          {replies.isPending ? (
            <p className="py-6 text-center text-sm text-slate-500">Loading…</p>
          ) : list.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500">
              {term ? 'No shortcuts match.' : 'No shortcuts yet. Save answers you type often, like opening hours or payment details.'}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
              {list.map((r) => (
                <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                  <code className="mt-0.5 shrink-0 rounded-md bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">/{r.shortcut}</code>
                  <p className="min-w-0 flex-1 text-sm whitespace-pre-line text-slate-700">{r.body}</p>
                  {canEdit && (
                    <span className="flex shrink-0 gap-0.5">
                      <button type="button" onClick={() => setEditing(r)} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label={`Edit /${r.shortcut}`}>
                        <Pencil className="size-4" />
                      </button>
                      <button type="button" onClick={() => window.confirm(`Delete /${r.shortcut}?`) && remove.mutate(r.id)} className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Delete /${r.shortcut}`}>
                        <Trash2 className="size-4" />
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}

function CannedForm({ reply, onDone }: { reply: CannedReply | null; onDone: () => void }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [shortcut, setShortcut] = useState(reply?.shortcut ?? '');
  const [body, setBody] = useState(reply?.body ?? '');
  const save = useMutation({
    mutationFn: () => {
      const base = `/workspaces/${workspace.id}/canned-replies`;
      return reply ? api.patch(`${base}/${reply.id}`, { shortcut, body }) : api.post(base, { shortcut, body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['canned-replies', workspace.id] });
      onDone();
    },
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {save.error != null && !fieldError(save.error, 'shortcut') && !fieldError(save.error, 'body') && <Alert>{errorMessage(save.error)}</Alert>}
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-slate-700">Shortcut</span>
        <div className="flex items-center rounded-lg border border-slate-300 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20">
          <span className="pl-3 font-mono text-slate-400">/</span>
          <input autoFocus value={shortcut} maxLength={31} onChange={(e) => setShortcut(e.target.value.toLowerCase().replace(/\s+/g, '-'))} placeholder="hours" className="w-full rounded-lg px-1 py-2 font-mono text-sm focus:outline-none" />
        </div>
        {fieldError(save.error, 'shortcut') && <span className="text-xs text-red-600">{fieldError(save.error, 'shortcut')}</span>}
      </label>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-slate-700">Message</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={4096} placeholder="Hi {{name}}, we're open 9 AM – 7 PM, Monday to Saturday." className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none" />
        <span className="text-xs text-slate-500">{'{{name}}'} becomes the customer&apos;s first name.</span>
        {fieldError(save.error, 'body') && <span className="block text-xs text-red-600">{fieldError(save.error, 'body')}</span>}
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending} disabled={!shortcut.trim() || !body.trim()}>
          {reply ? 'Save' : 'Create shortcut'}
        </Button>
      </div>
    </form>
  );
}

// ---- wa.me link, QR code and website widget ----

/** The connected WhatsApp number as digits, for wa.me links. */
function useBusinessNumber() {
  const { workspace } = useWorkspace();
  const conn = useQuery({ queryKey: ['whatsapp-connection', workspace.id], queryFn: () => api.get<ConnectionPayload>(`/workspaces/${workspace.id}/whatsapp/connection`) });
  return { loading: conn.isPending, number: (conn.data?.connection?.displayPhoneNumber ?? '').replace(/\D/g, ''), name: conn.data?.connection?.verifiedName ?? workspace.name };
}

const waLink = (number: string, text: string) => `https://wa.me/${number}${text.trim() ? `?text=${encodeURIComponent(text.trim())}` : ''}`;

function NumberField({ value, onChange, detected }: { value: string; onChange: (v: string) => void; detected: boolean }) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium text-slate-700">WhatsApp number</span>
      <Input value={value} inputMode="tel" placeholder="919876543210" onChange={(e) => onChange(e.target.value.replace(/[^\d+]/g, ''))} />
      <span className="text-xs text-slate-500">{detected ? 'Your connected business number. Country code included, no + or spaces.' : 'With country code, e.g. 919876543210.'}</span>
    </label>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      disabled={!text}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="size-4" /> : <Copy className="size-4" />} {done ? 'Copied' : label}
    </Button>
  );
}

function QrDialog({ onClose }: { onClose: () => void }) {
  const biz = useBusinessNumber();
  const [number, setNumber] = useState('');
  const [message, setMessage] = useState('Hi! I would like to know more.');
  const [color, setColor] = useState('#0f172a');
  const [png, setPng] = useState('');
  useEffect(() => {
    if (biz.number && !number) setNumber(biz.number);
  }, [biz.number, number]);
  const digits = number.replace(/\D/g, '');
  const link = digits.length >= 8 ? waLink(digits, message) : '';
  useEffect(() => {
    if (!link) return setPng('');
    let live = true;
    void QRCode.toDataURL(link, { width: 640, margin: 2, errorCorrectionLevel: 'M', color: { dark: color, light: '#ffffff' } }).then((url) => live && setPng(url));
    return () => {
      live = false;
    };
  }, [link, color]);
  const download = () => {
    const a = Object.assign(document.createElement('a'), { href: png, download: `whatsapp-qr-${digits}.png` });
    a.click();
  };

  return (
    <Dialog
      icon={<QrCode className="size-5" />}
      title="Create QR code"
      subtitle="Customers scan it to open a WhatsApp chat with you"
      width="max-w-3xl"
      onClose={onClose}
      footer={
        <>
          <CopyButton text={link} label="Copy link" />
          <Button disabled={!png} onClick={download}>
            <Download className="size-4" /> Download PNG
          </Button>
        </>
      }
    >
      <div className="grid gap-6 md:grid-cols-[1fr_16rem]">
        <div className="space-y-4">
          <NumberField value={number} onChange={setNumber} detected={!!biz.number && number === biz.number} />
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium text-slate-700">Pre-filled message (optional)</span>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxLength={500} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none" />
            <span className="text-xs text-slate-500">Appears in the customer&apos;s message box; they just tap send. Tip: add a keyword your Keyword Triggers answer.</span>
          </label>
          <label className="flex items-center gap-3 text-sm">
            <span className="font-medium text-slate-700">QR colour</span>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-8 w-12 cursor-pointer rounded border border-slate-300" aria-label="QR colour" />
          </label>
          {link && <p className="rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs break-all text-slate-600">{link}</p>}
        </div>
        <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 p-4">
          {png ? <img src={png} alt="WhatsApp QR code" className="w-full rounded-xl bg-white" /> : <p className="py-16 text-center text-sm text-slate-500">Enter a number to see the QR code</p>}
          {png && <p className="mt-3 text-center text-xs text-slate-500">Print it on menus, receipts, packaging or your shop counter.</p>}
        </div>
      </div>
    </Dialog>
  );
}

interface WidgetConfig {
  number: string;
  title: string;
  greeting: string;
  message: string;
  button: string;
  color: string;
  position: 'right' | 'left';
}

/** A dependency-free snippet: a floating button with a small greeting card that opens WhatsApp. */
export function widgetSnippet(c: WidgetConfig): string {
  const cfg = JSON.stringify({ n: c.number, t: c.title, g: c.greeting, m: c.message, b: c.button, c: c.color, p: c.position }).replace(/</g, '\\u003c');
  return `<!-- Zeta Connect WhatsApp chat widget -->
<script>
(function () {
  var c = ${cfg};
  if (document.getElementById('zc-wa-widget')) return;
  var side = c.p === 'left' ? 'left' : 'right';
  var root = document.createElement('div');
  root.id = 'zc-wa-widget';
  root.style.cssText = 'position:fixed;bottom:20px;' + side + ':20px;z-index:2147483000;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
  var card = document.createElement('div');
  card.style.cssText = 'display:none;width:300px;max-width:calc(100vw - 40px);margin-bottom:12px;background:#fff;border-radius:16px;box-shadow:0 12px 32px rgba(0,0,0,.18);overflow:hidden';
  var head = document.createElement('div');
  head.style.cssText = 'background:' + c.c + ';color:#fff;padding:14px 16px;font-weight:600;font-size:15px';
  head.textContent = c.t;
  var body = document.createElement('div');
  body.style.cssText = 'padding:16px;background:#efe7de';
  var bubble = document.createElement('div');
  bubble.style.cssText = 'background:#fff;border-radius:0 10px 10px 10px;padding:10px 12px;font-size:14px;color:#111;white-space:pre-line;box-shadow:0 1px 1px rgba(0,0,0,.08)';
  bubble.textContent = c.g;
  body.appendChild(bubble);
  var go = document.createElement('a');
  go.href = 'https://wa.me/' + c.n + (c.m ? '?text=' + encodeURIComponent(c.m) : '');
  go.target = '_blank';
  go.rel = 'noopener';
  go.textContent = c.b;
  go.style.cssText = 'display:block;margin:12px 16px 16px;padding:10px;border-radius:999px;background:#25D366;color:#fff;text-align:center;text-decoration:none;font-weight:600;font-size:14px';
  card.appendChild(head); card.appendChild(body); card.appendChild(go);
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Chat on WhatsApp');
  btn.style.cssText = 'float:' + side + ';width:58px;height:58px;border:0;border-radius:50%;background:#25D366;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center';
  btn.innerHTML = '<svg viewBox="0 0 32 32" width="30" height="30" fill="#fff" aria-hidden="true"><path d="M16 3a13 13 0 0 0-11.2 19.6L3 29l6.6-1.7A13 13 0 1 0 16 3zm0 23.7c-2 0-4-.6-5.7-1.6l-.4-.2-3.9 1 1-3.8-.3-.4A10.7 10.7 0 1 1 16 26.7zm5.9-8c-.3-.2-1.9-.9-2.2-1s-.5-.2-.7.2-.8 1-1 1.2-.4.2-.7.1a8.8 8.8 0 0 1-4.4-3.8c-.3-.6.3-.5 1-1.7.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4s-1.2 1.1-1.2 2.7 1.2 3.2 1.4 3.4 2.4 3.6 5.7 5c2.1.9 3 1 4 .8.7-.1 1.9-.8 2.2-1.5s.3-1.3.2-1.5-.3-.2-.6-.4z"/></svg>';
  btn.onclick = function () { card.style.display = card.style.display === 'none' ? 'block' : 'none'; };
  root.appendChild(card); root.appendChild(btn);
  (document.body || document.documentElement).appendChild(root);
})();
</script>`;
}

function WidgetDialog({ onClose }: { onClose: () => void }) {
  const biz = useBusinessNumber();
  const [cfg, setCfg] = useState<WidgetConfig>({ number: '', title: '', greeting: 'Hi there 👋\nHow can we help you today?', message: 'Hi! I have a question.', button: 'Start chat', color: '#075e54', position: 'right' });
  useEffect(() => {
    if (!biz.loading) setCfg((c) => ({ ...c, number: c.number || biz.number, title: c.title || biz.name }));
  }, [biz.loading, biz.number, biz.name]);
  const set = (patch: Partial<WidgetConfig>) => setCfg((c) => ({ ...c, ...patch }));
  const digits = cfg.number.replace(/\D/g, '');
  const snippet = useMemo(() => (digits.length >= 8 ? widgetSnippet({ ...cfg, number: digits }) : ''), [cfg, digits]);
  const field = (label: string, el: ReactNode) => (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      {el}
    </label>
  );

  return (
    <Dialog icon={<Code2 className="size-5" />} title="Create chat widget" subtitle="A WhatsApp button for your website" width="max-w-4xl" onClose={onClose} footer={<CopyButton text={snippet} label="Copy code" />}>
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <NumberField value={cfg.number} onChange={(number) => set({ number })} detected={!!biz.number && cfg.number === biz.number} />
          <div className="grid gap-4 sm:grid-cols-2">
            {field('Header', <Input value={cfg.title} maxLength={60} onChange={(e) => set({ title: e.target.value })} />)}
            {field('Button text', <Input value={cfg.button} maxLength={30} onChange={(e) => set({ button: e.target.value })} />)}
          </div>
          {field('Greeting', <textarea rows={3} maxLength={300} value={cfg.greeting} onChange={(e) => set({ greeting: e.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none" />)}
          {field('Pre-filled message', <Input value={cfg.message} maxLength={300} onChange={(e) => set({ message: e.target.value })} />)}
          <div className="grid gap-4 sm:grid-cols-2">
            {field('Header colour', <input type="color" value={cfg.color} onChange={(e) => set({ color: e.target.value })} className="h-9 w-full cursor-pointer rounded-lg border border-slate-300" />)}
            {field(
              'Position',
              <Select value={cfg.position} onChange={(e) => set({ position: e.target.value as WidgetConfig['position'] })}>
                <option value="right">Bottom right</option>
                <option value="left">Bottom left</option>
              </Select>,
            )}
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">Embed code</p>
            <p className="mb-2 text-xs text-slate-500">
              Paste it before <code>&lt;/body&gt;</code> on every page (WordPress: a header/footer code plugin; Shopify: theme.liquid).
            </p>
            <pre className="max-h-40 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-emerald-100">{snippet || 'Enter a WhatsApp number to get the code.'}</pre>
          </div>
        </div>
        <div className="relative flex min-h-96 flex-col justify-end rounded-2xl border border-slate-200 bg-[repeating-linear-gradient(45deg,#f8fafc,#f8fafc_10px,#f1f5f9_10px,#f1f5f9_20px)] p-4" aria-label="Widget preview">
          <p className="absolute top-3 left-4 text-xs font-medium text-slate-400">Preview on your site</p>
          <div className={cn('flex flex-col gap-3', cfg.position === 'left' ? 'items-start' : 'items-end')}>
            <div className="w-64 overflow-hidden rounded-2xl bg-white shadow-xl">
              <div className="px-4 py-3 text-sm font-semibold text-white" style={{ background: cfg.color }}>
                {cfg.title || 'Your business'}
              </div>
              <div className="bg-[#efe7de] p-4">
                <p className="rounded-xl rounded-tl-none bg-white px-3 py-2 text-sm whitespace-pre-line text-slate-800 shadow-sm">{cfg.greeting}</p>
              </div>
              <div className="px-4 pb-4">
                <span className="block rounded-full bg-[#25D366] py-2 text-center text-sm font-semibold text-white">{cfg.button || 'Start chat'}</span>
              </div>
            </div>
            <span className="flex size-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-lg">
              <MessageCircle className="size-7" />
            </span>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

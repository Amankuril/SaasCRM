import {
  Bot,
  BotMessageSquare,
  BellOff,
  CreditCard,
  ExternalLink,
  FileText,
  Home,
  LayoutList,
  Link2,
  MapPin,
  Navigation,
  Package,
  Paperclip,
  Reply,
  Send,
  Signal,
  Type,
  Video,
  Wifi,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { TemplatePreview } from '../../components/TemplatePreview';
import { cn } from '../../components/ui';
import type { AutoReply, AutoReplyActionType, MessageTemplate } from '../../lib/api';

export const ACTION_INFO: { type: AutoReplyActionType | 'order_gateway' | 'order_link' | 'order_status'; label: string; icon: LucideIcon; soon?: boolean }[] = [
  { type: 'text', label: 'Text', icon: Type },
  { type: 'file', label: 'File', icon: FileText },
  { type: 'quick_reply', label: 'Quick Reply', icon: Reply },
  { type: 'cta_url', label: 'CTA URL', icon: ExternalLink },
  { type: 'form', label: 'Flow / Form', icon: LayoutList },
  { type: 'chatbot', label: 'Chatbot', icon: Bot },
  { type: 'ai_chatbot', label: 'AI Chatbot', icon: BotMessageSquare },
  { type: 'location', label: 'Location', icon: MapPin },
  { type: 'address', label: 'Address', icon: Navigation },
  { type: 'template', label: 'Template', icon: LayoutList },
  { type: 'unsubscribe', label: 'Unsubscribe Message', icon: BellOff },
  // India payments: shown for parity, not available yet.
  { type: 'order_gateway', label: 'Order Details (Gateway)', icon: CreditCard, soon: true },
  { type: 'order_link', label: 'Order Details (Link)', icon: Link2, soon: true },
  { type: 'order_status', label: 'Order Status', icon: Package, soon: true },
];

export const actionLabel = (type: AutoReplyActionType) => {
  const label = ACTION_INFO.find((a) => a.type === type)?.label ?? type;
  return type === 'text' ? 'Text Reply' : label;
};

const ACTION_TONE: Partial<Record<AutoReplyActionType, string>> = {
  ai_chatbot: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  chatbot: 'bg-violet-50 text-violet-700 ring-violet-200',
  template: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  unsubscribe: 'bg-red-50 text-red-700 ring-red-200',
};

export function ActionPill({ type }: { type: AutoReplyActionType }) {
  return (
    <span className={cn('inline-block rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap ring-1 ring-inset', ACTION_TONE[type] ?? 'bg-slate-50 text-slate-700 ring-slate-200')}>
      {actionLabel(type)}
    </span>
  );
}

export const MATCH_LABEL = { equals: 'Equals', contains: 'Contains', event: 'Event' } as const;
export const EVENT_LABEL = { first_message: "Customer's first message", any_message: 'Any message' } as const;
export const SOURCE_LABEL = { ad: 'Click-to-WhatsApp ad', broadcast: 'Reply to a broadcast', direct: 'Direct message' } as const;
export const COOLDOWNS = [
  { minutes: 0, label: 'Every time' },
  { minutes: 60, label: 'At most once an hour' },
  { minutes: 24 * 60, label: 'At most once a day' },
  { minutes: 7 * 24 * 60, label: 'At most once a week' },
];

/** What the trigger listens for, as the customer would type it. */
export function triggerText(r: Pick<AutoReply, 'match' | 'keywords' | 'event'>) {
  return r.match === 'event' ? EVENT_LABEL[r.event ?? 'any_message'] : r.keywords.join(', ');
}

const SAMPLE = { name: 'Priya Sharma', first_name: 'Priya', phone: '+91 98111 12222', email: 'priya@example.com' } as Record<string, string>;
export const sampleText = (text: string) => text.replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (m, k: string) => SAMPLE[k.toLowerCase()] ?? m);

function Bubble({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('max-w-[85%] rounded-lg rounded-tr-none bg-[#d9fdd3] px-2.5 py-1.5 text-sm text-slate-800 shadow-sm', className)}>{children}</div>;
}

function ButtonRow({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="mt-1 flex items-center justify-center gap-1.5 border-t border-emerald-900/10 pt-1.5 text-sm font-medium text-sky-600">
      <Icon className="size-3.5" /> {children}
    </div>
  );
}

function SystemChip({ children }: { children: ReactNode }) {
  return <div className="mx-auto rounded-md bg-white/80 px-2.5 py-1 text-center text-xs text-slate-600 shadow-sm">{children}</div>;
}

const time = <p className="mt-0.5 text-right text-[10px] text-slate-500">10:30 AM</p>;

/** How the business's automatic answer looks in WhatsApp. */
export function ReplyPreview({ action, names }: { action: AutoReply['action']; names?: { form?: string; flow?: string; template?: MessageTemplate } }) {
  const c = action.config ?? {};
  const text = (t?: string) => (t ? <p className="whitespace-pre-wrap">{sampleText(t)}</p> : <p className="text-slate-400">Write your message…</p>);
  switch (action.type) {
    case 'text':
      return <Bubble>{text(c.text)}{time}</Bubble>;
    case 'unsubscribe':
      return (
        <>
          <Bubble>{text(c.text)}{time}</Bubble>
          <SystemChip>Customer is unsubscribed from broadcasts</SystemChip>
        </>
      );
    case 'file': {
      const Icon = c.mediaType === 'video' ? Video : Paperclip;
      return (
        <Bubble>
          {c.mediaType === 'image' && c.link ? (
            <img src={c.link} alt="" className="mb-1 max-h-40 w-full rounded object-cover" />
          ) : (
            <div className="mb-1 flex items-center gap-2 rounded bg-white/60 p-2 text-xs text-slate-600">
              <Icon className="size-5" /> {c.filename || `${c.mediaType ?? 'File'}`}
            </div>
          )}
          {c.caption && <p className="whitespace-pre-wrap">{sampleText(c.caption)}</p>}
          {time}
        </Bubble>
      );
    }
    case 'quick_reply':
      return (
        <div className="ml-auto w-[85%] space-y-1">
          <Bubble className="max-w-full">
            {c.header && <p className="font-semibold">{c.header}</p>}
            {text(c.text)}
            {c.footer && <p className="mt-1 text-xs text-slate-500">{c.footer}</p>}
            {time}
          </Bubble>
          {(c.buttons ?? []).map((b: { title: string }, i: number) => (
            <div key={i} className="flex items-center justify-center gap-1.5 rounded-lg bg-white py-1.5 text-sm font-medium text-sky-600 shadow-sm">
              <Reply className="size-3.5" /> {b.title || 'Button'}
            </div>
          ))}
        </div>
      );
    case 'cta_url':
      return (
        <Bubble>
          {c.header && <p className="font-semibold">{c.header}</p>}
          {text(c.text)}
          {c.footer && <p className="mt-1 text-xs text-slate-500">{c.footer}</p>}
          {time}
          <ButtonRow icon={ExternalLink}>{c.buttonText || 'Open link'}</ButtonRow>
        </Bubble>
      );
    case 'form':
      return (
        <Bubble>
          {text(c.text || `Please fill in ${names?.form ?? 'this form'}.`)}
          {time}
          <ButtonRow icon={LayoutList}>{names?.form ?? 'Open form'}</ButtonRow>
        </Bubble>
      );
    case 'address':
      return (
        <Bubble>
          {text(c.text)}
          {time}
          <ButtonRow icon={Home}>Provide address</ButtonRow>
        </Bubble>
      );
    case 'location':
      return (
        <Bubble>
          <div className="mb-1 flex h-24 items-center justify-center rounded bg-emerald-100/70 text-emerald-700">
            <MapPin className="size-7" />
          </div>
          <p className="font-medium">{c.name || 'Location'}</p>
          {c.address && <p className="text-xs text-slate-600">{c.address}</p>}
          {time}
        </Bubble>
      );
    case 'chatbot':
      return <SystemChip>▶ Starts the chatbot flow “{names?.flow ?? 'chosen flow'}”</SystemChip>;
    case 'ai_chatbot':
      return <SystemChip>🤖 Your AI agent writes the answer from your knowledge base</SystemChip>;
    case 'template':
      return names?.template ? (
        <div className="ml-auto w-[85%]">
          <TemplatePreview components={names.template.components} />
        </div>
      ) : (
        <SystemChip>Choose a template</SystemChip>
      );
  }
}

/** A WhatsApp-style phone frame: the customer's message and the automatic answer. */
export function PhonePreview({ customerText, trigger, action, names }: { customerText: string; trigger: string; action: AutoReply['action']; names?: Parameters<typeof ReplyPreview>[0]['names'] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 shadow-sm">
      <div className="flex items-center gap-2.5 bg-[#075e54] px-3 py-2.5 text-white">
        <span className="flex size-8 items-center justify-center rounded-full bg-white/20">
          <Bot className="size-4" />
        </span>
        <div className="flex-1">
          <p className="text-sm font-semibold">Your Business</p>
          <p className="text-[11px] opacity-80">online</p>
        </div>
        <Signal className="size-3.5 opacity-80" />
        <Wifi className="size-3.5 opacity-80" />
      </div>
      <div className="wa-wallpaper flex max-h-80 min-h-56 flex-col gap-2 overflow-y-auto p-3">
        <span className="mx-auto rounded-md bg-white/80 px-2 py-0.5 text-[11px] text-slate-500 shadow-sm">Today</span>
        <span className="mx-auto inline-flex items-center gap-1 rounded-md bg-slate-500/70 px-2 py-0.5 text-[11px] text-white">
          <Zap className="size-3" /> Trigger: <strong>{trigger}</strong>
        </span>
        <div className="max-w-[80%] rounded-lg rounded-tl-none bg-white px-2.5 py-1.5 text-sm text-slate-800 shadow-sm">
          {customerText}
          {time}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <ReplyPreview action={action} names={names} />
        </div>
      </div>
      <div className="flex items-center gap-2 bg-slate-100 px-3 py-2">
        <span className="flex-1 rounded-full bg-white px-3 py-1.5 text-xs text-slate-400">Type a message</span>
        <span className="flex size-7 items-center justify-center rounded-full bg-[#075e54] text-white">
          <Send className="size-3.5" />
        </span>
      </div>
    </div>
  );
}

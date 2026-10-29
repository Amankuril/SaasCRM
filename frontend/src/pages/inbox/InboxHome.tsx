import { AlarmClock, ArrowLeft, AtSign, BellOff, BrainCircuit, CheckCircle2, ClipboardList, Hourglass, Keyboard, Layers, MessageSquareDot, PhoneCall, ShieldAlert, Sparkles, StickyNote, UserCheck, UserRound, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../components/ui';

interface Capability {
  icon: typeof Zap;
  title: string;
  text: string;
  soon?: boolean;
  onClick?: () => void;
}

/** What the right side shows before a chat is opened: what you can do once you open one. */
export function InboxHome({ ai, onShortcuts }: { ai: boolean; onShortcuts: () => void }) {
  const groups: { title: string; dot: string; items: Capability[] }[] = ai
    ? [
        {
          title: 'AI capabilities',
          dot: 'bg-violet-500',
          items: [
            { icon: Sparkles, title: 'AI Auto-Reply', text: 'Answers customers from your knowledge base' },
            { icon: ShieldAlert, title: 'Smart Escalation', text: "Hands over to a person when the AI can't help" },
            { icon: ClipboardList, title: 'Reply limits', text: 'Caps automatic replies per chat, then hands over' },
            { icon: BrainCircuit, title: 'Suggested replies', text: 'Drafts an answer for agents to review' },
          ],
        },
        {
          title: 'Conversation management',
          dot: 'bg-sky-500',
          items: [
            { icon: UserCheck, title: 'Assign', text: 'Route to the right agent' },
            { icon: Hourglass, title: 'Waiting for a person', text: 'Escalated chats wait until someone replies' },
            { icon: CheckCircle2, title: 'Resolve', text: 'Close it; the AI can greet them next time' },
            { icon: StickyNote, title: 'Hand-off notes', text: 'See why the AI handed the chat over' },
          ],
        },
      ]
    : [
        {
          title: 'Conversation actions',
          dot: 'bg-sky-500',
          items: [
            { icon: UserCheck, title: 'Assign', text: 'Route to the right agent' },
            { icon: CheckCircle2, title: 'Resolve', text: 'Mark conversation as done' },
            { icon: AlarmClock, title: 'Snooze', text: 'Hide a chat until later; replies wake it up' },
            { icon: Layers, title: 'Bulk Actions', text: 'Tick avatars to act on many chats at once' },
          ],
        },
        {
          title: 'Team collaboration',
          dot: 'bg-emerald-500',
          items: [
            { icon: StickyNote, title: 'Internal Notes', text: 'Private notes; @mention a teammate' },
            { icon: Zap, title: 'Canned Replies', text: 'Quick replies via / shortcut' },
            { icon: PhoneCall, title: 'Voice Call', text: 'Call customers from the inbox', soon: true },
            { icon: Keyboard, title: 'Keyboard Shortcuts', text: 'Press ? to see them all', onClick: onShortcuts },
          ],
        },
        {
          title: 'Intelligence & context',
          dot: 'bg-violet-500',
          items: [
            { icon: Sparkles, title: 'Suggested Reply', text: 'AI drafts an answer for you to review' },
            { icon: UserRound, title: 'Contact Details', text: 'Tags, stage and notes beside the chat' },
            { icon: MessageSquareDot, title: '24-hour window', text: 'Active vs Rolling Over: when templates are needed' },
            { icon: AtSign, title: 'Mentions', text: 'Chats where a teammate needs you' },
          ],
        },
      ];

  return (
    <div className="@container flex min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto w-full max-w-2xl rounded-3xl border border-slate-200">
        <div className="flex flex-col items-center border-b border-slate-100 px-6 py-10 text-center">
          <span className={cn('flex size-14 items-center justify-center rounded-2xl text-white', ai ? 'bg-violet-600' : 'bg-slate-700')}>
            <MessageSquareDot className="size-7" />
          </span>
          <h2 className="mt-4 text-2xl font-bold text-ink">{ai ? 'Team Inbox for AI Agent Chats' : 'Team Inbox'}</h2>
          <p className="mt-1 text-slate-500">Here&apos;s everything you can do once you open a chat.</p>
          <span className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-4 py-1.5 text-sm text-slate-600">
            <ArrowLeft className="size-3.5" /> Pick a chat from the list to begin
          </span>
        </div>
        <div className="space-y-6 px-5 py-6 @xl:px-10">
          {groups.map((g) => (
            <section key={g.title}>
              <h3 className="mb-2.5 flex items-center gap-2 text-xs font-bold tracking-wider text-slate-500 uppercase">
                <span className={cn('size-1.5 rounded-full', g.dot)} /> {g.title}
              </h3>
              <div className="grid gap-2.5 @lg:grid-cols-2">
                {g.items.map((c) => (
                  <Card key={c.title} c={c} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function Card({ c }: { c: Capability }) {
  const body: ReactNode = (
    <>
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
        {c.soon ? <BellOff className="size-4" /> : <c.icon className="size-4" />}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 font-semibold text-ink">
          {c.title}
          {c.soon && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">Soon</span>}
        </span>
        <span className="block text-sm text-slate-500">{c.text}</span>
      </span>
    </>
  );
  const cls = 'flex gap-3 rounded-xl border border-slate-200 p-3.5 text-left';
  return c.onClick ? (
    <button type="button" onClick={c.onClick} className={cn(cls, 'hover:border-slate-300 hover:bg-slate-50')}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}


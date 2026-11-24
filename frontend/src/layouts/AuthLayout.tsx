import { CheckCheck, Lock, ShieldHalf } from 'lucide-react';
import type { ReactNode } from 'react';
import { Logo } from '../components/Logo';
import { LegalLinks } from '../pages/PublicPage';

/** Business sign-in pages: the form on one side, a real exchange on the other. */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-full bg-white lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <main className="flex min-h-full flex-col px-4 py-6 sm:px-10">
        <Logo />
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          <h1 className="text-3xl leading-10 font-medium text-ink">{title}</h1>
          {subtitle && <div className="mt-1 text-sm text-slate-500">{subtitle}</div>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-6 text-sm text-slate-500">{footer}</div>}
        </div>
        <LegalLinks />
      </main>
      <aside className="wa-wallpaper hidden border-l border-slate-200 lg:flex lg:flex-col lg:justify-center lg:px-16 xl:px-24" aria-hidden>
        <p className="max-w-md text-2xl leading-8 font-medium text-ink">Every customer conversation of your business, answered from one WhatsApp desk</p>
        <ChatDay />
      </aside>
    </div>
  );
}

const DAY: { at: string; from: 'them' | 'us'; text: string; label?: string; read?: boolean }[] = [
  { at: '9:02 AM', from: 'us', label: 'Appointment reminder', text: 'Hi Priya, your cleaning is tomorrow at 11:30 AM with Dr. Mehta.', read: true },
  { at: '9:05 AM', from: 'them', text: 'Can I come at 12 instead?' },
  { at: '9:06 AM', from: 'us', label: 'Answered by Anita', text: 'Moved to 12:00 PM. See you then.', read: true },
  { at: '10:00 AM', from: 'us', label: 'Invoice due tomorrow', text: 'Hi Rahul, invoice INV-1042 of ₹4,500 is due on 1 Dec.' },
];

/** One morning at a clinic: a reminder, a reply, an answer, an invoice notice, with the ticks that tell how each went. */
function ChatDay() {
  return (
    <ol className="mt-10 max-w-md space-y-3 text-sm [@media(max-height:640px)]:hidden">
      {DAY.map((m) => (
        <li key={m.at + m.text} className={m.from === 'us' ? 'flex justify-end' : 'flex'}>
          <div className={`max-w-[85%] rounded-xl px-3 py-2 shadow-sm ${m.from === 'us' ? 'rounded-tr-sm bg-[#d9fdd3]' : 'rounded-tl-sm bg-white'}`}>
            {m.label && <p className="text-xs text-brand-700">{m.label}</p>}
            <p className="text-slate-800">{m.text}</p>
            <p className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-slate-500 tabular-nums">
              {m.at} {m.from === 'us' && <CheckCheck className={m.read ? 'size-3.5 text-read' : 'size-3.5 text-slate-400'} strokeWidth={1.75} />}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Super Admin portal: deliberately dark so it is never mistaken for the business login. */
export function AdminAuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-slate-950 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-between">
          <Logo light />
          <span className="inline-flex items-center gap-2 text-sm text-slate-300">
            <ShieldHalf className="size-4" strokeWidth={1.5} /> Super Admin
          </span>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:p-8">{children}</div>
        <p className="mt-6 flex items-center justify-center gap-2 text-center text-xs text-slate-300">
          <Lock className="size-3.5" strokeWidth={1.5} /> Restricted area. Repeated failed attempts lock sign-in for 30 minutes.
        </p>
      </div>
    </div>
  );
}

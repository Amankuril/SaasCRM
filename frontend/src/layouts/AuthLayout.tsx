import { BadgeCheck, Bot, CheckCheck, Lock, Megaphone, MessagesSquare, ShieldCheck, ShieldHalf } from 'lucide-react';
import type { ReactNode } from 'react';
import { Logo } from '../components/Logo';

const FEATURES = [
  { icon: MessagesSquare, title: 'One shared team inbox', text: 'Every WhatsApp chat in one place, assigned to the right person.' },
  { icon: Megaphone, title: 'Broadcasts that convert', text: 'Approved templates to thousands, with read and reply tracking.' },
  { icon: Bot, title: 'Automation and AI', text: 'Keyword triggers, flows, forms and an AI agent that never sleeps.' },
];

/** Business sign-in pages: brand panel on the left, the form on the right. */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-full bg-slate-50 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-emerald-700 via-emerald-800 to-teal-950 p-12 text-white lg:flex lg:flex-col">
        <div aria-hidden className="pointer-events-none absolute -top-32 -right-24 size-96 rounded-full bg-emerald-400/20 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-40 -left-20 size-96 rounded-full bg-teal-300/10 blur-3xl" />
        <Logo light />
        <div className="relative my-auto max-w-lg py-10">
          <h2 className="text-4xl leading-tight font-bold tracking-tight">Every customer conversation, in one WhatsApp workspace.</h2>
          <p className="mt-4 text-lg text-emerald-100/90">Sell, support and follow up with your customers on the app they already use.</p>
          <ul className="mt-10 space-y-5">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15">
                  <Icon className="size-5 text-emerald-200" />
                </span>
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="block text-sm text-emerald-100/80">{text}</span>
                </span>
              </li>
            ))}
          </ul>
          <ChatMock />
        </div>
        <p className="relative flex items-center gap-2 text-sm text-emerald-100/80">
          <ShieldCheck className="size-4" /> Protected by email verification and one active session per account.
        </p>
      </aside>

      <main className="flex min-h-full items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <Logo />
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-9">
            <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
            {subtitle && <div className="mt-1.5 text-sm text-slate-500">{subtitle}</div>}
            <div className="mt-7">{children}</div>
          </div>
          {footer && <div className="mt-6 text-center text-sm text-slate-500">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

/** A small, static WhatsApp-style exchange for the brand panel. */
function ChatMock() {
  return (
    <div aria-hidden className="mt-10 w-80 rounded-2xl bg-white/10 p-4 ring-1 ring-white/15 backdrop-blur [@media(max-height:820px)]:hidden">
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className="flex size-8 items-center justify-center rounded-full bg-emerald-400 text-xs font-bold text-emerald-950">SK</span>
        <span>
          <span className="block font-semibold">Smile Dental Clinic</span>
          <span className="flex items-center gap-1 text-xs text-emerald-100/80">
            <BadgeCheck className="size-3" /> Business account
          </span>
        </span>
      </div>
      <div className="space-y-2 text-sm">
        <p className="w-fit max-w-[85%] rounded-xl rounded-tl-none bg-white px-3 py-2 text-slate-800">Hi Priya! Your cleaning is booked for Fri, 11:30 AM. 🦷</p>
        <p className="ml-auto w-fit max-w-[85%] rounded-xl rounded-tr-none bg-[#d9fdd3] px-3 py-2 text-slate-800">
          Perfect, see you then!{' '}
          <span className="inline-flex translate-y-0.5 items-center text-sky-500">
            <CheckCheck className="size-3.5" />
          </span>
        </p>
      </div>
    </div>
  );
}

/** Super Admin portal: a deliberately different, dark look so it is never mistaken for the business login. */
export function AdminAuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden bg-slate-950 px-4 py-12">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.12),transparent_55%)]" />
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.06)_1px,transparent_1px)] bg-[size:40px_40px]" />
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex items-center justify-between">
          <Logo light />
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs font-semibold tracking-wide text-sky-300">
            <ShieldHalf className="size-3.5" /> SUPER ADMIN
          </span>
        </div>
        <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-7 shadow-2xl backdrop-blur sm:p-9">{children}</div>
        <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-slate-500">
          <Lock className="size-3.5" /> Restricted area. Repeated failed attempts lock sign-in for 30 minutes.
        </p>
      </div>
    </div>
  );
}

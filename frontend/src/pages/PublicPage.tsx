import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Clock, Mail, MessageCircle, Phone, type LucideIcon } from 'lucide-react';
import { Link, NavLink } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Logo';
import { Markdown } from '../components/Markdown';
import { Spinner, cn } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { formatDate } from '../lib/options';
import type { SitePage, SitePageSlug } from './admin/AdminContentPage';

export const LEGAL_LINKS: { slug: SitePageSlug; label: string }[] = [
  { slug: 'privacy', label: 'Privacy' },
  { slug: 'terms', label: 'Terms' },
  { slug: 'support', label: 'Support' },
];

/** Privacy, Terms and Support: public pages whose content is edited in the Super Admin panel. */
export function PublicPage({ slug }: { slug: SitePageSlug }) {
  const { status } = useAuth();
  const query = useQuery({ queryKey: ['site-page', slug], queryFn: () => api.get<{ page: SitePage }>(`/pages/${slug}`), retry: false });
  const page = query.data?.page;
  const missing = query.error instanceof ApiError && query.error.status === 404;

  return (
    <div className="min-h-full bg-slate-50">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
          <Link to="/" aria-label="Zeta Connect home">
            <Logo />
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {LEGAL_LINKS.map((l) => (
              <NavLink key={l.slug} to={`/${l.slug}`} className={({ isActive }) => cn('hidden rounded-md px-2.5 py-1.5 font-medium sm:block', isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-900')}>
                {l.label}
              </NavLink>
            ))}
            <Link to={status === 'authenticated' ? '/' : '/login'} className="ml-2 inline-flex h-9 items-center rounded-lg bg-slate-900 px-3.5 text-sm font-medium text-white hover:bg-slate-800">
              {status === 'authenticated' ? 'Open app' : 'Sign in'}
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
        <Link to={status === 'authenticated' ? '/' : '/login'} className="mb-6 inline-flex items-center gap-1.5 text-[13px] font-medium text-slate-500 hover:text-slate-900">
          <ArrowLeft className="size-4" /> Back
        </Link>
        {query.isPending ? (
          <Spinner />
        ) : missing || !page ? (
          <div className="rounded-2xl bg-white p-10 text-center ring-1 ring-slate-200">
            <p className="font-medium text-slate-900">{missing ? 'This page is not available right now.' : 'Could not load this page.'}</p>
            <p className="mt-1 text-sm text-slate-500">Please try again later.</p>
          </div>
        ) : (
          <article className="rounded-2xl bg-white px-6 py-8 shadow-[0_1px_3px_rgba(15,23,42,0.06)] ring-1 ring-slate-200 sm:px-12 sm:py-12">
            <p className="text-xs font-medium tracking-wide text-emerald-700 uppercase">Zeta Connect</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">{page.title}</h1>
            <p className="mt-2 text-sm text-slate-500">Last updated {formatDate(page.updatedAt)}</p>
            {page.contact && <ContactCards contact={page.contact} />}
            <div className="mt-8 border-t border-slate-100 pt-8 text-[15px]">
              <Markdown source={page.content} />
            </div>
          </article>
        )}
      </main>

      <footer className="border-t border-slate-200 py-6">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 text-sm text-slate-500 sm:px-6">
          <span>© {new Date().getFullYear()} Zeta Connect</span>
          <LegalLinks />
        </div>
      </footer>
    </div>
  );
}

function ContactCards({ contact }: { contact: NonNullable<SitePage['contact']> }) {
  const wa = contact.whatsapp?.replace(/[^\d]/g, '');
  const cards: { icon: LucideIcon; label: string; value: string; href?: string }[] = [];
  if (contact.email) cards.push({ icon: Mail, label: 'Email', value: contact.email, href: `mailto:${contact.email}` });
  if (contact.whatsapp) cards.push({ icon: MessageCircle, label: 'WhatsApp', value: contact.whatsapp, href: wa ? `https://wa.me/${wa}` : undefined });
  if (contact.phone) cards.push({ icon: Phone, label: 'Phone', value: contact.phone, href: `tel:${contact.phone.replace(/[^\d+]/g, '')}` });
  if (contact.hours) cards.push({ icon: Clock, label: 'Hours', value: contact.hours });
  if (cards.length === 0) return null;
  return (
    <div className="mt-8 grid gap-3 sm:grid-cols-2">
      {cards.map(({ icon: Icon, label, value, href }) => {
        const body = (
          <>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
              <Icon className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-xs text-slate-500">{label}</span>
              <span className="block truncate font-medium text-slate-900">{value}</span>
            </span>
          </>
        );
        return href ? (
          <a key={label} href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" className="flex items-center gap-3 rounded-xl p-4 ring-1 ring-slate-200 transition hover:ring-emerald-300 hover:bg-emerald-50/30">
            {body}
          </a>
        ) : (
          <div key={label} className="flex items-center gap-3 rounded-xl p-4 ring-1 ring-slate-200">
            {body}
          </div>
        );
      })}
    </div>
  );
}

/** "Privacy · Terms · Support", used under the business login forms. */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav className={cn('flex items-center gap-1 text-[13px]', className)} aria-label="Legal">
      {LEGAL_LINKS.map((l, i) => (
        <span key={l.slug} className="flex items-center gap-1">
          {i > 0 && <span className="text-slate-300">·</span>}
          <Link to={`/${l.slug}`} className="rounded px-1 text-slate-500 hover:text-slate-900">
            {l.label}
          </Link>
        </span>
      ))}
    </nav>
  );
}

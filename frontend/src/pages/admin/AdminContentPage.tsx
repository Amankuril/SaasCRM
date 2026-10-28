import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { AButton, AdminHeader, Panel, Segmented, Switch } from '../../components/admin';
import { Markdown } from '../../components/Markdown';
import { Alert, Field, Input, Spinner, errorMessage } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/options';

export type SitePageSlug = 'privacy' | 'terms' | 'support';

export interface SitePage {
  slug: SitePageSlug;
  title: string;
  content: string;
  contact: { email: string | null; phone: string | null; whatsapp: string | null; hours: string | null } | null;
  published?: boolean;
  updatedAt: string;
}

const INFO: Record<SitePageSlug, { name: string; path: string; description: string }> = {
  privacy: { name: 'Privacy policy', path: '/privacy', description: 'What data you collect from businesses and how you use it. Linked from the login and sign-up pages.' },
  terms: { name: 'Terms of service', path: '/terms', description: 'The rules businesses agree to by signing up. Linked from the login and sign-up pages.' },
  support: { name: 'Support', path: '/support', description: 'How businesses reach your team. Linked from the login and sign-up pages.' },
};

type Form = { title: string; content: string; published: boolean; contact: { email: string; phone: string; whatsapp: string; hours: string } };

function toForm(p: SitePage): Form {
  return {
    title: p.title,
    content: p.content,
    published: p.published ?? true,
    contact: { email: p.contact?.email ?? '', phone: p.contact?.phone ?? '', whatsapp: p.contact?.whatsapp ?? '', hours: p.contact?.hours ?? '' },
  };
}

/** /admin/content/:slug — edit the public Privacy, Terms and Support pages. */
export function AdminContentPage() {
  const slug = (useParams().slug ?? 'privacy') as SitePageSlug;
  const queryClient = useQueryClient();
  const pages = useQuery({ queryKey: ['admin', 'pages'], queryFn: () => api.get<{ pages: SitePage[] }>('/admin/pages') });
  const page = pages.data?.pages.find((p) => p.slug === slug);
  const [form, setForm] = useState<Form | null>(null);
  const [view, setView] = useState<'write' | 'preview'>('write');
  useEffect(() => {
    if (page) setForm(toForm(page));
  }, [page]);

  const save = useMutation({
    mutationFn: (f: Form) => api.put<{ page: SitePage }>(`/admin/pages/${slug}`, { title: f.title, content: f.content, published: f.published, ...(slug === 'support' ? { contact: f.contact } : {}) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'pages'] }),
  });

  const info = INFO[slug];
  if (!info) return <Alert>Unknown page.</Alert>;
  if (pages.error) return <Alert>{errorMessage(pages.error)}</Alert>;
  if (!page || !form) return <Spinner />;
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(page));

  return (
    <>
      <AdminHeader
        eyebrow="Content"
        title={info.name}
        description={info.description}
        actions={
          <>
            <a href={info.path} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900">
              <ExternalLink className="size-4" /> View live page
            </a>
            <AButton variant="primary" icon={Save} disabled={!dirty || !form.title.trim()} loading={save.isPending} onClick={() => save.mutate(form)}>
              {dirty ? 'Save changes' : 'Saved'}
            </AButton>
          </>
        }
      />
      <div className="space-y-5">
        {save.error != null && <Alert>{errorMessage(save.error)}</Alert>}

        <Panel>
          <div className="flex flex-wrap items-end gap-4 text-sm">
            <div className="min-w-64 flex-1">
              <Field label="Page title" htmlFor="cp-title">
                <Input id="cp-title" maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </Field>
            </div>
            <label className="flex items-center gap-3 pb-2">
              <Switch label="Published" checked={form.published} onChange={(v) => setForm({ ...form, published: v })} />
              <span className="text-slate-700">{form.published ? 'Published' : 'Hidden (link shows “not found”)'}</span>
            </label>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Live at <code className="rounded bg-slate-100 px-1 py-0.5">{window.location.origin}{info.path}</code> · last saved {formatDate(page.updatedAt, true)}
          </p>
        </Panel>

        {slug === 'support' && (
          <Panel title="Contact details" description="Shown as contact cards at the top of the Support page. Leave a field empty to hide it.">
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <Field label="Support email" htmlFor="cp-email">
                <Input id="cp-email" type="email" placeholder="support@yourcompany.com" value={form.contact.email} onChange={(e) => setForm({ ...form, contact: { ...form.contact, email: e.target.value } })} />
              </Field>
              <Field label="Phone" htmlFor="cp-phone">
                <Input id="cp-phone" placeholder="+91 98765 43210" value={form.contact.phone} onChange={(e) => setForm({ ...form, contact: { ...form.contact, phone: e.target.value } })} />
              </Field>
              <Field label="WhatsApp number" htmlFor="cp-wa" hint="With country code. Opens a chat on wa.me.">
                <Input id="cp-wa" placeholder="+91 98765 43210" value={form.contact.whatsapp} onChange={(e) => setForm({ ...form, contact: { ...form.contact, whatsapp: e.target.value } })} />
              </Field>
              <Field label="Support hours" htmlFor="cp-hours">
                <Input id="cp-hours" placeholder="Mon–Sat, 10 AM – 7 PM IST" value={form.contact.hours} onChange={(e) => setForm({ ...form, contact: { ...form.contact, hours: e.target.value } })} />
              </Field>
            </div>
          </Panel>
        )}

        <Panel
          flush
          title="Content"
          description="Formatting: # Heading, ## Subheading, - list item, 1. numbered item, **bold**, *italic*, [link text](https://…), --- for a divider."
          actions={
            <div className="lg:hidden">
              <Segmented
                value={view}
                onChange={setView}
                options={[
                  { value: 'write', label: 'Write' },
                  { value: 'preview', label: 'Preview' },
                ]}
              />
            </div>
          }
        >
          <div className="grid lg:grid-cols-2 lg:divide-x lg:divide-slate-100">
            <div className={view === 'preview' ? 'hidden lg:block' : undefined}>
              <textarea
                aria-label="Page content"
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                spellCheck
                className="block h-[560px] w-full resize-y border-0 bg-slate-50/40 p-5 font-mono text-[13px] leading-6 text-slate-800 focus:bg-white focus:ring-0 focus:outline-none"
              />
            </div>
            <div className={view === 'write' ? 'hidden lg:block' : undefined}>
              <div className="h-[560px] overflow-y-auto p-6">
                <p className="mb-4 text-[11px] font-medium tracking-wide text-slate-400 uppercase">Preview</p>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">{form.title || 'Untitled'}</h1>
                <div className="mt-4 text-[15px]">
                  <Markdown source={form.content || '*Nothing written yet.*'} />
                </div>
              </div>
            </div>
          </div>
          <div className="flex justify-end border-t border-slate-100 px-5 py-2 text-xs text-slate-400">{form.content.length.toLocaleString('en-IN')} / 60,000 characters</div>
        </Panel>
      </div>
    </>
  );
}

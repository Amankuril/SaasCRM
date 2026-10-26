import { BarChart3, Clock, Info, Lightbulb, ListChecks, Megaphone, Repeat, Rocket, Target, Users, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { cn } from '../../components/ui';
import { useWorkspace } from '../../layouts/workspaceContext';

const SECTIONS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: 'overview', label: 'Overview', icon: Info },
  { id: 'contacts', label: 'Contacts', icon: Users },
  { id: 'create-campaign', label: 'Create Campaign', icon: Megaphone },
  { id: 'campaign-list', label: 'Campaign List', icon: ListChecks },
  { id: 'retarget', label: 'Retarget Campaign', icon: Repeat },
];

function Section({ id, n, title, intro, children }: { id: string; n: number; title: string; intro: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
      <p className="text-sm font-semibold text-indigo-600">{String(n).padStart(2, '0')}</p>
      <h2 className="mt-1 text-2xl font-bold text-ink">{title}</h2>
      <p className="mt-3 text-slate-600">{intro}</p>
      <div className="mt-6 space-y-6">{children}</div>
    </section>
  );
}

function Callout({ tone = 'amber', icon: Icon = Lightbulb, children }: { tone?: 'amber' | 'sky' | 'emerald'; icon?: LucideIcon; children: ReactNode }) {
  const styles = { amber: 'border-amber-300 bg-amber-50 text-amber-950', sky: 'border-sky-200 bg-sky-50 text-sky-950', emerald: 'border-emerald-200 bg-emerald-50 text-emerald-950' }[tone];
  return (
    <div className={cn('flex gap-3 rounded-xl border-2 p-4 text-sm', styles)}>
      <Icon className="mt-0.5 size-5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

function Steps({ items }: { items: { title: string; body: ReactNode }[] }) {
  return (
    <ol className="space-y-3">
      {items.map((s, i) => (
        <li key={s.title} className="flex gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-sm font-semibold text-white">{i + 1}</span>
          <div className="pt-0.5 text-sm text-slate-700">
            <strong className="text-ink">{s.title}</strong> {s.body}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Card({ title, children, icon: Icon }: { title: string; children: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="rounded-xl border border-slate-200 p-4">
      <p className="flex items-center gap-2 font-semibold text-ink">
        {Icon && <Icon className="size-4 text-indigo-600" />}
        {title}
      </p>
      <div className="mt-1.5 text-sm text-slate-600">{children}</div>
    </div>
  );
}

const Bullets = ({ items }: { items: ReactNode[] }) => (
  <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
    {items.map((it, i) => (
      <li key={i}>{it}</li>
    ))}
  </ul>
);

/** Broadcast User Guide: how contact lists, campaigns and retargeting work here. */
export function BroadcastGuidePage() {
  const { workspace } = useWorkspace();
  const { hash } = useLocation();
  const [active, setActive] = useState(hash.slice(1) || 'overview');
  const base = `/w/${workspace.id}`;

  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: '0px 0px -70% 0px' },
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <nav className="space-y-1 rounded-2xl border border-slate-200 bg-white p-3 lg:sticky lg:top-0" aria-label="Guide sections">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            onClick={(e) => {
              e.preventDefault();
              setActive(s.id);
              document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            className={cn('flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium', active === s.id ? 'bg-indigo-500 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50')}
          >
            <s.icon className="size-4" /> {s.label}
          </a>
        ))}
      </nav>

      <div className="space-y-6">
        <header className="border-b-4 border-indigo-500 pb-6">
          <h1 className="text-3xl font-bold text-ink sm:text-4xl">Broadcast User Guide</h1>
          <p className="mt-2 text-lg text-slate-500">Master mass communication with WhatsApp Business</p>
        </header>

        <Section id="overview" n={1} title="Overview" intro="Broadcast sends an approved WhatsApp template to many contacts at once — ideal for offers, announcements and customer updates.">
          <Callout>
            <strong>Important:</strong> you need an approved WhatsApp template before creating a campaign. Create one under{' '}
            <Link to={`${base}/templates/new`} className="font-medium underline">
              Templates
            </Link>
            ; WhatsApp usually reviews it within minutes, sometimes up to 24–48 hours.
          </Callout>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card title="Track Performance" icon={BarChart3}>
              Delivery, read, reply and failure counts update live from WhatsApp.
            </Card>
            <Card title="Target Precisely" icon={Target}>
              Send to contact lists, tags or segments — or retarget by what happened last time.
            </Card>
            <Card title="Send or Schedule" icon={Clock}>
              Launch immediately or pick a date and time in your workspace's timezone.
            </Card>
          </div>
          <div className="rounded-2xl bg-gradient-to-br from-indigo-50 to-white p-5 ring-1 ring-indigo-100">
            <p className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Rocket className="size-5 text-indigo-600" /> Quick Start: your first broadcast in 3 minutes
            </p>
            <p className="mt-1 mb-4 text-sm text-slate-600">Goal: send a WhatsApp campaign to a list of contacts.</p>
            <Steps
              items={[
                { title: 'Create Campaign', body: '→ click "Create Campaign" in the Broadcast menu → enter a campaign name.' },
                { title: 'Select Audience', body: '→ pick one or more contact lists (create a list and upload a CSV first if you have none).' },
                { title: 'Choose Template', body: '→ select an approved WhatsApp template.' },
                { title: 'Fill Variables', body: '→ map {{1}}, {{2}}… to contact fields or fixed text (only if the template has variables).' },
                { title: 'Send or Schedule', body: '→ choose Send Now or a date and time, then Review & Send → Publish.' },
              ]}
            />
            <p className="mt-4 text-sm text-slate-700">
              ✨ <strong>Done!</strong> Track it in{' '}
              <Link to={`${base}/campaigns`} className="font-medium underline">
                Campaign List
              </Link>
              .
            </p>
          </div>
        </Section>

        <Section id="contacts" n={2} title="Contact Management" intro="Organize your audience into lists. One person can be in several lists but is stored only once.">
          <div className="grid gap-3 sm:grid-cols-3">
            <Card title="1 · All Lists">Your contact lists with their size, creation date and the tags most of their members carry.</Card>
            <Card title="2 · All Contacts">Everyone across your lists. Search by name or number, tick people and use Assign Lists.</Card>
            <Card title="3 · Unsubscribers">People who opted out (e.g. replied STOP). They are always skipped by campaigns.</Card>
          </div>
          <div>
            <p className="mb-2 font-semibold text-ink">Table columns (All Lists)</p>
            <Bullets
              items={[
                <>
                  <strong>List Name</strong> — the name you gave the list
                </>,
                <>
                  <strong>Count</strong> — how many contacts are in it
                </>,
                <>
                  <strong>Created On</strong> — when the list was created
                </>,
                <>
                  <strong>Tags</strong> — the most common tags among its contacts
                </>,
                <>
                  <strong>Actions</strong> — 👁 view the list (search, remove people, rename, delete) and ➕ add contacts
                </>,
              ]}
            />
          </div>
          <div>
            <p className="mb-2 font-semibold text-ink">Add contacts to a list (➕ icon)</p>
            <div className="grid gap-3 md:grid-cols-3">
              <Card title="Option 1 · One by One">
                <Bullets items={['Select the country code', 'Enter the WhatsApp number', 'Enter the customer name', 'Click Save Contact']} />
              </Card>
              <Card title="Option 2 · Bulk Upload">
                <Bullets items={['Download the sample CSV', 'Fill in name and number', 'Upload the file', 'See created / added / skipped rows']} />
              </Card>
              <Card title="Option 3 · Bulk (with Tags)">
                <Bullets items={['Same as Bulk Upload', 'Add a 3rd column with tags', 'Missing tags are created', 'Great for segmenting later']} />
              </Card>
            </div>
          </div>
          <Callout tone="sky" icon={Info}>
            <strong>CSV format:</strong> no header row. Column 1 = name, column 2 = number with country code and no “+” or spaces (e.g. <code>918757648374</code>), optional column 3 = tags
            separated by “;”. If your numbers have no country code, untick “Every number already includes its country code” and choose the country.
          </Callout>
          <p className="text-sm">
            <Link to={`${base}/broadcast`} className="font-medium text-indigo-600 hover:underline">
              Open Contacts List →
            </Link>
          </p>
        </Section>

        <Section id="create-campaign" n={3} title="Create Campaign" intro="Launch a broadcast with a guided, step-by-step form and a live preview.">
          <div className="space-y-4">
            <Card title="Step 1 · Business Info">
              <Bullets items={['Profile name: your WhatsApp business name, filled in automatically', 'Campaign name: a descriptive name for tracking, e.g. “Diwali Sale 2026”']} />
            </Card>
            <Card title="Step 2 · Target Customers">
              <Bullets
                items={[
                  'Open “Select contact lists…”, search, tick lists (or Select all) and click OK',
                  'The reachable count excludes people who unsubscribed',
                  'Need tags, a saved segment or everyone instead? Use the link under the list picker',
                ]}
              />
              <p className="mt-2 text-xs text-slate-500">For following up on an earlier campaign use Retarget Campaign (section 5).</p>
            </Card>
            <Card title="Step 3 · Template Customization">
              <p>
                <strong>3a. Choose template</strong> — select an approved template.
              </p>
              <p className="mt-2">
                <strong>3b. Update variables</strong> — map each variable to a contact field (with a fallback) or fixed text:
              </p>
              <div className="mt-2 rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700">
                Template: “Hi {'{{1}}'}, your order {'{{2}}'} will arrive on {'{{3}}'}!”
                <br />
                {'{{1}}'} = first name · {'{{2}}'} = #12345 · {'{{3}}'} = Dec 20
                <br />
                Result: “Hi John, your order #12345 will arrive on Dec 20!”
              </div>
              <p className="mt-2 text-xs text-slate-500">Templates with images, offer codes, links or carousels ask for those values here too.</p>
            </Card>
            <Card title="Step 4 · Schedule or Publish">
              <Bullets
                items={['Send Now — starts as soon as you publish', 'Schedule — pick a future date and time (your workspace timezone)', 'Sending options — messages per minute and quiet hours']}
              />
            </Card>
            <Card title="Step 5 · Assign Teammates (optional)">
              When a customer replies to the broadcast and their chat isn't assigned yet, it's assigned to these teammates in turn.
            </Card>
          </div>
          <Callout tone="emerald" icon={Rocket}>
            Click <strong>Review &amp; Send</strong> to see the exact number of recipients and a sample message, then <strong>Publish</strong> (or Schedule).
          </Callout>
        </Section>

        <Section id="campaign-list" n={4} title="Campaign List" intro="Track all campaigns and their performance in real time.">
          <div className="grid gap-3 sm:grid-cols-4">
            <Card title="Sent">Accepted by WhatsApp</Card>
            <Card title="Delivered">Reached the phone</Card>
            <Card title="Read">Opened by the customer</Card>
            <Card title="Failed">Not delivered</Card>
          </div>
          <div>
            <p className="mb-2 font-semibold text-ink">Campaign status</p>
            <Bullets
              items={[
                <>
                  <strong>Completed</strong> — finished sending to everyone
                </>,
                <>
                  <strong>Sending</strong> — in progress (pause or cancel anytime)
                </>,
                <>
                  <strong>Scheduled</strong> — waiting for its send time
                </>,
                <>
                  <strong>Paused</strong> — stopped by you, or automatically (e.g. template no longer approved, plan limit reached)
                </>,
                <>
                  <strong>Draft</strong> — not sent yet
                </>,
              ]}
            />
          </div>
          <div>
            <p className="mb-2 font-semibold text-ink">Actions</p>
            <Bullets items={['Template view — preview the template used', 'View analytics — funnel, replies and every recipient’s status', 'Retarget — follow up based on this campaign’s results', 'View — open the campaign (edit if it’s a draft)']} />
          </div>
        </Section>

        <Section id="retarget" n={5} title="Retarget Campaign" intro="Follow up with people based on what happened to an earlier campaign. It's separate from Create Campaign.">
          <Callout tone="sky" icon={Info}>
            <strong>How it works:</strong> open Retarget Campaign, choose a previous campaign and who to target, then finish the same steps as Create Campaign. Statuses come from WhatsApp's delivery receipts.
          </Callout>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card title="Read">Opened and read your message. Use case: thank-you or the next product recommendation.</Card>
            <Card title="Delivered">Received but not opened. Use case: a reminder with different wording or timing.</Card>
            <Card title="Sent">Everyone from the original campaign. Use case: an important update to the whole audience.</Card>
            <Card title="Failed">Not delivered (invalid number, blocked…). Use case: review and fix those contacts.</Card>
          </div>
          <Callout>
            <strong>Best practice:</strong> wait 24–48 hours after the original campaign before retargeting, so people have time to read it.
          </Callout>
          <p className="text-sm">
            <Link to={`${base}/broadcast/retarget`} className="font-medium text-indigo-600 hover:underline">
              Open Retarget Campaign →
            </Link>
          </p>
        </Section>
      </div>
    </div>
  );
}

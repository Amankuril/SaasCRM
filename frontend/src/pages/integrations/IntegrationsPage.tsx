import { ArrowRight, Blocks, Rocket, ShoppingCart } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../../components/ui';
import { useWorkspace } from '../../layouts/workspaceContext';

interface Integration {
  key: string;
  name: string;
  description: string;
  logo: ReactNode;
  /** Route inside the workspace; integrations without one are "coming soon". */
  to?: string;
}

const img = (file: string, alt: string, size = 'size-14') => <img src={`/integrations/${file}.svg`} alt={alt} className={size} />;
const mark = (text: string, className: string) => <span className={cn('text-3xl font-black tracking-tight', className)}>{text}</span>;

const INTEGRATIONS: Integration[] = [
  { key: 'zoho', name: 'Zoho', description: 'Import contacts and leads from Zoho CRM straight into your audience.', logo: img('zoho', 'Zoho', 'size-24') },
  {
    key: 'google-sheets',
    name: 'Google Sheets',
    description: 'Send a WhatsApp template automatically whenever a new row is added to your sheet.',
    logo: img('googlesheets', 'Google Sheets'),
    to: 'integrations/google-sheets',
  },
  { key: 'google-calendar', name: 'Google Calendar', description: 'Keep appointments booked here in sync with your Google Calendar.', logo: img('googlecalendar', 'Google Calendar') },
  { key: 'shopify', name: 'Shopify', description: 'Recover abandoned carts and send order and shipping updates from your store.', logo: img('shopify', 'Shopify') },
  { key: 'takeapp', name: 'TakeApp', description: 'Trigger WhatsApp messages when TakeApp orders are placed or updated.', logo: <ShoppingCart className="size-14 text-slate-800" strokeWidth={1.6} /> },
  { key: 'wortal', name: 'Wortal', description: 'Connect Wortal CRM to manage customer conversations on WhatsApp.', logo: mark('Wortal', 'bg-gradient-to-r from-red-500 via-amber-500 to-sky-600 bg-clip-text font-semibold text-transparent') },
  { key: 'shiprocket', name: 'Shiprocket', description: 'Send WhatsApp updates on every shipment status change.', logo: <span className="flex items-center gap-1 text-2xl font-semibold text-violet-700"><Rocket className="size-7" /> Shiprocket</span> },
  { key: 'tradeindia', name: 'TradeIndia', description: 'Fetch new buyer enquiries from TradeIndia and reply on WhatsApp instantly.', logo: mark('TI', 'text-orange-600') },
  { key: 'indiamart', name: 'IndiaMART', description: 'Turn IndiaMART leads into WhatsApp conversations automatically.', logo: mark('IM', 'text-red-700') },
  { key: 'woocommerce', name: 'WooCommerce', description: 'Order confirmations and abandoned cart reminders for your WooCommerce store.', logo: img('woocommerce', 'WooCommerce') },
  { key: 'razorpay', name: 'Razorpay', description: 'Send payment links and payment confirmations on WhatsApp.', logo: img('razorpay', 'Razorpay') },
  { key: 'zapier', name: 'Zapier', description: 'Connect thousands of apps to WhatsApp without writing code.', logo: img('zapier', 'Zapier') },
];

export function IntegrationsPage() {
  const { workspace } = useWorkspace();
  return (
    <>
      <div className="mb-6 flex items-start gap-3">
        <span className="rounded-xl bg-emerald-50 p-2.5 text-emerald-600 ring-1 ring-emerald-100">
          <Blocks className="size-5" />
        </span>
        <div>
          <h1 className="text-xl font-semibold text-ink">Integration Marketplace</h1>
          <p className="text-sm text-slate-500">Connect your favorite tools to streamline your workflow.</p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {INTEGRATIONS.map((i) => (
          <article key={i.key} className={cn('flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white transition', i.to && 'hover:border-emerald-300 hover:shadow-md')}>
            <div className="flex h-32 items-center justify-center">{i.logo}</div>
            <div className="flex-1 px-5 pb-4">
              <h2 className="text-lg font-semibold text-ink">{i.name}</h2>
              <p className="mt-1.5 text-sm text-slate-500">{i.description}</p>
            </div>
            <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3.5">
              {i.to ? (
                <>
                  <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">Available</span>
                  <Link to={`/w/${workspace.id}/${i.to}`} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50">
                    Connect <ArrowRight className="size-4" />
                  </Link>
                </>
              ) : (
                <>
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">Coming soon</span>
                  <span className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 py-1.5 text-sm font-medium text-slate-400" aria-disabled="true">
                    Connect <ArrowRight className="size-4" />
                  </span>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

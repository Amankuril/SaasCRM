import { Copy, ExternalLink, FileText, Gift, Image as ImageIcon, List, MapPin, Phone, PhoneCall, Reply, ShoppingBag, Video } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TemplateButton, TemplateComponent } from '../lib/api';
import { cn } from './ui';

/** Renders a template roughly as it looks in WhatsApp, with optional sample values. */
export function TemplatePreview({
  components,
  headerParams = [],
  bodyParams = [],
  mediaUrl,
  cardMediaUrls = [],
  cardBodyParams = [],
}: {
  components: TemplateComponent[];
  headerParams?: string[];
  bodyParams?: string[];
  /** Local preview (object URL) of a header image/video that is not uploaded yet. */
  mediaUrl?: string;
  cardMediaUrls?: (string | undefined)[];
  cardBodyParams?: string[][];
}) {
  const find = (type: TemplateComponent['type']) => components.find((c) => c.type.toUpperCase() === type);
  const body = find('BODY');
  const carousel = find('CAROUSEL');
  const callPermission = find('CALL_PERMISSION_REQUEST');
  const buttons = find('BUTTONS')?.buttons ?? [];

  return (
    <div className="wa-wallpaper rounded-xl p-4">
      <div className="max-w-[280px]">
        <Bubble components={components} headerParams={headerParams} bodyParams={bodyParams} mediaUrl={mediaUrl} showBodyPlaceholder={!body?.add_security_recommendation} />
        <Buttons buttons={buttons} />
        {callPermission && (
          <div className="mt-1 rounded-lg bg-white p-3 text-sm shadow-sm">
            <p className="flex items-center gap-1.5 font-medium text-slate-800">
              <PhoneCall className="size-4 text-emerald-600" /> Allow calls from this business?
            </p>
            <p className="mt-1 text-xs text-slate-500">You can change this anytime in chat settings.</p>
            <div className="mt-2 grid grid-cols-2 gap-1 text-center text-xs font-medium text-sky-600">
              <span className="rounded bg-slate-50 py-1.5">Always allow</span>
              <span className="rounded bg-slate-50 py-1.5">Not now</span>
            </div>
          </div>
        )}
      </div>
      {carousel?.cards && carousel.cards.length > 0 && (
        <div className="-mx-1 mt-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {carousel.cards.map((card, i) => (
            <div key={i} className="w-[200px] shrink-0">
              <Bubble components={card.components} bodyParams={cardBodyParams[i] ?? []} mediaUrl={cardMediaUrls[i]} compact />
              <Buttons buttons={card.components.find((c) => c.type.toUpperCase() === 'BUTTONS')?.buttons ?? []} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Bubble({
  components,
  headerParams = [],
  bodyParams = [],
  mediaUrl,
  compact = false,
  showBodyPlaceholder = true,
}: {
  components: TemplateComponent[];
  headerParams?: string[];
  bodyParams?: string[];
  mediaUrl?: string;
  compact?: boolean;
  showBodyPlaceholder?: boolean;
}) {
  const find = (type: TemplateComponent['type']) => components.find((c) => c.type.toUpperCase() === type);
  const header = find('HEADER');
  const offer = find('LIMITED_TIME_OFFER')?.limited_time_offer;
  const body = find('BODY');
  const footer = find('FOOTER');
  // Saved templates carry the sample values given at submission; use them when none are passed.
  const bodyValues = bodyParams.length ? bodyParams : (body?.example?.body_text?.[0] ?? []);
  const headerValues = headerParams.some(Boolean) ? headerParams : (header?.example?.header_text ?? []);

  const bodyText = body?.add_security_recommendation !== undefined
    ? `*123456* is your verification code.${body.add_security_recommendation ? ' For your security, do not share this code.' : ''}`
    : body?.text;
  const footerText = footer?.code_expiration_minutes ? `This code expires in ${footer.code_expiration_minutes} minutes.` : footer?.text;

  return (
    <div className={cn('rounded-lg bg-white p-1.5 text-sm shadow-sm', !compact && 'rounded-tl-none')}>
      {header && <HeaderView header={header} params={headerValues} mediaUrl={mediaUrl} />}
      {offer && (
        <div className="mx-1 mt-1 flex items-center gap-2 rounded-md bg-slate-50 p-2">
          <span className="rounded-full bg-emerald-100 p-1.5 text-emerald-700">
            <Gift className="size-4" />
          </span>
          <div>
            <p className="font-semibold text-slate-900">{offer.text || 'Offer headline'}</p>
            {offer.has_expiration && <p className="text-xs text-slate-500">Ends in 2 days</p>}
          </div>
        </div>
      )}
      <div className="px-1.5 pt-1">
        <p className="whitespace-pre-wrap break-words text-slate-800">
          {bodyText ? formatWhatsApp(fill(bodyText, bodyValues)) : showBodyPlaceholder && <span className="text-slate-400">Message body…</span>}
        </p>
        {footerText && <p className="mt-1 text-xs text-slate-500">{footerText}</p>}
        <p className="text-right text-[10px] text-slate-400">12:00</p>
      </div>
    </div>
  );
}

function HeaderView({ header, params, mediaUrl }: { header: TemplateComponent; params: string[]; mediaUrl?: string }) {
  const format = (header.format ?? 'TEXT').toUpperCase();
  if (format === 'TEXT') return header.text ? <p className="px-1.5 pt-1 font-semibold text-slate-900">{fill(header.text, params)}</p> : null;

  const sample = header.example?.header_handle?.[0];
  const url = mediaUrl ?? (sample && /^https?:\/\//.test(sample) ? sample : undefined);
  if (format === 'IMAGE' && url) return <img src={url} alt="" className="aspect-[1.91/1] w-full rounded-md object-cover" />;
  if (format === 'VIDEO' && url) return <video src={url} className="aspect-[1.91/1] w-full rounded-md bg-black object-cover" muted />;
  if (format === 'DOCUMENT') {
    return (
      <div className="flex items-center gap-2 rounded-md bg-slate-100 p-2.5 text-xs text-slate-600">
        <FileText className="size-6 text-red-500" />
        <span className="font-medium">Document.pdf</span>
      </div>
    );
  }
  const Icon = format === 'VIDEO' ? Video : format === 'LOCATION' ? MapPin : ImageIcon;
  return (
    <div className="flex aspect-[1.91/1] w-full flex-col items-center justify-center gap-1 rounded-md bg-slate-100 text-xs text-slate-400">
      <Icon className="size-7" />
      {format === 'LOCATION' ? 'Location' : `${format.charAt(0)}${format.slice(1).toLowerCase()} header`}
    </div>
  );
}

const BUTTON_ICON: Record<string, typeof Reply> = {
  URL: ExternalLink,
  PHONE_NUMBER: Phone,
  COPY_CODE: Copy,
  OTP: Copy,
  FLOW: List,
  CATALOG: ShoppingBag,
  MPM: ShoppingBag,
};

export function buttonLabel(b: TemplateButton): string {
  if (b.type.toUpperCase() === 'COPY_CODE') return 'Copy offer code';
  return b.text || 'Button';
}

function Buttons({ buttons }: { buttons: TemplateButton[] }) {
  if (!buttons.length) return null;
  // WhatsApp folds more than 3 buttons into "See all options".
  const shown = buttons.length > 3 ? buttons.slice(0, 2) : buttons;
  return (
    <div className="mt-0.5 space-y-0.5">
      {shown.map((b, i) => {
        const Icon = BUTTON_ICON[b.type.toUpperCase()] ?? Reply;
        return (
          <div key={i} className="flex items-center justify-center gap-1.5 rounded-lg bg-white py-2 text-sm font-medium text-sky-600 shadow-sm">
            <Icon className="size-3.5" />
            {buttonLabel(b)}
          </div>
        );
      })}
      {buttons.length > 3 && (
        <div className="flex items-center justify-center gap-1.5 rounded-lg bg-white py-2 text-sm font-medium text-sky-600 shadow-sm">
          <List className="size-3.5" /> See all options
        </div>
      )}
    </div>
  );
}

function fill(text: string, params: string[]) {
  return text.replace(/\{\{(\d+)\}\}/g, (match, n: string) => params[Number(n) - 1]?.trim() || match);
}

/** WhatsApp's inline formatting: *bold*, _italic_, ~strike~, ```mono```. */
function formatWhatsApp(text: string): ReactNode[] {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|```[^`]+```)/g);
  return parts.map((p, i) => {
    if (/^\*[^*]+\*$/.test(p)) return <strong key={i}>{p.slice(1, -1)}</strong>;
    if (/^_[^_]+_$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>;
    if (/^~[^~]+~$/.test(p)) return <s key={i}>{p.slice(1, -1)}</s>;
    if (/^```[^`]+```$/.test(p)) return <code key={i} className="font-mono text-xs">{p.slice(3, -3)}</code>;
    return p;
  });
}

const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray' | 'blue'> = {
  APPROVED: 'green',
  PENDING: 'amber',
  IN_APPEAL: 'amber',
  REJECTED: 'red',
  PAUSED: 'gray',
  DISABLED: 'gray',
  DRAFT: 'blue',
  PENDING_DELETION: 'red',
};

export function templateTone(status: string) {
  return STATUS_TONE[status] ?? 'gray';
}

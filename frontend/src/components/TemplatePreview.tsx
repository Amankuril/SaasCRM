import { ExternalLink, Phone, Reply } from 'lucide-react';
import type { TemplateComponent } from '../lib/api';

/** Renders a template roughly as it looks in WhatsApp, with optional sample values. */
export function TemplatePreview({
  components,
  headerParams = [],
  bodyParams = [],
}: {
  components: TemplateComponent[];
  headerParams?: string[];
  bodyParams?: string[];
}) {
  const header = components.find((c) => c.type === 'HEADER');
  const body = components.find((c) => c.type === 'BODY');
  const footer = components.find((c) => c.type === 'FOOTER');
  const buttons = components.find((c) => c.type === 'BUTTONS')?.buttons ?? [];

  return (
    <div className="rounded-xl bg-[#e5ddd5] p-4">
      <div className="max-w-xs rounded-lg rounded-tl-none bg-white p-2.5 text-sm shadow-sm">
        {header?.format === 'TEXT' && header.text && <p className="mb-1 font-semibold text-slate-900">{fill(header.text, headerParams)}</p>}
        {header && header.format !== 'TEXT' && <p className="mb-1 rounded bg-slate-100 py-6 text-center text-xs text-slate-500">{header.format} header</p>}
        <p className="whitespace-pre-wrap text-slate-800">{body?.text ? fill(body.text, bodyParams) : <span className="text-slate-400">Message body…</span>}</p>
        {footer?.text && <p className="mt-1 text-xs text-slate-500">{footer.text}</p>}
        <p className="mt-1 text-right text-[10px] text-slate-400">12:00</p>
      </div>
      {buttons.length > 0 && (
        <div className="mt-1 max-w-xs space-y-1">
          {buttons.map((b, i) => (
            <div key={i} className="flex items-center justify-center gap-1.5 rounded-lg bg-white py-2 text-sm font-medium text-sky-600 shadow-sm">
              {b.type === 'URL' ? <ExternalLink className="size-3.5" /> : b.type === 'PHONE_NUMBER' ? <Phone className="size-3.5" /> : <Reply className="size-3.5" />}
              {b.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fill(text: string, params: string[]) {
  return text.replace(/\{\{(\d+)\}\}/g, (match, n: string) => params[Number(n) - 1]?.trim() || match);
}

const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray'> = {
  APPROVED: 'green',
  PENDING: 'amber',
  IN_APPEAL: 'amber',
  REJECTED: 'red',
  PAUSED: 'gray',
  DISABLED: 'gray',
};

export function templateTone(status: string) {
  return STATUS_TONE[status] ?? 'gray';
}

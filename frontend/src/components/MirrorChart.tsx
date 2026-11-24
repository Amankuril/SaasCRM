import { useEffect, useRef, useState } from 'react';

export interface MirrorDay {
  day: string;
  sent: number;
  received: number;
}

const SENT = '#0a7d55';
const RECEIVED = '#2a78d6';
const H = 300;
const PAD = { top: 16, right: 8, bottom: 28, left: 40 };

function niceMax(v: number) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => v / s <= 2)!;
  // Even, so the half-way gridline is a whole number of messages.
  const top = Math.ceil(v / step) * step;
  return top + (top % 2);
}

const label = (d: string, long = false) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(long ? { weekday: 'long' } : {}) });

/** A conversation has two sides: what the business sent rises above the line, what customers sent hangs below it. */
export function MirrorChart({ days }: { days: MirrorDay[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(260, e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [asTable]);

  const max = niceMax(Math.max(0, ...days.flatMap((d) => [d.sent, d.received])));
  const innerW = width - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const mid = PAD.top + innerH / 2;
  const scale = innerH / 2 / max;
  const slot = innerW / Math.max(1, days.length);
  const barW = Math.min(24, Math.max(6, slot * 0.5));
  const cx = (i: number) => PAD.left + slot * i + slot / 2;
  const every = Math.ceil(days.length / Math.max(2, Math.floor(innerW / 64)));
  // Rounded outer end, flat at the shared baseline.
  const bar = (x: number, h: number, up: boolean) => {
    const r = Math.min(4, h, barW / 2);
    const y0 = up ? mid - 1 : mid + 1;
    const y1 = up ? y0 - h : y0 + h;
    const s = up ? 1 : -1;
    return `M${x},${y0}V${y1 + r * s}Q${x},${y1} ${x + r},${y1}H${x + barW - r}Q${x + barW},${y1} ${x + barW},${y1 + r * s}V${y0}Z`;
  };
  const h = hover !== null ? days[hover] : null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-slate-600">
        <span className="flex items-center gap-2">
          <span className="size-2.5 rounded-xs" style={{ background: SENT }} /> Sent
        </span>
        <span className="flex items-center gap-2">
          <span className="size-2.5 rounded-xs" style={{ background: RECEIVED }} /> Received
        </span>
        <button type="button" onClick={() => setAsTable(!asTable)} className="ml-auto text-sm text-slate-500 hover:text-ink">
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-[300px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="py-2 font-normal">Day</th>
                <th className="py-2 text-right font-normal">Sent</th>
                <th className="py-2 text-right font-normal">Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {days.map((d) => (
                <tr key={d.day}>
                  <td className="py-1.5 text-slate-700">{label(d.day)}</td>
                  <td className="py-1.5 text-right">{d.sent}</td>
                  <td className="py-1.5 text-right">{d.received}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrap} className="relative min-w-0">
          <svg width={width} height={H} role="img" aria-label="Messages sent and received per day" className="block max-w-full" onPointerLeave={() => setHover(null)}>
            {[max, max / 2, -max / 2, -max].map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={width - PAD.right} y1={mid - v * scale} y2={mid - v * scale} stroke="var(--color-slate-100)" />
                <text x={PAD.left - 8} y={mid - v * scale} dy="0.32em" textAnchor="end" className="fill-slate-400 text-[11px] tabular-nums">
                  {Math.abs(v).toLocaleString('en-IN')}
                </text>
              </g>
            ))}
            {hover !== null && <rect x={cx(hover) - slot / 2} y={PAD.top} width={slot} height={innerH} fill="var(--color-slate-100)" rx={4} />}
            <line x1={PAD.left} x2={width - PAD.right} y1={mid} y2={mid} stroke="var(--color-slate-300)" />
            {days.map((d, i) => (
              <g key={d.day}>
                {d.sent > 0 && <path d={bar(cx(i) - barW / 2, Math.max(2, d.sent * scale - 1), true)} fill={SENT} />}
                {d.received > 0 && <path d={bar(cx(i) - barW / 2, Math.max(2, d.received * scale - 1), false)} fill={RECEIVED} />}
                {((days.length - 1 - i) % every === 0) && (
                  <text x={cx(i)} y={H - 8} textAnchor="middle" className="fill-slate-400 text-[11px]">
                    {label(d.day)}
                  </text>
                )}
                <rect x={cx(i) - slot / 2} y={PAD.top} width={slot} height={innerH} fill="transparent" onPointerEnter={() => setHover(i)} />
              </g>
            ))}
          </svg>
          {h && hover !== null && (
            <div className="pointer-events-none absolute top-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs whitespace-nowrap shadow-md" style={cx(hover) > width / 2 ? { right: width - cx(hover) + slot / 2 + 4 } : { left: cx(hover) + slot / 2 + 4 }}>
              <p className="font-medium text-ink">{label(h.day, true)}</p>
              <p className="mt-1 text-slate-600 tabular-nums">{h.sent.toLocaleString('en-IN')} sent</p>
              <p className="text-slate-600 tabular-nums">{h.received.toLocaleString('en-IN')} received</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

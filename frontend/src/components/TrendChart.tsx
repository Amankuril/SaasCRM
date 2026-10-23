import { useEffect, useRef, useState } from 'react';
import { cn } from './ui';

export interface TrendSeries {
  key: string;
  label: string;
  /** Categorical slot color (validated palette: #2a78d6, #eb6834). */
  color: string;
  values: number[];
}

const H = 220;
const PAD = { top: 12, right: 16, bottom: 28, left: 40 };

function niceMax(v: number) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => v / s <= 4)!;
  return Math.ceil(v / step) * step;
}

/**
 * Multi-series line chart over days: one y-axis, 2px lines, recessive grid,
 * crosshair + tooltip on hover, legend, and a table view for exact numbers.
 */
export function TrendChart({ days, series, title }: { days: string[]; series: TrendSeries[]; title: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const innerW = width - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (days.length <= 1 ? innerW / 2 : (i / (days.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const labelEvery = Math.ceil(days.length / Math.max(2, Math.floor(innerW / 70)));
  const short = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.min(days.length - 1, Math.max(0, Math.round(rel * (days.length - 1)))));
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-4 text-xs text-slate-600" aria-label={`${title} legend`}>
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
        <button onClick={() => setAsTable(!asTable)} className="text-xs font-medium text-brand-700 hover:underline">
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {asTable ? (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-1.5 font-medium">Day</th>
                {series.map((s) => (
                  <th key={s.key} className="px-3 py-1.5 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {days.map((d, i) => (
                <tr key={d}>
                  <td className="px-3 py-1">{short(d)}</td>
                  {series.map((s) => (
                    <td key={s.key} className="px-3 py-1 text-right tabular-nums">
                      {s.values[i]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrap} className="relative">
          <svg width={width} height={H} role="img" aria-label={title} className="block">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth={1} />
                <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-slate-400 text-[10px]">
                  {Number.isInteger(t) ? t.toLocaleString('en-IN') : t.toFixed(1)}
                </text>
              </g>
            ))}
            {days.map((d, i) =>
              i % labelEvery === 0 || i === days.length - 1 ? (
                <text key={d} x={x(i)} y={H - 8} textAnchor="middle" className="fill-slate-400 text-[10px]">
                  {short(d)}
                </text>
              ) : null,
            )}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" />}
            {series.map((s) => (
              <g key={s.key}>
                <polyline fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
                {hover !== null && <circle cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4} fill={s.color} stroke="white" strokeWidth={2} />}
              </g>
            ))}
            <rect
              x={PAD.left}
              y={PAD.top}
              width={innerW}
              height={innerH}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
              style={{ cursor: 'crosshair' }}
            />
          </svg>
          {hover !== null && (
            <div
              className={cn('pointer-events-none absolute top-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md')}
              style={x(hover) > width / 2 ? { right: width - x(hover) + 10 } : { left: x(hover) + 10 }}
            >
              <p className="mb-1 font-medium text-slate-800">{short(days[hover]!)}</p>
              {series.map((s) => (
                <p key={s.key} className="flex items-center gap-1.5 text-slate-600">
                  <span className="size-2 rounded-full" style={{ background: s.color }} />
                  {s.label}: <span className="font-medium text-slate-800 tabular-nums">{s.values[hover]}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

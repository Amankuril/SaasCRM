import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '../../components/ui';

/**
 * Drag handle that sits in the 12px gap between two cards and resizes one of them.
 * `side="left"` resizes the card before it (drag right to widen), `side="right"` the
 * card after it (drag left to widen). Arrow keys nudge it; double-click resets.
 */
export function PanelResizeHandle({
  side,
  width,
  min,
  max,
  fallback,
  onChange,
  label,
}: {
  side: 'left' | 'right';
  width: number | null;
  min: number;
  max: number;
  fallback: number;
  onChange: (w: number | null) => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));
  const target = () => (side === 'left' ? ref.current?.previousElementSibling : ref.current?.nextElementSibling) as HTMLElement | null | undefined;
  // The card's live width is the starting point until the user has set one.
  const current = () => width ?? target()?.getBoundingClientRect().width ?? fallback;
  const sign = side === 'left' ? 1 : -1;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = current();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    // Keep the resize cursor and stop text selection everywhere while dragging.
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (ev: PointerEvent) => onChange(clamp(startW + sign * (ev.clientX - startX)));
    const up = () => {
      setDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(width ?? fallback)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={() => onChange(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          onChange(clamp(current() + sign * (e.key === 'ArrowRight' ? 16 : -16)));
        }
      }}
      // Sits in the 12px gap between the cards without changing the spacing.
      className={cn('group relative -mx-[9px] w-1.5 shrink-0 cursor-col-resize touch-none items-center justify-center focus:outline-none', side === 'left' ? 'hidden md:flex' : 'hidden xl:flex')}
    >
      <span className={cn('h-full w-0.5 rounded-full transition-colors', dragging ? 'bg-brand-500' : 'bg-transparent group-hover:bg-slate-300 group-focus-visible:bg-brand-500')} />
      <span className={cn('absolute h-8 w-1.5 rounded-full transition-colors', dragging ? 'bg-brand-500' : 'bg-slate-300 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')} />
    </div>
  );
}

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ConsentStatus, LifecycleStage, StageColor, Tag, TagColor } from '../lib/api';
import { useStages } from '../lib/hooks';
import { useWorkspace } from '../layouts/workspaceContext';
import { cn } from './ui';

/** Dot, text and soft background classes per stage colour. */
export const STAGE_TONE: Record<StageColor, { dot: string; text: string; soft: string }> = {
  green: { dot: 'bg-emerald-500', text: 'text-emerald-600', soft: 'bg-emerald-50 text-emerald-700' },
  orange: { dot: 'bg-orange-500', text: 'text-orange-600', soft: 'bg-orange-50 text-orange-700' },
  amber: { dot: 'bg-amber-500', text: 'text-amber-600', soft: 'bg-amber-50 text-amber-800' },
  yellow: { dot: 'bg-yellow-500', text: 'text-yellow-600', soft: 'bg-yellow-50 text-yellow-800' },
  blue: { dot: 'bg-blue-500', text: 'text-blue-600', soft: 'bg-blue-50 text-blue-700' },
  indigo: { dot: 'bg-indigo-500', text: 'text-indigo-600', soft: 'bg-indigo-50 text-indigo-700' },
  violet: { dot: 'bg-violet-500', text: 'text-violet-600', soft: 'bg-violet-50 text-violet-700' },
  pink: { dot: 'bg-pink-500', text: 'text-pink-600', soft: 'bg-pink-50 text-pink-700' },
  red: { dot: 'bg-red-500', text: 'text-red-600', soft: 'bg-red-50 text-red-700' },
  teal: { dot: 'bg-teal-500', text: 'text-teal-600', soft: 'bg-teal-50 text-teal-700' },
  gray: { dot: 'bg-slate-400', text: 'text-slate-600', soft: 'bg-slate-100 text-slate-700' },
};

/** The workspace's stages as select options (was a fixed list before stages became editable). */
export function useStageOptions(): { value: LifecycleStage; label: string; tone: string }[] {
  const { workspace } = useWorkspace();
  const stages = useStages(workspace.id);
  return (stages.data ?? []).map((s) => ({ value: s.key, label: s.name, tone: STAGE_TONE[s.color]?.soft ?? STAGE_TONE.gray.soft }));
}

export const CONSENT_LABEL: Record<ConsentStatus, string> = { unknown: 'Unknown', opted_in: 'Opted in', opted_out: 'Opted out' };

const TAG_TONES: Record<TagColor, string> = {
  gray: 'bg-slate-100 text-slate-700',
  red: 'bg-red-100 text-red-700',
  amber: 'bg-amber-100 text-amber-800',
  green: 'bg-emerald-100 text-emerald-800',
  blue: 'bg-sky-100 text-sky-800',
  violet: 'bg-violet-100 text-violet-800',
  pink: 'bg-pink-100 text-pink-800',
};
export const TAG_COLORS = Object.keys(TAG_TONES) as TagColor[];

export function StageBadge({ stage }: { stage: LifecycleStage }) {
  const s = useStageOptions().find((x) => x.value === stage);
  return <span className={cn('inline-flex rounded-md px-2 py-0.5 text-xs font-medium', s?.tone ?? STAGE_TONE.gray.soft)}>{s?.label ?? stage}</span>;
}

export function TagChip({ tag, onRemove }: { tag: Pick<Tag, 'name' | 'color'>; onRemove?: () => void }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', TAG_TONES[tag.color])}>
      {tag.name}
      {onRemove && (
        <button type="button" onClick={onRemove} className="opacity-60 hover:opacity-100" aria-label={`Remove ${tag.name}`}>
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:items-center" onClick={onClose}>
      <div
        className={cn('w-full rounded-2xl bg-white p-5 shadow-xl sm:p-6', wide ? 'max-w-3xl' : 'max-w-md')}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-slate-500 hover:bg-slate-100" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('') || '?'
  );
}

export function relativeTime(value: string | null): string {
  if (!value) return '';
  const diff = Date.now() - new Date(value).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** `light`: white text, for dark backgrounds. */
export function Logo({ compact = false, light = false }: { compact?: boolean; light?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-brand-600" />
        <path d="M10 11h12l-12 10h12" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {!compact && (
        <span className={`text-base font-semibold tracking-tight ${light ? 'text-white' : 'text-ink'}`}>
          Zeta <span className={light ? 'text-emerald-300' : 'text-brand-600'}>Connect</span>
        </span>
      )}
    </div>
  );
}

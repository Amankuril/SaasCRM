import { Eye, EyeOff, TriangleAlert } from 'lucide-react';
import { useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { cn } from './ui';

/** Password field with show/hide and a Caps Lock warning. */
export function PasswordInput({ className, dark = false, ...props }: InputHTMLAttributes<HTMLInputElement> & { dark?: boolean }) {
  const [visible, setVisible] = useState(false);
  const [caps, setCaps] = useState(false);
  const checkCaps = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.('CapsLock') ?? false);
  return (
    <div>
      <div className="relative">
        <input
          {...props}
          type={visible ? 'text' : 'password'}
          onKeyDown={(e) => {
            checkCaps(e);
            props.onKeyDown?.(e);
          }}
          onKeyUp={checkCaps}
          onBlur={(e) => {
            setCaps(false);
            props.onBlur?.(e);
          }}
          className={cn(
            'block w-full rounded-xl border px-3.5 py-2.5 pr-11 text-sm shadow-sm transition focus:ring-2 focus:outline-none',
            dark ? 'border-slate-700 bg-slate-900 text-white placeholder:text-slate-500 focus:border-sky-500 focus:ring-sky-500/30' : 'border-slate-300 bg-white text-ink focus:border-brand-500 focus:ring-brand-500/20',
            className,
          )}
        />
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          className={cn('absolute inset-y-0 right-0 flex w-11 items-center justify-center', dark ? 'text-slate-400 hover:text-white' : 'text-slate-400 hover:text-slate-700')}
          aria-label={visible ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {caps && (
        <p className={cn('mt-1.5 flex items-center gap-1 text-xs', dark ? 'text-amber-300' : 'text-amber-700')}>
          <TriangleAlert className="size-3.5" /> Caps Lock is on
        </p>
      )}
    </div>
  );
}

/** Text input styled to match the auth pages. */
export function AuthInput({ className, dark = false, ...props }: InputHTMLAttributes<HTMLInputElement> & { dark?: boolean }) {
  return (
    <input
      {...props}
      className={cn(
        'block w-full rounded-xl border px-3.5 py-2.5 text-sm shadow-sm transition focus:ring-2 focus:outline-none',
        dark ? 'border-slate-700 bg-slate-900 text-white placeholder:text-slate-500 focus:border-sky-500 focus:ring-sky-500/30' : 'border-slate-300 bg-white text-ink placeholder:text-slate-400 focus:border-brand-500 focus:ring-brand-500/20',
        className,
      )}
    />
  );
}

/** Six boxes for the emailed login code; typing moves along, pasting fills them all. */
export function OtpInput({ value, onChange, onComplete, disabled, invalid }: { value: string; onChange: (v: string) => void; onComplete?: (v: string) => void; disabled?: boolean; invalid?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? '');
  const set = (next: string) => {
    const clean = next.replace(/\D/g, '').slice(0, 6);
    onChange(clean);
    if (clean.length === 6) onComplete?.(clean);
  };
  const focus = (i: number) => refs.current[Math.max(0, Math.min(5, i))]?.focus();
  return (
    <div className="flex justify-center gap-2 sm:gap-2.5" role="group" aria-label="6-digit code">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          disabled={disabled}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          aria-label={`Digit ${i + 1}`}
          maxLength={6}
          autoFocus={i === 0}
          onFocus={(e) => e.target.select()}
          onPaste={(e) => {
            e.preventDefault();
            set(e.clipboardData.getData('text'));
            focus(e.clipboardData.getData('text').replace(/\D/g, '').length);
          }}
          onChange={(e) => {
            const typed = e.target.value.replace(/\D/g, '');
            if (!typed) return set(value.slice(0, i) + value.slice(i + 1));
            // Autofill can drop the whole code into one box.
            if (typed.length > 1) {
              set(value.slice(0, i) + typed);
              return focus(i + typed.length);
            }
            set(value.slice(0, i) + typed + value.slice(i + 1));
            focus(i + 1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !d) focus(i - 1);
            if (e.key === 'ArrowLeft') focus(i - 1);
            if (e.key === 'ArrowRight') focus(i + 1);
          }}
          className={cn(
            'size-11 rounded-xl border-2 bg-white text-center text-xl font-semibold text-ink shadow-sm transition focus:ring-4 focus:outline-none sm:size-12 sm:text-2xl',
            invalid ? 'border-red-400 focus:border-red-500 focus:ring-red-500/15' : d ? 'border-brand-500 focus:border-brand-600 focus:ring-brand-500/20' : 'border-slate-200 focus:border-brand-500 focus:ring-brand-500/20',
          )}
        />
      ))}
    </div>
  );
}

const STRENGTH = [
  { label: 'Too short', color: 'bg-red-500', text: 'text-red-600' },
  { label: 'Weak', color: 'bg-red-500', text: 'text-red-600' },
  { label: 'Fair', color: 'bg-amber-500', text: 'text-amber-600' },
  { label: 'Good', color: 'bg-emerald-500', text: 'text-emerald-600' },
  { label: 'Strong', color: 'bg-emerald-600', text: 'text-emerald-700' },
];

/** 0–4: length plus variety of character kinds. */
export function passwordScore(pw: string): number {
  if (pw.length < 8) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  return Math.min(4, Math.max(1, kinds - 1 + (pw.length >= 12 ? 1 : 0)));
}

export function PasswordStrength({ password }: { password: string }) {
  if (!password) return null;
  const score = passwordScore(password);
  const s = STRENGTH[score]!;
  return (
    <div className="mt-2">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={cn('h-1 flex-1 rounded-full', score >= n ? s.color : 'bg-slate-200')} />
        ))}
      </div>
      <p className={cn('mt-1 text-xs', s.text)}>
        {s.label}
        {score < 3 && <span className="text-slate-500"> · use 12+ characters with upper and lower case, numbers and symbols</span>}
      </p>
    </div>
  );
}

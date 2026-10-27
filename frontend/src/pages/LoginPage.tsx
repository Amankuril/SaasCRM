import { ArrowLeft, ArrowRight, Loader2, LogIn, Mail, MonitorSmartphone, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { AuthInput, OtpInput, PasswordInput } from '../components/auth';
import { Alert, Button, errorMessage } from '../components/ui';
import { ApiError, type LoginChallenge } from '../lib/api';
import { AuthLayout } from '../layouts/AuthLayout';

export function LoginPage() {
  const [params] = useSearchParams();
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [email, setEmail] = useState(params.get('email') ?? '');
  return challenge ? (
    <CodeStep challenge={challenge} onRestart={() => setChallenge(null)} onResent={(c) => setChallenge(c)} />
  ) : (
    <PasswordStep email={email} setEmail={setEmail} onChallenge={setChallenge} />
  );
}

function PasswordStep({ email, setEmail, onChallenge }: { email: string; setEmail: (v: string) => void; onChallenge: (c: LoginChallenge) => void }) {
  const { login, endedReason, clearEndedReason } = useAuth();
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      onChallenge(await login(email.trim(), password));
      clearEndedReason();
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Log in to manage your WhatsApp conversations."
      footer={
        <>
          New to Zeta Connect?{' '}
          <Link to={`/signup?${params.toString()}`} className="font-semibold text-brand-700 hover:underline">
            Create a free account
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {endedReason === 'replaced' && (
          <Alert tone="info">
            <span className="flex gap-2">
              <MonitorSmartphone className="mt-0.5 size-4 shrink-0" />
              Your account was logged in on another browser or tab, so you were signed out here.
            </span>
          </Alert>
        )}
        {endedReason === 'expired' && <Alert tone="info">Your session expired. Please log in again.</Alert>}
        {error != null && <Alert>{errorMessage(error)}</Alert>}
        <div className="space-y-1.5">
          <label htmlFor="email" className="block text-sm font-medium text-slate-700">
            Work email
          </label>
          <AuthInput id="email" type="email" autoComplete="email" autoFocus={!email} placeholder="you@company.com" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="password" className="block text-sm font-medium text-slate-700">
            Password
          </label>
          <PasswordInput id="password" autoComplete="current-password" autoFocus={!!email} placeholder="Your password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <Button type="submit" className="w-full rounded-xl py-3 text-base" loading={submitting} disabled={!email.trim() || !password}>
          Continue <ArrowRight className="size-4" />
        </Button>
        <p className="flex items-center justify-center gap-1.5 text-xs text-slate-500">
          <ShieldCheck className="size-3.5 text-brand-600" /> We'll email you a 6-digit code to confirm it's you.
        </p>
      </form>
    </AuthLayout>
  );
}

function useCountdown(seconds: number, key: unknown) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [seconds, key]);
  return left;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function CodeStep({ challenge, onRestart, onResent }: { challenge: LoginChallenge; onRestart: () => void; onResent: (c: LoginChallenge) => void }) {
  const { verifyLogin, resendCode } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [elsewhere, setElsewhere] = useState<{ device: string; lastSeenAt: string } | null>(null);
  const expiresIn = useCountdown(challenge.expiresInSeconds, challenge);
  const resendIn = useCountdown(challenge.resendInSeconds, challenge);
  const expired = error instanceof ApiError && error.code === 'CHALLENGE_EXPIRED';

  async function submit(value = code, force = false) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // GuestOnly redirects to ?next once the user is authenticated.
      await verifyLogin(challenge.challengeToken, force ? undefined : value, force);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SESSION_ACTIVE') setElsewhere(err.details as unknown as { device: string; lastSeenAt: string });
      else {
        setError(err);
        if (err instanceof ApiError && err.code === 'INVALID_CODE') setCode('');
      }
      setBusy(false);
    }
  }

  async function resend() {
    setResending(true);
    setError(null);
    try {
      const r = await resendCode(challenge.challengeToken);
      onResent({ ...challenge, ...r });
      setCode('');
      setResent(true);
    } catch (err) {
      setError(err);
    }
    setResending(false);
  }

  return (
    <AuthLayout
      title="Check your email"
      subtitle={
        <>
          We sent a 6-digit code to <b className="text-slate-700">{challenge.email}</b>.
        </>
      }
      footer={
        <button type="button" onClick={onRestart} className="inline-flex items-center gap-1 font-medium text-slate-600 hover:text-ink">
          <ArrowLeft className="size-4" /> Use a different account
        </button>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-6"
      >
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
          <Mail className="size-7" />
        </div>
        {resent && !error && <Alert tone="success">A new code is on its way.</Alert>}
        {error != null && <Alert>{errorMessage(error)}</Alert>}
        <OtpInput value={code} onChange={setCode} onComplete={(v) => void submit(v)} disabled={busy || expired} invalid={error instanceof ApiError && error.code === 'INVALID_CODE'} />
        {expired ? (
          <Button type="button" className="w-full rounded-xl py-3" onClick={onRestart}>
            Log in again
          </Button>
        ) : (
          <Button type="submit" className="w-full rounded-xl py-3 text-base" loading={busy} disabled={code.length !== 6}>
            Verify &amp; log in
          </Button>
        )}
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">{expiresIn > 0 ? <>Code expires in {mmss(expiresIn)}</> : 'Code expired'}</span>
          <button type="button" onClick={() => void resend()} disabled={resendIn > 0 || resending || expired} className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
            {resending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
          </button>
        </div>
        <p className="text-center text-xs text-slate-400">Can't find it? Check your spam or promotions folder.</p>
      </form>

      {elsewhere && <ActiveSessionDialog info={elsewhere} busy={busy} onCancel={() => setElsewhere(null)} onConfirm={() => void submit(code, true)} />}
    </AuthLayout>
  );
}

function ago(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? 'just now' : `${Math.round(s / 60)} min ago`;
}

/** "Already logged in elsewhere": the other session closes if the user continues here. */
function ActiveSessionDialog({ info, busy, onCancel, onConfirm }: { info: { device: string; lastSeenAt: string }; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="session-title">
      <div className="w-full max-w-sm rounded-3xl bg-white p-6 text-center shadow-2xl">
        <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 ring-1 ring-amber-100">
          <MonitorSmartphone className="size-7" />
        </span>
        <h2 id="session-title" className="mt-4 text-lg font-bold text-ink">
          Already logged in elsewhere
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          This account is open in another session (<b>{info.device}</b>, active {ago(info.lastSeenAt)}). Only one session can be open at a time.
        </p>
        <p className="mt-2 text-sm text-slate-600">Close that session and log in here?</p>
        <div className="mt-6 grid gap-2">
          <Button className="w-full rounded-xl py-2.5" loading={busy} onClick={onConfirm}>
            <LogIn className="size-4" /> Close it &amp; log in here
          </Button>
          <Button variant="ghost" className="w-full rounded-xl" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

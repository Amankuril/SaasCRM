import { KeyRound, Lock, ShieldAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { AuthInput, PasswordInput } from '../components/auth';
import { Button, errorMessage } from '../components/ui';
import { ApiError } from '../lib/api';
import { AdminAuthLayout } from '../layouts/AuthLayout';

/** Super Admin login (/admin/login): password only, stricter lockout. Business users log in at /login. */
export function AdminLoginPage() {
  const { adminLogin } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // The server refuses non-admin accounts here; AdminGuestOnly then opens /admin.
      await adminLogin(email.trim(), password);
    } catch (err) {
      setError(err);
      setPassword('');
      setSubmitting(false);
    }
  }

  const locked = error instanceof ApiError && (error.code === 'LOGIN_LOCKED' || error.code === 'RATE_LIMITED');

  return (
    <AdminAuthLayout>
      <div className="mb-7 flex items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-sky-500/10 text-sky-300 ring-1 ring-sky-500/30">
          <KeyRound className="size-5" />
        </span>
        <div>
          <h1 className="text-xl font-bold text-white">Administrator sign in</h1>
          <p className="text-sm text-slate-400">Platform administrators only.</p>
        </div>
      </div>
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {error != null && (
          <div role="alert" className={`flex gap-2 rounded-xl border px-3.5 py-3 text-sm ${locked ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-red-500/30 bg-red-500/10 text-red-200'}`}>
            {locked ? <Lock className="mt-0.5 size-4 shrink-0" /> : <ShieldAlert className="mt-0.5 size-4 shrink-0" />}
            {errorMessage(error)}
          </div>
        )}
        <div className="space-y-1.5">
          <label htmlFor="admin-email" className="block text-sm font-medium text-slate-300">
            Admin email
          </label>
          <AuthInput dark id="admin-email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="admin-password" className="block text-sm font-medium text-slate-300">
            Password
          </label>
          <PasswordInput dark id="admin-password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <Button type="submit" className="w-full rounded-xl bg-sky-600 py-3 text-base hover:bg-sky-500 focus-visible:outline-sky-500" loading={submitting} disabled={!email.trim() || !password}>
          <Lock className="size-4" /> Sign in securely
        </Button>
      </form>
    </AdminAuthLayout>
  );
}

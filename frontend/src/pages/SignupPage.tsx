import { ArrowRight, Check } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { AuthInput, PasswordInput, PasswordStrength } from '../components/auth';
import { Alert, Button, cn, errorMessage, fieldError } from '../components/ui';
import { ApiError } from '../lib/api';
import { AuthLayout } from '../layouts/AuthLayout';

const RULES = [
  { label: 'At least 8 characters', test: (p: string) => p.length >= 8 },
  { label: 'A letter and a number', test: (p: string) => /[A-Za-z]/.test(p) && /\d/.test(p) },
];

export function SignupPage() {
  const { signup } = useAuth();
  const [params] = useSearchParams();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signup(name.trim(), email.trim(), password);
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  }

  const isFieldError = error instanceof ApiError && error.code === 'VALIDATION_ERROR';
  const rulesOk = RULES.every((r) => r.test(password));
  const fieldErr = (k: string) => fieldError(error, k) && <p className="text-xs text-red-600">{fieldError(error, k)}</p>;

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Start sending WhatsApp messages your customers actually read."
      footer={
        <>
          Already have an account?{' '}
          <Link to={`/login?${params.toString()}`} className="font-semibold text-brand-700 hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {error != null && !isFieldError && <Alert>{errorMessage(error)}</Alert>}
        <div className="space-y-1.5">
          <label htmlFor="name" className="block text-sm font-medium text-slate-700">
            Your name
          </label>
          <AuthInput id="name" autoComplete="name" autoFocus placeholder="Full name" required value={name} onChange={(e) => setName(e.target.value)} />
          {fieldErr('name')}
        </div>
        <div className="space-y-1.5">
          <label htmlFor="email" className="block text-sm font-medium text-slate-700">
            Work email
          </label>
          <AuthInput id="email" type="email" autoComplete="email" placeholder="you@company.com" required value={email} onChange={(e) => setEmail(e.target.value)} />
          {fieldErr('email')}
        </div>
        <div className="space-y-1.5">
          <label htmlFor="password" className="block text-sm font-medium text-slate-700">
            Password
          </label>
          <PasswordInput id="password" autoComplete="new-password" placeholder="Create a password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <PasswordStrength password={password} />
          <ul className="grid gap-1 pt-1 sm:grid-cols-2">
            {RULES.map((r) => (
              <li key={r.label} className={cn('flex items-center gap-1.5 text-xs', r.test(password) ? 'text-emerald-700' : 'text-slate-500')}>
                <span className={cn('flex size-4 items-center justify-center rounded-full', r.test(password) ? 'bg-emerald-100' : 'bg-slate-100')}>
                  <Check className="size-3" />
                </span>
                {r.label}
              </li>
            ))}
          </ul>
          {fieldErr('password')}
        </div>
        <label className="flex items-start gap-2.5 text-sm text-slate-600">
          <input type="checkbox" className="mt-0.5 size-4 rounded accent-emerald-600" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>I agree to use WhatsApp messaging responsibly and only contact customers who opted in.</span>
        </label>
        <Button type="submit" className="w-full rounded-xl py-3 text-base" loading={submitting} disabled={!name.trim() || !email.trim() || !rulesOk || !agreed}>
          Create account <ArrowRight className="size-4" />
        </Button>
      </form>
    </AuthLayout>
  );
}

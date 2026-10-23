import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Field, Input, errorMessage } from '../components/ui';
import { AuthLayout } from '../layouts/AuthLayout';

export function LoginPage() {
  const { login } = useAuth();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
      // GuestOnly redirects to ?next once the user is authenticated.
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Log in to your account"
      subtitle={
        <>
          New to Zeta Connect?{' '}
          <Link to={`/signup?${params.toString()}`} className="font-medium text-brand-700 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error != null && <Alert>{errorMessage(error)}</Alert>}
        <Field label="Work email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" className="w-full" loading={submitting}>
          Log in
        </Button>
      </form>
    </AuthLayout>
  );
}

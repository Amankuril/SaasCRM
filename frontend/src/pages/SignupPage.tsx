import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Field, Input, errorMessage, fieldError } from '../components/ui';
import { ApiError } from '../lib/api';
import { AuthLayout } from '../layouts/AuthLayout';

export function SignupPage() {
  const { signup } = useAuth();
  const [params] = useSearchParams();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signup(name, email, password);
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  }

  const isFieldError = error instanceof ApiError && error.code === 'VALIDATION_ERROR';

  return (
    <AuthLayout
      title="Create your account"
      subtitle={
        <>
          Already have an account?{' '}
          <Link to={`/login?${params.toString()}`} className="font-medium text-brand-700 hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error != null && !isFieldError && <Alert>{errorMessage(error)}</Alert>}
        <Field label="Your name" htmlFor="name" error={fieldError(error, 'name')}>
          <Input id="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Work email" htmlFor="email" error={fieldError(error, 'email')}>
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password" error={fieldError(error, 'password')} hint="At least 8 characters.">
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" className="w-full" loading={submitting}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}

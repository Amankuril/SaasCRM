import { ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Field, Input, errorMessage } from '../components/ui';
import { AuthLayout } from '../layouts/AuthLayout';

/** Super Admin login (/admin/login). Business users log in at /login. */
export function AdminLoginPage() {
  const { login } = useAuth();
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
      await login(email, password, 'admin');
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Super Admin login"
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="size-4 text-brand-600" /> Platform administrators only.
        </span>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error != null && <Alert>{errorMessage(error)}</Alert>}
        <Field label="Email" htmlFor="admin-email">
          <Input id="admin-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="admin-password">
          <Input id="admin-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" loading={submitting}>
          Log in
        </Button>
      </form>
    </AuthLayout>
  );
}

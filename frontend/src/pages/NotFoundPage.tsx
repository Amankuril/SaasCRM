import { Link } from 'react-router';
import { Logo } from '../components/Logo';

export function NotFoundPage({ message = "This page doesn't exist or you don't have access to it." }: { message?: string }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 px-4 text-center">
      <Logo />
      <h1 className="text-lg font-semibold text-ink">Page not found</h1>
      <p className="max-w-sm text-sm text-slate-500">{message}</p>
      <Link to="/" className="text-sm font-medium text-brand-700 hover:underline">
        Go to my workspace
      </Link>
    </div>
  );
}

import { CircleAlert, RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui';

interface Props {
  children: ReactNode;
  /** Changing it clears the error (e.g. the current path: moving to another page recovers). */
  resetKey?: string;
}

/** A page that crashes shows what happened and a way out, instead of a blank screen. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page crashed', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // A tab left open across a deploy asks for files that no longer exist.
    const stale = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(error.message);
    return (
      <div className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center" role="alert">
        <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-red-200 bg-red-50 text-red-600">
          <CircleAlert className="size-5" strokeWidth={1.5} />
        </div>
        <p className="text-base font-medium text-ink">{stale ? 'This page was updated' : 'This page ran into a problem'}</p>
        <p className="mt-1 max-w-md text-sm text-slate-500">{stale ? 'Reload to get the latest version.' : 'Your data is safe. Try again, or reload if it keeps happening.'}</p>
        {!stale && <p className="mt-3 max-w-lg rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs break-words text-slate-600">{error.message}</p>}
        <div className="mt-5 flex gap-2">
          {!stale && (
            <Button variant="secondary" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          )}
          <Button onClick={() => window.location.reload()}>
            <RefreshCw className="size-4" strokeWidth={1.5} /> Reload
          </Button>
        </div>
      </div>
    );
  }
}

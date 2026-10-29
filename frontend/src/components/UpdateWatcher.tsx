import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { Button } from './ui';

const BUILD_ID: string | undefined = import.meta.env.VITE_BUILD_ID;
const CHECK_EVERY_MS = 30_000;
const RELOADED_KEY = 'zeta-chunk-reload';

/** True when the deployed build (dist/version.json) differs from the one running in this tab. */
async function newBuildDeployed(): Promise<boolean> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return false;
    const { buildId } = (await res.json()) as { buildId?: string };
    return !!buildId && buildId !== BUILD_ID;
  } catch {
    return false;
  }
}

/**
 * Picks up a new deploy without a manual refresh. Production only.
 * - Checks every 30s and whenever the tab regains focus.
 * - A hidden tab, or the next page change, reloads straight away (nothing to lose).
 * - While the person is on a page, a small bar offers "Reload" so a half-filled form is not wiped.
 * - A lazy chunk that 404s (deleted by the deploy) reloads once to fetch the new build.
 */
export function UpdateWatcher() {
  const [available, setAvailable] = useState(false);
  const availableRef = useRef(false);
  const location = useLocation();
  const firstPath = useRef(location.pathname);

  useEffect(() => {
    if (!import.meta.env.PROD || !BUILD_ID) return;
    const check = async () => {
      if (availableRef.current || !(await newBuildDeployed())) return;
      if (document.visibilityState === 'hidden') return window.location.reload();
      availableRef.current = true;
      setAvailable(true);
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (availableRef.current) return window.location.reload();
      void check();
    };
    const onPreloadError = (e: Event) => {
      // Reload at most once per minute so a genuinely broken deploy cannot loop.
      const last = Number(sessionStorage.getItem(RELOADED_KEY) ?? 0);
      if (Date.now() - last < 60_000) return;
      e.preventDefault();
      sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
      window.location.reload();
    };
    void check();
    const timer = setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('vite:preloadError', onPreloadError);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('vite:preloadError', onPreloadError);
    };
  }, []);

  // Navigating to another page: load it from the new build.
  useEffect(() => {
    if (location.pathname !== firstPath.current && availableRef.current) window.location.reload();
    firstPath.current = location.pathname;
  }, [location.pathname]);

  if (!available) return null;
  return (
    <div className="fixed inset-x-0 bottom-4 z-[90] flex justify-center px-4" role="status">
      <div className="flex items-center gap-3 rounded-2xl bg-ink px-4 py-2.5 text-sm text-white shadow-2xl">
        <span>A new version of Zeta Connect is available.</span>
        <Button className="rounded-xl py-1.5" onClick={() => window.location.reload()}>
          <RefreshCw className="size-4" /> Reload
        </Button>
      </div>
    </div>
  );
}

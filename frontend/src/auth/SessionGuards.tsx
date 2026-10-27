import { AppWindow, LogIn, MonitorSmartphone } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '../components/ui';
import { useAuth } from './AuthContext';

type TabMessage = { type: 'ping'; from: string } | { type: 'pong'; from: string } | { type: 'takeover'; from: string };

const CHANNEL = 'zeta-connect-tabs';
/** How long a new tab listens for an already-open tab before taking over. */
const PING_WAIT_MS = 400;

/**
 * One business tab at a time. A newly opened tab asks the others whether one
 * is active; if so it offers "Use here", which hands the session over and puts
 * the other tab to sleep (with its own "Use here" to take it back).
 * The Super Admin portal is exempt.
 */
export function SingleTabGuard() {
  const { status } = useAuth();
  const location = useLocation();
  const enabled = status === 'authenticated' && !location.pathname.startsWith('/admin') && typeof BroadcastChannel !== 'undefined';
  const [state, setState] = useState<'checking' | 'active' | 'elsewhere' | 'taken'>('checking');
  const tabId = useRef(Math.random().toString(36).slice(2));
  const channel = useRef<BroadcastChannel | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!enabled) return;
    const ch = new BroadcastChannel(CHANNEL);
    channel.current = ch;
    const post = (m: TabMessage) => ch.postMessage(m);
    ch.onmessage = (e: MessageEvent<TabMessage>) => {
      const m = e.data;
      if (m.from === tabId.current) return;
      if (m.type === 'ping' && stateRef.current === 'active') post({ type: 'pong', from: tabId.current });
      if (m.type === 'pong' && stateRef.current === 'checking') setState('elsewhere');
      if (m.type === 'takeover' && stateRef.current === 'active') setState('taken');
    };
    setState('checking');
    post({ type: 'ping', from: tabId.current });
    const t = setTimeout(() => setState((s) => (s === 'checking' ? 'active' : s)), PING_WAIT_MS);
    return () => {
      clearTimeout(t);
      ch.close();
      channel.current = null;
    };
  }, [enabled]);

  const useHere = () => {
    channel.current?.postMessage({ type: 'takeover', from: tabId.current } satisfies TabMessage);
    setState('active');
  };

  if (!enabled || state === 'active' || state === 'checking') return null;
  return (
    <BlockingDialog
      icon={<AppWindow className="size-7" />}
      title={state === 'taken' ? 'Opened in another tab' : 'Already open in another tab'}
      body={
        state === 'taken'
          ? 'Zeta Connect is now being used in another tab. Only one tab can be used at a time.'
          : 'Zeta Connect is already open in another tab of this browser. Only one tab can be used at a time, so the other tab will be paused.'
      }
      action={
        <Button className="w-full rounded-xl py-2.5" onClick={useHere}>
          <LogIn className="size-4" /> Use here instead
        </Button>
      }
    />
  );
}

/** Shown when this tab's session was closed because the account logged in somewhere else. */
export function SessionReplacedDialog() {
  const { endedReason, clearEndedReason } = useAuth();
  const navigate = useNavigate();
  if (endedReason !== 'replaced') return null;
  return (
    <BlockingDialog
      icon={<MonitorSmartphone className="size-7" />}
      title="You've been logged out"
      body="Your account was just logged in on another browser or tab. Only one session can be open at a time, so this one was closed."
      action={
        <Button
          className="w-full rounded-xl py-2.5"
          onClick={() => {
            clearEndedReason();
            navigate('/login', { replace: true });
          }}
        >
          <LogIn className="size-4" /> Log in again
        </Button>
      }
    />
  );
}

function BlockingDialog({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm" role="alertdialog" aria-modal="true" aria-labelledby="guard-title">
      <div className="w-full max-w-sm rounded-3xl bg-white p-6 text-center shadow-2xl">
        <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 ring-1 ring-amber-100">{icon}</span>
        <h2 id="guard-title" className="mt-4 text-lg font-bold text-ink">
          {title}
        </h2>
        <p className="mt-2 text-sm text-slate-600">{body}</p>
        <div className="mt-6">{action}</div>
      </div>
    </div>
  );
}

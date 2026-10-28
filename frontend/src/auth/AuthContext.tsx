import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  api,
  refreshAccessToken,
  setAccessToken,
  setSessionExpiredHandler,
  type AuthPayload,
  type LoginChallenge,
  type LoginStart,
  type SessionEndReason,
  type User,
  type WorkspaceSummary,
} from '../lib/api';

interface AuthContextValue {
  status: 'loading' | 'authenticated' | 'anonymous';
  user: User | null;
  workspaces: WorkspaceSummary[];
  /** Business login, step 1: checks the password and emails a code. */
  login: (email: string, password: string) => Promise<LoginStart>;
  /** Step 2: the emailed code; `force` closes a session open in another browser. */
  verifyLogin: (challengeToken: string, code: string | undefined, force?: boolean) => Promise<void>;
  resendCode: (challengeToken: string) => Promise<Omit<LoginChallenge, 'otpRequired' | 'challengeToken'>>;
  /** Super Admin portal: password only. */
  adminLogin: (email: string, password: string) => Promise<void>;
  /** Why the last session ended on its own (shown once on the login page). */
  endedReason: SessionEndReason | null;
  clearEndedReason: () => void;
  signup: (name: string, email: string, password: string) => Promise<void>;
  /** Logs out and goes to `redirectTo` (default: the login page). */
  logout: (redirectTo?: string) => Promise<void>;
  reload: () => Promise<WorkspaceSummary[]>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface MePayload {
  user: User;
  workspaces: WorkspaceSummary[];
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [endedReason, setEndedReason] = useState<SessionEndReason | null>(null);

  const reset = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setWorkspaces([]);
    setStatus('anonymous');
    queryClient.clear();
  }, [queryClient]);

  const reload = useCallback(async () => {
    const me = await api.get<MePayload>('/auth/me');
    setUser(me.user);
    setWorkspaces(me.workspaces);
    setStatus('authenticated');
    return me.workspaces;
  }, []);

  // Restore the session from the refresh cookie on first load.
  useEffect(() => {
    setSessionExpiredHandler((reason) => {
      setEndedReason(reason);
      reset();
    });
    refreshAccessToken()
      .then(async (token) => {
        if (token) await reload();
        else reset();
      })
      .catch(() => reset());
  }, [reload, reset]);

  // Open tabs check in, so a login elsewhere knows this session is in use (and this tab
  // learns quickly when it was replaced).
  useEffect(() => {
    if (status !== 'authenticated') return;
    const beat = () => void api.post('/auth/heartbeat').catch(() => undefined);
    beat();
    const timer = setInterval(beat, 60_000);
    const onVisible = () => document.visibilityState === 'visible' && beat();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      workspaces,
      reload,
      endedReason,
      clearEndedReason: () => setEndedReason(null),
      login: (email, password) => api.post<LoginStart>('/auth/login', { email, password }),
      verifyLogin: async (challengeToken, code, force = false) => {
        const res = await api.post<AuthPayload>('/auth/login/verify', { challengeToken, code, force });
        setAccessToken(res.accessToken);
        setEndedReason(null);
        await reload();
      },
      resendCode: (challengeToken) => api.post('/auth/login/resend', { challengeToken }),
      adminLogin: async (email, password) => {
        const res = await api.post<AuthPayload>('/auth/login', { email, password, portal: 'admin' });
        setAccessToken(res.accessToken);
        await reload();
      },
      signup: async (name, email, password) => {
        const res = await api.post<AuthPayload>('/auth/signup', { name, email, password });
        setAccessToken(res.accessToken);
        await reload();
      },
      logout: async (redirectTo = '/login') => {
        await api.post('/auth/logout').catch(() => undefined);
        setAccessToken(null);
        // Full page load: wipes all in-memory state and avoids route guards adding ?next=
        // back into the previous workspace.
        window.location.replace(redirectTo);
      },
    }),
    [status, user, workspaces, reload, endedReason],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

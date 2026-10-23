import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  api,
  refreshAccessToken,
  setAccessToken,
  setSessionExpiredHandler,
  type AuthPayload,
  type User,
  type WorkspaceSummary,
} from '../lib/api';

interface AuthContextValue {
  status: 'loading' | 'authenticated' | 'anonymous';
  user: User | null;
  workspaces: WorkspaceSummary[];
  login: (email: string, password: string, portal?: 'app' | 'admin') => Promise<void>;
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
    setSessionExpiredHandler(reset);
    refreshAccessToken()
      .then(async (token) => {
        if (token) await reload();
        else reset();
      })
      .catch(reset);
  }, [reload, reset]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      workspaces,
      reload,
      login: async (email, password, portal = 'app') => {
        const res = await api.post<AuthPayload>('/auth/login', { email, password, portal });
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
    [status, user, workspaces, reload],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

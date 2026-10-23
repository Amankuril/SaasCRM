import { createContext, useContext } from 'react';
import type { Permission, WorkspaceContextPayload } from '../lib/api';

export interface WorkspaceContextValue extends WorkspaceContextPayload {
  can: (permission: Permission) => boolean;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** Current workspace + the signed-in user's role and permissions in it (from the server). */
export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceLayout>');
  return ctx;
}

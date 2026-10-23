import type { UserDoc } from '../modules/auth/user.model.js';
import type { MemberDoc } from '../modules/workspaces/member.model.js';
import type { WorkspaceDoc } from '../modules/workspaces/workspace.model.js';

declare global {
  namespace Express {
    interface Request {
      id: string;
      user?: UserDoc;
      sessionId?: string;
      /** Set by `loadWorkspace`, derived from the user's membership, never from the client alone. */
      workspace?: WorkspaceDoc;
      membership?: MemberDoc;
    }
  }
}

export {};

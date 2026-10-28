import type { Server as HttpServer } from 'node:http';
import { Types } from 'mongoose';
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { Session } from '../modules/auth/session.model.js';
import { User } from '../modules/auth/user.model.js';
import { WorkspaceMember } from '../modules/workspaces/member.model.js';
import { subscribe } from './bus.js';

/**
 * Socket.io for live inbox updates. Clients authenticate with their access token
 * and join one workspace room at a time, after a membership check.
 */
export function attachRealtime(server: HttpServer): Server {
  const io = new Server(server, { path: '/socket.io', cors: { origin: env.APP_URL, credentials: true } });

  io.use(async (socket, next) => {
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
    const payload = token ? verifyAccessToken(token) : null;
    if (!payload || !Types.ObjectId.isValid(payload.sid)) return next(new Error('unauthorized'));
    const session = await Session.exists({ _id: payload.sid, userId: payload.sub, revokedAt: null, expiresAt: { $gt: new Date() } });
    if (!session) return next(new Error('unauthorized'));
    socket.data.userId = payload.sub;
    next();
  });

  io.on('connection', (socket) => {
    socket.on('workspace:join', async (workspaceId: unknown, ack?: (res: { ok: boolean }) => void) => {
      const ok =
        typeof workspaceId === 'string' &&
        Types.ObjectId.isValid(workspaceId) &&
        (!!(await WorkspaceMember.exists({ workspaceId, userId: socket.data.userId as string })) ||
          // Platform admins on support access see the same live updates.
          !!(await User.exists({ _id: socket.data.userId as string, isPlatformAdmin: true, status: 'active' })));
      if (ok) {
        for (const room of socket.rooms) if (room.startsWith('ws:')) void socket.leave(room);
        void socket.join(`ws:${workspaceId}`);
      }
      ack?.({ ok });
    });
  });

  subscribe((workspaceId, event) => io.to(`ws:${workspaceId}`).emit('event', event));
  logger.info('Realtime (Socket.io) attached');
  return io;
}

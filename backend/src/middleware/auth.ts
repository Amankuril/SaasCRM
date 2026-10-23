import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { Session } from '../modules/auth/session.model.js';
import { User } from '../modules/auth/user.model.js';

/** Requires a valid `Authorization: Bearer <access token>` tied to a live session. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const payload = token ? verifyAccessToken(token) : null;
  if (!payload || !Types.ObjectId.isValid(payload.sid)) throw unauthorized('Your session has expired. Please log in again.', 'TOKEN_INVALID');

  const session = await Session.findOne({ _id: payload.sid, userId: payload.sub, revokedAt: null }).lean();
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    throw unauthorized('Your session has expired. Please log in again.', 'SESSION_EXPIRED');
  }

  const user = await User.findById(payload.sub);
  if (!user || user.status !== 'active') throw unauthorized('Your account is not active.', 'ACCOUNT_INACTIVE');

  req.user = user;
  req.sessionId = payload.sid;
  next();
};

export const requirePlatformAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user?.isPlatformAdmin) throw forbidden('Platform admin access required.');
  next();
};

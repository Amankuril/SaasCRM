import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface AccessTokenPayload {
  sub: string; // user id
  sid: string; // session id
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded === 'string' || typeof decoded.sub !== 'string' || typeof decoded.sid !== 'string') {
      return null;
    }
    return { sub: decoded.sub, sid: decoded.sid };
  } catch {
    return null;
  }
}

/** Opaque random token for refresh sessions and invitations; only its hash is stored. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

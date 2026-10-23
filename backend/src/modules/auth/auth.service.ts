import bcrypt from 'bcryptjs';
import type { Request } from 'express';
import { env } from '../../config/env.js';
import { unauthorized } from '../../lib/errors.js';
import { generateOpaqueToken, hashToken, signAccessToken } from '../../lib/tokens.js';
import { Session, type SessionDoc } from './session.model.js';
import type { UserDoc } from './user.model.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Parallel refreshes (two tabs) may both present the token that was just rotated. */
const ROTATION_GRACE_MS = 30 * 1000;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, env.BCRYPT_ROUNDS);
}

let dummyHash: Promise<string> | undefined;

/** Compares even when the user does not exist so response timing does not reveal accounts. */
export async function verifyPassword(password: string, hash: string | undefined): Promise<boolean> {
  if (!hash) {
    dummyHash ??= bcrypt.hash(generateOpaqueToken(), env.BCRYPT_ROUNDS);
    await bcrypt.compare(password, await dummyHash);
    return false;
  }
  return bcrypt.compare(password, hash);
}

export interface IssuedTokens {
  accessToken: string;
  /** Undefined when the existing refresh cookie stays valid (grace-window refresh). */
  refreshToken?: string;
  userId: string;
}

export async function startSession(user: UserDoc, req: Request): Promise<IssuedTokens> {
  const refreshToken = generateOpaqueToken();
  const session = await Session.create({
    userId: user._id,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * DAY_MS),
    userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
    ip: req.ip ?? null,
  });
  return { refreshToken, accessToken: accessTokenFor(session), userId: user.id };
}

export async function rotateSession(refreshToken: string): Promise<IssuedTokens> {
  const hash = hashToken(refreshToken);
  const session = await Session.findOne({ tokenHash: hash });

  if (!session) {
    const previous = await Session.findOne({ previousTokenHash: hash, revokedAt: null });
    if (previous && isUsable(previous)) {
      if (Date.now() - previous.lastUsedAt.getTime() <= ROTATION_GRACE_MS) {
        return { accessToken: accessTokenFor(previous), userId: previous.userId.toString() };
      }
      // An old token was replayed after the grace window: assume it leaked and kill the session.
      previous.revokedAt = new Date();
      await previous.save();
    }
    throw unauthorized('Your session has expired. Please log in again.', 'REFRESH_INVALID');
  }

  if (!isUsable(session)) throw unauthorized('Your session has expired. Please log in again.', 'REFRESH_INVALID');

  const nextToken = generateOpaqueToken();
  session.previousTokenHash = hash;
  session.tokenHash = hashToken(nextToken);
  session.lastUsedAt = new Date();
  await session.save();

  return { refreshToken: nextToken, accessToken: accessTokenFor(session), userId: session.userId.toString() };
}

export async function revokeSessionByToken(refreshToken: string): Promise<void> {
  await Session.updateOne({ tokenHash: hashToken(refreshToken), revokedAt: null }, { revokedAt: new Date() });
}

function isUsable(session: SessionDoc): boolean {
  return !session.revokedAt && session.expiresAt.getTime() > Date.now();
}

function accessTokenFor(session: SessionDoc): string {
  return signAccessToken({ sub: session.userId.toString(), sid: session.id as string });
}

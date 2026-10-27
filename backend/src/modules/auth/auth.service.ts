import bcrypt from 'bcryptjs';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { env } from '../../config/env.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import { generateOpaqueToken, hashToken, signAccessToken } from '../../lib/tokens.js';
import { LoginThrottle } from './loginChallenge.model.js';
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

export async function startSession(user: UserDoc, req: Request, portal: 'app' | 'admin' = 'app'): Promise<IssuedTokens> {
  const refreshToken = generateOpaqueToken();
  const session = await Session.create({
    userId: user._id,
    portal,
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
      previous.revokedReason = 'reuse';
      await previous.save();
    }
    throw unauthorized('Your session has expired. Please log in again.', 'REFRESH_INVALID');
  }

  if (session.revokedReason === 'replaced') throw sessionReplaced();
  if (!isUsable(session)) throw unauthorized('Your session has expired. Please log in again.', 'REFRESH_INVALID');

  const nextToken = generateOpaqueToken();
  session.previousTokenHash = hash;
  session.tokenHash = hashToken(nextToken);
  session.lastUsedAt = new Date();
  session.lastSeenAt = new Date();
  await session.save();

  return { refreshToken: nextToken, accessToken: accessTokenFor(session), userId: session.userId.toString() };
}

export async function revokeSessionByToken(refreshToken: string): Promise<void> {
  await Session.updateOne({ tokenHash: hashToken(refreshToken), revokedAt: null }, { revokedAt: new Date(), revokedReason: 'logout' });
}

function isUsable(session: SessionDoc): boolean {
  return !session.revokedAt && session.expiresAt.getTime() > Date.now();
}

function accessTokenFor(session: SessionDoc): string {
  return signAccessToken({ sub: session.userId.toString(), sid: session.id as string });
}

export const sessionReplaced = () =>
  unauthorized('Your account was logged in on another browser or tab, so this session was closed.', 'SESSION_REPLACED');

// ---- One business session at a time ----

/** How recently a tab must have checked in for its session to count as "in use". */
export const ACTIVE_WINDOW_MS = 3 * 60 * 1000;

/** Business sessions of this user that an open tab is still using. */
export function activeAppSessions(userId: UserDoc['_id']) {
  return Session.find({
    userId,
    portal: 'app',
    revokedAt: null,
    expiresAt: { $gt: new Date() },
    lastSeenAt: { $gt: new Date(Date.now() - ACTIVE_WINDOW_MS) },
  })
    .sort({ lastSeenAt: -1 })
    .lean();
}

/** Closes every other business session; their tabs are told on their next request. */
export async function replaceAppSessions(userId: UserDoc['_id']) {
  await Session.updateMany({ userId, portal: 'app', revokedAt: null }, { revokedAt: new Date(), revokedReason: 'replaced' });
}

/** "Chrome on Windows", from a User-Agent header. */
export function describeDevice(ua: string | null | undefined): string {
  if (!ua) return 'an unknown browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return os ? `${browser} on ${os}` : browser;
}

// ---- Email login codes ----

export const CODE_TTL_MINUTES = 10;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_MAX_SENDS = 5;
export const CODE_RESEND_SECONDS = 30;

export const newLoginCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** Keyed to the challenge, so a code is useless for any other login attempt. */
export const hashLoginCode = (code: string, challengeTokenHash: string) => createHmac('sha256', env.JWT_ACCESS_SECRET).update(`login-code:${challengeTokenHash}:${code}`).digest('hex');

export function codeMatches(code: string, challengeTokenHash: string, storedHash: string): boolean {
  const given = Buffer.from(hashLoginCode(code, challengeTokenHash));
  const stored = Buffer.from(storedHash);
  return given.length === stored.length && timingSafeEqual(given, stored);
}

/** "as****@gmail.com" */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}

// ---- Failed-password lockout ----

/** Business logins lock after 5 wrong passwords for 15 minutes; the Super Admin portal after 3 for 30. */
const LOCK_RULES = { app: { failures: 5, minutes: 15 }, admin: { failures: 3, minutes: 30 } } as const;

const throttleKey = (portal: 'app' | 'admin', email: string) => `${portal}:${email}`;

export async function assertNotLocked(portal: 'app' | 'admin', email: string) {
  const t = await LoginThrottle.findOne({ key: throttleKey(portal, email) }).lean();
  if (t?.lockedUntil && t.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((t.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new AppError(429, 'LOGIN_LOCKED', `Too many failed attempts. For your security, try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
}

/** Counts a wrong password; returns how many tries are left before the lock (0 = now locked). */
export async function recordFailedLogin(portal: 'app' | 'admin', email: string): Promise<number> {
  const rule = LOCK_RULES[portal];
  const t = await LoginThrottle.findOneAndUpdate({ key: throttleKey(portal, email) }, { $inc: { failures: 1 }, lastFailureAt: new Date() }, { upsert: true, new: true });
  if (t.failures >= rule.failures) {
    await LoginThrottle.updateOne({ _id: t._id }, { failures: 0, lockedUntil: new Date(Date.now() + rule.minutes * 60_000) });
    return 0;
  }
  return rule.failures - t.failures;
}

export async function clearFailedLogins(portal: 'app' | 'admin', email: string) {
  await LoginThrottle.deleteOne({ key: throttleKey(portal, email) });
}

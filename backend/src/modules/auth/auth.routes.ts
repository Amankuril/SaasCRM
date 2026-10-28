import { Router, type CookieOptions, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { env, isProd, isTest } from '../../config/env.js';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../../lib/errors.js';
import { getMailer, loginCodeEmail } from '../../lib/mailer.js';
import { generateOpaqueToken, hashToken } from '../../lib/tokens.js';
import { emailSchema, parse, passwordSchema } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { listUserWorkspaces } from '../workspaces/workspace.service.js';
import {
  CODE_MAX_ATTEMPTS,
  CODE_MAX_SENDS,
  CODE_RESEND_SECONDS,
  CODE_TTL_MINUTES,
  activeAppSessions,
  assertNotLocked,
  clearFailedLogins,
  codeMatches,
  describeDevice,
  hashLoginCode,
  maskEmail,
  newLoginCode,
  recordFailedLogin,
  replaceAppSessions,
  hashPassword,
  revokeSessionByToken,
  rotateSession,
  startSession,
  verifyPassword,
  type IssuedTokens,
} from './auth.service.js';
import { LoginChallenge, type LoginChallengeDoc } from './loginChallenge.model.js';
import { Session } from './session.model.js';
import { User, toPublicUser, type UserDoc } from './user.model.js';

export const REFRESH_COOKIE = 'zc_rt';

const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'strict',
  path: '/api/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
};

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (req, res) => {
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes.', request_id: req.id },
    });
  },
});

// The Super Admin portal gets a tighter budget per IP.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (req, res) => {
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait 15 minutes.', request_id: req.id } });
  },
});

const signupSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(100),
  email: emailSchema,
  password: passwordSchema,
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  // `admin`: the Super Admin login (/admin/login) only accepts platform admins.
  portal: z.enum(['app', 'admin']).default('app'),
});

export const authRouter = Router();

authRouter.post('/signup', authLimiter, async (req, res) => {
  const body = parse(signupSchema, req.body);
  if (await User.exists({ email: body.email })) {
    throw conflict('EMAIL_TAKEN', 'An account with this email already exists.');
  }
  const user = await User.create({
    name: body.name,
    email: body.email,
    passwordHash: await hashPassword(body.password),
    lastLoginAt: new Date(),
  });
  const tokens = await startSession(user, req);
  sendTokens(res.status(201), tokens, toPublicUser(user));
});

authRouter.post('/login', authLimiter, async (req, res, next) => {
  const body = parse(loginSchema, req.body);
  if (body.portal === 'admin') return void adminLimiter(req, res, () => void adminLogin(req, res, body).catch(next));
  await assertNotLocked('app', body.email);
  const user = await User.findOne({ email: body.email }).select('+passwordHash');
  const valid = await verifyPassword(body.password, user?.passwordHash);
  if (!user || !valid) return wrongPassword('app', body.email);
  if (user.status !== 'active') throw unauthorized('Your account has been disabled.', 'ACCOUNT_INACTIVE');
  await clearFailedLogins('app', body.email);

  // Step 2: a code goes to the account's email; the session starts once it is entered.
  const challengeToken = generateOpaqueToken();
  const tokenHash = hashToken(challengeToken);
  const code = newLoginCode();
  // OTP_BYPASS_EMAILS: the challenge starts verified and no code is sent; the browser goes
  // straight to /login/verify (which still handles "logged in elsewhere").
  const bypass = env.OTP_BYPASS_EMAILS.has(user.email);
  const challenge = await LoginChallenge.create({
    userId: user._id,
    tokenHash,
    codeHash: hashLoginCode(code, tokenHash),
    expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000),
    verifiedAt: bypass ? new Date() : null,
    userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
    ip: req.ip ?? null,
  });
  if (bypass) return void res.json({ otpRequired: false, challengeToken });
  await sendCode(user, challenge, code).catch(async (err) => {
    await LoginChallenge.deleteOne({ _id: challenge._id });
    throw err;
  });
  res.json({ otpRequired: true, challengeToken, email: maskEmail(user.email), expiresInSeconds: CODE_TTL_MINUTES * 60, resendInSeconds: CODE_RESEND_SECONDS });
});

/** Super Admin portal: password only (no code), with a stricter lockout. */
async function adminLogin(req: Request, res: Response, body: z.infer<typeof loginSchema>) {
  await assertNotLocked('admin', body.email);
  const user = await User.findOne({ email: body.email }).select('+passwordHash');
  const valid = await verifyPassword(body.password, user?.passwordHash);
  if (!user || !valid) return wrongPassword('admin', body.email);
  if (user.status !== 'active') throw unauthorized('Your account has been disabled.', 'ACCOUNT_INACTIVE');
  // Checked after the password, so it reveals nothing to someone without it. No session is created.
  if (!user.isPlatformAdmin) throw forbidden('This account does not have Super Admin access.', 'NOT_PLATFORM_ADMIN');
  await clearFailedLogins('admin', body.email);
  user.lastLoginAt = new Date();
  await user.save();
  sendTokens(res, await startSession(user, req, 'admin'), toPublicUser(user));
}

async function wrongPassword(portal: 'app' | 'admin', email: string): Promise<never> {
  const left = await recordFailedLogin(portal, email);
  if (left === 0) await assertNotLocked(portal, email);
  const hint = left <= 2 ? ` ${left} attempt${left === 1 ? '' : 's'} left before a temporary lock.` : '';
  throw new AppError(401, 'INVALID_CREDENTIALS', `Incorrect email or password.${hint}`);
}

async function sendCode(user: UserDoc, challenge: LoginChallengeDoc, code: string) {
  await getMailer().send(loginCodeEmail(user.email, user.name, code, CODE_TTL_MINUTES, describeDevice(challenge.userAgent)));
}

async function findChallenge(token: unknown) {
  const challenge = typeof token === 'string' && token ? await LoginChallenge.findOne({ tokenHash: hashToken(token) }) : null;
  if (!challenge || challenge.usedAt || challenge.expiresAt.getTime() <= Date.now() || challenge.attempts >= CODE_MAX_ATTEMPTS) {
    throw unauthorized('This code has expired. Please log in again.', 'CHALLENGE_EXPIRED');
  }
  return challenge;
}

const verifySchema = z.object({
  challengeToken: z.string().min(1).max(200),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.').optional(),
  // "Log in here": close the session open on another browser.
  force: z.boolean().default(false),
});

authRouter.post('/login/verify', authLimiter, async (req, res) => {
  const body = parse(verifySchema, req.body);
  const challenge = await findChallenge(body.challengeToken);
  if (!challenge.verifiedAt) {
    if (!body.code) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { code: ['Enter the 6-digit code.'] });
    if (!codeMatches(body.code, challenge.tokenHash, challenge.codeHash)) {
      challenge.attempts += 1;
      await challenge.save();
      const left = CODE_MAX_ATTEMPTS - challenge.attempts;
      if (left <= 0) throw unauthorized('Too many wrong codes. Please log in again.', 'CHALLENGE_EXPIRED');
      throw badRequest('INVALID_CODE', `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`);
    }
    challenge.verifiedAt = new Date();
    await challenge.save();
  }

  const user = await User.findById(challenge.userId);
  if (!user || user.status !== 'active') throw unauthorized('Your account has been disabled.', 'ACCOUNT_INACTIVE');
  const [active] = await activeAppSessions(user._id);
  if (active && !body.force) {
    throw new AppError(409, 'SESSION_ACTIVE', 'This account is already logged in on another browser or tab.', {
      device: describeDevice(active.userAgent),
      lastSeenAt: active.lastSeenAt.toISOString(),
    });
  }

  challenge.usedAt = new Date();
  await challenge.save();
  await replaceAppSessions(user._id);
  user.lastLoginAt = new Date();
  user.emailVerifiedAt ??= new Date();
  await user.save();
  sendTokens(res, await startSession(user, req, 'app'), toPublicUser(user));
});

authRouter.post('/login/resend', authLimiter, async (req, res) => {
  const { challengeToken } = parse(z.object({ challengeToken: z.string().min(1).max(200) }), req.body);
  const challenge = await findChallenge(challengeToken);
  if (challenge.verifiedAt) throw conflict('ALREADY_VERIFIED', 'The code was already accepted.');
  const wait = CODE_RESEND_SECONDS - Math.floor((Date.now() - challenge.lastSentAt.getTime()) / 1000);
  if (wait > 0) throw new AppError(429, 'RESEND_TOO_SOON', `You can ask for a new code in ${wait} seconds.`);
  if (challenge.sends >= CODE_MAX_SENDS) throw new AppError(429, 'TOO_MANY_CODES', 'Too many codes sent. Please log in again later.');
  const user = await User.findById(challenge.userId);
  if (!user) throw unauthorized('This code has expired. Please log in again.', 'CHALLENGE_EXPIRED');
  const code = newLoginCode();
  challenge.set({ codeHash: hashLoginCode(code, challenge.tokenHash), attempts: 0, sends: challenge.sends + 1, lastSentAt: new Date(), expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000) });
  await challenge.save();
  await sendCode(user, challenge, code);
  res.json({ email: maskEmail(user.email), expiresInSeconds: CODE_TTL_MINUTES * 60, resendInSeconds: CODE_RESEND_SECONDS });
});

/** Open tabs check in every minute: keeps the session "in use" and learns if it was replaced. */
authRouter.post('/heartbeat', requireAuth, async (req, res) => {
  await Session.updateOne({ _id: req.sessionId, revokedAt: null }, { lastSeenAt: new Date() });
  res.status(204).end();
});

authRouter.post('/refresh', authLimiter, async (req, res) => {
  const token: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof token !== 'string' || !token) throw unauthorized('Please log in.', 'REFRESH_MISSING');

  const tokens = await rotateSession(token).catch((err) => {
    res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions, maxAge: undefined });
    throw err;
  });
  const user = await User.findById(tokens.userId);
  if (!user || user.status !== 'active') throw unauthorized('Your account is not active.', 'ACCOUNT_INACTIVE');
  sendTokens(res, tokens, toPublicUser(user));
});

authRouter.post('/logout', async (req, res) => {
  const token: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof token === 'string' && token) await revokeSessionByToken(token);
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions, maxAge: undefined });
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json({ user: toPublicUser(req.user!), workspaces: await listUserWorkspaces(req.user!._id) });
});

function sendTokens(res: Response, tokens: IssuedTokens, user: ReturnType<typeof toPublicUser>) {
  if (tokens.refreshToken) res.cookie(REFRESH_COOKIE, tokens.refreshToken, refreshCookieOptions);
  res.json({ user, accessToken: tokens.accessToken });
}

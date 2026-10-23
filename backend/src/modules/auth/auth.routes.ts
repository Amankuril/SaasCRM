import { Router, type CookieOptions, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { env, isProd, isTest } from '../../config/env.js';
import { conflict, forbidden, unauthorized } from '../../lib/errors.js';
import { emailSchema, parse, passwordSchema } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { listUserWorkspaces } from '../workspaces/workspace.service.js';
import {
  hashPassword,
  revokeSessionByToken,
  rotateSession,
  startSession,
  verifyPassword,
  type IssuedTokens,
} from './auth.service.js';
import { User, toPublicUser } from './user.model.js';

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

authRouter.post('/login', authLimiter, async (req, res) => {
  const body = parse(loginSchema, req.body);
  const user = await User.findOne({ email: body.email }).select('+passwordHash');
  const valid = await verifyPassword(body.password, user?.passwordHash);
  if (!user || !valid) throw unauthorized('Incorrect email or password.', 'INVALID_CREDENTIALS');
  if (user.status !== 'active') throw unauthorized('Your account has been disabled.', 'ACCOUNT_INACTIVE');
  // Checked after the password, so it reveals nothing to someone without it. No session is created.
  if (body.portal === 'admin' && !user.isPlatformAdmin) throw forbidden('This account does not have Super Admin access.', 'NOT_PLATFORM_ADMIN');

  user.lastLoginAt = new Date();
  await user.save();
  const tokens = await startSession(user, req);
  sendTokens(res, tokens, toPublicUser(user));
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

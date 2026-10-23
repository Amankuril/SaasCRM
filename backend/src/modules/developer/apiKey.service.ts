import { createHash, randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Types } from 'mongoose';
import { AppError, forbidden, unauthorized } from '../../lib/errors.js';
import { Workspace } from '../workspaces/workspace.model.js';
import type { ApiScope } from './catalog.js';
import { ApiKey, type ApiKeyDoc } from './developer.model.js';

const KEY_PATTERN = /^zc_live_([a-z0-9]{8})_([A-Za-z0-9]{32})$/;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** How long a rolled key keeps working so integrations can switch over. */
export const ROLL_GRACE_MS = 24 * 60 * 60 * 1000;
export const MAX_ACTIVE_KEYS = 20;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function randomString(length: number, alphabet = ALPHABET): string {
  // Rejection sampling keeps every character equally likely.
  const out: string[] = [];
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < Math.floor(256 / alphabet.length) * alphabet.length) out.push(alphabet[byte % alphabet.length]!);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): { key: string; prefix: string; hash: string; last4: string } {
  const prefix = randomString(8, 'abcdefghijklmnopqrstuvwxyz0123456789');
  const key = `zc_live_${prefix}_${randomString(32)}`;
  return { key, prefix, hash: hashApiKey(key), last4: key.slice(-4) };
}

export async function createApiKey(input: {
  workspaceId: Types.ObjectId;
  name: string;
  scopes: ApiScope[];
  expiresAt: Date | null;
  createdBy: Types.ObjectId;
}): Promise<{ apiKey: ApiKeyDoc; key: string }> {
  const active = await ApiKey.countDocuments({ workspaceId: input.workspaceId, revokedAt: null });
  if (active >= MAX_ACTIVE_KEYS) throw new AppError(409, 'TOO_MANY_KEYS', `A workspace can have at most ${MAX_ACTIVE_KEYS} active API keys. Revoke one first.`);
  const generated = generateApiKey();
  const apiKey = await ApiKey.create({ ...input, prefix: generated.prefix, hash: generated.hash, last4: generated.last4 });
  return { apiKey, key: generated.key };
}

export function keyState(k: Pick<ApiKeyDoc, 'revokedAt' | 'expiresAt'>, now = Date.now()): 'active' | 'revoked' | 'expired' {
  if (k.revokedAt) return 'revoked';
  if (k.expiresAt && k.expiresAt.getTime() <= now) return 'expired';
  return 'active';
}

export function toPublicApiKey(k: ApiKeyDoc) {
  return {
    id: k.id as string,
    name: k.name,
    // Safe to show: identifies the key without revealing it.
    hint: `zc_live_${k.prefix}_…${k.last4}`,
    scopes: k.scopes,
    state: keyState(k),
    expiresAt: k.expiresAt,
    lastUsedAt: k.lastUsedAt,
    createdAt: k.createdAt,
    rolled: !!k.rolledToId,
  };
}

function readKey(req: Parameters<RequestHandler>[0]): string | null {
  const auth = req.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return req.get('x-api-key')?.trim() ?? null;
}

/**
 * Authenticates `/api/v1` calls with a workspace API key (Authorization: Bearer or
 * X-API-Key; never a query string). Sets req.workspace and req.apiKey.
 */
export const requireApiKey: RequestHandler = async (req, _res, next) => {
  const key = readKey(req);
  if (!key) throw unauthorized('Send your API key in the Authorization header: "Bearer zc_live_…".', 'API_KEY_MISSING');
  if (!KEY_PATTERN.test(key)) throw unauthorized('This API key is not valid.', 'API_KEY_INVALID');

  // Deliberate cross-tenant lookup: the key itself identifies the workspace.
  const apiKey = await ApiKey.findOne({ hash: hashApiKey(key) }).setOptions({ skipTenantScope: true });
  if (!apiKey) throw unauthorized('This API key is not valid.', 'API_KEY_INVALID');
  const state = keyState(apiKey);
  if (state !== 'active') throw unauthorized(`This API key is ${state}.`, state === 'revoked' ? 'API_KEY_REVOKED' : 'API_KEY_EXPIRED');

  const workspace = await Workspace.findById(apiKey.workspaceId);
  if (!workspace) throw unauthorized('This API key is not valid.', 'API_KEY_INVALID');
  if (workspace.status === 'suspended' && !READ_METHODS.has(req.method)) {
    throw new AppError(403, 'WORKSPACE_SUSPENDED', 'This workspace is suspended. Contact support to restore access.');
  }

  // Throttle last-used writes to once a minute per key.
  if (!apiKey.lastUsedAt || Date.now() - apiKey.lastUsedAt.getTime() > 60_000) {
    await ApiKey.updateOne({ _id: apiKey._id, workspaceId: apiKey.workspaceId }, { lastUsedAt: new Date(), lastUsedIp: req.ip ?? null });
  }
  req.workspace = workspace;
  req.apiKey = apiKey;
  next();
};

export function requireScope(scope: ApiScope): RequestHandler {
  return (req, _res, next) => {
    if (!req.apiKey?.scopes.includes(scope)) throw forbidden(`This API key needs the "${scope}" scope.`, 'INSUFFICIENT_SCOPE');
    next();
  };
}

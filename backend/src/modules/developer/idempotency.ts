import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { AppError } from '../../lib/errors.js';
import { IdempotencyRecord } from './developer.model.js';

const KEY_RE = /^[A-Za-z0-9_:.-]{8,128}$/;

/**
 * `Idempotency-Key` support for public API writes: the first response for a key is
 * stored for 24h and replayed for retries with the same body. Reusing a key with a
 * different body is an error; a retry while the first call is still running gets 409.
 */
export const idempotent: RequestHandler = async (req, res, next) => {
  const key = req.get('idempotency-key');
  if (!key) return next();
  if (!KEY_RE.test(key)) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8–128 letters, digits, "_", "-", ":" or ".".');

  const workspaceId = req.workspace!._id;
  const apiKeyId = req.apiKey!._id;
  const requestHash = createHash('sha256').update(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body ?? null)}`).digest('hex');

  let record;
  try {
    record = await IdempotencyRecord.create({ workspaceId, apiKeyId, key, requestHash });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    const existing = await IdempotencyRecord.findOne({ workspaceId, apiKeyId, key }).lean();
    if (!existing) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Retry this request in a moment.');
    if (existing.requestHash !== requestHash) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.');
    }
    if (existing.state !== 'done') throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed.');
    res.setHeader('Idempotent-Replayed', 'true');
    res.status(existing.statusCode!).json(existing.body);
    return;
  }

  // Store the outcome before the response goes out, so an immediate retry replays it.
  // Server errors free the key for a retry.
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    const store =
      res.statusCode < 500
        ? IdempotencyRecord.updateOne({ _id: record._id, workspaceId }, { state: 'done', statusCode: res.statusCode, body })
        : IdempotencyRecord.deleteOne({ _id: record._id, workspaceId });
    store.catch(() => undefined).finally(() => json(body));
    return res;
  };
  next();
};

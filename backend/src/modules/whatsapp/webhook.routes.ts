import { createHash } from 'node:crypto';
import express, { Router } from 'express';
import { env } from '../../config/env.js';
import { verifyHmacSha256 } from '../../lib/crypto.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { enqueue } from '../../jobs/queue.js';
import { WebhookEvent } from './webhookEvent.model.js';

/**
 * Mounted at /api/webhooks BEFORE the JSON body parser: signature verification
 * needs the exact raw bytes Meta signed.
 */
export const webhookRouter = Router();

// Meta's one-time verification handshake when the callback URL is saved.
webhookRouter.get('/whatsapp', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (env.META_WEBHOOK_VERIFY_TOKEN && mode === 'subscribe' && token === env.META_WEBHOOK_VERIFY_TOKEN && typeof challenge === 'string') {
    res.type('text/plain').send(challenge);
    return;
  }
  res.status(403).json({ error: { code: 'VERIFY_FAILED', message: 'Webhook verification failed.', request_id: req.id } });
});

webhookRouter.post('/whatsapp', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  if (!env.META_APP_SECRET) {
    throw new AppError(503, 'WEBHOOK_NOT_CONFIGURED', 'META_APP_SECRET is not configured.');
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyHmacSha256(raw, req.get('x-hub-signature-256'), env.META_APP_SECRET)) {
    logger.warn({ requestId: req.id }, 'Rejected webhook with invalid signature');
    throw unauthorized('Invalid webhook signature.', 'INVALID_SIGNATURE');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Webhook body is not valid JSON.');
  }

  // Store first, acknowledge fast, process asynchronously. Identical redeliveries are ignored.
  const payloadHash = createHash('sha256').update(raw).digest('hex');
  try {
    const event = await WebhookEvent.create({ provider: 'meta_cloud', payloadHash, payload });
    await enqueue('webhook.process', { eventId: event.id as string }, { jobId: `webhook-${event.id}` });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }
  res.status(200).json({ received: true });
});

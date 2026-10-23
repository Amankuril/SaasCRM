import { Router } from 'express';
import { z } from 'zod';
import { env, isProd } from '../../config/env.js';
import { AppError, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { audit } from '../audit/audit.service.js';
import { normalizePhone } from '../contacts/contact.service.js';
import { ProviderConnection, toPublicConnection } from './connection.model.js';
import { connectWhatsApp, getConnection, refreshConnection } from './connection.service.js';
import { processEvents } from './events.service.js';

const connectSchema = z.object({
  wabaId: z.string().trim().regex(/^\d{5,30}$/, 'Enter the numeric WhatsApp Business Account ID.'),
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, 'Enter the numeric Phone number ID.'),
  accessToken: z.string().trim().min(20, 'Paste the full access token.').max(1000),
});

const simulateSchema = z.object({
  from: z.string().trim().min(5),
  text: z.string().trim().min(1).max(4096),
  profileName: z.string().trim().max(100).optional(),
});

/** Mounted at /api/workspaces/:workspaceId/whatsapp (workspace already loaded). */
export const connectionRouter = Router({ mergeParams: true });

connectionRouter.get('/connection', requirePermission('workspace:read'), async (req, res) => {
  const conn = await getConnection(req.workspace!._id);
  res.json({
    connection: conn ? toPublicConnection(conn) : null,
    // What the platform owner configures once in the Meta app (shared by all workspaces).
    webhook: {
      callbackUrl: `${env.PUBLIC_API_URL}/api/webhooks/whatsapp`,
      configured: Boolean(env.META_APP_SECRET && env.META_WEBHOOK_VERIFY_TOKEN),
    },
    sandbox: env.WHATSAPP_PROVIDER === 'sandbox',
  });
});

connectionRouter.put('/connection', requirePermission('provider:manage'), async (req, res) => {
  const input = parse(connectSchema, req.body);
  const conn = await connectWhatsApp(req.workspace!, req.user!, input);
  await audit(req, {
    workspaceId: req.workspace!._id,
    action: 'whatsapp.connected',
    targetType: 'connection',
    targetId: conn.id,
    metadata: { phoneNumberId: conn.phoneNumberId, displayPhoneNumber: conn.displayPhoneNumber },
  });
  res.json({ connection: toPublicConnection(conn) });
});

connectionRouter.post('/connection/refresh', requirePermission('provider:manage'), async (req, res) => {
  const conn = await getConnection(req.workspace!._id, true);
  if (!conn) throw notFound('No WhatsApp number is connected.');
  res.json({ connection: toPublicConnection(await refreshConnection(conn)) });
});

connectionRouter.delete('/connection', requirePermission('provider:manage'), async (req, res) => {
  const workspace = req.workspace!;
  const conn = await getConnection(workspace._id);
  if (!conn) throw notFound('No WhatsApp number is connected.');

  await ProviderConnection.deleteOne({ _id: conn._id, workspaceId: workspace._id });
  if (workspace.status === 'active') {
    workspace.status = 'setup';
    await workspace.save();
  }
  await audit(req, {
    workspaceId: workspace._id,
    action: 'whatsapp.disconnected',
    targetType: 'connection',
    targetId: conn.id,
    metadata: { phoneNumberId: conn.phoneNumberId, displayPhoneNumber: conn.displayPhoneNumber },
  });
  res.status(204).end();
});

/**
 * Development aid: inject an inbound customer message without Meta (e.g. to open
 * the 24h window or test flows). Disabled in production.
 */
connectionRouter.post('/simulate-inbound', requirePermission('provider:manage'), async (req, res) => {
  if (isProd) throw notFound();
  const input = parse(simulateSchema, req.body);
  const conn = await getConnection(req.workspace!._id);
  if (!conn) throw new AppError(409, 'WHATSAPP_NOT_CONNECTED', 'Connect a WhatsApp number first.');
  const phone = normalizePhone(input.from, req.workspace!.country);
  if (!phone) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', { from: ['Enter a valid phone number.'] });

  await processEvents([
    {
      kind: 'message',
      phoneNumberId: conn.phoneNumberId,
      providerMessageId: `wamid.simulated.${Date.now()}`,
      from: phone.slice(1),
      profileName: input.profileName ?? null,
      timestamp: new Date(),
      type: 'text',
      content: { text: input.text },
    },
  ]);
  res.status(202).json({ ok: true });
});

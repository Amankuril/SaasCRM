import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import mongoose from 'mongoose';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { requireAuth, requirePlatformAdmin } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestContext.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { publicInvitationRouter } from './modules/invitations/invitation.routes.js';
import { workspacesRouter } from './modules/workspaces/workspace.routes.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => (req as express.Request).id, autoLogging: { ignore: (req) => req.url === '/api/health' } }));
  app.use(helmet());
  app.use(cors({ origin: env.APP_URL, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', db: mongoose.connection.readyState === 1 ? 'up' : 'down' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/invitations', publicInvitationRouter);
  app.use('/api/workspaces', requireAuth, workspacesRouter);
  app.use('/api/admin', requireAuth, requirePlatformAdmin, adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

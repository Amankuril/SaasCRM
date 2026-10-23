import './loadEnv.js';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './db/connect.js';
import { closeQueues, startWorkers } from './jobs/queue.js';
import { logger } from './lib/logger.js';

async function main() {
  await connectDatabase(env.MONGODB_URI);
  if (env.RUN_WORKERS) startWorkers();
  const server = createApp().listen(env.PORT, () => {
    logger.info(`Zeta Connect API listening on http://localhost:${env.PORT}`);
  });

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => {
      void closeQueues()
        .then(disconnectDatabase)
        .finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});

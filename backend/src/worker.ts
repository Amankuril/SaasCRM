/** Standalone queue worker for production: `npm run worker` (set RUN_WORKERS=false on the API). */
import './loadEnv.js';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './db/connect.js';
import './jobs/index.js';
import { closeQueues, startWorkers } from './jobs/queue.js';
import { logger } from './lib/logger.js';

await connectDatabase(env.MONGODB_URI);
startWorkers();

const shutdown = (signal: string) => {
  logger.info(`${signal} received, stopping workers`);
  void closeQueues()
    .then(disconnectDatabase)
    .finally(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

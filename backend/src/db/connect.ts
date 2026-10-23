import mongoose from 'mongoose';
import { logger } from '../lib/logger.js';

mongoose.set('strictQuery', true);

export async function connectDatabase(uri: string): Promise<void> {
  await mongoose.connect(uri, { autoIndex: true });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

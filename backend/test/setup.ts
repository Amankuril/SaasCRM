import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';

process.env.MONGODB_URI = inject('mongoUri');

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI!);
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
});

beforeEach(async () => {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
});

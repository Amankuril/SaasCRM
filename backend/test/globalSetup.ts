import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

let mongo: MongoMemoryServer | undefined;

export async function setup(project: TestProject) {
  mongo = await MongoMemoryServer.create();
  project.provide('mongoUri', mongo.getUri('zeta_test'));
}

export async function teardown() {
  await mongo?.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

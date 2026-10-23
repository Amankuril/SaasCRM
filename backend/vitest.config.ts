import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setup.ts'],
    // Files share one in-memory MongoDB; run them one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'test-secret-that-is-definitely-long-enough-123',
      BCRYPT_ROUNDS: '4',
      APP_URL: 'http://localhost:5173',
      ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
      QUEUE_DRIVER: 'inline',
      RUN_WORKERS: 'false',
      META_APP_SECRET: 'test-app-secret',
      META_WEBHOOK_VERIFY_TOKEN: 'test-verify-token',
    },
  },
});

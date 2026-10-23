import { z } from 'zod';

/** Empty strings (e.g. `KEY=` in .env) count as unset. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => v || undefined);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  APP_URL: z.string().url().default('http://localhost:5173'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  // 32-byte key (base64) for encrypting provider credentials at rest.
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64-encoded'),

  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  // `inline` runs jobs immediately in-process (tests); `bullmq` uses Redis-backed queues.
  QUEUE_DRIVER: z.enum(['bullmq', 'inline']).default('bullmq'),
  // Run queue workers inside the API process (dev). In production run `npm run worker` separately.
  RUN_WORKERS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Public URL Meta calls for webhooks (e.g. an ngrok/cloudflared tunnel in development).
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),

  // `sandbox` fakes WhatsApp (any credentials, simulated delivery receipts) for local development.
  WHATSAPP_PROVIDER: z.enum(['meta', 'sandbox']).default('meta'),

  // Meta (WhatsApp Cloud API) app settings. The webhook is rejected until these are set.
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v23.0'),
  META_APP_SECRET: optionalString,
  META_WEBHOOK_VERIFY_TOKEN: optionalString,
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

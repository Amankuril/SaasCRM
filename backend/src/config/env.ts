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

  // `sandbox` answers from knowledge snippets without calling a model (development/demos).
  AI_PROVIDER: z.enum(['anthropic', 'sandbox']).default('anthropic'),
  // Platform-wide key; a workspace may bring its own key instead (stored encrypted).
  ANTHROPIC_API_KEY: optionalString,

  // Subscription payments: `razorpay`, or `sandbox` (fake checkout, development/demos).
  BILLING_PROVIDER: z.enum(['razorpay', 'sandbox']).default('razorpay'),
  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,

  // Lets webhooks and flow HTTP steps call http:// and private/localhost addresses.
  // Development only: in production customer URLs must be public https.
  ALLOW_PRIVATE_OUTBOUND_URLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Meta (WhatsApp Cloud API) app settings. The webhook is rejected until these are set.
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v23.0'),
  // WhatsApp Flows JSON version used for published forms (check Meta's docs for the current one).
  META_FLOW_JSON_VERSION: z.string().regex(/^\d+\.\d+$/).default('6.3'),
  META_APP_SECRET: optionalString,
  // Embedded Signup ("Connect WhatsApp with Facebook"): Meta App ID + the Facebook Login
  // for Business configuration id. Without both, businesses connect manually.
  META_APP_ID: optionalString,
  META_ES_CONFIG_ID: optionalString,
  META_WEBHOOK_VERIFY_TOKEN: optionalString,

  // Outgoing email (login codes). Without SMTP_HOST, development logs codes to the console;
  // production refuses business logins until it is set.
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  // true for port 465 (implicit TLS); false uses STARTTLS when the server offers it.
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  MAIL_FROM: z.string().default('Zeta Connect <no-reply@zetaconnect.app>'),

  // Google Sheets integration. Without an OAuth client, sheets shared as
  // "Anyone with the link" still work; with one, private sheets can be connected.
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  // How often active Google Sheets campaigns are checked for new rows.
  SHEETS_POLL_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

if (isProd && env.ALLOW_PRIVATE_OUTBOUND_URLS) throw new Error('ALLOW_PRIVATE_OUTBOUND_URLS must not be enabled in production.');

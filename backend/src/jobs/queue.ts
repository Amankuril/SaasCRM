import { Queue, Worker, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Durable background jobs. Every job name maps to a BullMQ queue; with
 * QUEUE_DRIVER=inline (tests) jobs run immediately in-process instead.
 *
 * Processors signal "try again later" by throwing; permanent failures should be
 * recorded by the processor itself and return normally.
 */
export interface JobPayloads {
  'whatsapp.send': { workspaceId: string; messageId: string };
  'webhook.process': { eventId: string };
  'campaign.dispatch': { workspaceId: string; campaignId: string };
  'flow.resume': { workspaceId: string; executionId: string; token: string };
  'integration.webhook': { workspaceId: string; deliveryId: string; token: string };
  'billing.sweep': Record<string, never>;
}
export type JobName = keyof JobPayloads;

export interface JobContext {
  attempt: number;
  maxAttempts: number;
}

type Processor<K extends JobName> = (data: JobPayloads[K], ctx: JobContext) => Promise<void>;

const QUEUE_NAMES: Record<JobName, string> = {
  'whatsapp.send': 'whatsapp-send',
  'webhook.process': 'webhooks',
  'campaign.dispatch': 'campaigns',
  'flow.resume': 'flows',
  'integration.webhook': 'integration-webhooks',
  'billing.sweep': 'billing',
};

const CONCURRENCY: Record<JobName, number> = {
  'whatsapp.send': 10,
  'webhook.process': 20,
  'campaign.dispatch': 2,
  'flow.resume': 10,
  'integration.webhook': 20,
  'billing.sweep': 1,
};

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
};

const processors = new Map<JobName, Processor<JobName>>();
/** Jobs the scheduler runs on an interval (durable: BullMQ job schedulers live in Redis). */
const repeating = new Map<JobName, number>();
const queues = new Map<JobName, Queue>();
const workers: Worker[] = [];
let connection: Redis | undefined;

function redis(): Redis {
  // BullMQ requires maxRetriesPerRequest: null for blocking worker connections.
  connection ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

export function registerProcessor<K extends JobName>(name: K, processor: Processor<K>): void {
  processors.set(name, processor as Processor<JobName>);
}

export function registerRepeating(name: JobName, everyMs: number): void {
  repeating.set(name, everyMs);
}

export async function enqueue<K extends JobName>(
  name: K,
  data: JobPayloads[K],
  opts: { jobId?: string; delayMs?: number } = {},
): Promise<void> {
  if (env.QUEUE_DRIVER === 'inline') {
    // Delayed jobs (schedules, next batch) are not run inline; tests drive them explicitly.
    if (opts.delayMs && opts.delayMs > 0) return;
    const processor = processors.get(name);
    if (!processor) throw new Error(`No processor registered for ${name}`);
    try {
      await processor(data, { attempt: 1, maxAttempts: 1 });
    } catch (err) {
      logger.warn({ err, job: name }, 'Inline job failed');
    }
    return;
  }

  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(QUEUE_NAMES[name], { connection: redis(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
    queues.set(name, queue);
  }
  await queue.add(name, data, { jobId: opts.jobId, delay: opts.delayMs });
}

export function startWorkers(): void {
  if (env.QUEUE_DRIVER === 'inline') return;
  for (const [name, processor] of processors) {
    const worker = new Worker(
      QUEUE_NAMES[name],
      (job) => processor(job.data, { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 }),
      { connection: redis(), concurrency: CONCURRENCY[name] },
    );
    worker.on('failed', (job, err) => {
      logger.warn({ job: name, jobId: job?.id, attempt: job?.attemptsMade, err: err.message }, 'Job attempt failed');
    });
    workers.push(worker);
  }
  for (const [name, every] of repeating) {
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(QUEUE_NAMES[name], { connection: redis(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
      queues.set(name, queue);
    }
    void queue.upsertJobScheduler(`${name}-every`, { every }, { name, data: {} }).catch((err) => logger.error({ err, job: name }, 'Could not schedule repeating job'));
  }
  logger.info({ queues: [...processors.keys()] }, 'Queue workers started');
}

/** Job counts per queue for the ops dashboard (null with the inline driver). */
export async function queueStats(): Promise<Record<string, Record<string, number>> | null> {
  if (env.QUEUE_DRIVER === 'inline') return null;
  const out: Record<string, Record<string, number>> = {};
  for (const name of Object.keys(QUEUE_NAMES) as JobName[]) {
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(QUEUE_NAMES[name], { connection: redis(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
      queues.set(name, queue);
    }
    out[name] = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  }
  return out;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...workers.map((w) => w.close()), ...[...queues.values()].map((q) => q.close())]);
  await connection?.quit();
}

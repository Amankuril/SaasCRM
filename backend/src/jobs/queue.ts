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
};

const CONCURRENCY: Record<JobName, number> = {
  'whatsapp.send': 10,
  'webhook.process': 20,
};

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
};

const processors = new Map<JobName, Processor<JobName>>();
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

export async function enqueue<K extends JobName>(
  name: K,
  data: JobPayloads[K],
  opts: { jobId?: string; delayMs?: number } = {},
): Promise<void> {
  if (env.QUEUE_DRIVER === 'inline') {
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
  logger.info({ queues: [...processors.keys()] }, 'Queue workers started');
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...workers.map((w) => w.close()), ...[...queues.values()].map((q) => q.close())]);
  await connection?.quit();
}

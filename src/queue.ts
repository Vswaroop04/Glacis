import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";

// BullMQ needs this setting on the shared connection.
export const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

export interface NormalizeJob {
  rawEventId: string;
}

export const normalizeQueue = new Queue<NormalizeJob>(config.queueName, {
  connection,
  defaultJobOptions: {
    attempts: config.maxAttempts,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 1000,
    removeOnFail: false, // keep failed jobs; we mirror them into the dead_letters table
  },
});

/**
 * Enqueue work. jobId is the raw-event hash, so a duplicate webhook that slipped
 * past the DB check still can't create a second job — queue-level idempotency.
 * Postgres is the durable source of truth; this is just dispatch.
 */
export async function enqueueNormalize(rawEventId: string): Promise<void> {
  await normalizeQueue.add("normalize", { rawEventId }, { jobId: rawEventId });
}

export async function closeQueue(): Promise<void> {
  await normalizeQueue.close();
  await connection.quit();
}

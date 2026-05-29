import { Worker, type Job } from "bullmq";
import { config } from "./config.js";
import { connection, type NormalizeJob } from "./queue.js";
import { normalize } from "./normalize.js";
import { handle } from "./handlers/index.js";
import { evaluateTransition, isAnomalous } from "./state-machine.js";
import { staticLocodeProvider } from "./geo/provider.js";
import { enrichEvent, assembleRoute, type RouteLeg } from "./geo/enrich.js";
import {
  getRawEvent, setRawStatus, insertNormalizedEvent, applySnapshot,
  getSnapshot, getTimeline, insertDeadLetter,
} from "./db.js";

// first attempt uses the cheap fast model; retries escalate to the stronger one
function modelForAttempt(attempt: number): string {
  return attempt <= 1 ? config.primaryModel : config.fallbackModel;
}

async function process(job: Job<NormalizeJob>): Promise<void> {
  const { rawEventId } = job.data;
  const raw = await getRawEvent(rawEventId);
  if (!raw) throw new Error(`raw event ${rawEventId} not found`);
  if (raw.status === "done") return; // already processed (idempotent reprocessing)

  await setRawStatus(rawEventId, "processing");

  const model = modelForAttempt(job.attemptsMade);
  const { event, confidence } = await normalize(raw.payload, model);

  // shape the record and decide if it advances an entity's lifecycle
  const handled = handle(event);

  let needsReview = confidence != null && confidence < config.reviewConfidenceThreshold;

  // geo enrichment (best-effort; never fails the job)
  const enriched = enrichEvent(handled.event, staticLocodeProvider);

  if (handled.snapshot) {
    const snap = await getSnapshot(handled.snapshot.entityId);
    const verdict = evaluateTransition({
      eventType: handled.snapshot.eventType,
      currentState: snap?.canonical_state ?? null,
      currentTimestamp: snap?.last_event_timestamp ? new Date(snap.last_event_timestamp).toISOString() : null,
      incomingState: handled.snapshot.canonicalState,
      incomingTimestamp: handled.snapshot.eventTimestamp,
    });
    if (isAnomalous(verdict)) needsReview = true;

    await insertNormalizedEvent({
      rawEventId, event: enriched.event, confidence,
      model, enrichmentStatus: enriched.status, needsReview,
    });

    // rebuild the route from the entity's full located history (out-of-order safe)
    const timeline = await getTimeline(handled.snapshot.entityId);
    const legs: RouteLeg[] = timeline.map((t) => {
      const loc = t.payload?.event_location ?? null;
      return { state: t.canonical_state, point: loc, ts: new Date(t.event_timestamp).toISOString() };
    });
    const route = assembleRoute(legs);

    await applySnapshot({
      entityId: handled.snapshot.entityId,
      eventType: handled.snapshot.eventType,
      canonicalState: handled.snapshot.canonicalState,
      eventTimestamp: handled.snapshot.eventTimestamp,
      route,
    });
  } else {
    await insertNormalizedEvent({
      rawEventId, event: enriched.event, confidence,
      model, enrichmentStatus: enriched.status, needsReview,
    });
  }

  await setRawStatus(rawEventId, "done");
}

export function startWorker(): Worker<NormalizeJob> {
  const worker = new Worker<NormalizeJob>(config.queueName, process, {
    connection,
    concurrency: config.workerConcurrency,
    // pace consumption so traffic spikes don't blast the LLM provider into 429s.
    // the queue still absorbs unlimited inbound; this only throttles draining.
    limiter: { max: config.workerConcurrency, duration: 1000 },
  });

  // when all retries are exhausted, mirror the job into the dead-letter table
  worker.on("failed", async (job, err) => {
    if (!job) return;
    if (job.attemptsMade >= (job.opts.attempts ?? config.maxAttempts)) {
      await setRawStatus(job.data.rawEventId, "failed").catch(() => {});
      await insertDeadLetter({
        rawEventId: job.data.rawEventId,
        payload: job.data,
        error: err.message,
        attempts: job.attemptsMade,
      }).catch(() => {});
      console.error(`[dlq] ${job.data.rawEventId} after ${job.attemptsMade} attempts: ${err.message}`);
    } else {
      console.warn(`[retry] ${job.data.rawEventId} attempt ${job.attemptsMade}: ${err.message}`);
    }
  });

  return worker;
}

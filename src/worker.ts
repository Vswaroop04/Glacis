import { Worker, type Job } from "bullmq";
import { config } from "./config.js";
import { connection, type NormalizeJob } from "./queue.js";
import { normalize } from "./normalize.js";
import { PROMPT_VERSION } from "./prompt.js";
import { handle } from "./handlers/index.js";
import { evaluateTransition, type TransitionVerdict } from "./state-machine.js";
import { computeConfidence, reviewReasons } from "./confidence.js";
import { geoProvider } from "./geo/live.js";
import { enrichEvent, assembleRoute, type RouteLeg } from "./geo/enrich.js";
import {
  getRawEvent, setRawStatus, insertNormalizedEvent, applySnapshot,
  getSnapshot, getTimeline, insertDeadLetter, insertReview,
} from "./db.js";
import { publish } from "./bus.js";

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
  const { event, confidence: modelConfidence } = await normalize(raw.payload, model);

  // shape the record and decide if it advances an entity's lifecycle
  const handled = handle(event);

  // deterministic + geo enrichment (best-effort; never fails the job)
  const enriched = await enrichEvent(handled.event, geoProvider);

  // evaluate the lifecycle transition (only when this event belongs to an entity)
  let verdict: TransitionVerdict | null = null;
  if (handled.snapshot) {
    const snap = await getSnapshot(handled.snapshot.entityId);
    verdict = evaluateTransition({
      eventType: handled.snapshot.eventType,
      currentState: snap?.canonical_state ?? null,
      currentTimestamp: snap?.last_event_timestamp ? new Date(snap.last_event_timestamp).toISOString() : null,
      incomingState: handled.snapshot.canonicalState,
      incomingTimestamp: handled.snapshot.eventTimestamp,
    });
  }

  // confidence we compute ourselves from verifiable signals, not the model's word
  const confInputs = { event: enriched.event, modelConfidence, verdict, enrichmentStatus: enriched.status, containerValid: enriched.containerValid };
  const confidence = computeConfidence(confInputs);
  const reasons = reviewReasons(confInputs, confidence, config.reviewConfidenceThreshold);
  const needsReview = reasons.length > 0;

  await insertNormalizedEvent({
    rawEventId, event: enriched.event, confidence, modelConfidence,
    model, promptVersion: PROMPT_VERSION, enrichmentStatus: enriched.status, needsReview,
  });

  if (needsReview) {
    await insertReview({
      rawEventId,
      entityId: handled.snapshot?.entityId ?? null,
      reason: reasons.join("+"),
      confidence,
    });
  }

  if (handled.snapshot) {
    // rebuild the route from the entity's full located history (out-of-order safe)
    const timeline = await getTimeline(handled.snapshot.entityId);
    const legs: RouteLeg[] = timeline.map((t) => {
      const loc = t.payload?.event_location ?? null;
      return { state: t.canonical_state, point: loc, ts: new Date(t.event_timestamp).toISOString() };
    });
    const mode = enriched.event.event_type === "SHIPMENT" ? enriched.event.mode : "UNKNOWN";
    const route = assembleRoute(legs, mode);

    await applySnapshot({
      entityId: handled.snapshot.entityId,
      eventType: handled.snapshot.eventType,
      canonicalState: handled.snapshot.canonicalState,
      eventTimestamp: handled.snapshot.eventTimestamp,
      route,
    });
  }

  await setRawStatus(rawEventId, "done");

  publish({
    type: "processed",
    rawEventId,
    at: new Date().toISOString(),
    eventType: enriched.event.event_type,
    mode: enriched.event.event_type === "SHIPMENT" ? enriched.event.mode : undefined,
    entityId: handled.snapshot?.entityId ?? null,
    state: handled.snapshot?.canonicalState ?? null,
    confidence,
    needsReview,
    isException: enriched.event.event_type === "SHIPMENT" ? enriched.event.is_exception : undefined,
    exceptionReason: enriched.event.event_type === "SHIPMENT" ? enriched.event.exception_reason ?? null : undefined,
    enrichmentStatus: enriched.status,
    model,
  });
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
      publish({ type: "failed", rawEventId: job.data.rawEventId, at: new Date().toISOString(), error: err.message });
      console.error(`[dlq] ${job.data.rawEventId} after ${job.attemptsMade} attempts: ${err.message}`);
    } else {
      console.warn(`[retry] ${job.data.rawEventId} attempt ${job.attemptsMade}: ${err.message}`);
    }
  });

  return worker;
}

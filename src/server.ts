import Fastify, { type FastifyInstance } from "fastify";
import { deriveIdentity } from "./ingest.js";
import { enqueueNormalize } from "./queue.js";
import {
  insertRawEvent, getRawEvent, getSnapshot, getTimeline,
  listDeadLetters, metrics,
} from "./db.js";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  // Ingestion. Persist the raw event, enqueue, and ACK immediately — the LLM call
  // happens off the hot path so vendors get a sub-second response. Duplicate
  // payloads are deduped here and simply ACKed without enqueuing more work.
  app.post("/webhooks", async (req, reply) => {
    const body = req.body;
    if (body === undefined || body === null) {
      return reply.code(400).send({ error: "empty body" });
    }
    const idemKey = req.headers["idempotency-key"];
    const identity = deriveIdentity(body, typeof idemKey === "string" ? idemKey : undefined);

    const { inserted } = await insertRawEvent({
      id: identity.id,
      vendor: identity.vendor,
      vendorEventId: identity.vendorEventId,
      payload: body,
    });

    if (inserted) {
      await enqueueNormalize(identity.id);
      return reply.code(202).header("x-webhook-id", identity.id).send({ id: identity.id, status: "accepted" });
    }
    // already seen — idempotent no-op, still a success for the vendor
    return reply.code(200).header("x-webhook-id", identity.id).send({ id: identity.id, status: "duplicate" });
  });

  // Inspect a single ingestion's processing status.
  app.get<{ Params: { id: string } }>("/webhooks/:id", async (req, reply) => {
    const raw = await getRawEvent(req.params.id);
    if (!raw) return reply.code(404).send({ error: "not found" });
    return { id: raw.id, status: raw.status, vendor: raw.vendor, received_at: raw.received_at };
  });

  // Current state of an entity plus its full event timeline (ordered by event time).
  app.get<{ Params: { id: string } }>("/entities/:id", async (req, reply) => {
    const snapshot = await getSnapshot(req.params.id);
    if (!snapshot) return reply.code(404).send({ error: "not found" });
    const timeline = await getTimeline(req.params.id);
    return { snapshot, timeline };
  });

  // Resolved route for a shipment entity.
  app.get<{ Params: { id: string } }>("/entities/:id/route", async (req, reply) => {
    const snapshot = await getSnapshot(req.params.id);
    if (!snapshot) return reply.code(404).send({ error: "not found" });
    return { entity_id: snapshot.entity_id, route: snapshot.route ?? null };
  });

  // Dead-letter queue: events that exhausted retries, for inspection / replay.
  app.get("/dead-letters", async () => ({ dead_letters: await listDeadLetters() }));

  // Operational metrics.
  app.get("/metrics", async () => await metrics());

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

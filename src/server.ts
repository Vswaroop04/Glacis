import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { deriveIdentity } from "./ingest.js";
import { enqueueNormalize } from "./queue.js";
import { publish, subscribe } from "./bus.js";
import {
  insertRawEvent, getRawEvent, getSnapshot, getTimeline,
  listEntities, listDeadLetters, listReviewQueue, listOpenExceptions, metrics,
} from "./db.js";

const INDEX_HTML = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  // the demo UI
  app.get("/", async (_req, reply) => reply.type("text/html").send(INDEX_HTML));

  // Server-Sent Events: push a message every time a webhook moves through the
  // pipeline, so the UI can show the async result land without polling.
  app.get("/stream", (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");
    const unsubscribe = subscribe((e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`));
    const keepalive = setInterval(() => reply.raw.write(": ping\n\n"), 20000);
    req.raw.on("close", () => { clearInterval(keepalive); unsubscribe(); });
  });

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
      publish({ type: "accepted", rawEventId: identity.id, at: new Date().toISOString() });
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

  // List current entities (snapshots), optionally filtered by ?type=SHIPMENT|INVOICE.
  app.get<{ Querystring: { type?: string } }>("/entities", async (req) => {
    const type = req.query.type === "SHIPMENT" || req.query.type === "INVOICE" ? req.query.type : null;
    return { entities: await listEntities(type) };
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

  // Human review queue: events the system wasn't confident about.
  app.get("/review-queue", async () => ({ review_queue: await listReviewQueue() }));

  // Shipments currently sitting on an exception (customs hold, delay, etc).
  app.get("/exceptions", async () => ({ open_exceptions: await listOpenExceptions() }));

  // Operational metrics.
  app.get("/metrics", async () => await metrics());

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

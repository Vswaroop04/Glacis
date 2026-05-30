import { Pool } from "pg";
import { config } from "./config.js";
import type { NormalizedEvent, Route } from "./schemas.js";

export const pool = new Pool({ connectionString: config.databaseUrl });

/**
 * Event-sourced storage: three layers that are never collapsed.
 *   raw_events        — immutable original payload (the source of truth, never lost)
 *   normalized_events — append-only log of LLM-normalized + enriched events
 *   entity_snapshots  — derived current state per entity (rebuildable from the log)
 *   dead_letters      — events that exhausted retries, kept for inspection / replay
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_events (
  id              TEXT PRIMARY KEY,                 -- SHA-256 of the raw body
  vendor          TEXT,
  vendor_event_id TEXT,
  payload         JSONB       NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending',  -- pending|processing|done|failed
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency is the body hash (the PK): identical retries collapse to one row,
-- while different lifecycle events of the same entity (e.g. invoice ISSUED then
-- PAID share a doc_ref but differ in body) stay distinct. vendor/vendor_event_id
-- are kept as queryable metadata only, never as a dedup key.
DROP INDEX IF EXISTS uq_raw_vendor_event;
CREATE INDEX IF NOT EXISTS ix_raw_vendor_event ON raw_events (vendor, vendor_event_id);

CREATE TABLE IF NOT EXISTS normalized_events (
  id                BIGGSERIAL PRIMARY KEY,
  raw_event_id      TEXT        NOT NULL REFERENCES raw_events(id),
  event_type        TEXT        NOT NULL,
  entity_id         TEXT,
  canonical_state   TEXT,
  event_timestamp   TIMESTAMPTZ,
  payload           JSONB       NOT NULL,
  confidence        REAL,
  model             TEXT        NOT NULL,
  enrichment_status TEXT        NOT NULL,
  needs_review      BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (raw_event_id)
);
CREATE INDEX IF NOT EXISTS ix_norm_entity_ts
  ON normalized_events (entity_id, event_timestamp);

CREATE TABLE IF NOT EXISTS entity_snapshots (
  entity_id            TEXT PRIMARY KEY,
  event_type           TEXT        NOT NULL,
  canonical_state      TEXT        NOT NULL,
  last_event_timestamp TIMESTAMPTZ NOT NULL,
  route                JSONB,
  event_count          INTEGER     NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dead_letters (
  id           BIGSERIAL PRIMARY KEY,
  raw_event_id TEXT,
  payload      JSONB,
  error        TEXT        NOT NULL,
  attempts     INTEGER     NOT NULL,
  failed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- provenance for reprocessing: which prompt + the model's own (untrusted) score
ALTER TABLE normalized_events ADD COLUMN IF NOT EXISTS model_confidence REAL;
ALTER TABLE normalized_events ADD COLUMN IF NOT EXISTS prompt_version TEXT;

-- so you can answer "which shipments are currently held?" off the snapshot
ALTER TABLE entity_snapshots ADD COLUMN IF NOT EXISTS has_open_exception BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE entity_snapshots ADD COLUMN IF NOT EXISTS open_exception_reason TEXT;

-- one snapshot table serves both types, but the DB still enforces that the state
-- vocabulary matches the type — an invoice state can never land in a shipment row
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_snapshot_state') THEN
    ALTER TABLE entity_snapshots ADD CONSTRAINT chk_snapshot_state CHECK (
      (event_type = 'SHIPMENT' AND canonical_state IN ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED'))
      OR (event_type = 'INVOICE' AND canonical_state IN ('ISSUED','PAID','VOIDED','REFUNDED'))
    );
  END IF;
END $$;

-- events the system is not sure about, surfaced for a human to check
CREATE TABLE IF NOT EXISTS review_queue (
  id           BIGSERIAL PRIMARY KEY,
  raw_event_id TEXT REFERENCES raw_events(id),
  entity_id    TEXT,
  reason       TEXT        NOT NULL,
  confidence   REAL,
  resolved     BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`.replace("BIGGSERIAL", "BIGSERIAL");

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA);
}

// raw events
export interface RawEventInput {
  id: string;
  vendor: string | null;
  vendorEventId: string | null;
  payload: unknown;
}

/**
 * Idempotent insert. Returns whether THIS call created the row. A duplicate
 * (same hash, or same vendor+event_id) returns inserted=false, and the caller
 * ACKs without enqueuing more work.
 */
export async function insertRawEvent(e: RawEventInput): Promise<{ inserted: boolean }> {
  const res = await pool.query(
    `INSERT INTO raw_events (id, vendor, vendor_event_id, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [e.id, e.vendor, e.vendorEventId, JSON.stringify(e.payload)],
  );
  return { inserted: (res.rowCount ?? 0) > 0 };
}

export async function getRawEvent(id: string) {
  const res = await pool.query(`SELECT * FROM raw_events WHERE id = $1`, [id]);
  return res.rows[0] ?? null;
}

export async function setRawStatus(id: string, status: string): Promise<void> {
  await pool.query(`UPDATE raw_events SET status = $2 WHERE id = $1`, [id, status]);
}

// normalized events
export interface NormalizedInput {
  rawEventId: string;
  event: NormalizedEvent;
  confidence: number | null;       // computed confidence (authoritative)
  modelConfidence: number | null;  // the model's own self-report
  model: string;
  promptVersion: string;
  enrichmentStatus: string;
  needsReview: boolean;
}

export async function insertNormalizedEvent(n: NormalizedInput): Promise<void> {
  const entityId = "entity_id" in n.event ? n.event.entity_id : null;
  const state = "canonical_state" in n.event ? n.event.canonical_state : null;
  const ts = "event_timestamp" in n.event ? n.event.event_timestamp : null;

  await pool.query(
    `INSERT INTO normalized_events
       (raw_event_id, event_type, entity_id, canonical_state, event_timestamp,
        payload, confidence, model_confidence, model, prompt_version, enrichment_status, needs_review)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (raw_event_id) DO NOTHING`,
    [
      n.rawEventId, n.event.event_type, entityId, state, ts,
      JSON.stringify(n.event), n.confidence, n.modelConfidence, n.model, n.promptVersion,
      n.enrichmentStatus, n.needsReview,
    ],
  );
}

export async function insertReview(r: {
  rawEventId: string;
  entityId: string | null;
  reason: string;
  confidence: number | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO review_queue (raw_event_id, entity_id, reason, confidence)
     VALUES ($1, $2, $3, $4)`,
    [r.rawEventId, r.entityId, r.reason, r.confidence],
  );
}

export async function listReviewQueue(limit = 100) {
  const res = await pool.query(
    `SELECT * FROM review_queue WHERE NOT resolved ORDER BY created_at DESC LIMIT $1`, [limit],
  );
  return res.rows;
}

/**
 * Timestamp-guarded upsert — the core out-of-order defence.
 *
 * The snapshot's canonical_state only advances when the incoming event's
 * event_timestamp is NEWER than what we've already recorded. A late-arriving
 * PICKED_UP (older timestamp) that lands after DELIVERED is still counted and
 * lives in the append-only log, but it can NOT regress the head state.
 *
 * Ordering is decided by event_timestamp (when it happened), never by arrival
 * time. event_count and the snapshot row are updated atomically in one statement.
 */
export async function applySnapshot(args: {
  entityId: string;
  eventType: "SHIPMENT" | "INVOICE";
  canonicalState: string;
  eventTimestamp: string;
  route: Route | null;
  isException: boolean;
  exceptionReason: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO entity_snapshots
       (entity_id, event_type, canonical_state, last_event_timestamp, route,
        has_open_exception, open_exception_reason, event_count, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, now())
     ON CONFLICT (entity_id) DO UPDATE SET
       canonical_state = CASE
         WHEN EXCLUDED.last_event_timestamp > entity_snapshots.last_event_timestamp
         THEN EXCLUDED.canonical_state ELSE entity_snapshots.canonical_state END,
       last_event_timestamp = GREATEST(
         entity_snapshots.last_event_timestamp, EXCLUDED.last_event_timestamp),
       -- route is derived from the entity's full history, so the freshest
       -- computation is always the most complete; take it whenever present
       route = COALESCE(EXCLUDED.route, entity_snapshots.route),
       -- exception status follows the latest event, same out-of-order guard as state
       has_open_exception = CASE
         WHEN EXCLUDED.last_event_timestamp > entity_snapshots.last_event_timestamp
         THEN EXCLUDED.has_open_exception ELSE entity_snapshots.has_open_exception END,
       open_exception_reason = CASE
         WHEN EXCLUDED.last_event_timestamp > entity_snapshots.last_event_timestamp
         THEN EXCLUDED.open_exception_reason ELSE entity_snapshots.open_exception_reason END,
       event_count = entity_snapshots.event_count + 1,
       updated_at = now()`,
    [
      args.entityId, args.eventType, args.canonicalState, args.eventTimestamp,
      args.route ? JSON.stringify(args.route) : null,
      args.isException, args.exceptionReason,
    ],
  );
}

export async function listOpenExceptions(limit = 100) {
  const res = await pool.query(
    `SELECT entity_id, event_type, canonical_state, open_exception_reason, last_event_timestamp
       FROM entity_snapshots WHERE has_open_exception ORDER BY last_event_timestamp DESC LIMIT $1`,
    [limit],
  );
  return res.rows;
}

export async function getSnapshot(entityId: string) {
  const res = await pool.query(`SELECT * FROM entity_snapshots WHERE entity_id = $1`, [entityId]);
  return res.rows[0] ?? null;
}

export async function getTimeline(entityId: string) {
  const res = await pool.query(
    `SELECT event_type, canonical_state, event_timestamp, confidence, model,
            enrichment_status, needs_review, payload, created_at
       FROM normalized_events
      WHERE entity_id = $1
      ORDER BY event_timestamp ASC`,
    [entityId],
  );
  return res.rows;
}

// dead letters
export async function insertDeadLetter(d: {
  rawEventId: string | null;
  payload: unknown;
  error: string;
  attempts: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO dead_letters (raw_event_id, payload, error, attempts)
     VALUES ($1, $2, $3, $4)`,
    [d.rawEventId, d.payload ? JSON.stringify(d.payload) : null, d.error, d.attempts],
  );
}

export async function listDeadLetters(limit = 100) {
  const res = await pool.query(
    `SELECT * FROM dead_letters ORDER BY failed_at DESC LIMIT $1`, [limit],
  );
  return res.rows;
}

// metrics
export async function metrics() {
  const [statuses, types, review, dlq, latency] = await Promise.all([
    pool.query(`SELECT status, count(*)::int AS n FROM raw_events GROUP BY status`),
    pool.query(`SELECT event_type, count(*)::int AS n FROM normalized_events GROUP BY event_type`),
    pool.query(`SELECT count(*)::int AS n FROM normalized_events WHERE needs_review`),
    pool.query(`SELECT count(*)::int AS n FROM dead_letters`),
    pool.query(
      `SELECT round(avg(extract(epoch FROM (created_at - r.received_at)) * 1000)::numeric, 1) AS ms
         FROM normalized_events n JOIN raw_events r ON r.id = n.raw_event_id`,
    ),
  ]);
  return {
    raw_by_status: Object.fromEntries(statuses.rows.map((r) => [r.status, r.n])),
    normalized_by_type: Object.fromEntries(types.rows.map((r) => [r.event_type, r.n])),
    needs_review: review.rows[0]?.n ?? 0,
    dead_letters: dlq.rows[0]?.n ?? 0,
    avg_processing_ms: latency.rows[0]?.ms ?? null,
  };
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

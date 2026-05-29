# Glacis — AI Webhook Ingestion Service

Ingests arbitrary vendor webhooks (logistics + financial), classifies and normalizes them into a strict canonical schema using an LLM, and persists the result with the resiliency a production webhook pipeline needs: sub-second acknowledgement, idempotency, out-of-order handling, retries, and a dead-letter queue.

The interesting part of this problem is not the LLM call — it's everything around it. Vendors expect an instant ACK, they resend the same payload, and events arrive out of order. The architecture below is built around those realities.

---

## Architecture

```
                    POST /webhooks (any JSON)
                              │
              ┌───────────────▼────────────────┐
              │  Fastify ingest                 │
              │  1. hash body (idempotency key) │
              │  2. INSERT raw_event (ON CONFLICT DO NOTHING)
              │  3. enqueue (jobId = hash)      │
              │  4. 202 Accepted  ← ~15ms       │   LLM is OFF the hot path
              └───────────────┬────────────────┘
                              │  (Redis / BullMQ)
              ┌───────────────▼────────────────┐
              │  Worker (concurrency + limiter) │
              │  ┌───────────────────────────┐  │
              │  │ normalize  (1 LLM call)    │  │  Haiku → Sonnet on retry
              │  │ validate   (Zod gate)      │  │  invalid ⇒ retry ⇒ DLQ
              │  │ handle     (type registry) │  │
              │  │ transition (state machine) │  │  flags regressions/anomalies
              │  │ enrich     (geo, best-effort)│ │
              │  │ persist    (event + snapshot)│ │  timestamp-guarded upsert
              │  └───────────────────────────┘  │
              └───────────────┬────────────────┘
                              │
              ┌───────────────▼────────────────┐
              │ Postgres (durable source of truth)
              │   raw_events        immutable originals
              │   normalized_events append-only log
              │   entity_snapshots  derived head state
              │   dead_letters      exhausted retries
              └─────────────────────────────────┘
```

**Postgres is the source of truth; Redis/BullMQ is only work dispatch.** The raw event is persisted *before* it is enqueued, so if Redis is lost no webhook is lost — the work can be re-enqueued from `raw_events`.

---

## Why not an "agent"?

Normalization is a single, bounded task: classify + extract into a strict schema. It is done in **one structured tool call**, not an autonomous agent loop, because:

- **Latency** — one round trip (~2s) vs many. Vendors and the worker both benefit.
- **Cost** — 1× the tokens, not 3–10×.
- **Determinism** — one call is testable and reproducible; the [benchmark](benchmarks/README.md) shows a single Haiku call hits 100% on the sample payloads.
- **Failure surface** — one thing can go wrong, not a loop that can stall.

The extensibility an agent would give is provided instead by a **typed handler registry** ([`src/handlers`](src/handlers/index.ts)): adding a new event type is one handler + one switch arm, with no change to the LLM or worker layers. Tool-use *is* used for the one place it genuinely fits — deterministic **geo enrichment** — but as plain code, because an LLM would hallucinate coordinates.

---

## Resiliency & data integrity

### Sub-second acknowledgement
The endpoint persists the raw event, enqueues a job, and returns `202` — measured at **~15ms**. The LLM call happens asynchronously in the worker, so vendor-facing latency is independent of model latency.

### Idempotency (vendors resend the same payload)
The idempotency key is the **SHA-256 of the canonical body** (key-order independent), used as the `raw_events` primary key *and* the BullMQ `jobId`. An exact retry collapses to the same row and the same job — dedup at both the storage and queue layers. A vendor-supplied `Idempotency-Key` header is honored when present.

A deliberate non-choice: dedup is **not** keyed on a vendor event/document id, because an invoice's `ISSUED` and `PAID` events share a `doc_ref` but are different lifecycle events. They have different bodies, so they hash differently and stay distinct — while true duplicates still collapse.

### Out-of-order events (this is where correctness is easy to get wrong)
Events are ordered by **`event_timestamp` (when it happened)**, never by arrival time. The snapshot upsert is timestamp-guarded ([`applySnapshot`](src/db.ts)):

```sql
canonical_state = CASE
  WHEN EXCLUDED.last_event_timestamp > entity_snapshots.last_event_timestamp
  THEN EXCLUDED.canonical_state ELSE entity_snapshots.canonical_state END
```

A `PICKED_UP` that arrives *after* `DELIVERED` is still stored in the append-only log and counted, but it **cannot regress** the head state. Verified live: the head stays `DELIVERED`/`IN_TRANSIT` while the late event lands in history.

### State machine
[`src/state-machine.ts`](src/state-machine.ts) classifies every transition: `INITIAL`, `ADVANCE`, `DUPLICATE`, `OUT_OF_ORDER` (benign late arrival), or `ANOMALY`. The key distinction: a late `PICKED_UP` (older timestamp) is benign, but a `PICKED_UP` with a *newer* timestamp after `DELIVERED` is a genuine `ANOMALY`. Anomalies are stored and flagged `needs_review` — never silently dropped. Invoice rules (`ISSUED → PAID|VOIDED`, `PAID → REFUNDED`) are enforced the same way.

### LLM reliability
The model output passes a **Zod validation gate** before it can be stored. Invalid output throws and becomes a retry. The model also returns a `confidence`; anything below threshold is flagged `needs_review`.

### Retries, backoff, tiered fallback, DLQ
BullMQ retries with exponential backoff. **Attempt 1 uses Haiku (cheap, fast); retries escalate to Sonnet** (the benchmark's most reliable model on hard cases) — a model choice driven directly by the benchmark data. When attempts are exhausted the job is mirrored into `dead_letters` with the error and attempt count, and `raw_events.status` becomes `failed`. Verified live.

### Rate limiting
The worker has a configurable limiter (`max` jobs / interval) plus concurrency. The queue absorbs unlimited inbound traffic; the limiter only paces *consumption* so spikes don't trigger LLM-provider 429s.

### Enrichment — filling what vendors leave out (best-effort)
Logistics webhooks routinely omit fields the platform needs. The system derives them deterministically after normalization. All of this is **non-blocking**: any failure produces a `PARTIAL`/`FAILED`/`SKIPPED` status and is never allowed to fail normalization.

| Derived | How | Source of truth |
|---|---|---|
| Coordinates from a port code/name | static UN/LOCODE table → live geocoder fallback | [`geo/`](src/geo) |
| Carrier name from a SCAC code | static SCAC registry (`MAEU`→Maersk) | [`enrich/carriers.ts`](src/enrich/carriers.ts) |
| Container number validity | ISO 6346 check-digit; bad → `needs_review` | [`enrich/container.ts`](src/enrich/container.ts) |
| Route distance + transit + ETA | mode-aware (sea/air/road), from resolved endpoints | [`enrich/distance.ts`](src/enrich/distance.ts) |

**Geo resolution is two-tier.** A static LOCODE table is the *primary* (exact, offline, deterministic for known ports). A live **Photon→Nominatim** geocoder is the *fallback* for a port name with no code, or a road address — borrowed from the spotter-labs project's design, but global (no US bounding box). The [port geocoding benchmark](benchmarks/geo/README.md) shows *why* this ordering matters: freeform geocoding put "Port of Shanghai" ~9,000 km off, so the table must be primary and the geocoder labelled (`source: GEOCODER`) as best-effort only.

### Multi-modal
A shipment carries a `mode` (`SEA`/`AIR`/`ROAD`/`RAIL`/`PARCEL`), classified by the LLM. The lifecycle states are mode-agnostic, but enrichment is mode-aware: distance is a sea-lane approximation for `SEA`, an exact **great-circle for `AIR`**, and road routing for `ROAD`; ETA uses a per-mode speed. The sample payloads are all `SEA`, which is implemented end-to-end; `AIR` distance is correct out of the box; `ROAD` is wired through the same geocoder + a routing-provider interface (the spotter-labs ORS HGV stack is the production fit). This keeps the system from being locked to one transport mode.

---

## Data model

| Table | Role |
|---|---|
| `raw_events` | Immutable original payloads. The source of truth; never mutated except status. |
| `normalized_events` | Append-only log of normalized + enriched events, with confidence/model/provenance. |
| `entity_snapshots` | Derived current state per entity (rebuildable from the log). Holds the route. |
| `dead_letters` | Events that exhausted retries, kept for inspection / replay. |

This is event-sourcing-flavored: the raw payload and the normalized log are kept separately and never lost, and the snapshot is a derived projection.

---

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhooks` | Ingest any JSON. `202` + `x-webhook-id`, or `200 duplicate`. |
| `GET` | `/webhooks/:id` | Processing status of one ingestion. |
| `GET` | `/entities/:id` | Entity snapshot + full timeline (ordered by event time). |
| `GET` | `/entities/:id/route` | Resolved origin/destination/distance. |
| `GET` | `/dead-letters` | Failed events for inspection. |
| `GET` | `/metrics` | Queue/status counts, needs-review, DLQ size, avg processing ms. |
| `GET` | `/health` | Liveness. |

---

## Running it

```bash
docker compose up -d          # postgres + redis
cp .env.example .env          # add ANTHROPIC_API_KEY (OPENAI_API_KEY optional)
npm install
npm start                     # server + worker on :3000
```

Then:

```bash
curl -X POST localhost:3000/webhooks -H 'content-type: application/json' \
  -d '{"carrier_scac":"MAEU","transport_doc":{"number":"MAEU240498712"},
       "milestone":"Loaded onboard and sailed","milestone_at":"2026-04-21T22:47:00+08:00",
       "port":{"code":"CNSHA","name":"Shanghai"}}'

curl localhost:3000/entities/MAEU240498712
curl localhost:3000/metrics
```

Scripts: `npm run typecheck`, `npm run bench:llm` (model comparison), `npm run bench:geo` (port geocoding), and `scripts/smoke-*.ts` (db, normalize, state machine, geo, enrich).

---

## Model choice — driven by the benchmark

The default is **Haiku 4.5** with **Sonnet 4.6** as the retry fallback. This comes from the [benchmark suite](benchmarks/README.md), which compared 6 models across accuracy, reliability on hard/adversarial payloads, latency, throughput, and cost. Haiku gives 100% accuracy on clean payloads at low latency; Sonnet is the most reliable on adversarial cases, so it's the right escalation target — not the default.

---

## Tradeoffs made for the time box

- **Sea distance is a great-circle approximation**, not a true sea-lane distance (which follows shipping routes). It's labelled `SEA_ROUTE` and the distance layer is swappable for a sea-route provider (searoutes.com). Air distance is already exact (great-circle).
- **Geo is a small static LOCODE table + a live geocoder fallback.** Production would use a full UN/LOCODE / World Port Index dataset; the geocoder is mainly for road addresses.
- **In-process worker** rather than a separate worker deployment. The boundary (`startWorker`) is clean enough to split out.
- **Polling-free BullMQ** keeps infra to Postgres + Redis (one `docker compose up`) rather than Kafka/Temporal.
- **Confidence** is the model's self-report, not a calibrated score.
- **AIR/ROAD enrichment is wired but not deep** — no sample payloads for those modes; SEA is the implemented path.

---

## Production roadmap

- **Queue/durability**: BullMQ → Kafka or a durable workflow engine (Temporal) for replay, partitioning, and exactly-once semantics at scale.
- **Scaling**: workers are stateless — scale horizontally; Postgres read replicas for the query endpoints.
- **Observability**: OpenTelemetry traces across ingest → queue → LLM → persist; per-stage latency and per-model accuracy dashboards.
- **Eval framework**: promote the benchmark into CI — gate prompt/model changes on accuracy regressions, add a labeled golden set.
- **Human review queue**: surface `needs_review` (low confidence + anomalies) to an ops UI with correction feedback.
- **Enrichment**: full UN/LOCODE dataset + sea-route distance provider; carrier SCAC registry.
- **Schema evolution**: versioned canonical schema; backfill by replaying `normalized_events`.

---

## Considered: Mastra / agent frameworks — and why not (yet)

An agent framework (e.g. Mastra) was considered for orchestration. It was rejected for the hot path because the resiliency guarantees that matter here — body-hash idempotency and the timestamp-guarded out-of-order upsert — are domain-specific and must be explicit and visible, not delegated to a framework's durable-workflow store (which would also duplicate the `raw_events` queue as a second source of truth). BullMQ was chosen instead: it's the industry-standard job queue and provides retries/backoff/DLQ without hiding the data-integrity logic. A framework's eval tooling is a reasonable future addition (see roadmap), but not on the ingestion path.
```

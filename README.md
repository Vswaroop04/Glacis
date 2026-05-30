# Glacis — AI Webhook Ingestion Service

A service that takes webhooks from logistics and finance vendors — every one of them shaped differently — figures out what each event is, normalizes it into one internal schema with an LLM, and stores it so that duplicates, out-of-order arrivals, and bad data don't corrupt anything.

## How I read the assignment

The first thing I decided was that the LLM part is the easy 20%. Calling a model with a tool schema and getting back clean JSON is close to a solved problem. The brief itself tells you where the real work is — it mentions sub-second acknowledgements, vendors resending the same payload, and events arriving out of order. Those three lines are the whole assignment. A `POST → LLM → save` toy meets none of them. So I built around them and treated the model call as one stage in a pipeline rather than the centerpiece.

## I started with a benchmark, not the service

Before writing any service code I wanted to know which model to trust, so I wrote a benchmark suite first ([`benchmarks/`](benchmarks/README.md)). It runs the sample payloads and an adversarial set across six models — Haiku, Sonnet, and four GPT variants — and measures accuracy, reliability on the hard cases, latency, throughput, and cost.

That told me two useful things. Haiku 4.5 gets 100% on the clean payloads at low latency and low cost, so it's the right default. Sonnet is the most reliable when the input gets adversarial, but it's slow and pricey, so it's wrong as a default and right as a fallback. I used that result directly: the worker runs Haiku first, and only escalates to Sonnet if the first attempt fails validation. I'll come back to that.

## The shape of the system

The single most important decision is that the LLM never runs on the request path. When a webhook comes in, I hash it, write the raw event to Postgres, drop a job on a queue, and return `202` — measured at around 15ms. Everything else happens in a background worker.

```
POST /webhooks ─► hash ─► save raw ─► enqueue ─► 202   (~15ms, no LLM here)
                                          │
                                     (BullMQ / Redis)
                                          ▼
   worker: normalize ─► validate ─► route to handler ─► check state transition
           ─► enrich (geo, carrier, container, ETA) ─► save event + snapshot
```

I went with Postgres for storage and BullMQ on Redis for the queue. The thing I care about there: Postgres is the source of truth, the queue is just dispatch. I write the raw event to Postgres *before* enqueuing, so if Redis falls over I haven't lost a single webhook — I can replay from the raw table. A lot of designs put the payload only in the queue and lose it when the queue dies.

## Idempotency

Vendors resend. The brief says so explicitly. My key is the SHA-256 of the canonical body (sorted keys, so field order doesn't matter), used as both the Postgres primary key and the BullMQ job id. An exact resend collapses to the same row and the same job — deduped at the storage and the queue layer.

I actually got this wrong the first time and caught it in live testing, which is worth admitting because it shaped the final design. I'd added a second "smart" dedup key on `(vendor, document_id)`, thinking it would catch logical duplicates. But an invoice's ISSUED and PAID events share the same `doc_ref` — they're different events in the same entity's life. My clever key threw the PAID event away as a duplicate. The fix was to delete the clever key: ISSUED and PAID have different bodies, so they hash differently and stay distinct, while genuine byte-for-byte resends still collapse. The simpler key was the correct one.

## Out-of-order events

This is the part I was most worried about getting wrong, because it's the part a naive system silently corrupts. If `DELIVERED` arrives and then a delayed `PICKED_UP` shows up an hour later, you must not let the shipment regress to PICKED_UP.

I order everything by the event's own timestamp, never by when it arrived. The snapshot update is guarded in SQL — the head state only moves forward when the incoming event is actually newer:

```sql
canonical_state = CASE
  WHEN EXCLUDED.last_event_timestamp > entity_snapshots.last_event_timestamp
  THEN EXCLUDED.canonical_state ELSE entity_snapshots.canonical_state END
```

The late `PICKED_UP` still gets stored and counted in the event log, it just can't move the head backwards. I tested this end-to-end: post the in-transit event, then post an earlier pickup, and the entity stays `IN_TRANSIT` with two events in its timeline ordered correctly.

On top of the timestamp guard there's a small state machine ([`src/state-machine.ts`](src/state-machine.ts)) that judges each transition. A late pickup (older timestamp) is a benign `OUT_OF_ORDER`. But a pickup with a *newer* timestamp landing after delivery is a real `ANOMALY` — that's not late data, that's wrong data — so it gets flagged for review instead of trusted. Invoices get the same treatment (`ISSUED → PAID → REFUNDED`, with `VOIDED` off ISSUED).

## Not trusting the model blindly

The model output goes through a Zod schema gate before it's allowed anywhere near storage. If it doesn't parse, it throws, and that becomes a retry — and the retry is where the model escalates from Haiku to Sonnet. The model also returns a confidence score; anything under threshold gets flagged for review rather than silently accepted.

## When things fail

BullMQ retries with exponential backoff. After the attempts are exhausted, the job is written into a `dead_letters` table with the error and the attempt count, and the raw event is marked `failed`. Nothing disappears. I tested this by pointing the worker at a model name that doesn't exist — the job retried, gave up, and landed in the dead-letter table with the 404 from the API attached.

There's also a rate limiter on the worker. The queue can absorb any amount of inbound traffic; the limiter just paces how fast the worker drains it, so a traffic spike doesn't turn into a wall of 429s from the model provider.

## Filling in what vendors leave out

Logistics data is missing things constantly. A webhook gives you a SCAC code but no carrier name, a port but no coordinates, a container number with no way to know if it's been corrupted in transit. So after normalizing, I enrich — deterministically, and always best-effort, so a failure here never fails the event itself.

| What's missing | How I fill it |
|---|---|
| Coordinates for a port | static UN/LOCODE table, with a live geocoder as fallback |
| Carrier name from a SCAC | a SCAC registry (`MAEU` → Maersk) |
| Whether a container number is real | ISO 6346 check-digit math; a bad one gets flagged for review |
| Route distance, transit time, ETA | computed from the resolved endpoints, mode-aware |

The geocoding I'd actually solved before, on a trucking project, so I pulled that pattern in: a primary geocoder (Photon) with a fallback (Nominatim), both free and key-less, with a cache in front. That project was US-only and routed trucks; this one is global ocean freight, so I dropped the US bounding box and re-benchmarked it against ports instead of street addresses, because the old numbers meant nothing here.

That [port benchmark](benchmarks/geo/README.md) taught me something that changed the design. Freeform geocoding of "Port of Shanghai" came back about 9,000 km wrong, on both providers, and Nominatim failed Busan outright. So a port name is not something you can trust as a primary coordinate source. That's exactly why the static LOCODE table is primary and the geocoder is only a labelled fallback — known ports resolve exactly and offline, and anything the geocoder fills in is tagged `source: GEOCODER` so it's clear it's a guess.

## It isn't only ships

The samples are all ocean freight, but the brief defines a shipment as any parcel moving through a logistics network — that's air, road, rail, parcel too. The lifecycle states are the same regardless of mode, but the enrichment isn't. So a shipment carries a `mode`, and the distance logic follows it: a sea-lane approximation for ocean, an exact great-circle for air (which is genuinely correct for flights), road routing for trucks. Ocean is implemented all the way through because that's what the sample data is; air and road are wired through the same interfaces so the system isn't boxed into one mode. The trucking geocoder and HGV routing from that earlier project are exactly the road path, if it's ever needed.

## Why there's no agent in here

I considered making normalization an agent, and decided against it on purpose. Classifying and extracting into a fixed schema is a single bounded task — one structured call does it, and my benchmark proves a single Haiku call hits 100% on the samples. An agent loop would add latency, cost, and a pile of new failure modes for nothing. The flexibility people reach for an agent to get, I got from a plain handler registry: adding a new event type is one handler and one switch case, no change to the model layer.

I looked at a workflow framework (Mastra) for the orchestration too, and passed for the same reason. The guarantees that matter here — the hash idempotency and the timestamp-guarded upsert — are specific to this domain and I want them explicit and visible, not hidden inside a framework's durable-workflow store, which would also become a second source of truth fighting with my raw table. BullMQ is the industry-standard queue and gives me retries and a dead-letter queue without taking the data-integrity logic out of my hands.

## The data model

Four tables, kept deliberately separate so nothing is ever lost:

- `raw_events` — the original payload, untouched, the source of truth
- `normalized_events` — an append-only log of every normalized event
- `entity_snapshots` — the current state per entity, derived, rebuildable from the log
- `dead_letters` — whatever exhausted its retries, kept for inspection

It's event-sourcing in spirit: the raw payload and the event log are immutable, and the snapshot is just a projection over them.

## API

| Method | Path | What it does |
|---|---|---|
| `POST` | `/webhooks` | takes any JSON, returns `202` (or `200` if it's a duplicate) |
| `GET` | `/webhooks/:id` | processing status of one ingestion |
| `GET` | `/entities/:id` | an entity's current state plus its full timeline |
| `GET` | `/entities/:id/route` | resolved origin, destination, distance, ETA |
| `GET` | `/dead-letters` | failed events |
| `GET` | `/metrics` | queue counts, review backlog, DLQ size, average processing time |
| `GET` | `/health` | liveness |

## Running it

```bash
docker compose up -d        # postgres + redis
cp .env.example .env        # add ANTHROPIC_API_KEY
npm install
npm start                   # server + worker on :3000
```

```bash
curl -X POST localhost:3000/webhooks -H 'content-type: application/json' \
  -d '{"carrier_scac":"MAEU","transport_doc":{"number":"MAEU240498712"},
       "milestone":"Loaded onboard and sailed","milestone_at":"2026-04-21T22:47:00+08:00",
       "port":{"code":"CNSHA","name":"Shanghai"}}'

curl localhost:3000/entities/MAEU240498712
```

`npm run bench:llm` runs the model comparison, `npm run bench:geo` the port geocoding one, and the `scripts/smoke-*.ts` files exercise each piece (db, normalize, state machine, geo, enrich) on their own.

## What I'd do before calling it production

- Swap BullMQ for Kafka or Temporal once volume and replay guarantees matter.
- Replace the sea-lane approximation with a real sea-route distance provider, and the small LOCODE table with a full UN/LOCODE / World Port Index dataset.
- Promote the benchmark into CI so a prompt or model change can't regress accuracy without failing a build.
- Build the review queue into an actual UI — right now low-confidence and anomalous events are flagged in the data but nobody's looking at them.
- Add tracing across ingest → queue → model → store, and per-model accuracy dashboards.

## Honest about the tradeoffs

Ocean distance is a great-circle approximation, not a true sea route, and it's labelled as such. Confidence is the model's own number, not a calibrated one. The worker runs in the same process as the server for simplicity, though the boundary is clean enough to split out. And air/road are wired but shallow, because I have no sample payloads for them and didn't want to ship code I couldn't test against real data.

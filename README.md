# Glacis — AI Webhook Ingestion Service

A service that takes webhooks from logistics and finance vendors every one of them shaped differently figures out what each event is, normalizes it into one internal schema with an LLM, and stores it so that duplicates, out-of-order arrivals, and bad data don't corrupt anything.

## How I read the assignment

The first thing I decided was that the LLM part is the easy 20%. Calling a model with a tool schema and getting back clean JSON is close to a solved problem. The brief itself tells you where the real work is it mentions sub-second acknowledgements, vendors resending the same payload, and events arriving out of order. Those three lines are the whole assignment. A `POST → LLM → save` toy meets none of them. So I built around them and treated the model call as one stage in a pipeline rather than the centerpiece.

## I started with a benchmark, not the service

Before writing any service code I wanted to know which model to trust, so I wrote a benchmark suite first ([`benchmarks/`](benchmarks/README.md)). It runs the sample payloads and an adversarial set across six models Haiku, Sonnet, and four GPT variants — and measures accuracy, reliability on the hard cases, latency, throughput, and cost.

That told me two useful things. Haiku 4.5 gets 100% on the clean payloads at low latency and low cost, so it's the right default. Sonnet is the most reliable when the input gets adversarial, but it's slow and pricey, so it's wrong as a default and right as a fallback. I used that result directly: the worker runs Haiku first, and only escalates to Sonnet if the first attempt fails validation. I'll come back to that.

## The shape of the system

The single most important decision is that the LLM never runs on the request path. When a webhook comes in, I hash it, write the raw event to Postgres, drop a job on a queue, and return `202` measured at around 15ms. Everything else happens in a background worker.

```
POST /webhooks ─► hash ─► save raw ─► enqueue ─► 202   (~15ms, no LLM here)
                                          │
                                     (BullMQ / Redis)
                                          ▼
   worker: normalize ─► validate ─► route to handler ─► check state transition
           ─► enrich (geo, carrier, container, ETA) ─► save event + snapshot
```

I went with Postgres for storage and BullMQ on Redis for the queue. The thing I care about there: Postgres is the source of truth, the queue is just dispatch. I write the raw event to Postgres *before* enqueuing, so if Redis falls over I haven't lost a single webhook I can replay from the raw table. A lot of designs put the payload only in the queue and lose it when the queue dies.

## Idempotency

Vendors resend. The brief says so explicitly. My key is the SHA-256 of the canonical body (sorted keys, so field order doesn't matter), used as both the Postgres primary key and the BullMQ job id. An exact resend collapses to the same row and the same job deduped at the storage and the queue layer.

I actually got this wrong the first time and caught it in live testing, which is worth admitting because it shaped the final design. I'd added a second "smart" dedup key on `(vendor, document_id)`, thinking it would catch logical duplicates. But an invoice's ISSUED and PAID events share the same `doc_ref` — they're different events in the same entity's life. My clever key threw the PAID event away as a duplicate. The fix was to delete the clever key: ISSUED and PAID have different bodies, so they hash differently and stay distinct, while genuine byte-for-byte resends still collapse. The simpler key was the correct one.

## Out-of-order events

This is the part I was most worried about getting wrong, because it's the part a naive system silently corrupts. If `DELIVERED` arrives and then a delayed `PICKED_UP` shows up an hour later, you must not let the shipment regress to PICKED_UP.

I order everything by the event's own timestamp, never by when it arrived. The snapshot update is guarded in SQL the head state only moves forward when the incoming event is actually newer:

```sql
canonical_state = CASE
  WHEN EXCLUDED.last_event_timestamp > entity_snapshots.last_event_timestamp
  THEN EXCLUDED.canonical_state ELSE entity_snapshots.canonical_state END
```

The late `PICKED_UP` still gets stored and counted in the event log, it just can't move the head backwards. I tested this end-to-end: post the in-transit event, then post an earlier pickup, and the entity stays `IN_TRANSIT` with two events in its timeline ordered correctly.

On top of the timestamp guard there's a small state machine ([`src/state-machine.ts`](src/state-machine.ts)) that judges each transition. A late pickup (older timestamp) is a benign `OUT_OF_ORDER`. But a pickup with a *newer* timestamp landing after delivery is a real `ANOMALY` that's not late data, that's wrong data — so it gets flagged for review instead of trusted. Invoices get the same treatment (`ISSUED → PAID → REFUNDED`, with `VOIDED` off ISSUED).

The assignment also mentions *exceptions* (customs holds, delays, damage), and these were the one part of the lifecycle I had to think about, because an exception isn't a state — a shipment on a customs hold is still physically where it was. So instead of inventing an `EXCEPTION` state and corrupting the progression, an exception event keeps its canonical state (a hold at the destination stays `OUT_FOR_DELIVERY`) and sets an `is_exception` flag with a reason. That flag routes the event straight to the review queue, since a hold is exactly the kind of thing a human needs to act on, and it shows up on the entity's timeline. The four-state model stays clean; the exception rides alongside it.

## Not trusting the model blindly

The model output goes through a Zod schema gate before it's allowed anywhere near storage. If it doesn't parse, it throws, and that becomes a retry and the retry is where the model escalates from Haiku to Sonnet.

The model also returns a confidence score, and this is the one place I'd push back on my own first instinct: I don't trust a model's self-reported confidence. It has no idea whether the fields it just made up are right — it'll tell you it's 0.98 sure of a hallucinated invoice number. So I compute my own confidence ([`src/confidence.ts`](src/confidence.ts)) from things I can actually verify: did every required field come back, was the state transition legal, did enrichment succeed, did the container number pass its check digit. The model's number is one input with a low weight, not the answer. Both are stored — the computed one is what decisions use, the model's own is kept for comparison.

Anything the system isn't sure about goes into a `review_queue` with a concrete reason: `INVALID_TRANSITION`, `INVALID_CONTAINER`, `ENRICHMENT_FAILED`, or `LOW_CONFIDENCE`. The reasons matter — a bad container check digit flags the event even when its overall score is high, because it's a hard signal, not a soft one. Real logistics operations never fully automate this; there's always a human looking at the uncertain cases, and this is the queue they'd work from (`GET /review-queue`).

## Measuring whether normalization is actually correct

Benchmarking models tells you which is fast and cheap. It doesn't tell you whether the output is *right*, so I wrote a second eval for that ([`benchmarks/eval/`](benchmarks/eval/README.md), `npm run eval`). Each fixture is a raw payload with a hand-written expected output, and it scores classification, state mapping, entity extraction, mode, and the field-level extractions *separately* — because a system can classify perfectly and still botch the amount. Latest run is 97.2% overall, and the one miss is a genuinely ambiguous mode call (a courier last-mile that's arguably `PARCEL`, not `ROAD`). I left it failing instead of editing the fixture to hit a fake 100%, because surfacing the ambiguity is the whole point of having the eval. In production this runs in CI so a prompt or model change can't quietly regress accuracy.

## When things fail

BullMQ retries with exponential backoff. After the attempts are exhausted, the job is written into a `dead_letters` table with the error and the attempt count, and the raw event is marked `failed`. Nothing disappears. I tested this by pointing the worker at a model name that doesn't exist — the job retried, gave up, and landed in the dead-letter table with the 404 from the API attached.

There's also a rate limiter on the worker. The queue can absorb any amount of inbound traffic; the limiter just paces how fast the worker drains it, so a traffic spike doesn't turn into a wall of 429s from the model provider.

## Filling in what vendors leave out

As I personally worked in supply chain for last couple of years i learned most Logistics data is missing these things constantly. A webhook gives you a SCAC code but no carrier name, a port but no coordinates, a container number with no way to know if it's been corrupted in transit. So after normalizing, I enrich — deterministically, and always best-effort, so a failure here never fails the event itself.

| What's missing commonly | How I fill it |
|---|---|
| Coordinates for a port | static UN/LOCODE table, with a live geocoder as fallback |
| Carrier name from a SCAC | a SCAC registry (`MAEU` → Maersk) |
| Whether a container number is real | ISO 6346 check-digit math; a bad one gets flagged for review |
| Route distance, transit time, ETA | computed from the resolved endpoints, mode-aware |

The geocoding I'd actually solved before, so I pulled that pattern in: a primary geocoder (Photon) with a fallback (Nominatim), both free and key-less, with a cache in front. I benchmarked it against ports

That [port benchmark](benchmarks/geo/README.md) taught me something that changed the design. Freeform geocoding of "Port of Shanghai" came back about 9,000 km wrong, on both providers, and Nominatim failed Busan outright. So a port name is not something you can trust as a primary coordinate source. That's exactly why the static LOCODE table is primary and the geocoder is only a labelled fallback — known ports resolve exactly and offline, and anything the geocoder fills in is tagged `source: GEOCODER` so it's clear it's a guess.

## It isn't only ships

The samples are all ocean freight, but the brief defines a shipment as any parcel moving through a logistics network — that's air, road, rail, parcel too. The lifecycle states are the same regardless of mode, but the enrichment isn't. So a shipment carries a `mode`, and the distance logic follows it: a sea-lane approximation for ocean, an exact great-circle for air (which is genuinely correct for flights), road routing for trucks. Ocean is implemented all the way through because that's what the sample data is; air and road are wired through the same interfaces so the system isn't boxed into one mode. The trucking geocoder and HGV routing from that earlier project are exactly the road path, if it's ever needed.

## Why there's no agent in here

I considered making normalization an agent, and decided against it on purpose. Classifying and extracting into a fixed schema is a single bounded task one structured call does it, and my benchmark proves a single Haiku call hits 100% on the samples. An agent loop would add latency, cost, and a pile of new failure modes for nothing. The flexibility people reach for an agent to get, I got from a plain handler registry: adding a new event type is one handler and one switch case, no change to the model layer.

I looked at a workflow framework (Mastra) for the orchestration too, and passed for the same reason. The guarantees that matter here — the hash idempotency and the timestamp-guarded upsert — are specific to this domain and I want them explicit and visible, not hidden inside a framework's durable-workflow store, which would also become a second source of truth fighting with my raw table. BullMQ is the industry-standard queue and gives me retries and a dead-letter queue without taking the data-integrity logic out of my hands.

## The internal schema we defined

The assignment asks to define a strict internal schema, so here's the one I settled on. Every webhook, whatever shape the vendor sent, is converted into one of **three canonical event types** — a discriminated union in [`src/schemas.ts`](src/schemas.ts):

- **SHIPMENT** — mode, entity id (the BL/AWB), canonical state, exception flag, carrier, parties, location, timestamp.
- **INVOICE** — entity id (the invoice ref), canonical state, amount in cents, currency, due date, linked BL.
- **UNCLASSIFIED** — just a reason.

The `event_type` field is the discriminant: the model picks it during classification, and that decides which of the three shapes the event is validated and stored as. Before that point it's untyped raw JSON; after it, it's exactly one of three strict shapes.

### Why shipment and invoice events live in the same tables

A deliberate decision worth calling out: both event types are stored **together** — in one `normalized_events` log and one `entity_snapshots` table — rather than in separate per-type tables.

The reason is that the parts that differ between a shipment and an invoice are the *contents* of an event, while the parts the storage layer cares about are the *same* for both: every event has an id, a type, an entity it belongs to, a state, and a timestamp; every entity has a current state and a last-seen time. That shared structure is what the log and the snapshot are built around. The type-specific fields (a shipment's container number, an invoice's amount) ride inside a JSONB `payload`, so adding or changing them never touches the table shape — and a *new* entity type later (air customs declaration, say) needs no migration at all.

The alternative — a table per type — would mean every "where is entity X?" read, every metric, and every list endpoint becomes a UNION or a type-lookup-first, plus two code paths for writes, all to avoid a few nullable columns. For a uniform read model that isn't worth it. I kept one set of tables and instead enforced the one invariant that a shared table can't guarantee on its own — that an invoice state can't land in a shipment row — with a database **CHECK constraint** on `entity_snapshots`. So: one storage path, but the database still rejects a `SHIPMENT` row whose state is `PAID`.

(This is single-table inheritance, and the table is already normalized in the relational sense — the nullable shipment-only columns are sparse optional attributes, not a normal-form violation.)

## The data model

Five tables, kept deliberately separate so nothing is ever lost:

- `raw_events` — the original payload, untouched, the source of truth
- `normalized_events` — an append-only log of every normalized event
- `entity_snapshots` — the current state per entity, derived, rebuildable from the log
- `review_queue` — events the system wasn't sure about, for a human to check
- `dead_letters` — whatever exhausted its retries, kept for inspection

It's event-sourcing in spirit: the raw payload and the event log are immutable, the snapshot is just a projection over them, and the last two are operational side-tables so an uncertain or failed event is never silently dropped.

## API

| Method | Path | What it does |
|---|---|---|
| `POST` | `/webhooks` | takes any JSON, returns `202` (or `200` if it's a duplicate) |
| `GET` | `/webhooks/:id` | processing status of one ingestion |
| `GET` | `/entities/:id` | an entity's current state plus its full timeline |
| `GET` | `/entities/:id/route` | resolved origin, destination, distance, ETA |
| `GET` | `/dead-letters` | events that exhausted retries |
| `GET` | `/review-queue` | events flagged for a human to check, with reasons |
| `GET` | `/metrics` | queue counts, review backlog, DLQ size, average processing time |
| `GET` | `/health` | liveness |

## Running it

```bash
docker compose up -d        # postgres + redis
cp .env.example .env        # add ANTHROPIC_API_KEY
npm install
npm start                   # server + worker on :3000
```

Open **http://localhost:3000** for a small console: pick a sample payload, send it, and watch the result land in a live feed over Server-Sent Events — it's the clearest way to see the async pipeline, since the card shows up as `processing` the instant you submit and flips to `done` a second or two later when the worker finishes. Or use curl:

```bash
curl -X POST localhost:3000/webhooks -H 'content-type: application/json' \
  -d '{"carrier_scac":"MAEU","transport_doc":{"number":"MAEU240498712"},
       "milestone":"Loaded onboard and sailed","milestone_at":"2026-04-21T22:47:00+08:00",
       "port":{"code":"CNSHA","name":"Shanghai"}}'

curl localhost:3000/entities/MAEU240498712
```

`npm run eval` checks normalization correctness, `npm run bench:llm` runs the model comparison, `npm run bench:geo` the port geocoding one, and the `scripts/smoke-*.ts` files exercise each piece (db, normalize, state machine, geo, enrich) on their own.

## Why event sourcing matters more for an AI system than a normal one

Keeping the raw payload immutable and the normalized output in a separate append-only log isn't just good hygiene here — it's load-bearing, because normalization is probabilistic. The model I use today will be beaten by a better one next quarter, my prompt will improve, the schema will grow a field. In a normal system that's fine, you move forward. In an AI system it means every event I've ever stored can be *re-normalized* against the better model or prompt, because I never threw away the original. The raw table plus the `prompt_version` and model stamped on each event make historical reprocessing a backfill job, not a data-loss problem. That's the real reason event sourcing and AI belong together.

## Where this goes: the model should handle novelty, not every request

Having spent time around supply-chain data, the thing I'd build next is a deterministic fast path in front of the LLM. Vendors send the same handful of payload shapes thousands of times — Maersk's gate-in event looks the same every day. There's no reason to pay for and wait on a model call for a shape I've already normalized correctly a thousand times. The normalized log I'm already keeping is exactly the training data for that: fingerprint the payload structure per vendor, and once a shape has been confirmed enough times, normalize it with deterministic pattern matching and only fall back to the LLM for genuinely new shapes. The model should be spent on novelty, not on the 95% of traffic that's repetitive. That's where the cost curve and the latency curve both bend in the right direction.

## What I'd do before calling it production

- Swap BullMQ for Kafka or Temporal once volume and replay guarantees matter.
- Replace the sea-lane approximation with a real sea-route distance provider, and the small LOCODE table with a full UN/LOCODE / World Port Index dataset.
- Run the eval (`npm run eval`) in CI against a growing golden set so a prompt or model change can't regress accuracy without failing a build.
- Build the review queue into an actual UI — the uncertain events are flagged and queued, but a human still needs a screen to work them from.
- Add a circuit breaker around the model: if the LLM error rate crosses a threshold, open the circuit and let events sit in the queue instead of burning through retries into the dead-letter table, then resume when it recovers. The queue already makes this safe — nothing is lost while the circuit is open.
- Add the deterministic fast path described above, and tracing across ingest → queue → model → store with per-model accuracy dashboards.

## What I intentionally did NOT build

Restraint felt like part of the assignment, so a few things I deliberately left out:

- **An agent / multi-agent orchestration for normalization.** It's a single bounded extraction; an agent loop would add latency, cost, and failure modes for no accuracy gain. The benchmark backs this up.
- **A workflow framework (Mastra, Temporal) on the hot path.** The guarantees that matter — idempotency, the out-of-order upsert — are domain-specific and I wanted them visible, not delegated to a framework that would also become a second source of truth next to my raw table.
- **A retrieval/RAG pipeline.** There's nothing to retrieve; normalization is classify-and-extract, not question-answering. Adding a vector store would be complexity cosplay.
- **Self-reported model confidence as the trust signal.** I computed my own instead, for the reasons above.

Each of these is a reasonable thing to reach for, and on a different problem I would. Here they'd have been features added to look thorough rather than because the problem needed them.

## Honest about the tradeoffs

Ocean distance is a great-circle approximation, not a true sea route, and it's labelled as such. The computed confidence is a sensible weighting, not a statistically calibrated probability — good enough to triage review, not something I'd quote as a real likelihood. The worker runs in the same process as the server for simplicity, though the boundary is clean enough to split out. And air/road are wired but shallow, because I have no sample payloads for them and didn't want to ship code I couldn't test against real data.

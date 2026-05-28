import "dotenv/config";
import { payloads } from "./payloads.js";
import { adversarialPayloads } from "./adversarial-payloads.js";
import { NormalizedEventSchema } from "./schemas.js";
import { callModel, MODELS, type ModelSpec } from "./llm-client.js";

const SYSTEM_PROMPT = `You are a logistics data normalization engine for a global supply chain platform.

You receive arbitrary JSON webhook payloads from external logistics and financial vendors.
Your job: classify each payload, then normalize it into the canonical internal schema.

CLASSIFICATION
Classify into exactly one of: SHIPMENT, INVOICE, UNCLASSIFIED
- SHIPMENT: any update about a physical parcel, container, or cargo moving through a logistics network
- INVOICE: any financial document — issued, settled, cancelled, or reversed
- UNCLASSIFIED: advisories, alerts, weather, port congestion, anything that is neither

CANONICAL SHIPMENT STATES — map vendor language to exactly one of these:
- PICKED_UP        : container collected from shipper / received at origin terminal / gate-in
- IN_TRANSIT       : vessel/truck/aircraft departed, cargo is moving between origin and destination
- OUT_FOR_DELIVERY : arrived at destination port/hub, customs cleared, last-mile delivery started
- DELIVERED        : cargo physically handed to consignee, delivery complete

CANONICAL INVOICE STATES — map vendor language to exactly one of these:
- ISSUED    : invoice created, raised, generated, sent to customer
- PAID      : invoice settled, paid, remitted, cleared
- VOIDED    : invoice cancelled, withdrawn, reversed before payment
- REFUNDED  : payment reversed after it was previously settled

FIELD RULES
entity_id   : For SHIPMENT use master BL number first, house BL second, container number last.
              For INVOICE use the vendor's invoice/document reference number.
event_timestamp : Convert ALL date formats to ISO 8601 UTC.
              WIB = UTC+7. CST/SGT/HKT = UTC+8. CET = UTC+1. CEST = UTC+2.
              Example: "28/04/2026 09:42 WIB" → "2026-04-28T02:42:00Z"
amount_cents: Parse ALL number formats to integer cents (smallest currency unit).
              European: "EUR 24.350,75" → 2435075  (period=thousands, comma=decimal)
              US:       "USD 24,350.75" → 2435075  (comma=thousands, period=decimal)
              Plain:    "EUR 24350.75"  → 2435075
              NEVER return a float. NEVER omit this field for INVOICE payloads.
currency    : Extract the ISO 4217 three-letter code (EUR, USD, GBP, SGD ...).
              "Euros" → "EUR". "US Dollars" → "USD". NEVER omit for INVOICE payloads.
null policy : Use null only when a field is genuinely absent. Never invent values.

REQUIRED FIELDS BY TYPE — you MUST populate all of these:
SHIPMENT:
  event_type, entity_id, canonical_state, event_timestamp,
  carrier (object: {scac, name}), container_no, raw_milestone_text

INVOICE:
  event_type, entity_id, canonical_state, event_timestamp,
  amount_cents, currency, carrier (string), linked_bl, raw_transaction_kind

UNCLASSIFIED:
  event_type, reason

FEW-SHOT EXAMPLES

Example 1 — INVOICE PAID with European decimal format:
Input:
{
  "doc_ref": "GFP-INV-2026-Q2-08821",
  "transaction": {
    "kind": "settled in full",
    "settled_at": "2026-04-22 18:47:11+02:00",
    "amount": "EUR 24.350,75",
    "remitter": "ACME Logistics GmbH"
  }
}
Correct output:
{
  "event_type": "INVOICE",
  "entity_id": "GFP-INV-2026-Q2-08821",
  "canonical_state": "PAID",
  "event_timestamp": "2026-04-22T16:47:11Z",
  "amount_cents": 2435075,
  "currency": "EUR",
  "carrier": null,
  "linked_bl": null,
  "raw_transaction_kind": "settled in full"
}

Example 2 — SHIPMENT IN_TRANSIT:
Input:
{
  "transport_doc": {"type": "MBL", "number": "MAEU240498712"},
  "milestone": "Loaded onboard and sailed",
  "milestone_at": "2026-04-21T22:47:00+08:00",
  "carrier_scac": "MAEU"
}
Correct output:
{
  "event_type": "SHIPMENT",
  "entity_id": "MAEU240498712",
  "canonical_state": "IN_TRANSIT",
  "event_timestamp": "2026-04-21T14:47:00Z",
  "carrier": {"scac": "MAEU", "name": "Maersk"},
  "container_no": null,
  "origin_port": {"locode": "CNSHA", "name": "Shanghai"},
  "vessel": null,
  "raw_milestone_text": "Loaded onboard and sailed"
}`;

type AnyPayload = { id: string; expectedType: string; expectedState: string | null; body: unknown };

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx] ?? 0;
}

function stddev(values: number[]): number {
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length);
}

function latencyStats(ms: number[]) {
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
    avg: ms.reduce((s, v) => s + v, 0) / ms.length,
    stddev: stddev(ms),
  };
}

function fms(n: number) { return `${Math.round(n)}ms`; }

function printTable(rows: Record<string, string | number | boolean>[]) {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c]).length))
  );
  const bar = (l: string, m: string, r: string) =>
    l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  console.log(bar("┌", "┬", "┐"));
  console.log("│" + cols.map((c, i) => ` ${c.padEnd(widths[i])} `).join("│") + "│");
  console.log(bar("├", "┼", "┤"));
  for (const row of rows) {
    console.log("│" + cols.map((c, i) => ` ${String(row[c]).padEnd(widths[i])} `).join("│") + "│");
  }
  console.log(bar("└", "┴", "┘"));
}

function printStats(label: string, latencies: number[]) {
  const s = latencyStats(latencies);
  console.log(`\n${label} latency (n=${latencies.length})`);
  printTable([{
    min: fms(s.min), p50: fms(s.p50), p75: fms(s.p75),
    p95: fms(s.p95), p99: fms(s.p99), max: fms(s.max),
    avg: fms(s.avg), stddev: fms(s.stddev),
  }]);
}

async function normalizeOne(spec: ModelSpec, payload: AnyPayload, debug = false) {
  const userContent = `Normalize this vendor webhook:\n\n${JSON.stringify(payload.body, null, 2)}`;
  let response;
  try {
    response = await callModel(spec, SYSTEM_PROMPT, userContent, { cached: true });
  } catch (e) {
    console.error(`  [${spec.label}][${payload.id}] call failed:`, (e as Error).message);
    return { result: null, elapsed: 0, gotType: "?", gotState: "-", parseError: "call failed", ...zeroTokens() };
  }

  const parsed = NormalizedEventSchema.safeParse(response.toolInput);
  let result = null;
  let parseError: string | null = null;

  if (parsed.success) {
    result = parsed.data;
  } else {
    parseError = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ");
    if (debug) {
      console.log(`  [DEBUG ${payload.id}] raw: ${JSON.stringify(response.toolInput)}`);
      console.log(`  [DEBUG ${payload.id}] zod: ${parseError}`);
    }
  }

  const gotType  = result?.event_type ?? "?";
  const gotState = result && result.event_type !== "UNCLASSIFIED"
    ? (result as Record<string, unknown>)["canonical_state"] as string : "-";

  return { result, elapsed: response.latencyMs, gotType, gotState, parseError, ...response };
}

function zeroTokens() {
  return { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
}

// A: Accuracy across all models on the 6 sample payloads
async function benchmarkAccuracy() {
  const summaryRows: Record<string, string | number>[] = [];

  for (const spec of MODELS) {
    if (spec.provider === "openai" && !process.env.OPENAI_API_KEY) {
      console.log(`  Skipping ${spec.label} — OPENAI_API_KEY not set`);
      continue;
    }

    console.log(`\n  ${spec.label}`);
    const rows: Record<string, string | number>[] = [];
    const latencies: number[] = [];
    let totalIn = 0, totalOut = 0;
    let typeCorrect = 0, stateCorrect = 0, parseCorrect = 0;

    for (const payload of payloads) {
      const { result, elapsed, gotType, gotState, parseError, inputTokens, outputTokens, cacheRead, cacheWrite } =
        await normalizeOne(spec, payload as AnyPayload);

      latencies.push(elapsed);
      totalIn  += inputTokens;
      totalOut += outputTokens;

      const typeOk  = gotType === payload.expectedType;
      const stateOk = payload.expectedState === null ? gotState === "-" : gotState === payload.expectedState;
      if (typeOk)  typeCorrect++;
      if (stateOk) stateCorrect++;
      if (result)  parseCorrect++;

      rows.push({
        payload:  payload.id.slice(0, 22),
        want:     `${payload.expectedType}/${payload.expectedState ?? "-"}`,
        got:      `${gotType}/${gotState}`,
        "T✓":    typeOk  ? "✓" : "✗",
        "S✓":    stateOk ? "✓" : "✗",
        "P✓":    result  ? "✓" : "✗",
        ms:       elapsed,
        in_tok:   inputTokens,
        out_tok:  outputTokens,
        cache_r:  cacheRead,
        cache_w:  cacheWrite,
      });

      if (!result && parseError) {
        console.log(`    [parse-fail ${payload.id}] ${parseError}`);
      }
    }

    printTable(rows);
    const s = latencyStats(latencies);
    console.log(`  type=${(typeCorrect/payloads.length*100).toFixed(0)}%  state=${(stateCorrect/payloads.length*100).toFixed(0)}%  parse=${(parseCorrect/payloads.length*100).toFixed(0)}%  in=${totalIn} out=${totalOut}`);
    printStats(`  ${spec.label}`, latencies);

    summaryRows.push({
      model:    spec.label,
      "type%":  `${(typeCorrect/payloads.length*100).toFixed(0)}%`,
      "state%": `${(stateCorrect/payloads.length*100).toFixed(0)}%`,
      "parse%": `${(parseCorrect/payloads.length*100).toFixed(0)}%`,
      "p50":    fms(s.p50),
      "p95":    fms(s.p95),
      "avg":    fms(s.avg),
      "stddev": fms(s.stddev),
      "in_tok": totalIn,
      "out_tok": totalOut,
    });
  }

  console.log("\n  Summary across all models");
  printTable(summaryRows);
  return summaryRows;
}

// B: Reliability — repeated runs on hard payloads
async function benchmarkReliability(payloadId: string, runs: number) {
  const payload = payloads.find((p) => p.id === payloadId)!;
  const rows: Record<string, string | number>[] = [];

  for (const spec of MODELS) {
    if (spec.provider === "openai" && !process.env.OPENAI_API_KEY) continue;

    const latencies: number[] = [];
    let parseOk = 0, typeOk = 0, stateOk = 0;

    for (let i = 0; i < runs; i++) {
      const { result, elapsed } = await normalizeOne(spec, payload as AnyPayload);
      latencies.push(elapsed);
      if (result) {
        parseOk++;
        if (result.event_type === payload.expectedType) typeOk++;
        const state = result.event_type !== "UNCLASSIFIED"
          ? (result as Record<string, unknown>)["canonical_state"] : null;
        if (state === (payload.expectedState ?? null)) stateOk++;
      }
    }

    const s   = latencyStats(latencies);
    const pct = (n: number) => `${((n / runs) * 100).toFixed(0)}%`;
    rows.push({
      model:    spec.label,
      "parse%": pct(parseOk), "type%": pct(typeOk), "state%": pct(stateOk),
      p50: fms(s.p50), p75: fms(s.p75), p95: fms(s.p95), p99: fms(s.p99),
      max: fms(s.max), stddev: fms(s.stddev),
    });
  }

  printTable(rows);
}

// C: Adversarial payloads across all models
async function benchmarkAdversarial() {
  const summaryRows: Record<string, string | number>[] = [];

  for (const spec of MODELS) {
    if (spec.provider === "openai" && !process.env.OPENAI_API_KEY) continue;

    const rows: Record<string, string | number>[] = [];
    const latencies: number[] = [];
    let typeCorrect = 0, stateCorrect = 0;

    for (const payload of adversarialPayloads) {
      const { elapsed, gotType, gotState, parseError } =
        await normalizeOne(spec, payload as AnyPayload);
      latencies.push(elapsed);

      const typeOk  = gotType === payload.expectedType;
      const stateOk = payload.expectedState === null ? gotState === "-" : gotState === payload.expectedState;
      if (typeOk)  typeCorrect++;
      if (stateOk) stateCorrect++;

      rows.push({
        id:    payload.id.slice(0, 30),
        "T✓": typeOk  ? "✓" : "✗",
        "S✓": stateOk ? "✓" : "✗",
        got:   `${gotType}/${gotState}`,
        ms:    elapsed,
        note:  parseError ? parseError.slice(0, 38) : payload.description.slice(0, 38),
      });
    }

    const s = latencyStats(latencies);
    summaryRows.push({
      model:    spec.label,
      "type%":  `${(typeCorrect/adversarialPayloads.length*100).toFixed(0)}%`,
      "state%": `${(stateCorrect/adversarialPayloads.length*100).toFixed(0)}%`,
      p50:      fms(s.p50),
      p95:      fms(s.p95),
      avg:      fms(s.avg),
    });
  }

  console.log("\n  Summary across all models");
  printTable(summaryRows);
}

// D: Concurrency — per model
async function benchmarkConcurrency() {
  const rows: Record<string, string | number>[] = [];

  for (const spec of MODELS) {
    if (spec.provider === "openai" && !process.env.OPENAI_API_KEY) continue;

    const batch = payloads.slice(0, 6);
    const t0    = Date.now();
    const results = await Promise.all(
      batch.map((p) =>
        callModel(spec, SYSTEM_PROMPT, `Normalize this vendor webhook:\n\n${JSON.stringify(p.body, null, 2)}`, { cached: true })
          .then((r) => ({ ok: NormalizedEventSchema.safeParse(r.toolInput).success }))
          .catch(() => ({ ok: false }))
      )
    );
    const wallMs  = Date.now() - t0;
    const okCount = results.filter((r) => r.ok).length;

    rows.push({
      model:           spec.label,
      concurrency:     6,
      wall_ms:         wallMs,
      "success/total": `${okCount}/6`,
      "norm/sec":      (6 / (wallMs / 1000)).toFixed(2),
      "avg_ms/req":    Math.round(wallMs / 6),
    });
  }

  printTable(rows);
}

// E: Cost analysis
function benchmarkCost(summaryRows: Record<string, string | number>[]) {
  const PRICING: Record<string, { in: number; out: number; label: string }> = {
    "Haiku 4.5":    { in: 0.80,  out: 4.00,  label: "Haiku 4.5"    },
    "Sonnet 4.6":   { in: 3.00,  out: 15.00, label: "Sonnet 4.6"   },
    "GPT-4o mini":  { in: 0.15,  out: 0.60,  label: "GPT-4o mini"  },
    "GPT-4o":       { in: 2.50,  out: 10.00, label: "GPT-4o"       },
    "GPT-4.1 nano": { in: 0.10,  out: 0.40,  label: "GPT-4.1 nano" },
    "GPT-4.1":      { in: 2.00,  out: 8.00,  label: "GPT-4.1"      },
  };

  const rows: Record<string, string | number>[] = [];

  for (const summary of summaryRows) {
    const label   = String(summary.model);
    const pricing = PRICING[label];
    if (!pricing) continue;

    const inTok  = Number(summary.in_tok)  / payloads.length;
    const outTok = Number(summary.out_tok) / payloads.length;
    const costPerCall = (inTok * pricing.in + outTok * pricing.out) / 1_000_000;

    rows.push({
      model:      label,
      "type%":    summary["type%"],
      "avg_ms":   summary["avg"],
      per_call:   `$${costPerCall.toFixed(5)}`,
      per_1k:     `$${(costPerCall * 1000).toFixed(4)}`,
      per_1M:     `$${(costPerCall * 1_000_000).toFixed(2)}`,
      "$/accuracy": `$${(costPerCall / (Number(String(summary["type%"]).replace("%","")) / 100) * 1000).toFixed(4)}/1k`,
    });
  }

  printTable(rows);
  console.log("\n  $/accuracy = cost per 1k normalizations adjusted for accuracy (lower is better)");
  console.log("  Pricing per MTok: Haiku $0.80/$4, Sonnet $3/$15, GPT-4o-mini $0.15/$0.60, GPT-4o $2.50/$10, GPT-4.1-nano $0.10/$0.40, GPT-4.1 $2/$8");
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set.");
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY not set — OpenAI models will be skipped. Add to .env to include them.");
  }

  console.log("\nGlacis - LLM Normalization Benchmark (Multi-Provider)");
  console.log(`Models: ${MODELS.map((m) => m.label).join(", ")}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  console.log("Benchmark A: Accuracy on 6 sample payloads — all models");
  const summaryRows = await benchmarkAccuracy();

  console.log("\nBenchmark B: Reliability — 5 runs on hard payloads");
  console.log("  gfp-invoice-paid: European decimal format (EUR 24.350,75 → 2435075 cents)");
  console.log("  one-delivered: Ambiguous milestone text requiring semantic mapping\n");
  console.log("  gfp-invoice-paid");
  await benchmarkReliability("gfp-invoice-paid", 5);
  console.log("\n  one-delivered");
  await benchmarkReliability("one-delivered", 5);

  console.log("\nBenchmark C: Adversarial payloads — all models");
  console.log("Missing BL, European decimals, non-standard dates, deeply nested schema\n");
  await benchmarkAdversarial();

  console.log("\nBenchmark D: Concurrency throughput — all models (6 parallel calls)");
  console.log("Shows raw parallel throughput per provider\n");
  await benchmarkConcurrency();

  console.log("\nBenchmark E: Cost analysis");
  console.log("Per-call and per-1k cost weighted by accuracy\n");
  benchmarkCost(summaryRows);

  console.log(`\nBenchmark complete: ${new Date().toISOString()}\n`);
}

main().catch((e) => {
  console.error("Benchmark failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { payloads } from "./payloads.js";
import { adversarialPayloads } from "./adversarial-payloads.js";
import { NormalizedEventSchema, type NormalizedEvent } from "./schemas.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Expanded prompt — few-shot examples push this past the 1024-token cache threshold
// and directly address the two failure modes: invoice field completeness + European decimals
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

const CLASSIFY_SYSTEM = `Classify this vendor webhook payload into exactly one category.

Categories:
- SHIPMENT: physical cargo/container movement update
- INVOICE: financial document (issued, paid, voided, refunded)
- UNCLASSIFIED: anything else (advisories, alerts, port notices)

Respond with raw JSON only — no markdown, no explanation, no code fences:
{"event_type":"SHIPMENT","confidence":"HIGH"}`;

// cache_control on the tool ensures tool tokens count toward the cached prefix
const NORMALIZE_TOOL = {
  name: "normalize_webhook",
  description: "Normalize a vendor webhook payload into the canonical schema",
  input_schema: {
    type: "object",
    properties: {
      event_type:          { type: "string", enum: ["SHIPMENT", "INVOICE", "UNCLASSIFIED"] },
      entity_id:           { type: "string" },
      canonical_state:     { type: "string" },
      event_timestamp:     { type: "string" },
      carrier:             { oneOf: [
        { type: "object", properties: { scac: { type: ["string","null"] }, name: { type: ["string","null"] } } },
        { type: ["string","null"] },
      ]},
      container_no:        { type: ["string","null"] },
      origin_port:         { type: ["object","null"], properties: { locode: { type: "string" }, name: { type: "string" } } },
      vessel:              { type: ["object","null"], properties: { name: { type: "string" }, imo: { type: ["string","null"] } } },
      raw_milestone_text:  { type: "string" },
      amount_cents:        { type: "integer", description: "Amount in smallest currency unit. European 24.350,75 = 2435075 cents." },
      currency:            { type: "string", description: "ISO 4217 three-letter code e.g. EUR, USD" },
      linked_bl:           { type: ["string","null"] },
      raw_transaction_kind:{ type: "string" },
      reason:              { type: "string" },
    },
    required: ["event_type"],
  },
  cache_control: { type: "ephemeral" as const },
} satisfies Tool & { cache_control: { type: "ephemeral" } };

type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

function buildSystem(text: string, cached: boolean): SystemBlock[] {
  return cached
    ? [{ type: "text", text, cache_control: { type: "ephemeral" } }]
    : [{ type: "text", text }];
}

async function callLLM(opts: {
  model: string;
  system: SystemBlock[];
  messages: MessageParam[];
  tools?: (Tool & { cache_control?: { type: "ephemeral" } })[];
  maxTokens?: number;
}): Promise<Message> {
  return client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    tools: opts.tools,
    tool_choice: opts.tools ? { type: "auto" } : undefined,
    messages: opts.messages,
  }) as unknown as Message;
}

function extractToolInput(response: Message): unknown | null {
  const block = response.content.find((b) => b.type === "tool_use");
  return block?.type === "tool_use" ? block.input : null;
}

function extractText(response: Message): string {
  const block = response.content.find((b) => b.type === "text");
  return block?.type === "text" ? block.text : "";
}

function stripMarkdown(text: string): string {
  return text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
}

function cacheTokens(response: Message) {
  const u = response.usage as unknown as Record<string, number>;
  return {
    cacheRead:  u["cache_read_input_tokens"]       ?? 0,
    cacheWrite: u["cache_creation_input_tokens"]   ?? 0,
  };
}

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
    min:    sorted[0] ?? 0,
    p50:    percentile(sorted, 0.5),
    p75:    percentile(sorted, 0.75),
    p95:    percentile(sorted, 0.95),
    p99:    percentile(sorted, 0.99),
    max:    sorted[sorted.length - 1] ?? 0,
    avg:    ms.reduce((s, v) => s + v, 0) / ms.length,
    stddev: stddev(ms),
  };
}

function fms(n: number) { return `${n.toFixed(0)}ms`; }

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
  console.log(`\n${label} (n=${latencies.length})`);
  printTable([{
    min: fms(s.min), p50: fms(s.p50), p75: fms(s.p75),
    p95: fms(s.p95), p99: fms(s.p99), max: fms(s.max),
    avg: fms(s.avg), stddev: fms(s.stddev),
  }]);
}

type AnyPayload = { id: string; expectedType: string; expectedState: string | null; body: unknown };

async function normalizeOne(model: string, payload: AnyPayload, debug = false) {
  const t0 = Date.now();
  let result: NormalizedEvent | null = null;
  let inTok = 0, outTok = 0, cacheRead = 0, cacheWrite = 0;
  let parseError: string | null = null;

  try {
    const response = await callLLM({
      model,
      system: buildSystem(SYSTEM_PROMPT, true),
      tools: [NORMALIZE_TOOL],
      messages: [{ role: "user", content: `Normalize this vendor webhook:\n\n${JSON.stringify(payload.body, null, 2)}` }],
    });
    inTok  = response.usage.input_tokens;
    outTok = response.usage.output_tokens;
    ({ cacheRead, cacheWrite } = cacheTokens(response));

    const rawInput = extractToolInput(response);
    const parsed = NormalizedEventSchema.safeParse(rawInput);
    if (parsed.success) {
      result = parsed.data;
    } else {
      parseError = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ");
      if (debug) {
        console.log(`  [DEBUG ${payload.id}] raw tool input: ${JSON.stringify(rawInput)}`);
        console.log(`  [DEBUG ${payload.id}] zod errors: ${parseError}`);
      }
    }
  } catch (e) {
    console.error(`  [${payload.id}] call failed:`, (e as Error).message);
  }

  const elapsed = Date.now() - t0;
  const gotType  = result?.event_type ?? "?";
  const gotState = result && result.event_type !== "UNCLASSIFIED"
    ? (result as Record<string, unknown>)["canonical_state"] as string
    : "-";

  return { result, elapsed, gotType, gotState, inTok, outTok, cacheRead, cacheWrite, parseError };
}

// A: Single-call accuracy per model
async function benchmarkSingleCall(model: string, label: string, debug = false) {
  const rows: Record<string, string | number>[] = [];
  const latencies: number[] = [];
  let totalIn = 0, totalOut = 0;

  for (const payload of payloads) {
    const { result, elapsed, gotType, gotState, inTok, outTok, cacheRead, cacheWrite, parseError } =
      await normalizeOne(model, payload as AnyPayload, debug);

    latencies.push(elapsed);
    totalIn  += inTok;
    totalOut += outTok;

    const typeOk  = gotType === payload.expectedType;
    const stateOk = payload.expectedState === null ? gotState === "-" : gotState === payload.expectedState;

    rows.push({
      payload:   payload.id.slice(0, 22),
      want:      `${payload.expectedType}/${payload.expectedState ?? "-"}`,
      got:       `${gotType}/${gotState}`,
      "T✓":     typeOk  ? "✓" : "✗",
      "S✓":     stateOk ? "✓" : "✗",
      "parse✓": result  !== null ? "✓" : "✗",
      ms:        elapsed,
      in_tok:    inTok,
      out_tok:   outTok,
      cache_r:   cacheRead,
      cache_w:   cacheWrite,
    });

    if (!result && parseError && !debug) {
      console.log(`  [parse-fail ${payload.id}] ${parseError}`);
    }
  }

  printTable(rows);
  const typeAcc  = rows.filter((r) => r["T✓"] === "✓").length / rows.length * 100;
  const stateAcc = rows.filter((r) => r["S✓"] === "✓").length / rows.length * 100;
  const parseAcc = rows.filter((r) => r["parse✓"] === "✓").length / rows.length * 100;
  console.log(`  type=${typeAcc.toFixed(0)}%  state=${stateAcc.toFixed(0)}%  parse=${parseAcc.toFixed(0)}%  total_in=${totalIn} total_out=${totalOut}`);
  printStats(`  ${label} latency`, latencies);

  return { typeAcc, stateAcc, parseAcc, latencies, totalIn, totalOut };
}

// B: One-call vs Two-call
async function benchmarkOneVsTwo(model: string) {
  const rows: Record<string, string | number>[] = [];
  const oneLatencies: number[] = [];
  const twoLatencies: number[] = [];

  for (const payload of payloads) {
    const t1s = Date.now();
    let oneOk = false;
    try {
      const r = await callLLM({
        model, system: buildSystem(SYSTEM_PROMPT, true), tools: [NORMALIZE_TOOL],
        messages: [{ role: "user", content: `Normalize this vendor webhook:\n\n${JSON.stringify(payload.body, null, 2)}` }],
      });
      oneOk = NormalizedEventSchema.safeParse(extractToolInput(r)).success;
    } catch (e) { console.error(`  [${payload.id}] 1-call failed:`, (e as Error).message); }
    const oneMs = Date.now() - t1s;
    oneLatencies.push(oneMs);

    const t2s = Date.now();
    let twoOk = false;
    try {
      const r1 = await callLLM({
        model, system: buildSystem(CLASSIFY_SYSTEM, true), maxTokens: 128,
        messages: [{ role: "user", content: JSON.stringify(payload.body) }],
      });
      const raw = stripMarkdown(extractText(r1));
      const cls = JSON.parse(raw) as { event_type: string };
      const r2 = await callLLM({
        model, system: buildSystem(SYSTEM_PROMPT, true), tools: [NORMALIZE_TOOL],
        messages: [{ role: "user", content: `Pre-classified as: ${cls.event_type}\n\n${JSON.stringify(payload.body, null, 2)}` }],
      });
      twoOk = NormalizedEventSchema.safeParse(extractToolInput(r2)).success;
    } catch (e) { console.error(`  [${payload.id}] 2-call failed:`, (e as Error).message); }
    const twoMs = Date.now() - t2s;
    twoLatencies.push(twoMs);

    rows.push({
      payload: payload.id.slice(0, 22),
      "1ms": oneMs, "1✓": oneOk ? "✓" : "✗",
      "2ms": twoMs, "2✓": twoOk ? "✓" : "✗",
      faster: oneMs < twoMs ? "1-call" : "2-call",
      "Δms": Math.abs(oneMs - twoMs),
    });
  }

  printTable(rows);
  const oneS = latencyStats(oneLatencies);
  const twoS = latencyStats(twoLatencies);
  printTable([
    { strategy: "1-call", min: fms(oneS.min), p50: fms(oneS.p50), p75: fms(oneS.p75), p95: fms(oneS.p95), p99: fms(oneS.p99), max: fms(oneS.max), avg: fms(oneS.avg), stddev: fms(oneS.stddev) },
    { strategy: "2-call", min: fms(twoS.min), p50: fms(twoS.p50), p75: fms(twoS.p75), p95: fms(twoS.p95), p99: fms(twoS.p99), max: fms(twoS.max), avg: fms(twoS.avg), stddev: fms(twoS.stddev) },
  ]);
}

// C: Prompt cache warmup
async function benchmarkCache(model: string, runs = 6) {
  const payload = payloads[0];
  const rows: Record<string, string | number>[] = [];
  const warmLatencies: number[] = [];
  let coldMs = 0;

  for (let i = 1; i <= runs; i++) {
    const t0 = Date.now();
    const response = await callLLM({
      model, system: buildSystem(SYSTEM_PROMPT, true), tools: [NORMALIZE_TOOL],
      messages: [{ role: "user", content: `Normalize this vendor webhook:\n\n${JSON.stringify(payload.body, null, 2)}` }],
    });
    const elapsed = Date.now() - t0;
    if (i === 1) coldMs = elapsed; else warmLatencies.push(elapsed);
    const { cacheRead, cacheWrite } = cacheTokens(response);
    rows.push({ run: i, ms: elapsed, cache_r: cacheRead, cache_w: cacheWrite, status: cacheRead > 0 ? "WARM ✓" : "COLD" });
  }

  printTable(rows);
  if (warmLatencies.length > 0) {
    const warmS  = latencyStats(warmLatencies);
    const saving = (((coldMs - warmS.avg) / coldMs) * 100).toFixed(1);
    console.log(`\n  cold=${fms(coldMs)}  warm_avg=${fms(warmS.avg)}  warm_p95=${fms(warmS.p95)}  speedup=${saving}%`);
  }
}

// D: Reliability — repeated runs on hard payloads
async function benchmarkReliability(model: string, payloadId: string, runs: number) {
  const payload = payloads.find((p) => p.id === payloadId)!;
  const latencies: number[] = [];
  let parseOk = 0, typeOk = 0, stateOk = 0;

  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    try {
      const response = await callLLM({
        model, system: buildSystem(SYSTEM_PROMPT, true), tools: [NORMALIZE_TOOL],
        messages: [{ role: "user", content: `Normalize this vendor webhook:\n\n${JSON.stringify(payload.body, null, 2)}` }],
      });
      latencies.push(Date.now() - t0);
      const parsed = NormalizedEventSchema.safeParse(extractToolInput(response));
      if (parsed.success) {
        parseOk++;
        if (parsed.data.event_type === payload.expectedType) typeOk++;
        const state = parsed.data.event_type !== "UNCLASSIFIED"
          ? (parsed.data as Record<string, unknown>)["canonical_state"] : null;
        if (state === (payload.expectedState ?? null)) stateOk++;
      }
    } catch (e) {
      console.error(`  [${payloadId} run ${i + 1}] failed:`, (e as Error).message);
      latencies.push(Date.now() - t0);
    }
  }

  const s   = latencyStats(latencies);
  const pct = (n: number) => `${((n / runs) * 100).toFixed(0)}%`;
  return {
    model:    model.includes("haiku") ? "Haiku 4.5" : "Sonnet 4.6",
    payload:  payloadId.slice(0, 18),
    "parse%": pct(parseOk), "type%": pct(typeOk), "state%": pct(stateOk),
    min: fms(s.min), p50: fms(s.p50), p75: fms(s.p75),
    p95: fms(s.p95), p99: fms(s.p99), max: fms(s.max), stddev: fms(s.stddev),
  };
}

// E: Concurrency throughput
async function benchmarkConcurrency(model: string) {
  const concurrencyLevels = [1, 3, 6];
  const rows: Record<string, string | number>[] = [];

  for (const concurrency of concurrencyLevels) {
    const batch = payloads.slice(0, concurrency);
    const t0    = Date.now();

    const results = await Promise.all(
      batch.map((p) =>
        callLLM({
          model, system: buildSystem(SYSTEM_PROMPT, true), tools: [NORMALIZE_TOOL],
          messages: [{ role: "user", content: `Normalize this vendor webhook:\n\n${JSON.stringify(p.body, null, 2)}` }],
        })
          .then((r) => ({ ok: NormalizedEventSchema.safeParse(extractToolInput(r)).success }))
          .catch(() => ({ ok: false }))
      )
    );

    const wallMs     = Date.now() - t0;
    const okCount    = results.filter((r) => r.ok).length;
    const throughput = (concurrency / (wallMs / 1000)).toFixed(2);

    rows.push({
      concurrency,
      wall_ms:        wallMs,
      "success/total": `${okCount}/${concurrency}`,
      "norm/sec":      throughput,
      "avg_ms/req":    Math.round(wallMs / concurrency),
    });
  }

  printTable(rows);
  console.log("\n  norm/sec = normalizations completed per wall-clock second at each concurrency");
}

// F: Adversarial payloads
async function benchmarkAdversarial(model: string) {
  const rows: Record<string, string | number>[] = [];
  const latencies: number[] = [];

  for (const payload of adversarialPayloads) {
    const { elapsed, gotType, gotState, parseError } = await normalizeOne(model, payload as AnyPayload);
    latencies.push(elapsed);

    const typeOk  = gotType === payload.expectedType;
    const stateOk = payload.expectedState === null ? gotState === "-" : gotState === payload.expectedState;

    rows.push({
      id:    payload.id.slice(0, 30),
      "T✓": typeOk  ? "✓" : "✗",
      "S✓": stateOk ? "✓" : "✗",
      got:   `${gotType}/${gotState}`,
      ms:    elapsed,
      note:  parseError ? parseError.slice(0, 40) : payload.description.slice(0, 40),
    });
  }

  printTable(rows);
  const typeAcc  = rows.filter((r) => r["T✓"] === "✓").length / rows.length * 100;
  const stateAcc = rows.filter((r) => r["S✓"] === "✓").length / rows.length * 100;
  console.log(`\n  type=${typeAcc.toFixed(0)}%  state=${stateAcc.toFixed(0)}%`);
  printStats("  Adversarial latency", latencies);
}

// G: Tiered model — Haiku first, Sonnet fallback on parse failure
async function benchmarkTieredModel() {
  const haiku  = "claude-haiku-4-5-20251001";
  const sonnet = "claude-sonnet-4-6";
  const rows: Record<string, string | number>[] = [];
  const latencies: number[] = [];
  let haikuCalls = 0, sonnetFallbacks = 0;

  for (const payload of payloads) {
    const t0 = Date.now();
    let result: NormalizedEvent | null = null;
    let usedModel = "haiku";

    // Try haiku first
    try {
      const r = await callLLM({
        model: haiku, system: buildSystem(SYSTEM_PROMPT, true), tools: [NORMALIZE_TOOL],
        messages: [{ role: "user", content: `Normalize this vendor webhook:\n\n${JSON.stringify(payload.body, null, 2)}` }],
      });
      const parsed = NormalizedEventSchema.safeParse(extractToolInput(r));
      if (parsed.success) result = parsed.data;
    } catch (_) {}
    haikuCalls++;

    // Fall back to Sonnet if Haiku failed
    if (!result) {
      sonnetFallbacks++;
      usedModel = "sonnet";
      try {
        const r = await callLLM({
          model: sonnet, system: buildSystem(SYSTEM_PROMPT, true), tools: [NORMALIZE_TOOL],
          messages: [{ role: "user", content: `Normalize this vendor webhook:\n\n${JSON.stringify(payload.body, null, 2)}` }],
        });
        const parsed = NormalizedEventSchema.safeParse(extractToolInput(r));
        if (parsed.success) result = parsed.data;
      } catch (_) {}
    }

    const elapsed  = Date.now() - t0;
    latencies.push(elapsed);
    const gotType  = result?.event_type ?? "?";
    const gotState = result && result.event_type !== "UNCLASSIFIED"
      ? (result as Record<string, unknown>)["canonical_state"] as string : "-";
    const correct  = gotType === payload.expectedType && (payload.expectedState === null ? gotState === "-" : gotState === payload.expectedState);

    rows.push({
      payload: payload.id.slice(0, 22),
      model:   usedModel,
      got:     `${gotType}/${gotState}`,
      correct: correct ? "✓" : "✗",
      ms:      elapsed,
    });
  }

  printTable(rows);
  const accuracy    = rows.filter((r) => r.correct === "✓").length / rows.length * 100;
  const fallbackPct = (sonnetFallbacks / haikuCalls * 100).toFixed(0);
  console.log(`\n  accuracy=${accuracy.toFixed(0)}%  haiku_calls=${haikuCalls}  sonnet_fallbacks=${sonnetFallbacks} (${fallbackPct}%)`);
  printStats("  Tiered latency", latencies);
}

// H: Cost analysis
function printCostAnalysis(
  haikuIn: number, haikuOut: number,
  sonnetIn: number, sonnetOut: number,
  sampleCount: number,
) {
  const HAIKU_IN   = 0.80  / 1_000_000;
  const HAIKU_OUT  = 4.00  / 1_000_000;
  const HAIKU_CR   = 0.08  / 1_000_000;
  const SONNET_IN  = 3.00  / 1_000_000;
  const SONNET_OUT = 15.00 / 1_000_000;
  const SONNET_CR  = 0.30  / 1_000_000;

  const haikuNoCachePerCall  = haikuIn * HAIKU_IN + haikuOut * HAIKU_OUT;
  const sonnetNoCachePerCall = sonnetIn * SONNET_IN + sonnetOut * SONNET_OUT;
  const haikuCachedPerCall   = (haikuIn * HAIKU_CR) + haikuOut * HAIKU_OUT;
  const sonnetCachedPerCall  = (sonnetIn * SONNET_CR) + sonnetOut * SONNET_OUT;

  const per1k = (c: number) => `$${((c / sampleCount) * 1000).toFixed(4)}`;
  const perCall = (c: number) => `$${(c / sampleCount).toFixed(5)}`;

  printTable([
    { model: "Haiku 4.5",  mode: "no cache",   per_call: perCall(haikuNoCachePerCall),  per_1k: per1k(haikuNoCachePerCall)  },
    { model: "Haiku 4.5",  mode: "with cache",  per_call: perCall(haikuCachedPerCall),   per_1k: per1k(haikuCachedPerCall)   },
    { model: "Sonnet 4.6", mode: "no cache",   per_call: perCall(sonnetNoCachePerCall), per_1k: per1k(sonnetNoCachePerCall) },
    { model: "Sonnet 4.6", mode: "with cache",  per_call: perCall(sonnetCachedPerCall),  per_1k: per1k(sonnetCachedPerCall)  },
  ]);
  console.log("\n  Haiku $0.80/$4 in/out per MTok, cache read $0.08. Sonnet $3/$15, cache read $0.30.");
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set. Add to .env or export before running.");
    process.exit(1);
  }

  const haiku  = "claude-haiku-4-5-20251001";
  const sonnet = "claude-sonnet-4-6";

  console.log("\nGlacis - LLM Normalization Benchmark");
  console.log(`Started: ${new Date().toISOString()}\n`);

  console.log("Benchmark A: Single-call accuracy per model (with parse-fail debug)");
  console.log("T=type correct, S=state correct. Parse errors shown inline.\n");
  console.log("  Haiku 4.5");
  const haikuA = await benchmarkSingleCall(haiku, "Haiku 4.5");
  console.log("\n  Sonnet 4.6");
  const sonnetA = await benchmarkSingleCall(sonnet, "Sonnet 4.6");

  console.log("\nBenchmark B: One-call vs Two-call [Sonnet 4.6]");
  console.log("2-call now strips markdown fences before JSON.parse.\n");
  await benchmarkOneVsTwo(sonnet);

  console.log("\nBenchmark C: Prompt cache warmup [Sonnet 4.6]");
  console.log("System prompt + few-shot examples + tool definition now > 1024 tokens.\n");
  await benchmarkCache(sonnet, 6);

  console.log("\nBenchmark D: Reliability — 5 runs on hard payloads");
  console.log("European number format (EUR 24.350,75) and ambiguous milestone text.\n");
  const relRows = await Promise.all([
    benchmarkReliability(haiku,  "gfp-invoice-paid", 5),
    benchmarkReliability(sonnet, "gfp-invoice-paid", 5),
    benchmarkReliability(haiku,  "one-delivered",    5),
    benchmarkReliability(sonnet, "one-delivered",    5),
  ]);
  printTable(relRows);

  console.log("\nBenchmark E: Concurrency throughput [Sonnet 4.6]");
  console.log("Parallel LLM calls — shows how norm/sec scales with concurrency.\n");
  await benchmarkConcurrency(sonnet);

  console.log("\nBenchmark F: Adversarial payloads [Sonnet 4.6]");
  console.log("Parse errors shown in note column when parse fails.\n");
  await benchmarkAdversarial(sonnet);

  console.log("\nBenchmark G: Tiered model — Haiku first, Sonnet fallback");
  console.log("Haiku handles easy payloads. Sonnet catches Haiku parse failures.\n");
  await benchmarkTieredModel();

  console.log("\nBenchmark H: Cost analysis");
  console.log("Estimated cost per normalization and per 1,000 normalizations.\n");
  printCostAnalysis(
    haikuA.totalIn, haikuA.totalOut,
    sonnetA.totalIn, sonnetA.totalOut,
    payloads.length,
  );

  console.log(`\nBenchmark complete: ${new Date().toISOString()}\n`);
}

main().catch((e) => {
  console.error("Benchmark failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

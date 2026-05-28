import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { payloads } from "./payloads.js";
import { NormalizedEventSchema, type NormalizedEvent } from "./schemas.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a logistics data normalization engine for a supply chain platform.

You receive arbitrary JSON webhook payloads from external vendors and must:
1. Classify the payload into exactly one of: SHIPMENT, INVOICE, UNCLASSIFIED
2. Normalize it into the canonical schema below

SHIPMENT canonical states (map vendor language exactly to these):
- PICKED_UP: container/cargo collected from shipper or received at origin terminal
- IN_TRANSIT: vessel departed, cargo loaded onboard, in ocean/air/road transit
- OUT_FOR_DELIVERY: arrived at destination port/hub, customs cleared, last-mile started
- DELIVERED: cargo handed to consignee, delivery complete

INVOICE canonical states:
- ISSUED: invoice created / freight invoice raised
- PAID: settled, paid, remitted
- VOIDED: cancelled before payment
- REFUNDED: payment reversed after settlement

Rules:
- entity_id for shipments: use master BL number if present, otherwise house BL
- event_timestamp: always convert to ISO 8601 UTC
- amount_cents: parse European number formats (24.350,75 = 2435075 cents). Never use floats.
- currency: extract ISO 4217 code (EUR, USD, etc.)
- If a field is genuinely absent from the payload, use null — never invent values`;

const CLASSIFY_SYSTEM = `Classify this vendor webhook into: SHIPMENT, INVOICE, or UNCLASSIFIED.
Return JSON only: { "event_type": "SHIPMENT"|"INVOICE"|"UNCLASSIFIED", "confidence": "HIGH"|"MEDIUM"|"LOW" }`;

const NORMALIZE_TOOL: Tool = {
  name: "normalize_webhook",
  description: "Normalize a vendor webhook payload into the canonical schema",
  input_schema: {
    type: "object",
    properties: {
      event_type: { type: "string", enum: ["SHIPMENT", "INVOICE", "UNCLASSIFIED"] },
      entity_id: { type: "string" },
      canonical_state: { type: "string" },
      event_timestamp: { type: "string" },
      carrier: {
        type: "object",
        properties: { scac: { type: ["string", "null"] }, name: { type: ["string", "null"] } },
      },
      container_no: { type: ["string", "null"] },
      origin_port: {
        type: ["object", "null"],
        properties: { locode: { type: "string" }, name: { type: "string" } },
      },
      vessel: {
        type: ["object", "null"],
        properties: { name: { type: "string" }, imo: { type: ["string", "null"] } },
      },
      raw_milestone_text: { type: "string" },
      amount_cents: { type: "integer" },
      currency: { type: "string" },
      linked_bl: { type: ["string", "null"] },
      raw_transaction_kind: { type: "string" },
      reason: { type: "string" },
    },
    required: ["event_type"],
  },
};

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
  tools?: Tool[];
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

function cacheTokens(response: Message) {
  const u = response.usage as unknown as Record<string, number>;
  return {
    cacheRead: u["cache_read_input_tokens"] ?? 0,
    cacheWrite: u["cache_creation_input_tokens"] ?? 0,
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

function fms(n: number) { return `${n.toFixed(0)}ms`; }

function printTable(rows: Record<string, string | number>[]) {
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
  console.log(`\n${label} latency stats (n=${latencies.length})`);
  printTable([{
    min: fms(s.min),
    p50: fms(s.p50),
    p75: fms(s.p75),
    p95: fms(s.p95),
    p99: fms(s.p99),
    max: fms(s.max),
    avg: fms(s.avg),
    stddev: fms(s.stddev),
  }]);
}

async function benchmarkSingleCall(model: string) {
  const rows: Record<string, string | number>[] = [];
  const latencies: number[] = [];

  for (const payload of payloads) {
    const t0 = Date.now();
    let result: NormalizedEvent | null = null;
    let cacheRead = 0, cacheWrite = 0, inTok = 0, outTok = 0;

    try {
      const response = await callLLM({
        model,
        system: buildSystem(SYSTEM_PROMPT, true),
        tools: [NORMALIZE_TOOL],
        messages: [{ role: "user", content: `Normalize this vendor webhook:\n\n${JSON.stringify(payload.body, null, 2)}` }],
      });
      inTok = response.usage.input_tokens;
      outTok = response.usage.output_tokens;
      ({ cacheRead, cacheWrite } = cacheTokens(response));
      const parsed = NormalizedEventSchema.safeParse(extractToolInput(response));
      if (parsed.success) result = parsed.data;
    } catch (e) { console.error(`  [${payload.id}] LLM call failed:`, (e as Error).message); }

    const elapsed = Date.now() - t0;
    latencies.push(elapsed);

    const gotType = result?.event_type ?? "?";
    const gotState = result && result.event_type !== "UNCLASSIFIED"
      ? (result as Record<string, unknown>)["canonical_state"] as string
      : "-";
    const typeOk = gotType === payload.expectedType;
    const stateOk = payload.expectedState === null ? gotState === "-" : gotState === payload.expectedState;

    rows.push({
      payload: payload.id.slice(0, 22),
      want: `${payload.expectedType}/${payload.expectedState ?? "-"}`,
      got: `${gotType}/${gotState}`,
      "T✓": typeOk ? "✓" : "✗",
      "S✓": stateOk ? "✓" : "✗",
      "parse✓": result !== null ? "✓" : "✗",
      "ms": elapsed,
      in_tok: inTok,
      out_tok: outTok,
      cache_r: cacheRead,
      cache_w: cacheWrite,
    });
  }

  return { rows, latencies };
}

async function benchmarkOneVsTwo(model: string) {
  const rows: Record<string, string | number>[] = [];
  const oneLatencies: number[] = [];
  const twoLatencies: number[] = [];

  for (const payload of payloads) {
    const t1s = Date.now();
    let oneOk = false;
    try {
      const r = await callLLM({
        model,
        system: buildSystem(SYSTEM_PROMPT, true),
        tools: [NORMALIZE_TOOL],
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
        model,
        system: buildSystem(CLASSIFY_SYSTEM, true),
        messages: [{ role: "user", content: JSON.stringify(payload.body) }],
        maxTokens: 128,
      });
      const cls = JSON.parse(extractText(r1)) as { event_type: string };
      const r2 = await callLLM({
        model,
        system: buildSystem(SYSTEM_PROMPT, true),
        tools: [NORMALIZE_TOOL],
        messages: [{ role: "user", content: `Pre-classified as: ${cls.event_type}\n\n${JSON.stringify(payload.body, null, 2)}` }],
      });
      twoOk = NormalizedEventSchema.safeParse(extractToolInput(r2)).success;
    } catch (e) { console.error(`  [${payload.id}] 2-call failed:`, (e as Error).message); }
    const twoMs = Date.now() - t2s;
    twoLatencies.push(twoMs);

    rows.push({
      payload: payload.id.slice(0, 22),
      "1-call ms": oneMs,
      "1-call ok": oneOk ? "✓" : "✗",
      "2-call ms": twoMs,
      "2-call ok": twoOk ? "✓" : "✗",
      faster: oneMs < twoMs ? "1-call" : "2-call",
      "delta ms": Math.abs(oneMs - twoMs),
    });
  }

  return { rows, oneLatencies, twoLatencies };
}

async function benchmarkCache(model: string, runs = 6) {
  const payload = payloads[0];
  const rows: Record<string, string | number>[] = [];
  const latencies: number[] = [];

  for (let i = 1; i <= runs; i++) {
    const t0 = Date.now();
    const response = await callLLM({
      model,
      system: buildSystem(SYSTEM_PROMPT, true),
      tools: [NORMALIZE_TOOL],
      messages: [{ role: "user", content: `Normalize this vendor webhook:\n\n${JSON.stringify(payload.body, null, 2)}` }],
    });
    const elapsed = Date.now() - t0;
    latencies.push(elapsed);
    const { cacheRead, cacheWrite } = cacheTokens(response);
    rows.push({
      run: i,
      "ms": elapsed,
      cache_read_tok: cacheRead,
      cache_write_tok: cacheWrite,
      status: cacheRead > 0 ? "WARM ✓" : "COLD",
    });
  }

  return { rows, latencies };
}

async function benchmarkReliability(model: string, payloadId: string, runs: number) {
  const payload = payloads.find((p) => p.id === payloadId)!;
  const latencies: number[] = [];
  let parseOk = 0, typeOk = 0, stateOk = 0;

  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    try {
      const response = await callLLM({
        model,
        system: buildSystem(SYSTEM_PROMPT, true),
        tools: [NORMALIZE_TOOL],
        messages: [{ role: "user", content: `Normalize this vendor webhook:\n\n${JSON.stringify(payload.body, null, 2)}` }],
      });
      latencies.push(Date.now() - t0);
      const parsed = NormalizedEventSchema.safeParse(extractToolInput(response));
      if (parsed.success) {
        parseOk++;
        if (parsed.data.event_type === payload.expectedType) typeOk++;
        const state = parsed.data.event_type !== "UNCLASSIFIED"
          ? (parsed.data as Record<string, unknown>)["canonical_state"]
          : null;
        if (state === (payload.expectedState ?? null)) stateOk++;
      }
    } catch (e) { console.error(`  [${payloadId} run ${i + 1}] failed:`, (e as Error).message); latencies.push(Date.now() - t0); }
  }

  const s = latencyStats(latencies);
  const pct = (n: number) => `${((n / runs) * 100).toFixed(0)}%`;

  return {
    model: model.includes("haiku") ? "Haiku 4.5" : "Sonnet 4.6",
    payload: payloadId.slice(0, 18),
    runs,
    "parse%": pct(parseOk),
    "type%": pct(typeOk),
    "state%": pct(stateOk),
    "min": fms(s.min),
    "p50": fms(s.p50),
    "p75": fms(s.p75),
    "p95": fms(s.p95),
    "p99": fms(s.p99),
    "max": fms(s.max),
    "stddev": fms(s.stddev),
  };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Export it before running:\n  export ANTHROPIC_API_KEY=sk-ant-...");
    process.exit(1);
  }

  const haiku = "claude-haiku-4-5-20251001";
  const sonnet = "claude-sonnet-4-6";

  console.log("\nGlacis - LLM Normalization Benchmark");
  console.log(`Started: ${new Date().toISOString()}\n`);

  console.log("Benchmark A: Single-call accuracy per model");
  console.log("Each payload sent once. Measures classification + normalization correctness and latency.\n");

  for (const [model, name] of [[haiku, "Haiku 4.5"], [sonnet, "Sonnet 4.6"]] as const) {
    console.log(`  ${name}`);
    const { rows, latencies } = await benchmarkSingleCall(model);
    printTable(rows);

    const typeAcc = rows.filter((r) => r["T✓"] === "✓").length / rows.length * 100;
    const stateAcc = rows.filter((r) => r["S✓"] === "✓").length / rows.length * 100;
    const parseAcc = rows.filter((r) => r["parse✓"] === "✓").length / rows.length * 100;
    console.log(`  type_accuracy=${typeAcc.toFixed(0)}%  state_accuracy=${stateAcc.toFixed(0)}%  parse_ok=${parseAcc.toFixed(0)}%`);
    printStats(`  ${name}`, latencies);
    console.log();
  }

  console.log("\nBenchmark B: One-call vs Two-call strategy");
  console.log("One-call: classify + normalize in a single LLM call.");
  console.log("Two-call: classify first, then normalize with type context injected.\n");

  const { rows: bRows, oneLatencies, twoLatencies } = await benchmarkOneVsTwo(sonnet);
  printTable(bRows);

  const oneS = latencyStats(oneLatencies);
  const twoS = latencyStats(twoLatencies);
  printTable([
    { strategy: "1-call", min: fms(oneS.min), p50: fms(oneS.p50), p75: fms(oneS.p75), p95: fms(oneS.p95), p99: fms(oneS.p99), max: fms(oneS.max), avg: fms(oneS.avg), stddev: fms(oneS.stddev) },
    { strategy: "2-call", min: fms(twoS.min), p50: fms(twoS.p50), p75: fms(twoS.p75), p95: fms(twoS.p95), p99: fms(twoS.p99), max: fms(twoS.max), avg: fms(twoS.avg), stddev: fms(twoS.stddev) },
  ]);

  console.log("\nBenchmark C: Prompt cache warmup");
  console.log("Run 1 = cold (cache write). Runs 2-6 = should read from cache.");
  console.log("Cache hits cut input token cost ~90% and reduce latency.\n");

  const { rows: cRows, latencies: cLatencies } = await benchmarkCache(sonnet, 6);
  printTable(cRows);

  const coldMs = cLatencies[0]!;
  const warmLatencies = cLatencies.slice(1);
  const warmS = latencyStats(warmLatencies);
  const saving = (((coldMs - warmS.avg) / coldMs) * 100).toFixed(1);
  console.log(`\n  cold=${fms(coldMs)}  warm_avg=${fms(warmS.avg)}  speedup=${saving}%`);
  printStats("  Warm runs", warmLatencies);

  console.log("\nBenchmark D: Reliability — repeated runs on hard payloads");
  console.log("gfp-invoice-paid : European number format  EUR 24.350,75 -> 2435075 cents");
  console.log("one-delivered    : Ambiguous milestone text requiring semantic mapping\n");

  const relRows = await Promise.all([
    benchmarkReliability(haiku, "gfp-invoice-paid", 5),
    benchmarkReliability(sonnet, "gfp-invoice-paid", 5),
    benchmarkReliability(haiku, "one-delivered", 5),
    benchmarkReliability(sonnet, "one-delivered", 5),
  ]);
  printTable(relRows);

  console.log(`\nBenchmark complete: ${new Date().toISOString()}\n`);
}

main().catch((e) => {
  console.error("Benchmark failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

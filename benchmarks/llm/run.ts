import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { payloads } from "./payloads.js";
import { NormalizedEventSchema, type NormalizedEvent } from "./schemas.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Prompt ──────────────────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function ms(n: number) { return `${n.toFixed(0)}ms`; }

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

// ─── Benchmark A: Single-call accuracy per model ─────────────────────────────

async function benchmarkSingleCall(model: string) {
  const rows: Record<string, string | number>[] = [];

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
    } catch (_) {}

    const latencyMs = Date.now() - t0;
    const gotType = result?.event_type ?? "?";
    const gotState = result && result.event_type !== "UNCLASSIFIED" ? (result as Record<string, unknown>)["canonical_state"] as string : "-";
    const typeOk = gotType === payload.expectedType;
    const stateOk = payload.expectedState === null ? gotState === "-" : gotState === payload.expectedState;

    rows.push({
      payload: payload.id.slice(0, 20),
      want: `${payload.expectedType}/${payload.expectedState ?? "-"}`,
      got: `${gotType}/${gotState}`,
      "T✓": typeOk ? "✓" : "✗",
      "S✓": stateOk ? "✓" : "✗",
      latency: ms(latencyMs),
      in_tok: inTok,
      out_tok: outTok,
      cache_r: cacheRead,
      cache_w: cacheWrite,
    });
  }
  return rows;
}

// ─── Benchmark B: One-call vs two-call ───────────────────────────────────────

const CLASSIFY_SYSTEM = `Classify this vendor webhook into: SHIPMENT, INVOICE, or UNCLASSIFIED.
Return JSON only: { "event_type": "SHIPMENT"|"INVOICE"|"UNCLASSIFIED", "confidence": "HIGH"|"MEDIUM"|"LOW" }`;

async function benchmarkOneVsTwo(model: string) {
  const rows: Record<string, string | number>[] = [];

  for (const payload of payloads) {
    // One call
    const t1s = Date.now();
    let oneCallOk = false;
    try {
      const r = await callLLM({
        model,
        system: buildSystem(SYSTEM_PROMPT, true),
        tools: [NORMALIZE_TOOL],
        messages: [{ role: "user", content: `Normalize this vendor webhook:\n\n${JSON.stringify(payload.body, null, 2)}` }],
      });
      oneCallOk = NormalizedEventSchema.safeParse(extractToolInput(r)).success;
    } catch (_) {}
    const oneMs = Date.now() - t1s;

    // Two calls
    const t2s = Date.now();
    let twoCallOk = false;
    try {
      const r1 = await callLLM({
        model,
        system: buildSystem(CLASSIFY_SYSTEM, true),
        messages: [{ role: "user", content: JSON.stringify(payload.body) }],
        maxTokens: 128,
      });
      const classText = extractText(r1);
      const cls = JSON.parse(classText) as { event_type: string };

      const r2 = await callLLM({
        model,
        system: buildSystem(SYSTEM_PROMPT, true),
        tools: [NORMALIZE_TOOL],
        messages: [{ role: "user", content: `Pre-classified as: ${cls.event_type}\n\n${JSON.stringify(payload.body, null, 2)}` }],
      });
      twoCallOk = NormalizedEventSchema.safeParse(extractToolInput(r2)).success;
    } catch (_) {}
    const twoMs = Date.now() - t2s;

    rows.push({
      payload: payload.id.slice(0, 20),
      "1-call ms": ms(oneMs),
      "1-call ok": oneCallOk ? "✓" : "✗",
      "2-call ms": ms(twoMs),
      "2-call ok": twoCallOk ? "✓" : "✗",
      winner: oneMs < twoMs ? "1-call faster" : "2-call faster",
    });
  }
  return rows;
}

// ─── Benchmark C: Prompt cache warmup ────────────────────────────────────────

async function benchmarkCache(model: string, runs = 6) {
  const payload = payloads[0];
  const rows: Record<string, string | number>[] = [];

  for (let i = 1; i <= runs; i++) {
    const t0 = Date.now();
    const response = await callLLM({
      model,
      system: buildSystem(SYSTEM_PROMPT, true),
      tools: [NORMALIZE_TOOL],
      messages: [{ role: "user", content: `Normalize this vendor webhook:\n\n${JSON.stringify(payload.body, null, 2)}` }],
    });
    const latencyMs = Date.now() - t0;
    const { cacheRead, cacheWrite } = cacheTokens(response);
    rows.push({
      run: i,
      latency: ms(latencyMs),
      cache_read_tok: cacheRead,
      cache_write_tok: cacheWrite,
      status: cacheRead > 0 ? "WARM ✓" : "COLD (miss)",
    });
  }
  return rows;
}

// ─── Benchmark D: Reliability — N runs on hardest payload ────────────────────

async function benchmarkReliability(model: string, payloadId: string, runs = 5) {
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
        const state = parsed.data.event_type !== "UNCLASSIFIED" ? (parsed.data as Record<string, unknown>)["canonical_state"] : null;
        if (state === (payload.expectedState ?? null)) stateOk++;
      }
    } catch (_) { latencies.push(Date.now() - t0); }
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (n: number) => `${((n / runs) * 100).toFixed(0)}%`;
  return {
    model: model.includes("haiku") ? "Haiku 4.5" : "Sonnet 4.6",
    payload: payloadId,
    runs,
    "parse%": pct(parseOk),
    "type%": pct(typeOk),
    "state%": pct(stateOk),
    p50: ms(sorted[Math.floor(sorted.length * 0.5)] ?? 0),
    p95: ms(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    min: ms(sorted[0] ?? 0),
    max: ms(sorted[sorted.length - 1] ?? 0),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const haiku = "claude-haiku-4-5-20251001";
  const sonnet = "claude-sonnet-4-6";

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║         GLACIS — LLM Normalization Benchmark                  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  // A. Accuracy per model
  for (const [model, name] of [[haiku, "Haiku 4.5"], [sonnet, "Sonnet 4.6"]] as const) {
    console.log(`\n━━━ A. Single-call accuracy [${name}] ━━━\n`);
    const rows = await benchmarkSingleCall(model);
    printTable(rows);
    const typeAcc = rows.filter((r) => r["T✓"] === "✓").length / rows.length * 100;
    const stateAcc = rows.filter((r) => r["S✓"] === "✓").length / rows.length * 100;
    const avgMs = rows.reduce((s, r) => s + parseInt(String(r.latency)), 0) / rows.length;
    console.log(`\ntype_accuracy=${typeAcc.toFixed(0)}%  state_accuracy=${stateAcc.toFixed(0)}%  avg_latency≈${avgMs.toFixed(0)}ms`);
  }

  // B. One-call vs two-call
  console.log(`\n━━━ B. One-call vs Two-call [Sonnet 4.6] ━━━\n`);
  const oneVsTwo = await benchmarkOneVsTwo(sonnet);
  printTable(oneVsTwo);

  // C. Cache warmup
  console.log(`\n━━━ C. Prompt cache warmup — 6 runs [Sonnet 4.6] ━━━\n`);
  console.log("Run 1 = cold write. Runs 2+ = should hit cache.\n");
  const cacheRows = await benchmarkCache(sonnet, 6);
  printTable(cacheRows);
  const coldMs = parseInt(String(cacheRows[0].latency));
  const warmAvg = cacheRows.slice(1).reduce((s, r) => s + parseInt(String(r.latency)), 0) / (cacheRows.length - 1);
  const saving = (((coldMs - warmAvg) / coldMs) * 100).toFixed(1);
  console.log(`\ncache_speedup: ${coldMs}ms cold → ${warmAvg.toFixed(0)}ms warm (${saving}% faster)`);

  // D. Reliability on hardest payloads
  console.log(`\n━━━ D. Reliability — 5 runs per hard payload ━━━`);
  console.log(`\n"gfp-invoice-paid" tests European number parsing (EUR 24.350,75 → 2435075 cents)`);
  console.log(`"one-delivered" tests ambiguous milestone text\n`);
  const relRows = await Promise.all([
    benchmarkReliability(haiku, "gfp-invoice-paid", 5),
    benchmarkReliability(sonnet, "gfp-invoice-paid", 5),
    benchmarkReliability(haiku, "one-delivered", 5),
    benchmarkReliability(sonnet, "one-delivered", 5),
  ]);
  printTable(relRows);

  console.log("\n━━━ Benchmark complete ━━━\n");
}

main().catch((e) => {
  console.error("Benchmark failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

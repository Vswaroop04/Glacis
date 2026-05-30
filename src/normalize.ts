import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "./config.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { LLMOutputSchema, type LLMOutput } from "./schemas.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
let _openai: OpenAI | null = null;
function openai(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: config.openaiApiKey });
  return _openai;
}

// One tool both providers fill in. Same shape as the canonical schema so the
// model's output drops straight into Zod validation.
const TOOL_PARAMS = {
  type: "object",
  properties: {
    event_type: { type: "string", enum: ["SHIPMENT", "INVOICE", "UNCLASSIFIED"] },
    mode: { type: "string", enum: ["SEA", "AIR", "ROAD", "RAIL", "PARCEL", "UNKNOWN"], description: "transport mode for SHIPMENT" },
    entity_id: { type: "string" },
    canonical_state: { type: "string" },
    is_exception: { type: "boolean", description: "true if this event reports a problem (customs hold, delay, damage)" },
    exception_reason: { type: ["string", "null"], description: "short reason when is_exception is true" },
    event_timestamp: { type: "string" },
    carrier: {
      oneOf: [
        { type: "object", properties: { scac: { type: ["string", "null"] }, name: { type: ["string", "null"] } } },
        { type: ["string", "null"] },
      ],
    },
    container_no: { type: ["string", "null"] },
    vessel: { type: ["object", "null"], properties: { name: { type: "string" }, imo: { type: ["string", "null"] } } },
    event_locode: { type: ["string", "null"], description: "UN/LOCODE of where this event happened" },
    event_location_name: { type: ["string", "null"] },
    raw_milestone_text: { type: "string" },
    amount_cents: { type: "integer", description: "smallest currency unit; European 24.350,75 = 2435075" },
    currency: { type: "string", description: "ISO 4217 code e.g. EUR, USD" },
    due_date: { type: ["string", "null"], description: "ISO 8601 UTC invoice payment due date if present" },
    linked_bl: { type: ["string", "null"] },
    raw_transaction_kind: { type: "string" },
    reason: { type: "string" },
    confidence: { type: "number", description: "0.0 to 1.0 confidence in this normalization" },
  },
  required: ["event_type", "confidence"],
} as const;

const TOOL_NAME = "normalize_webhook";

export class NormalizationError extends Error {
  constructor(message: string, readonly model: string) {
    super(message);
    this.name = "NormalizationError";
  }
}

export interface NormalizeResult {
  event: LLMOutput;
  confidence: number | null;
  model: string;
}

function providerFor(model: string): "anthropic" | "openai" {
  return model.startsWith("gpt") || model.startsWith("o") ? "openai" : "anthropic";
}

async function callAnthropic(model: string, userContent: string): Promise<unknown> {
  const res = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [{ name: TOOL_NAME, description: "Normalize a vendor webhook payload", input_schema: TOOL_PARAMS as never }],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: userContent }],
  });
  const block = res.content.find((b) => b.type === "tool_use");
  return block && block.type === "tool_use" ? block.input : null;
}

async function callOpenAI(model: string, userContent: string): Promise<unknown> {
  const res = await openai().chat.completions.create({
    model,
    max_tokens: 1024,
    tools: [{ type: "function", function: { name: TOOL_NAME, description: "Normalize a vendor webhook payload", parameters: TOOL_PARAMS as never } }],
    tool_choice: { type: "function", function: { name: TOOL_NAME } },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });
  const args = res.choices[0]?.message?.tool_calls?.[0];
  if (args && "function" in args && args.function.arguments) {
    try { return JSON.parse(args.function.arguments); } catch { return null; }
  }
  return null;
}

/**
 * Single structured LLM call: classify + normalize in one shot, then validate.
 * Throws NormalizationError if the model returns nothing or the output fails the
 * schema — the worker turns that into a retry (escalating the model).
 */
export async function normalize(payload: unknown, model: string): Promise<NormalizeResult> {
  const userContent = `Normalize this vendor webhook:\n\n${JSON.stringify(payload, null, 2)}`;
  const toolInput = providerFor(model) === "anthropic"
    ? await callAnthropic(model, userContent)
    : await callOpenAI(model, userContent);

  if (toolInput == null) throw new NormalizationError("model returned no tool call", model);

  const confidence = typeof (toolInput as { confidence?: unknown }).confidence === "number"
    ? (toolInput as { confidence: number }).confidence
    : null;

  const parsed = LLMOutputSchema.safeParse(toolInput);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new NormalizationError(`schema validation failed: ${detail}`, model);
  }

  return { event: parsed.data, confidence, model };
}

import Anthropic from "@anthropic-ai/sdk";
import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages/messages.js";
import OpenAI from "openai";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type Provider = "anthropic" | "openai";

export interface LLMResponse {
  toolInput:     unknown | null;
  inputTokens:   number;
  outputTokens:  number;
  cacheRead:     number;
  cacheWrite:    number;
  latencyMs:     number;
}

export interface ModelSpec {
  provider: Provider;
  model:    string;
  label:    string;
}

export const MODELS: ModelSpec[] = [
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Haiku 4.5"    },
  { provider: "anthropic", model: "claude-sonnet-4-6",         label: "Sonnet 4.6"   },
  { provider: "openai",    model: "gpt-4o-mini",               label: "GPT-4o mini"  },
  { provider: "openai",    model: "gpt-4o",                    label: "GPT-4o"       },
  { provider: "openai",    model: "gpt-4.1-nano",              label: "GPT-4.1 nano" },
  { provider: "openai",    model: "gpt-4.1",                   label: "GPT-4.1"      },
];

// Anthropic tool definition (with optional cache_control)
export const ANTHROPIC_TOOL = {
  name: "normalize_webhook",
  description: "Normalize a vendor webhook payload into the canonical schema",
  input_schema: {
    type: "object",
    properties: {
      event_type:           { type: "string", enum: ["SHIPMENT", "INVOICE", "UNCLASSIFIED"] },
      entity_id:            { type: "string" },
      canonical_state:      { type: "string" },
      event_timestamp:      { type: "string" },
      carrier:              { oneOf: [
        { type: "object", properties: { scac: { type: ["string","null"] }, name: { type: ["string","null"] } } },
        { type: ["string","null"] },
      ]},
      container_no:         { type: ["string","null"] },
      origin_port:          { type: ["object","null"], properties: { locode: { type: "string" }, name: { type: "string" } } },
      vessel:               { type: ["object","null"], properties: { name: { type: "string" }, imo: { type: ["string","null"] } } },
      raw_milestone_text:   { type: "string" },
      amount_cents:         { type: "integer", description: "Amount in smallest currency unit. European 24.350,75 = 2435075 cents." },
      currency:             { type: "string",  description: "ISO 4217 three-letter code e.g. EUR, USD" },
      linked_bl:            { type: ["string","null"] },
      raw_transaction_kind: { type: "string" },
      reason:               { type: "string" },
    },
    required: ["event_type"],
  },
  cache_control: { type: "ephemeral" as const },
} satisfies AnthropicTool & { cache_control: { type: "ephemeral" } };

// OpenAI function/tool definition (same schema, different wrapper)
const OPENAI_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "normalize_webhook",
    description: "Normalize a vendor webhook payload into the canonical schema",
    parameters: ANTHROPIC_TOOL.input_schema,
  },
};

type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

async function callAnthropic(
  model: string,
  systemBlocks: SystemBlock[],
  userContent: string,
  maxTokens = 1024,
): Promise<LLMResponse> {
  const t0 = Date.now();
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemBlocks,
    tools: [ANTHROPIC_TOOL],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: userContent }],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const toolBlock = response.content?.find((b: { type: string }) => b.type === "tool_use");
  const u = response.usage ?? {};
  return {
    toolInput:    toolBlock?.input ?? null,
    inputTokens:  u.input_tokens  ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheRead:    u.cache_read_input_tokens      ?? 0,
    cacheWrite:   u.cache_creation_input_tokens  ?? 0,
    latencyMs:    Date.now() - t0,
  };
}

async function callOpenAI(
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens = 1024,
): Promise<LLMResponse> {
  const t0 = Date.now();
  const response = await openai.chat.completions.create({
    model,
    max_tokens: maxTokens,
    tools: [OPENAI_TOOL],
    tool_choice: { type: "function", function: { name: "normalize_webhook" } },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userContent  },
    ],
  });

  const choice = response.choices[0];
  const toolCall = choice?.message?.tool_calls?.[0] as { function?: { arguments?: string } } | undefined;
  let toolInput: unknown = null;
  if (toolCall?.function?.arguments) {
    try { toolInput = JSON.parse(toolCall.function.arguments); } catch (_) {}
  }

  const u = response.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  return {
    toolInput,
    inputTokens:  u.prompt_tokens     ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cacheRead:    0,
    cacheWrite:   0,
    latencyMs:    Date.now() - t0,
  };
}

export function buildAnthropicSystem(text: string, cached: boolean): SystemBlock[] {
  return cached
    ? [{ type: "text", text, cache_control: { type: "ephemeral" } }]
    : [{ type: "text", text }];
}

export async function callModel(
  spec: ModelSpec,
  systemPrompt: string,
  userContent: string,
  opts?: { cached?: boolean; maxTokens?: number },
): Promise<LLMResponse> {
  if (spec.provider === "anthropic") {
    return callAnthropic(
      spec.model,
      buildAnthropicSystem(systemPrompt, opts?.cached ?? true),
      userContent,
      opts?.maxTokens,
    );
  }
  return callOpenAI(spec.model, systemPrompt, userContent, opts?.maxTokens);
}

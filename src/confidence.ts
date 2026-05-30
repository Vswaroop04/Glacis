import type { NormalizedEvent } from "./schemas.js";
import type { TransitionVerdict } from "./state-machine.js";

// fields that genuinely must be present for each type to be usable downstream
const REQUIRED: Record<string, string[]> = {
  SHIPMENT: ["entity_id", "canonical_state", "event_timestamp"],
  INVOICE: ["entity_id", "canonical_state", "event_timestamp", "amount_cents", "currency"],
  UNCLASSIFIED: ["reason"],
};

export function requiredFieldsPresent(e: NormalizedEvent): number {
  const req = REQUIRED[e.event_type] ?? [];
  if (req.length === 0) return 1;
  const rec = e as unknown as Record<string, unknown>;
  const present = req.filter((k) => rec[k] != null && rec[k] !== "").length;
  return present / req.length;
}

export interface ConfidenceInputs {
  event: NormalizedEvent;
  modelConfidence: number | null;
  verdict: TransitionVerdict | null; // null = no lifecycle transition (e.g. unclassified)
  enrichmentStatus: string;
  containerValid: boolean | null;
}

/**
 * A confidence score we can actually defend.
 *
 * The model returns its own confidence, but a model's self-report is not
 * trustworthy on its own — it has no idea whether the fields it invented are
 * right. So we down-weight it and combine it with signals we can verify
 * ourselves: did all required fields come back, was the state transition legal,
 * did enrichment succeed, did the container number check out. The model's number
 * is one input, not the answer.
 */
export function computeConfidence(i: ConfidenceInputs): number {
  const fields = requiredFieldsPresent(i.event);
  const transition = !i.verdict ? 1
    : i.verdict.kind === "ANOMALY" ? 0.2
    : i.verdict.kind === "OUT_OF_ORDER" ? 0.85
    : 1;
  const enrich = i.enrichmentStatus === "FAILED" ? 0.6 : i.enrichmentStatus === "PARTIAL" ? 0.85 : 1;
  const container = i.containerValid === false ? 0.4 : 1;
  const model = i.modelConfidence ?? 0.8;

  const score = 0.30 * fields + 0.25 * transition + 0.15 * enrich + 0.10 * container + 0.20 * model;
  return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
}

// in priority order — the first is the primary reason for review
export function reviewReasons(i: ConfidenceInputs, computed: number, threshold: number): string[] {
  const reasons: string[] = [];
  if (i.verdict?.kind === "ANOMALY") reasons.push("INVALID_TRANSITION");
  if (i.containerValid === false) reasons.push("INVALID_CONTAINER");
  if (i.enrichmentStatus === "FAILED") reasons.push("ENRICHMENT_FAILED");
  if (computed < threshold) reasons.push("LOW_CONFIDENCE");
  return reasons;
}

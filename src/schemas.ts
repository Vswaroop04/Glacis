import { z } from "zod";

/**
 * Two-tier schema design.
 *
 * Tier 1 (LLM output): exactly what the model is asked to return. Focused on
 * classification + extraction — the fuzzy work an LLM is good at. Deliberately
 * contains NO coordinates/distances; the model would hallucinate them.
 *
 * Tier 2 (stored record): the LLM output wrapped with deterministic enrichment
 * (geo) and provenance (which model, confidence, enrichment status). Every field
 * is traceable to its source, so LLM-derived data is never confused with
 * deterministically-resolved data.
 */

// canonical state enums
export const SHIPMENT_STATES = ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"] as const;
export const INVOICE_STATES = ["ISSUED", "PAID", "VOIDED", "REFUNDED"] as const;

export const ShipmentState = z.enum(SHIPMENT_STATES);
export const InvoiceState = z.enum(INVOICE_STATES);

// transport mode — the lifecycle is the same across modes, but enrichment
// (location codes, distance method, identifier validation) is mode-specific
export const TRANSPORT_MODES = ["SEA", "AIR", "ROAD", "RAIL", "PARCEL", "UNKNOWN"] as const;
export const TransportMode = z.enum(TRANSPORT_MODES);
export type TransportMode = (typeof TRANSPORT_MODES)[number];

// geo primitives, filled in by enrichment
export const GeoPoint = z.object({
  locode: z.string().nullable(),                 // UN/LOCODE, e.g. "CNSHA" — LLM-extracted
  name: z.string().nullable(),                   // "Shanghai" — LLM-extracted
  lat: z.number().nullable(),                    // resolved by enrichment
  lng: z.number().nullable(),                    // resolved by enrichment
  country: z.string().length(2).nullable(),      // ISO 3166-1 alpha-2 — resolved
  source: z.enum(["LOCODE_DB", "GEOCODER", "VENDOR", "UNRESOLVED"]),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

export const Route = z.object({
  origin: GeoPoint.nullable(),
  destination: GeoPoint.nullable(),
  distance_km: z.number().nullable(),
  // how the distance was derived — varies by mode (sea lane vs great circle vs road)
  distance_mode: z.enum(["SEA_ROUTE", "GREAT_CIRCLE", "ROAD", "NONE"]),
  transit_days: z.number().nullable(),
  eta: z.string().nullable(),
});
export type Route = z.infer<typeof Route>;

// tier 1: what the LLM must return
export const ShipmentLLM = z.object({
  event_type: z.literal("SHIPMENT"),
  mode: TransportMode.catch("UNKNOWN").describe("transport mode: SEA, AIR, ROAD, RAIL, PARCEL"),
  entity_id: z.string().describe("master BL > house BL > AWB > tracking/container number"),
  canonical_state: ShipmentState,
  // exceptions (customs hold, delay, damage) aren't a separate state — the
  // shipment is still wherever it was — so they ride alongside canonical_state
  is_exception: z.boolean().default(false).describe("true if this event reports a problem/exception"),
  exception_reason: z.string().nullish().describe("short reason if is_exception, e.g. 'customs hold'"),
  event_timestamp: z.string().describe("ISO 8601 UTC"),
  carrier: z.object({ scac: z.string().nullable(), name: z.string().nullable() }),
  container_no: z.string().nullish(),
  vessel: z.object({ name: z.string(), imo: z.string().nullish() }).nullish(),
  event_locode: z.string().nullish().describe("UN/LOCODE of where this event happened"),
  event_location_name: z.string().nullish(),
  raw_milestone_text: z.string().describe("original vendor text, unmodified"),
});

export const InvoiceLLM = z.object({
  event_type: z.literal("INVOICE"),
  entity_id: z.string().describe("vendor invoice reference number"),
  canonical_state: InvoiceState,
  event_timestamp: z.string().describe("ISO 8601 UTC"),
  amount_cents: z.number().int().describe("smallest currency unit, never a float"),
  currency: z.string().length(3).describe("ISO 4217 code"),
  carrier: z.string().nullish(),
  linked_bl: z.string().nullish(),
  raw_transaction_kind: z.string().describe("original vendor text, unmodified"),
});

export const UnclassifiedLLM = z.object({
  event_type: z.literal("UNCLASSIFIED"),
  reason: z.string(),
});

export const LLMOutputSchema = z.discriminatedUnion("event_type", [
  ShipmentLLM,
  InvoiceLLM,
  UnclassifiedLLM,
]);
export type LLMOutput = z.infer<typeof LLMOutputSchema>;
export type ShipmentLLM = z.infer<typeof ShipmentLLM>;
export type InvoiceLLM = z.infer<typeof InvoiceLLM>;
export type UnclassifiedLLM = z.infer<typeof UnclassifiedLLM>;

// tier 2: enriched, stored and served record
export const EnrichedShipment = ShipmentLLM.extend({
  event_location: GeoPoint.nullable(),           // enrichment resolves event_locode
});
export type EnrichedShipment = z.infer<typeof EnrichedShipment>;

export const NormalizedEventSchema = z.discriminatedUnion("event_type", [
  EnrichedShipment,
  InvoiceLLM,
  UnclassifiedLLM,
]);
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

// Full persisted record: normalized payload + provenance.
export const NormalizedRecord = z.object({
  raw_event_id: z.string(),                      // = SHA-256 of raw body
  event: NormalizedEventSchema,
  confidence: z.number().min(0).max(1).nullable(),
  model: z.string(),
  enrichment_status: z.enum(["DONE", "PARTIAL", "SKIPPED", "FAILED"]),
  normalized_at: z.string(),
});
export type NormalizedRecord = z.infer<typeof NormalizedRecord>;

// entity snapshot: derived head state
export const EntitySnapshot = z.object({
  entity_id: z.string(),
  event_type: z.enum(["SHIPMENT", "INVOICE"]),
  canonical_state: z.string(),
  last_event_timestamp: z.string(),              // the out-of-order guard
  route: Route.nullable(),
  event_count: z.number().int(),
  updated_at: z.string(),
});
export type EntitySnapshot = z.infer<typeof EntitySnapshot>;

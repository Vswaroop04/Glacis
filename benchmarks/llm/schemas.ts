import { z } from "zod";

export const ShipmentEventSchema = z.object({
  event_type: z.literal("SHIPMENT"),
  entity_id: z.string().describe("Bill of Lading number — master BL preferred over house BL"),
  canonical_state: z.enum(["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"]),
  event_timestamp: z.string().describe("ISO 8601 UTC timestamp of the milestone"),
  carrier: z.object({
    scac: z.string().nullable(),
    name: z.string().nullable(),
  }),
  container_no: z.string().nullish(),
  origin_port: z.object({ locode: z.string(), name: z.string() }).nullish(),
  vessel: z.object({ name: z.string(), imo: z.string().nullish() }).nullish(),
  raw_milestone_text: z.string().describe("Original vendor milestone text, unmodified"),
});

export const InvoiceEventSchema = z.object({
  event_type: z.literal("INVOICE"),
  entity_id: z.string().describe("Vendor invoice reference number"),
  canonical_state: z.enum(["ISSUED", "PAID", "VOIDED", "REFUNDED"]),
  event_timestamp: z.string().describe("ISO 8601 UTC timestamp of the financial event"),
  amount_cents: z.number().int().describe("Amount in smallest currency unit, e.g. EUR cents"),
  currency: z.string().length(3).describe("ISO 4217 currency code"),
  carrier: z.string().nullish(),
  linked_bl: z.string().nullish().describe("Associated Bill of Lading if present"),
  raw_transaction_kind: z.string().describe("Original vendor transaction kind string, unmodified"),
});

export const UnclassifiedEventSchema = z.object({
  event_type: z.literal("UNCLASSIFIED"),
  reason: z.string().describe("Why this payload cannot be classified as a shipment or invoice"),
});

export const NormalizedEventSchema = z.discriminatedUnion("event_type", [
  ShipmentEventSchema,
  InvoiceEventSchema,
  UnclassifiedEventSchema,
]);

export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;
export type ShipmentEvent = z.infer<typeof ShipmentEventSchema>;
export type InvoiceEvent = z.infer<typeof InvoiceEventSchema>;

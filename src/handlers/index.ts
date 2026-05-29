import type { LLMOutput, NormalizedEvent, ShipmentLLM, InvoiceLLM, UnclassifiedLLM } from "../schemas.js";

/**
 * Per-type handling. The single LLM call decides the type; the matching handler
 * owns everything type-specific (shaping the stored record, deciding whether the
 * event advances an entity's state). Adding a new event type means adding one
 * handler function and one switch arm — nothing in the worker or LLM layer changes.
 */

export interface SnapshotDescriptor {
  entityId: string;
  eventType: "SHIPMENT" | "INVOICE";
  canonicalState: string;
  eventTimestamp: string;
}

export interface HandlerResult {
  event: NormalizedEvent;              // tier-2 record to store
  snapshot: SnapshotDescriptor | null; // null = does not affect any entity (unclassified)
}

function handleShipment(s: ShipmentLLM): HandlerResult {
  // event_location is filled in later by the geo enrichment stage
  const event: NormalizedEvent = { ...s, event_location: null };
  return {
    event,
    snapshot: {
      entityId: s.entity_id,
      eventType: "SHIPMENT",
      canonicalState: s.canonical_state,
      eventTimestamp: s.event_timestamp,
    },
  };
}

function handleInvoice(i: InvoiceLLM): HandlerResult {
  return {
    event: i,
    snapshot: {
      entityId: i.entity_id,
      eventType: "INVOICE",
      canonicalState: i.canonical_state,
      eventTimestamp: i.event_timestamp,
    },
  };
}

function handleUnclassified(u: UnclassifiedLLM): HandlerResult {
  return { event: u, snapshot: null };
}

export function handle(llm: LLMOutput): HandlerResult {
  switch (llm.event_type) {
    case "SHIPMENT": return handleShipment(llm);
    case "INVOICE": return handleInvoice(llm);
    case "UNCLASSIFIED": return handleUnclassified(llm);
  }
}

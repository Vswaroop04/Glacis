import { staticLocodeProvider } from "../src/geo/provider.js";
import { enrichEvent, assembleRoute } from "../src/geo/enrich.js";
import type { NormalizedEvent } from "../src/schemas.js";

const shipment: NormalizedEvent = {
  event_type: "SHIPMENT", entity_id: "MAEU240498712", canonical_state: "IN_TRANSIT",
  event_timestamp: "2026-04-21T14:47:00Z", carrier: { scac: "MAEU", name: "Maersk" },
  container_no: null, event_locode: "CNSHA", event_location_name: "Shanghai",
  event_location: null, raw_milestone_text: "sailed",
};

const r = enrichEvent(shipment, staticLocodeProvider);
console.log(`enrich CNSHA: status=${r.status} point=${JSON.stringify(r.point)}`);

const unknown = enrichEvent({ ...shipment, event_locode: "ZZZZZ" }, staticLocodeProvider);
console.log(`enrich unknown locode: status=${unknown.status} (want PARTIAL)`);

const invoice: NormalizedEvent = { event_type: "INVOICE", entity_id: "X", canonical_state: "PAID", event_timestamp: "2026-01-01T00:00:00Z", amount_cents: 1, currency: "EUR", raw_transaction_kind: "paid" };
console.log(`enrich invoice: status=${enrichEvent(invoice, staticLocodeProvider).status} (want SKIPPED)`);

const route = assembleRoute([
  { state: "PICKED_UP", point: staticLocodeProvider.resolve("CNSHA"), ts: "2026-04-19T03:15:00Z" },
  { state: "IN_TRANSIT", point: staticLocodeProvider.resolve("SGSIN"), ts: "2026-04-22T00:00:00Z" },
  { state: "DELIVERED", point: staticLocodeProvider.resolve("DEHAM"), ts: "2026-05-10T00:00:00Z" },
]);
console.log(`route: ${route?.origin?.name} -> ${route?.destination?.name} = ${route?.distance_km}km (${route?.distance_mode})`);

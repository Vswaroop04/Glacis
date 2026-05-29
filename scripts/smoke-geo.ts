import { staticLocodeProvider } from "../src/geo/provider.js";
import { geoProvider } from "../src/geo/live.js";
import { enrichEvent, assembleRoute } from "../src/geo/enrich.js";
import type { NormalizedEvent } from "../src/schemas.js";

const shipment = {
  event_type: "SHIPMENT", mode: "SEA", entity_id: "MAEU240498712", canonical_state: "IN_TRANSIT",
  event_timestamp: "2026-04-21T14:47:00Z", carrier: { scac: "MAEU", name: "Maersk" },
  container_no: null, event_locode: "CNSHA", event_location_name: "Shanghai",
  event_location: null, raw_milestone_text: "sailed",
} satisfies NormalizedEvent;

async function main() {
  const r = await enrichEvent(shipment, staticLocodeProvider);
  console.log(`enrich CNSHA (static): status=${r.status} point=${JSON.stringify(r.point)}`);

  // unknown locode but a resolvable port name → live geocoder fallback fills coords
  const live = await enrichEvent({ ...shipment, event_locode: undefined, event_location_name: "Port of Felixstowe" }, geoProvider);
  console.log(`enrich "Port of Felixstowe" (live): status=${live.status} source=${live.point?.source} lat=${live.point?.lat}`);

  const invoice: NormalizedEvent = { event_type: "INVOICE", entity_id: "X", canonical_state: "PAID", event_timestamp: "2026-01-01T00:00:00Z", amount_cents: 1, currency: "EUR", raw_transaction_kind: "paid" };
  console.log(`enrich invoice: status=${(await enrichEvent(invoice, staticLocodeProvider)).status} (want SKIPPED)`);

  const route = assembleRoute([
    { state: "PICKED_UP", point: await staticLocodeProvider.resolve("CNSHA"), ts: "2026-04-19T03:15:00Z" },
    { state: "IN_TRANSIT", point: await staticLocodeProvider.resolve("SGSIN"), ts: "2026-04-22T00:00:00Z" },
    { state: "DELIVERED", point: await staticLocodeProvider.resolve("DEHAM"), ts: "2026-05-10T00:00:00Z" },
  ], "SEA");
  console.log(`route: ${route?.origin?.name} -> ${route?.destination?.name} = ${route?.distance_km}km (${route?.distance_mode}), transit=${route?.transit_days}d eta=${route?.eta}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

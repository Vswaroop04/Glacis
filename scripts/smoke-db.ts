import { migrate, insertRawEvent, insertNormalizedEvent, applySnapshot, getSnapshot, getTimeline, closeDb } from "../src/db.js";
import type { NormalizedEvent } from "../src/schemas.js";

// quick check that migrations, idempotency and the out-of-order guard hold
async function main() {
  await migrate();
  console.log("migrated ok");

  const id1 = "hash-aaa";
  const a = await insertRawEvent({ id: id1, vendor: "maersk", vendorEventId: "EVT-1", payload: { x: 1 } });
  const b = await insertRawEvent({ id: id1, vendor: "maersk", vendorEventId: "EVT-1", payload: { x: 1 } });
  console.log(`idempotency: first insert=${a.inserted} (want true), duplicate=${b.inserted} (want false)`);

  // simulate out-of-order: DELIVERED arrives first, then an older PICKED_UP
  const entity = "MAEU-TEST-001";
  const delivered = {
    event_type: "SHIPMENT", mode: "SEA", entity_id: entity, canonical_state: "DELIVERED",
    event_timestamp: "2026-04-28T02:42:00Z",
    carrier: { scac: "MAEU", name: "Maersk" }, container_no: null,
    event_locode: "IDJKT", event_location_name: "Jakarta",
    event_location: null, raw_milestone_text: "delivered",
  } satisfies NormalizedEvent;
  const pickedUp = {
    event_type: "SHIPMENT", mode: "SEA", entity_id: entity, canonical_state: "PICKED_UP",
    event_timestamp: "2026-04-19T03:15:00Z",
    carrier: { scac: "MAEU", name: "Maersk" }, container_no: null,
    event_locode: "CNSHA", event_location_name: "Shanghai",
    event_location: null, raw_milestone_text: "gate in",
  } satisfies NormalizedEvent;

  await insertNormalizedEvent({ rawEventId: id1, event: delivered, confidence: 0.97, model: "test", enrichmentStatus: "SKIPPED", needsReview: false });
  await applySnapshot({ entityId: entity, eventType: "SHIPMENT", canonicalState: "DELIVERED", eventTimestamp: delivered.event_timestamp, route: null });

  const id2 = "hash-bbb";
  await insertRawEvent({ id: id2, vendor: "maersk", vendorEventId: "EVT-2", payload: { x: 2 } });
  await insertNormalizedEvent({ rawEventId: id2, event: pickedUp, confidence: 0.95, model: "test", enrichmentStatus: "SKIPPED", needsReview: false });
  await applySnapshot({ entityId: entity, eventType: "SHIPMENT", canonicalState: "PICKED_UP", eventTimestamp: pickedUp.event_timestamp, route: null });

  const snap = await getSnapshot(entity);
  console.log(`out-of-order guard: state=${snap.canonical_state} (want DELIVERED), event_count=${snap.event_count} (want 2)`);

  const timeline = await getTimeline(entity);
  console.log(`timeline order: ${timeline.map((t: any) => t.canonical_state).join(" -> ")} (want PICKED_UP -> DELIVERED)`);

  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });

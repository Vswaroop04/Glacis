import type { GeoProvider } from "./provider.js";
import { haversineKm } from "./provider.js";
import type { NormalizedEvent, GeoPoint, Route } from "../schemas.js";

export type EnrichmentStatus = "DONE" | "PARTIAL" | "SKIPPED" | "FAILED";

export interface EnrichResult {
  event: NormalizedEvent;
  status: EnrichmentStatus;
  point: GeoPoint | null; // resolved location of this event, for route assembly
}

/**
 * Best-effort. Resolves a shipment event's location to coordinates. This never
 * throws into the caller — a geocoder failure or an unknown port must not fail
 * or delay normalization, so problems become a FAILED/SKIPPED status instead.
 */
export function enrichEvent(event: NormalizedEvent, provider: GeoProvider): EnrichResult {
  if (event.event_type !== "SHIPMENT") {
    return { event, status: "SKIPPED", point: null };
  }
  try {
    const point = provider.resolve(event.event_locode, event.event_location_name);
    if (!point) return { event, status: "SKIPPED", point: null };
    const enriched: NormalizedEvent = { ...event, event_location: point };
    const status: EnrichmentStatus = point.source === "LOCODE_DB" ? "DONE" : "PARTIAL";
    return { event: enriched, status, point };
  } catch {
    return { event, status: "FAILED", point: null };
  }
}

export interface RouteLeg {
  state: string;
  point: GeoPoint | null;
  ts: string;
}

/**
 * Assemble an entity's route from the full set of its located events. Because it
 * derives from the whole history each time, out-of-order arrival doesn't matter:
 * origin = earliest located leg (preferring PICKED_UP), destination = latest
 * (preferring the delivery legs).
 */
export function assembleRoute(legs: RouteLeg[]): Route | null {
  const located = legs
    .filter((l): l is RouteLeg & { point: GeoPoint } => l.point != null && l.point.lat != null)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  if (located.length === 0) return null;

  const origin = located.find((l) => l.state === "PICKED_UP")?.point ?? located[0].point;
  const deliveryLeg = [...located].reverse().find((l) => l.state === "DELIVERED" || l.state === "OUT_FOR_DELIVERY");
  const destination = deliveryLeg?.point ?? located[located.length - 1].point;

  // a single port (or all events at the same place) is not a route yet
  const samePlace = origin.locode != null && origin.locode === destination.locode;
  const distance = samePlace ? null : haversineKm(origin, destination);
  return {
    origin,
    destination: samePlace ? null : destination,
    distance_km: distance,
    distance_mode: distance != null ? "HAVERSINE" : "NONE",
  };
}

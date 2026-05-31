import type { GeoProvider } from "./provider.js";
import { modeDistanceKm, estimateEta } from "../enrich/distance.js";
import { carrierFromScac } from "../enrich/carriers.js";
import { isValidContainerNumber } from "../enrich/container.js";
import type { NormalizedEvent, GeoPoint, Route, TransportMode } from "../schemas.js";

export type EnrichmentStatus = "DONE" | "PARTIAL" | "SKIPPED" | "FAILED";

export interface EnrichResult {
  event: NormalizedEvent;
  status: EnrichmentStatus;
  point: GeoPoint | null; // resolved location of this event, for route assembly
  containerValid: boolean | null; // ISO 6346 check; null when no container number
}

/**
 * Best-effort. Resolves a shipment event's location to coordinates. This never
 * throws into the caller — a geocoder failure or an unknown port must not fail
 * or delay normalization, so problems become a FAILED/SKIPPED status instead.
 */
export async function enrichEvent(event: NormalizedEvent, provider: GeoProvider): Promise<EnrichResult> {
  if (event.event_type !== "SHIPMENT") {
    return { event, status: "SKIPPED", point: null, containerValid: null };
  }
  try {
    let e = event;
    // backfill carrier name from SCAC when the vendor only sent a code
    if (e.carrier && e.carrier.name == null && e.carrier.scac) {
      const name = carrierFromScac(e.carrier.scac);
      if (name) e = { ...e, carrier: { ...e.carrier, name } };
    }
    // validate the container number's ISO 6346 check digit, if present
    const containerValid = e.container_no ? isValidContainerNumber(e.container_no) : null;

    const point = await provider.resolve(e.event_locode, e.event_location_name);
    const enriched: NormalizedEvent = { ...e, container_valid: containerValid, ...(point ? { event_location: point } : {}) };
    const status: EnrichmentStatus =
      !point || point.source === "UNRESOLVED" ? (point ? "PARTIAL" : "SKIPPED")
      : point.source === "LOCODE_DB" || point.source === "GEOCODER" ? "DONE" : "PARTIAL";
    return { event: enriched, status, point: point ?? null, containerValid };
  } catch {
    return { event, status: "FAILED", point: null, containerValid: null };
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
export function assembleRoute(legs: RouteLeg[], mode: TransportMode = "UNKNOWN"): Route | null {
  const located = legs
    .filter((l): l is RouteLeg & { point: GeoPoint } => l.point != null && l.point.lat != null)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  if (located.length === 0) return null;

  const originLeg = located.find((l) => l.state === "PICKED_UP") ?? located[0];
  const origin = originLeg.point;
  const deliveryLeg = [...located].reverse().find((l) => l.state === "DELIVERED" || l.state === "OUT_FOR_DELIVERY");
  const destination = (deliveryLeg ?? located[located.length - 1]).point;

  // a single port (or all events at the same place) is not a route yet
  const samePlace = origin.locode != null && origin.locode === destination.locode;
  if (samePlace) {
    return { origin, destination: null, distance_km: null, distance_mode: "NONE", transit_days: null, eta: null };
  }

  const { km, label } = modeDistanceKm(mode, origin, destination);
  const { transitDays, eta } = estimateEta(mode, km, originLeg.ts);
  return { origin, destination, distance_km: km, distance_mode: label, transit_days: transitDays, eta };
}

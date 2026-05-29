import type { GeoPoint, TransportMode } from "../schemas.js";
import { haversineKm } from "../geo/provider.js";

// rough average speeds (km/h) per mode, for transit-time + ETA estimation
const SPEED_KMH: Record<TransportMode, number> = {
  SEA: 33, // ~18 knots, container vessel
  AIR: 800, // cruise
  ROAD: 70,
  RAIL: 60,
  PARCEL: 60,
  UNKNOWN: 40,
};

// how the straight-line distance should be labelled per mode. great-circle is
// exact for air; for sea it's an approximation of the real sea-lane distance
// (a sea-route provider replaces it in production); road needs road routing.
const DISTANCE_LABEL: Record<TransportMode, "SEA_ROUTE" | "GREAT_CIRCLE" | "ROAD" | "NONE"> = {
  SEA: "SEA_ROUTE",
  AIR: "GREAT_CIRCLE",
  ROAD: "ROAD",
  RAIL: "ROAD",
  PARCEL: "ROAD",
  UNKNOWN: "GREAT_CIRCLE",
};

export interface DistanceResult {
  km: number | null;
  label: "SEA_ROUTE" | "GREAT_CIRCLE" | "ROAD" | "NONE";
}

export function modeDistanceKm(mode: TransportMode, a: GeoPoint, b: GeoPoint): DistanceResult {
  const km = haversineKm(a, b);
  return { km, label: km != null ? DISTANCE_LABEL[mode] : "NONE" };
}

export interface EtaResult {
  transitDays: number | null;
  eta: string | null;
}

// estimate transit time and arrival from distance + the mode's average speed
export function estimateEta(mode: TransportMode, distanceKm: number | null, departISO: string): EtaResult {
  if (distanceKm == null || distanceKm <= 0) return { transitDays: null, eta: null };
  const hours = distanceKm / SPEED_KMH[mode];
  const transitDays = Math.round((hours / 24) * 10) / 10;
  const eta = new Date(new Date(departISO).getTime() + hours * 3600_000).toISOString();
  return { transitDays, eta };
}

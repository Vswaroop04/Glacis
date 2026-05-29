import { LOCODES } from "./locodes.js";
import type { GeoPoint } from "../schemas.js";

/**
 * Resolving a location to coordinates, kept behind this interface so the static
 * LOCODE table can be composed with a live geocoder (see geo/live.ts) or swapped
 * for a full dataset without touching the enrichment logic. Async because live
 * providers do network I/O.
 */
export interface GeoProvider {
  resolve(locode: string | null | undefined, name?: string | null): Promise<GeoPoint | null>;
}

// tier 1: exact, offline, deterministic for known ports
export const staticLocodeProvider: GeoProvider = {
  async resolve(locode, name) {
    if (!locode) {
      if (!name) return null;
      return { locode: null, name, lat: null, lng: null, country: null, source: "UNRESOLVED" };
    }
    const hit = LOCODES[locode.toUpperCase()];
    if (!hit) {
      return { locode, name: name ?? null, lat: null, lng: null, country: null, source: "UNRESOLVED" };
    }
    return { locode, name: hit.name, lat: hit.lat, lng: hit.lng, country: hit.country, source: "LOCODE_DB" };
  },
};

// great-circle distance in km. Note: ocean freight follows sea lanes, not great
// circles, so in production this is replaced by a sea-route distance provider.
// This is a labelled approximation for the demo.
export function haversineKm(a: GeoPoint, b: GeoPoint): number | null {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

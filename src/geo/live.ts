import { config } from "../config.js";
import { LOCODES } from "./locodes.js";
import { staticLocodeProvider, type GeoProvider } from "./provider.js";

/**
 * Live geocoding fallback for locations the static LOCODE table doesn't cover —
 * a port name with no code, or (for road freight) a street address. Pattern is
 * borrowed from the spotter-labs project: a primary geocoder (Photon) with a
 * fallback (Nominatim), both OSM-based and key-free, plus a small cache.
 *
 * Unlike spotter-labs this is global (no US bounding box), because Glacis is
 * cross-border. It stays best-effort: any failure returns null and the caller
 * keeps the unresolved metadata rather than erroring.
 */

interface RawGeo { lat: number; lng: number; name: string | null; country: string | null; }

const cache = new Map<string, RawGeo | null>();

async function getJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.geocoderTimeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function photon(q: string): Promise<RawGeo | null> {
  const data = (await getJson(`${config.photonUrl}?q=${encodeURIComponent(q)}&limit=1`, {})) as
    | { features?: { geometry?: { coordinates?: [number, number] }; properties?: Record<string, string> }[] }
    | null;
  const f = data?.features?.[0];
  if (!f?.geometry?.coordinates) return null;
  const [lng, lat] = f.geometry.coordinates;
  return { lat, lng, name: f.properties?.name ?? null, country: f.properties?.countrycode?.toUpperCase() ?? null };
}

async function nominatim(q: string): Promise<RawGeo | null> {
  const url = `${config.nominatimUrl}?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1`;
  const data = (await getJson(url, { "User-Agent": "glacis-webhook-ingest/1.0" })) as
    | { lat: string; lon: string; display_name?: string; address?: { country_code?: string } }[]
    | null;
  const r = data?.[0];
  if (!r) return null;
  return {
    lat: Number(r.lat), lng: Number(r.lon),
    name: r.display_name?.split(",")[0] ?? null,
    country: r.address?.country_code?.toUpperCase() ?? null,
  };
}

async function geocode(query: string): Promise<RawGeo | null> {
  const key = query.toLowerCase().trim();
  if (cache.has(key)) return cache.get(key)!;
  const result = (await photon(query)) ?? (await nominatim(query));
  cache.set(key, result);
  return result;
}

// composite: static LOCODE table first, live geocoder only as fallback
export function makeGeoProvider(): GeoProvider {
  return {
    async resolve(locode, name) {
      const known = locode ? LOCODES[locode.toUpperCase()] : undefined;
      if (known) return staticLocodeProvider.resolve(locode, name);

      const query = name ?? locode;
      if (config.geocoderEnabled && query) {
        const live = await geocode(query);
        if (live) {
          return { locode: locode ?? null, name: live.name ?? name ?? null, lat: live.lat, lng: live.lng, country: live.country, source: "GEOCODER" };
        }
      }
      // nothing resolved — keep whatever metadata we have
      return staticLocodeProvider.resolve(locode, name);
    },
  };
}

export const geoProvider = makeGeoProvider();

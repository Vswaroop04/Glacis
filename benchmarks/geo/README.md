# Port Geocoding Benchmark

Run: `npm run bench:geo` · Last run: **2026-05-30**

Methodology adapted from the [spotter-labs](../../../spotter-labs) project (Photon vs Nominatim, latency percentiles + distance-error accuracy). The key difference: spotter-labs is a **US trucking** app and benchmarked **US street addresses**; Glacis is **global ocean freight**, so this benchmarks **port queries worldwide**. Their numbers don't transfer; these do.

8 ports, 3 runs each. Truth coordinates are the port positions from `src/geo/locodes.ts`.

## Summary

| provider | success | avg p50 | p95 | avg err (km) | worst err (km) |
|---|---|---|---|---|---|
| **Photon** | 8/8 | 198ms | 219ms | 1149* | 9171 |
| Nominatim | 7/8 | 26ms | 64ms | 1422* | 9171 |

\* averages are dragged up by the Shanghai outlier (see below). Excluding it, Photon averages ~3.4 km.

## Per-port accuracy (km error)

| port | Photon | Nominatim |
|---|---|---|
| Shanghai | 9171 | 9171 |
| Hamburg | 1.02 | 1.70 |
| Antwerp | 2.62 | **765** |
| Singapore | 2.68 | 5.70 |
| Rotterdam | 3.97 | 3.97 |
| Los Angeles | 0.88 | 0.88 |
| Jebel Ali | 4.17 | 3.94 |
| Busan | 8.35 | **FAIL** |

## What this tells us

1. **Freeform port-name geocoding is unreliable.** Both providers placed "Port of Shanghai" ~9,000 km off, Nominatim missed Antwerp by 765 km, and failed Busan entirely. A port name is not a safe primary source of coordinates.
2. **So the architecture is right: the static UN/LOCODE table is primary; the geocoder is a best-effort fallback only.** Known ports resolve exactly and offline; the geocoder only runs when a webhook gives a name with no code, and its result is labelled `source: GEOCODER` so it can be trusted accordingly.
3. **Between the two, Photon is the better fallback** — 8/8 success, lower error on most ports, and consistent (p50 198ms / p95 219ms). Nominatim is much faster (~26ms) but less reliable on ports. So the order is **Photon primary, Nominatim fallback** — matching the implementation in `src/geo/live.ts`.

Production note: a dedicated maritime gazetteer (full UN/LOCODE dataset, World Port Index) would replace freeform geocoding for ports entirely; the geocoder fallback is mainly valuable for road/last-mile addresses.

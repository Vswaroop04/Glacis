import "dotenv/config";

/**
 * Port geocoding benchmark.
 *
 * Methodology adapted from the spotter-labs project (Photon vs Nominatim,
 * latency percentiles + distance-error accuracy). The difference: spotter-labs
 * is a US trucking app and benchmarked US street addresses; Glacis is global
 * ocean freight, so this benchmarks PORT queries worldwide. The numbers here
 * are meaningful for port resolution; the spotter-labs numbers are not.
 */

const PHOTON_URL = process.env.PHOTON_URL ?? "https://photon.komoot.io/api";
const NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org/search";
const RUNS = Number(process.env.GEO_BENCH_RUNS ?? 3);

interface Port { query: string; lat: number; lng: number }
const PORTS: Port[] = [
  { query: "Port of Shanghai", lat: 31.2304, lng: 121.4737 },
  { query: "Port of Hamburg", lat: 53.5511, lng: 9.9937 },
  { query: "Port of Antwerp", lat: 51.2603, lng: 4.3858 },
  { query: "Port of Singapore", lat: 1.2655, lng: 103.824 },
  { query: "Port of Rotterdam", lat: 51.9244, lng: 4.4777 },
  { query: "Port of Los Angeles", lat: 33.7406, lng: -118.2706 },
  { query: "Jebel Ali Port", lat: 25.0159, lng: 55.0606 },
  { query: "Port of Busan", lat: 35.1796, lng: 129.0756 },
];

function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function photon(q: string): Promise<[number, number] | null> {
  const res = await fetch(`${PHOTON_URL}?q=${encodeURIComponent(q)}&limit=1`);
  if (!res.ok) return null;
  const data = (await res.json()) as { features?: { geometry?: { coordinates?: [number, number] } }[] };
  const c = data.features?.[0]?.geometry?.coordinates;
  return c ? [c[1], c[0]] : null;
}

async function nominatim(q: string): Promise<[number, number] | null> {
  const res = await fetch(`${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=json&limit=1`, {
    headers: { "User-Agent": "glacis-geo-benchmark/1.0" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { lat: string; lon: string }[];
  return data[0] ? [Number(data[0].lat), Number(data[0].lon)] : null;
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)] ?? 0;
}

interface Row { provider: string; query: string; p50: number; p95: number; errKm: number; ok: boolean }

async function benchProvider(
  name: string,
  fn: (q: string) => Promise<[number, number] | null>,
  politeMs: number,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const port of PORTS) {
    const lat: number[] = [];
    let coords: [number, number] | null = null;
    for (let i = 0; i < RUNS; i++) {
      const t0 = Date.now();
      try { coords = (await fn(port.query)) ?? coords; } catch { /* best effort */ }
      lat.push(Date.now() - t0);
      if (politeMs) await sleep(politeMs);
    }
    const sorted = [...lat].sort((a, b) => a - b);
    rows.push({
      provider: name,
      query: port.query,
      p50: Math.round(pct(sorted, 0.5)),
      p95: Math.round(pct(sorted, 0.95)),
      errKm: coords ? Math.round(haversine(coords[0], coords[1], port.lat, port.lng) * 100) / 100 : NaN,
      ok: coords != null,
    });
  }
  return rows;
}

function summarize(name: string, rows: Row[]) {
  const lat = rows.map((r) => r.p50).sort((a, b) => a - b);
  const errs = rows.filter((r) => r.ok).map((r) => r.errKm);
  const avgErr = errs.reduce((s, v) => s + v, 0) / (errs.length || 1);
  return {
    provider: name,
    success: `${rows.filter((r) => r.ok).length}/${rows.length}`,
    avg_p50_ms: Math.round(lat.reduce((s, v) => s + v, 0) / lat.length),
    p95_ms: Math.round(pct(lat, 0.95)),
    avg_err_km: Math.round(avgErr * 100) / 100,
    worst_err_km: Math.round(Math.max(...errs) * 100) / 100,
  };
}

function table(rows: Record<string, string | number>[]) {
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cells: string[]) => "| " + cells.map((s, i) => s.padEnd(w[i])).join(" | ") + " |";
  console.log(line(cols));
  console.log("| " + w.map((x) => "-".repeat(x)).join(" | ") + " |");
  for (const r of rows) console.log(line(cols.map((c) => String(r[c]))));
}

async function main() {
  console.log(`\nGlacis - Port Geocoding Benchmark (Photon vs Nominatim)`);
  console.log(`${PORTS.length} ports, ${RUNS} runs each\n`);

  // Nominatim asks for <=1 req/sec; space its calls. Photon is more lenient.
  const photonRows = await benchProvider("Photon", photon, 0);
  const nominatimRows = await benchProvider("Nominatim", nominatim, 1100);

  console.log("Accuracy + latency by port (Photon):");
  table(photonRows.map((r) => ({ query: r.query, p50_ms: r.p50, p95_ms: r.p95, err_km: r.ok ? r.errKm : "FAIL" })));
  console.log("\nAccuracy + latency by port (Nominatim):");
  table(nominatimRows.map((r) => ({ query: r.query, p50_ms: r.p50, p95_ms: r.p95, err_km: r.ok ? r.errKm : "FAIL" })));

  console.log("\nSummary:");
  table([summarize("Photon", photonRows), summarize("Nominatim", nominatimRows)]);
}

main().catch((e) => { console.error(e); process.exit(1); });

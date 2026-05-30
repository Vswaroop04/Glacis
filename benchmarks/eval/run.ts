import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { normalize } from "../../src/normalize.js";
import { config } from "../../src/config.js";

/**
 * Normalization correctness eval.
 *
 * The model benchmark answers "which model is fastest/cheapest". This answers the
 * more important question: "is the normalization actually correct?" Each fixture
 * is a raw vendor payload with a hand-written expected output. We run the real
 * model and score classification, state mapping, entity extraction, mode, and
 * the field-level extractions (timestamp, amount, currency) separately, because
 * a system can classify perfectly and still get the amount wrong.
 *
 *   npm run eval
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");
const expectedDir = join(here, "expected");

type Expected = Record<string, unknown>;

function sameTimestamp(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

interface Metric { pass: number; total: number }
const metrics: Record<string, Metric> = {
  classification: { pass: 0, total: 0 },
  state: { pass: 0, total: 0 },
  entity: { pass: 0, total: 0 },
  mode: { pass: 0, total: 0 },
  exception: { pass: 0, total: 0 },
  timestamp: { pass: 0, total: 0 },
  amount: { pass: 0, total: 0 },
  currency: { pass: 0, total: 0 },
};

function score(metric: string, expected: unknown, got: unknown, eq = (a: unknown, b: unknown) => a === b): "✓" | "✗" | "·" {
  if (expected === undefined) return "·"; // not asserted for this fixture
  metrics[metric].total++;
  const ok = eq(expected, got);
  if (ok) metrics[metric].pass++;
  return ok ? "✓" : "✗";
}

function pad(s: string, n: number) { return s.padEnd(n); }

async function main() {
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
  console.log(`\nGlacis - Normalization Correctness Eval`);
  console.log(`${files.length} fixtures · model ${config.primaryModel}\n`);

  const header = ["fixture", "class", "state", "entity", "mode", "exc", "ts", "amount", "curr"];
  console.log(header.map((h, i) => pad(h, i === 0 ? 24 : 7)).join(""));
  console.log("-".repeat(24 + 7 * 8));

  for (const file of files) {
    const name = basename(file, ".json");
    const raw = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
    const exp = JSON.parse(readFileSync(join(expectedDir, file), "utf8")) as Expected;

    let got: Record<string, unknown> = {};
    try {
      const r = await normalize(raw, config.primaryModel);
      got = r.event as unknown as Record<string, unknown>;
    } catch (e) {
      console.log(pad(name, 24) + "ERROR " + (e as Error).message);
      metrics.classification.total++;
      continue;
    }

    const row = [
      score("classification", exp.event_type, got.event_type),
      score("state", exp.canonical_state, got.canonical_state),
      score("entity", exp.entity_id, got.entity_id),
      score("mode", exp.mode, got.mode),
      score("exception", exp.is_exception, got.is_exception),
      score("timestamp", exp.event_timestamp, got.event_timestamp, sameTimestamp),
      score("amount", exp.amount_cents, got.amount_cents),
      score("currency", exp.currency, got.currency),
    ];
    console.log(pad(name, 24) + row.map((c) => pad(c, 7)).join(""));
  }

  console.log("\nAccuracy by metric:");
  const order = ["classification", "state", "entity", "mode", "exception", "timestamp", "amount", "currency"];
  for (const m of order) {
    const { pass, total } = metrics[m];
    if (total === 0) continue;
    const pct = ((pass / total) * 100).toFixed(0);
    console.log(`  ${pad(m, 16)} ${pct}%  (${pass}/${total})`);
  }

  const overall = order.reduce((acc, m) => ({ pass: acc.pass + metrics[m].pass, total: acc.total + metrics[m].total }), { pass: 0, total: 0 });
  console.log(`\n  ${pad("overall", 16)} ${((overall.pass / overall.total) * 100).toFixed(1)}%  (${overall.pass}/${overall.total})\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

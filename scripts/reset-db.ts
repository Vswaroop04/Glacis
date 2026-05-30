import { pool, closeDb } from "../src/db.js";

// wipe all tables for a clean demo run
async function main() {
  await pool.query("TRUNCATE raw_events, normalized_events, entity_snapshots, dead_letters, review_queue RESTART IDENTITY CASCADE");
  console.log("tables truncated");
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });

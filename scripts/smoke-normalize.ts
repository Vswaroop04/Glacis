import { normalize } from "../src/normalize.js";
import { handle } from "../src/handlers/index.js";
import { config } from "../src/config.js";

// run the real LLM on a couple of sample payloads and show the handled result
const samples: { name: string; body: unknown }[] = [
  {
    name: "maersk in transit",
    body: {
      carrier_scac: "MAEU",
      transport_doc: { type: "MBL", number: "MAEU240498712" },
      milestone: "Loaded onboard and sailed",
      milestone_at: "2026-04-21T22:47:00+08:00",
      port: { code: "CNSHA", name: "Shanghai" },
    },
  },
  {
    name: "gfp invoice paid (european decimal)",
    body: {
      doc_ref: "GFP-INV-2026-Q2-08821",
      transaction: { kind: "settled in full", settled_at: "2026-04-22 18:47:11+02:00", amount: "EUR 24.350,75" },
    },
  },
  {
    name: "marine advisory (unclassified)",
    body: { issuer: "marine-traffic-advisory", subject: "congestion at Antwerp", severity: "AMBER" },
  },
];

async function main() {
  for (const s of samples) {
    const r = await normalize(s.body, config.primaryModel);
    const handled = handle(r.event);
    console.log(`\n${s.name}`);
    const mode = r.event.event_type === "SHIPMENT" ? ` mode=${r.event.mode}` : "";
    console.log(`  type=${r.event.event_type}${mode} confidence=${r.confidence} model=${r.model}`);
    if (handled.snapshot) {
      console.log(`  entity=${handled.snapshot.entityId} state=${handled.snapshot.canonicalState} ts=${handled.snapshot.eventTimestamp}`);
    } else {
      console.log(`  no entity (unclassified)`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

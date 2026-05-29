import { evaluateTransition } from "../src/state-machine.js";

const cases = [
  { d: "first event", a: { eventType:"SHIPMENT" as const, currentState:null, currentTimestamp:null, incomingState:"PICKED_UP", incomingTimestamp:"2026-04-19T03:15:00Z" }, want:"INITIAL" },
  { d: "normal advance", a: { eventType:"SHIPMENT" as const, currentState:"PICKED_UP", currentTimestamp:"2026-04-19T03:15:00Z", incomingState:"IN_TRANSIT", incomingTimestamp:"2026-04-21T14:47:00Z" }, want:"ADVANCE" },
  { d: "late picked_up after delivered", a: { eventType:"SHIPMENT" as const, currentState:"DELIVERED", currentTimestamp:"2026-04-28T02:42:00Z", incomingState:"PICKED_UP", incomingTimestamp:"2026-04-19T03:15:00Z" }, want:"OUT_OF_ORDER" },
  { d: "true regression newer ts", a: { eventType:"SHIPMENT" as const, currentState:"DELIVERED", currentTimestamp:"2026-04-28T02:42:00Z", incomingState:"PICKED_UP", incomingTimestamp:"2026-04-29T00:00:00Z" }, want:"ANOMALY" },
  { d: "duplicate", a: { eventType:"SHIPMENT" as const, currentState:"IN_TRANSIT", currentTimestamp:"2026-04-21T14:47:00Z", incomingState:"IN_TRANSIT", incomingTimestamp:"2026-04-21T14:47:00Z" }, want:"DUPLICATE" },
  { d: "invoice issued->paid", a: { eventType:"INVOICE" as const, currentState:"ISSUED", currentTimestamp:"2026-04-15T09:00:00Z", incomingState:"PAID", incomingTimestamp:"2026-04-22T16:47:11Z" }, want:"ADVANCE" },
  { d: "invoice paid->issued illegal", a: { eventType:"INVOICE" as const, currentState:"PAID", currentTimestamp:"2026-04-22T16:47:11Z", incomingState:"ISSUED", incomingTimestamp:"2026-04-23T00:00:00Z" }, want:"ANOMALY" },
  { d: "invoice paid->refunded", a: { eventType:"INVOICE" as const, currentState:"PAID", currentTimestamp:"2026-04-22T16:47:11Z", incomingState:"REFUNDED", incomingTimestamp:"2026-04-25T00:00:00Z" }, want:"ADVANCE" },
];

let pass = 0;
for (const c of cases) {
  const v = evaluateTransition(c.a);
  const ok = v.kind === c.want;
  if (ok) pass++;
  console.log(`${ok ? "ok  " : "FAIL"} ${c.d}: got ${v.kind}${"note" in v ? " ("+v.note+")" : ""}`);
}
console.log(`\n${pass}/${cases.length} passed`);

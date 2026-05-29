import { SHIPMENT_STATES, INVOICE_STATES } from "./schemas.js";

/**
 * Lifecycle rules per entity type.
 *
 * Two independent things protect entity state:
 *   1. The DB timestamp guard (applySnapshot) decides what the *head* state is —
 *      only a newer event_timestamp can advance it. That handles out-of-order.
 *   2. This engine decides whether a transition is *legal* in lifecycle terms and
 *      flags anomalies (regressions, skips, illegal moves) for review. It never
 *      silently drops an event — everything is stored; anomalies are just marked.
 */

type ShipmentState = (typeof SHIPMENT_STATES)[number];
type InvoiceState = (typeof INVOICE_STATES)[number];

// forward order; index = how far along the lifecycle a state is
const SHIPMENT_ORDER: ShipmentState[] = ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"];

// allowed moves. ISSUED can go to PAID or VOIDED; PAID can be REFUNDED.
const INVOICE_TRANSITIONS: Record<InvoiceState, InvoiceState[]> = {
  ISSUED: ["PAID", "VOIDED"],
  PAID: ["REFUNDED"],
  VOIDED: [],
  REFUNDED: [],
};

export type TransitionVerdict =
  | { kind: "INITIAL" }                          // first event for this entity
  | { kind: "ADVANCE" }                          // legal forward move
  | { kind: "DUPLICATE" }                        // same state again
  | { kind: "OUT_OF_ORDER"; note: string }       // older event arrived after a newer one
  | { kind: "ANOMALY"; note: string };           // illegal/regressive move — stored but flagged

function rank(state: ShipmentState): number {
  return SHIPMENT_ORDER.indexOf(state);
}

/**
 * Decide the verdict for an incoming event given what we already know about the
 * entity (its current head state and the timestamp of the latest event seen).
 */
export function evaluateTransition(args: {
  eventType: "SHIPMENT" | "INVOICE";
  currentState: string | null;        // null if this is the first event
  currentTimestamp: string | null;
  incomingState: string;
  incomingTimestamp: string;
}): TransitionVerdict {
  const { eventType, currentState, currentTimestamp, incomingState, incomingTimestamp } = args;

  if (currentState === null) return { kind: "INITIAL" };

  const isOlder = currentTimestamp !== null && new Date(incomingTimestamp) < new Date(currentTimestamp);

  if (eventType === "SHIPMENT") {
    const cur = currentState as ShipmentState;
    const inc = incomingState as ShipmentState;
    if (inc === cur) return { kind: "DUPLICATE" };

    // a real lifecycle move backwards is an anomaly regardless of timing
    if (rank(inc) < rank(cur)) {
      if (isOlder) {
        return { kind: "OUT_OF_ORDER", note: `late ${inc} arrived after ${cur}; head state preserved` };
      }
      return { kind: "ANOMALY", note: `regression ${cur} -> ${inc} with a newer timestamp` };
    }
    return { kind: "ADVANCE" };
  }

  // invoice
  const cur = currentState as InvoiceState;
  const inc = incomingState as InvoiceState;
  if (inc === cur) return { kind: "DUPLICATE" };
  if (isOlder) return { kind: "OUT_OF_ORDER", note: `late ${inc} arrived after ${cur}; head state preserved` };
  if (!INVOICE_TRANSITIONS[cur].includes(inc)) {
    return { kind: "ANOMALY", note: `illegal invoice move ${cur} -> ${inc}` };
  }
  return { kind: "ADVANCE" };
}

// an event needs human review if its transition looked wrong
export function isAnomalous(v: TransitionVerdict): boolean {
  return v.kind === "ANOMALY";
}

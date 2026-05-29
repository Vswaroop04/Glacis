import { createHash } from "node:crypto";

/**
 * Derive the idempotency identity of an incoming webhook.
 *
 * id  : SHA-256 of the canonical raw body (stable regardless of key order), or an
 *       explicit Idempotency-Key header if the vendor sent one. This is the only
 *       dedup key — identical retries collapse to the same row + job, while
 *       different events of one entity (invoice ISSUED vs PAID) hash differently.
 * vendor / vendorEventId : a cheap, deterministic guess from common field names,
 *       kept as queryable metadata only (not used for dedup).
 */
export interface Identity {
  id: string;
  vendor: string | null;
  vendorEventId: string | null;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export function hashBody(body: unknown): string {
  return createHash("sha256").update(canonical(body)).digest("hex");
}

const VENDOR_KEYS = ["vendor", "source", "issuer", "carrier_scac", "carrier", "system"];
const EVENT_ID_KEYS = ["event_msg_id", "event_id", "advisory_id", "doc_ref", "message_id", "document_id", "id"];

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export function deriveIdentity(body: unknown, idempotencyKey?: string): Identity {
  const id = idempotencyKey && idempotencyKey.length > 0 ? idempotencyKey : hashBody(body);
  let vendor: string | null = null;
  let vendorEventId: string | null = null;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    vendor = firstString(obj, VENDOR_KEYS);
    vendorEventId = firstString(obj, EVENT_ID_KEYS);
  }
  return { id, vendor, vendorEventId };
}

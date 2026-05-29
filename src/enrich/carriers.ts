// Carrier code registries. Vendors often send only a code (SCAC for ocean/road,
// IATA airline prefix for air) and leave the name blank — we backfill it
// deterministically rather than asking the LLM to remember every carrier.

const SCAC: Record<string, string> = {
  MAEU: "Maersk",
  MSCU: "Mediterranean Shipping Company",
  ONEY: "Ocean Network Express",
  HLCU: "Hapag-Lloyd",
  CMDU: "CMA CGM",
  COSU: "COSCO Shipping",
  EGLV: "Evergreen Line",
  OOLU: "OOCL",
  YMLU: "Yang Ming",
  HDMU: "HMM",
  ZIMU: "ZIM",
  APLU: "APL",
  NYKS: "NYK Line",
  DHLX: "DHL Express",
  FEDX: "FedEx",
  UPSN: "UPS",
};

// IATA airline prefixes (first 3 digits of an AWB) → carrier
const IATA_AIRLINE: Record<string, string> = {
  "020": "Lufthansa Cargo",
  "180": "Korean Air Cargo",
  "618": "Singapore Airlines Cargo",
  "176": "Emirates SkyCargo",
  "001": "American Airlines Cargo",
  "057": "Air France Cargo",
};

export function carrierFromScac(scac: string | null | undefined): string | null {
  if (!scac) return null;
  return SCAC[scac.toUpperCase()] ?? null;
}

export function carrierFromAwbPrefix(prefix: string | null | undefined): string | null {
  if (!prefix) return null;
  return IATA_AIRLINE[prefix] ?? null;
}

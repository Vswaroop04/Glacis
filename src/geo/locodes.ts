// A small static UN/LOCODE table for the demo. In production this is replaced by
// a full LOCODE dataset or a live geocoding provider (see GeoProvider).
// lat/lng are the port's approximate position; country is ISO 3166-1 alpha-2.

export interface LocodeEntry {
  name: string;
  lat: number;
  lng: number;
  country: string;
}

export const LOCODES: Record<string, LocodeEntry> = {
  CNSHA: { name: "Shanghai", lat: 31.2304, lng: 121.4737, country: "CN" },
  HKHKG: { name: "Hong Kong", lat: 22.3193, lng: 114.1694, country: "HK" },
  SGSIN: { name: "Singapore", lat: 1.2655, lng: 103.824, country: "SG" },
  IDJKT: { name: "Jakarta", lat: -6.1045, lng: 106.8865, country: "ID" },
  DEHAM: { name: "Hamburg", lat: 53.5511, lng: 9.9937, country: "DE" },
  NLRTM: { name: "Rotterdam", lat: 51.9244, lng: 4.4777, country: "NL" },
  BEANR: { name: "Antwerp", lat: 51.2603, lng: 4.3858, country: "BE" },
  GBFXT: { name: "Felixstowe", lat: 51.9617, lng: 1.3513, country: "GB" },
  USLAX: { name: "Los Angeles", lat: 33.7406, lng: -118.2706, country: "US" },
  USNYC: { name: "New York", lat: 40.7128, lng: -74.006, country: "US" },
  AEJEA: { name: "Jebel Ali", lat: 25.0159, lng: 55.0606, country: "AE" },
  INNSA: { name: "Nhava Sheva", lat: 18.9498, lng: 72.9525, country: "IN" },
  KRPUS: { name: "Busan", lat: 35.1796, lng: 129.0756, country: "KR" },
  JPTYO: { name: "Tokyo", lat: 35.6762, lng: 139.6503, country: "JP" },
  MYPKG: { name: "Port Klang", lat: 3.0008, lng: 101.392, country: "MY" },
};

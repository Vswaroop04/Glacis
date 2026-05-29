// ISO 6346 container number validation.
// Format: 4 letters (owner code + category) + 6 digits + 1 check digit.
// The check digit is derived from the first 10 characters, so a typo or a
// corrupted number is caught deterministically — a useful data-integrity flag.

const VALUES: Record<string, number> = (() => {
  // letters map to 10..38, skipping multiples of 11 (10,11,12,...) per the spec
  const map: Record<string, number> = {};
  let v = 10;
  for (let i = 0; i < 26; i++) {
    if (v % 11 === 0) v++;
    map[String.fromCharCode(65 + i)] = v;
    v++;
  }
  return map;
})();

export function isValidContainerNumber(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = raw.toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z]{4}\d{7}$/.test(s)) return false;

  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = s[i];
    const val = /[A-Z]/.test(ch) ? VALUES[ch] : Number(ch);
    sum += val * 2 ** i;
  }
  let check = sum % 11;
  if (check === 10) check = 0;
  return check === Number(s[10]);
}

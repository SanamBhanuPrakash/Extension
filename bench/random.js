/**
 * A seeded generator, so every number in the report can be reproduced.
 *
 * mulberry32 — small, fast, and good enough for corpus generation. The point
 * is not cryptographic quality, it is that `node bench/run.js` prints the same
 * figures on your machine as it does in the README.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed = 20260925) {
  const r = mulberry32(seed);
  return {
    float: r,
    int: (n) => Math.floor(r() * n),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    digits: (n) => Array.from({ length: n }, () => Math.floor(r() * 10)).join(''),
    hex: (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join(''),
    base32: (n) => Array.from({ length: n }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[Math.floor(r() * 32)]).join(''),
    alnum: (n) => Array.from({ length: n }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(r() * 62)]).join(''),
    lower: (n) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(r() * 26)]).join(''),
    upper: (n) => Array.from({ length: n }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(r() * 26)]).join(''),
  };
}

/** Appends a Luhn check digit so the result validates. */
export function withLuhn(prefixDigits) {
  const s = prefixDigits;
  let sum = 0;
  let dbl = true;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return s + String((10 - (sum % 10)) % 10);
}

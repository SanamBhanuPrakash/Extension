/**
 * Checksum and structure validators.
 *
 * These are the whole point of Chhanni. A regex that matches "16 digits"
 * fires on order numbers, tracking IDs and timestamps. A regex that matches
 * 16 digits *and passes Luhn* fires on payment cards. The difference between
 * those two products is whether anyone keeps the extension installed.
 *
 * Every function here is pure, synchronous and dependency-free so the same
 * code runs in the extension, in Node and in CI.
 */

/** Luhn mod-10. Payment cards, IMEI. */
export function luhn(digits) {
  const s = String(digits).replace(/[^0-9]/g, '');
  if (s.length < 12 || s.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Verhoeff tables. Used by UIDAI for the Aadhaar check digit.
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/**
 * Verhoeff check. An Aadhaar number is 12 digits whose last digit is a
 * Verhoeff check digit, and which never begins with 0 or 1. Both conditions
 * matter: without them, every 12-digit invoice total is a false positive.
 */
export function verhoeff(digits) {
  const s = String(digits).replace(/[^0-9]/g, '');
  if (!s) return false;
  let c = 0;
  for (let i = 0; i < s.length; i++) {
    const d = s.charCodeAt(s.length - 1 - i) - 48;
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][d]];
  }
  return c === 0;
}

/** Aadhaar = 12 digits, first digit 2-9, valid Verhoeff check digit. */
export function aadhaar(value) {
  const s = String(value).replace(/[^0-9]/g, '');
  if (s.length !== 12) return false;
  if (s[0] === '0' || s[0] === '1') return false;
  if (/^(\d)\1{11}$/.test(s)) return false; // 999999999999 and friends
  return verhoeff(s);
}

/**
 * IBAN mod-97. Move the first four characters to the end, map letters to
 * numbers (A=10), and the whole thing mod 97 must equal 1.
 */
export function iban(value) {
  const s = String(value).replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const part = code >= 65 ? String(code - 55) : ch;
    for (const digit of part) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

const CRC32_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(str) {
  let c = -1;
  for (let i = 0; i < str.length; i++) {
    c = (c >>> 8) ^ CRC32_TABLE[(c ^ str.charCodeAt(i)) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function toBase62(n, width) {
  let out = '';
  let v = n;
  while (v > 0) {
    out = BASE62[v % 62] + out;
    v = Math.floor(v / 62);
  }
  return out.padStart(width, '0');
}

/**
 * GitHub's v2 token format carries its own checksum: after the `ghp_`-style
 * prefix come 30 random base62 characters followed by 6 characters holding
 * the CRC32 of those 30, base62-encoded.
 *
 * Returns 'valid' | 'invalid' | 'unknown'. We deliberately do not treat
 * 'invalid' as "not a secret" — GitHub can change the scheme and we would
 * rather keep a true positive than defend a clever checksum. It only moves
 * confidence.
 */
export function githubTokenChecksum(token) {
  const m = /^gh[pousr]_([A-Za-z0-9]{36})$/.exec(token);
  if (!m) return 'unknown';
  const body = m[1].slice(0, 30);
  const given = m[1].slice(30);
  return toBase62(crc32(body), 6) === given ? 'valid' : 'invalid';
}

/**
 * Indian PAN: AAAAA9999A. The fourth character encodes holder type and the
 * fifth is the first letter of the surname (or entity name). There is no
 * public check-digit algorithm, so this is structural validation only and
 * findings are reported at lower confidence than checksum-backed ones.
 */
const PAN_HOLDER_TYPES = new Set(['A', 'B', 'C', 'F', 'G', 'H', 'J', 'L', 'P', 'T', 'K', 'E']);
export function pan(value) {
  const s = String(value).toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s)) return false;
  return PAN_HOLDER_TYPES.has(s[3]);
}

/**
 * US SSN. The published invalid ranges do most of the false-positive work:
 * area 000, 666 and 900-999 are never issued, nor is group 00 or serial 0000.
 */
export function ssn(value) {
  const s = String(value).replace(/[^0-9]/g, '');
  if (s.length !== 9) return false;
  const area = Number(s.slice(0, 3));
  const group = Number(s.slice(3, 5));
  const serial = Number(s.slice(5));
  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === 0 || serial === 0) return false;
  return true;
}

/** Shannon entropy in bits per character. */
export function entropy(str) {
  if (!str) return 0;
  const freq = new Map();
  for (const ch of str) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / str.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * A string of repeated or sequential characters has respectable entropy per
 * the formula but is obviously not a key. Cheap structural guard.
 */
export function looksRandom(str, minEntropy = 3.6) {
  if (str.length < 16) return false;
  if (/^(.)\1+$/.test(str)) return false;
  const distinct = new Set(str).size;
  if (distinct < Math.min(10, str.length / 3)) return false;
  const hasDigit = /[0-9]/.test(str);
  const hasAlpha = /[A-Za-z]/.test(str);
  if (!hasDigit || !hasAlpha) return false;
  return entropy(str) >= minEntropy;
}

/** Decodes a JWT header without verifying it. Returns null if not a JWT. */
export function jwtHeader(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  try {
    const json = atob(parts[0].replace(/-/g, '+').replace(/_/g, '/'));
    const header = JSON.parse(json);
    if (typeof header !== 'object' || header === null) return null;
    if (!('alg' in header)) return null;
    return header;
  } catch {
    return null;
  }
}

/** Decodes a JWT payload without verifying it. Returns null on failure. */
export function jwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json);
    return typeof payload === 'object' && payload !== null ? payload : null;
  } catch {
    return null;
  }
}

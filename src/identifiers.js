/**
 * National and financial identifier validators.
 *
 * Every function here is a check-digit algorithm published by the authority
 * that issues the identifier. They exist because the alternative — matching
 * "11 digits" or "15 alphanumerics" — is what makes secret scanners unusable.
 * Published precision for regex-and-entropy tools sits between 25% and 75%;
 * a mod-11 check takes a rule from "fires on every invoice number" to
 * "effectively never wrong".
 *
 * Imports nothing, by design. This is the layer a sceptic should be able to
 * read and verify against the spec without following a single reference.
 */

const digits = (v) => String(v).replace(/[^0-9]/g, '');
const allSame = (s) => /^(.)\1+$/.test(s);

// ---------------------------------------------------------------- India

const GST_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * GSTIN: 15 characters — 2-digit state code, 10-character PAN, entity number,
 * a literal 'Z', and a check character computed mod 36 (the same Luhn shape,
 * over a 36-symbol alphabet).
 */
export function gstin(value) {
  const s = String(value).toUpperCase().trim();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(s)) return false;
  const state = Number(s.slice(0, 2));
  // State codes run 01–38, plus 97 (other territory) and 99 (centre).
  if (!((state >= 1 && state <= 38) || state === 97 || state === 99)) return false;

  let factor = 2;
  let sum = 0;
  // Indices 0..13 — every character except the check character itself.
  // An earlier version stopped at 12, which produced a self-consistent but
  // wrong algorithm: the corpus generator used this same function to build
  // samples, so the benchmark scored 100% while rejecting every real GSTIN.
  // Only a known-good published example exposed it.
  for (let i = 13; i >= 0; i--) {
    const code = GST_ALPHABET.indexOf(s[i]);
    if (code < 0) return false;
    let d = factor * code;
    factor = factor === 2 ? 1 : 2;
    d = Math.floor(d / 36) + (d % 36);
    sum += d;
  }
  return GST_ALPHABET[(36 - (sum % 36)) % 36] === s[14];
}

/** IFSC: 4-letter bank code, a reserved '0', then a 6-character branch code. */
export function ifsc(value) {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(value).toUpperCase().trim());
}

/**
 * UPI virtual payment address. Structurally an email-alike, so it is only
 * accepted when the handle is one a real PSP actually issues — otherwise
 * every email address in a prompt becomes a payment identifier.
 */
const UPI_HANDLES = new Set([
  'okhdfcbank', 'okicici', 'oksbi', 'okaxis', 'paytm', 'ybl', 'ibl', 'axl',
  'upi', 'apl', 'yapl', 'abfspay', 'freecharge', 'airtel', 'jupieraxis',
  'fam', 'naviaxis', 'superyes', 'slc', 'timecosmos', 'waicici', 'waaxis',
  'wahdfcbank', 'wasbi', 'idfcbank', 'kotak', 'indus', 'rbl', 'federal',
]);
export function upiVpa(value) {
  const m = /^([a-zA-Z0-9.\-_]{2,256})@([a-zA-Z]{2,64})$/.exec(String(value).trim());
  return m ? UPI_HANDLES.has(m[2].toLowerCase()) : false;
}

/** Indian passport: one letter, 7 digits. The first letter excludes Q, X, Z. */
export function indianPassport(value) {
  return /^[A-PR-WY][0-9]{7}$/.test(String(value).toUpperCase().trim());
}

/** EPIC (voter ID): 3 letters then 7 digits. */
export function voterId(value) {
  return /^[A-Z]{3}[0-9]{7}$/.test(String(value).toUpperCase().trim());
}

/**
 * Indian driving licence: 2-letter state, 2-digit RTO, 4-digit year, 7 digits.
 * The year is checked against a plausible range, which removes most of the
 * random-alphanumeric false positives.
 */
export function indianDrivingLicence(value) {
  const s = String(value).toUpperCase().replace(/[\s-]/g, '');
  const m = /^([A-Z]{2})([0-9]{2})([0-9]{4})([0-9]{7})$/.exec(s);
  if (!m) return false;
  const year = Number(m[3]);
  return year >= 1950 && year <= new Date().getFullYear();
}

// --------------------------------------------------------------- Americas

/** Brazilian CPF: two mod-11 check digits over 9 base digits. */
export function cpf(value) {
  const s = digits(value);
  if (s.length !== 11 || allSame(s)) return false;
  for (const [len, start] of [[9, 10], [10, 11]]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(s[i]) * (start - i);
    let check = (sum * 10) % 11;
    if (check === 10 || check === 11) check = 0;
    if (check !== Number(s[len])) return false;
  }
  return true;
}

/** Brazilian CNPJ: two mod-11 check digits with cycling weights. */
export function cnpj(value) {
  const s = digits(value);
  if (s.length !== 14 || allSame(s)) return false;
  const run = (len) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
                               : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(s[i]) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return run(12) === Number(s[12]) && run(13) === Number(s[13]);
}

/** Canadian SIN: 9 digits, Luhn. */
export function sin(value) {
  const s = digits(value);
  if (s.length !== 9 || s[0] === '0' || s[0] === '8') return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------- Europe, APAC

/**
 * UK National Insurance number. No check digit exists, so validity rests
 * entirely on the published prefix exclusions — which is still enough to make
 * the rule usable.
 */
export function nino(value) {
  const s = String(value).toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z]{2}[0-9]{6}[A-D]$/.test(s)) return false;
  const [a, b] = s;
  if ('DFIQUV'.includes(a)) return false;
  if ('DFIOQUV'.includes(b)) return false;
  return !['BG', 'GB', 'NK', 'KN', 'TN', 'NT', 'ZZ'].includes(s.slice(0, 2));
}

/** Australian Business Number: weighted mod 89, with 1 subtracted from the first digit. */
export function abn(value) {
  const s = digits(value);
  if (s.length !== 11) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  let sum = (Number(s[0]) - 1) * weights[0];
  for (let i = 1; i < 11; i++) sum += Number(s[i]) * weights[i];
  return sum % 89 === 0;
}

/** Australian Tax File Number: weighted mod 11. */
export function tfn(value) {
  const s = digits(value);
  if (s.length !== 9) return false;
  const weights = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(s[i]) * weights[i];
  return sum % 11 === 0;
}

/**
 * ISIN: 2-letter country, 9 alphanumerics, one Luhn check digit computed after
 * expanding letters to their two-digit ordinals.
 */
export function isin(value) {
  const s = String(value).toUpperCase().trim();
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s)) return false;
  let expanded = '';
  for (const ch of s.slice(0, 11)) {
    expanded += /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
  }
  let sum = 0;
  let dbl = true;
  for (let i = expanded.length - 1; i >= 0; i--) {
    let d = Number(expanded[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return (10 - (sum % 10)) % 10 === Number(s[11]);
}

/** IMEI: 15 digits, Luhn. */
export function imei(value) {
  const s = digits(value);
  if (s.length !== 15 || allSame(s)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** EU VAT, for the member states whose check digit is publicly specified. */
export function euVat(value) {
  const s = String(value).toUpperCase().replace(/[\s-]/g, '');
  const country = s.slice(0, 2);
  const body = s.slice(2);
  switch (country) {
    case 'DE': {
      if (!/^[0-9]{9}$/.test(body)) return false;
      let product = 10;
      for (let i = 0; i < 8; i++) {
        let sum = (Number(body[i]) + product) % 10 || 10;
        product = (2 * sum) % 11;
      }
      const check = (11 - product) % 10;
      return check === Number(body[8]);
    }
    case 'NL': {
      if (!/^[0-9]{9}B[0-9]{2}$/.test(body)) return false;
      let sum = 0;
      for (let i = 0; i < 8; i++) sum += Number(body[i]) * (9 - i);
      return sum % 11 === Number(body[8]);
    }
    case 'IT': {
      if (!/^[0-9]{11}$/.test(body)) return false;
      let sum = 0;
      for (let i = 0; i < 10; i++) {
        let d = Number(body[i]);
        if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
      }
      return (10 - (sum % 10)) % 10 === Number(body[10]);
    }
    default:
      return false;
  }
}

// ------------------------------------------------------- AWS key decoding

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * The AWS account number is inside the access key ID.
 *
 * After the four-character resource prefix, the remaining characters are
 * base32. Decoding the first eight of them and masking off the low seven bits
 * yields the 12-digit account ID — no API call, no credentials, no network.
 * Published by Truffle Security; the arithmetic below is the whole technique.
 *
 * This turns "an AWS key is in your prompt" into "the key for account
 * 1234-5678-9012 is in your prompt", which is the difference between a warning
 * someone dismisses and one they act on.
 *
 * @returns {string|null} the 12-digit account id, or null if it cannot be read
 */
export function awsAccountId(keyId) {
  const s = String(keyId).toUpperCase();
  if (!/^(?:AKIA|ASIA|AIDA|AROA|AGPA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z2-7]{16}$/.test(s)) {
    return null;
  }
  // 16 base32 characters carry 80 bits.
  let bits = 0n;
  for (const ch of s.slice(4)) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    bits = (bits << 5n) | BigInt(v);
  }
  // The reference implementation decodes to bytes and takes the first six,
  // i.e. the top 48 of those 80 bits.
  const top48 = bits >> 32n;
  // Mask 0x7fffffffff80 clears the sign bit and the low seven, then shift.
  const account = (top48 & 0x7fffffffff80n) >> 7n;
  // No real account is zero; an all-'A' body decodes to it, so reject.
  if (account === 0n || account > 999999999999n) return null;
  return account.toString().padStart(12, '0');
}

/** Pretty form: 1234-5678-9012. */
export function formatAccountId(id) {
  return id ? `${id.slice(0, 4)}-${id.slice(4, 8)}-${id.slice(8)}` : null;
}

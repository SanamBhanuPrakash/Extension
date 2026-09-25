/**
 * Benign shapes.
 *
 * Published precision for regex-and-entropy secret scanners runs 25–75%.
 * The misses are not exotic: they are git SHAs, UUIDs, content hashes, order
 * numbers and epoch timestamps — high-entropy strings that are supposed to be
 * in your text.
 *
 * A detector consults this before reporting. Being wrong here costs a real
 * secret, so each entry is a shape that is *definitionally* not a credential,
 * not merely one that usually isn't.
 */

/** RFC 4122 UUID, any version. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A bare hex digest: md5 (32), sha1/git object (40), sha224 (56), sha256 (64), sha512 (128). */
export const HEX_DIGEST = /^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{56}$|^[0-9a-f]{64}$|^[0-9a-f]{128}$/i;

/** Milliseconds or microseconds since the epoch, in a plausible range. */
export function isEpoch(digits) {
  const s = String(digits).replace(/[^0-9]/g, '');
  if (s.length === 13) { const n = Number(s); return n > 946684800000 && n < 4102444800000; }
  if (s.length === 16) { const n = Number(s); return n > 946684800000000 && n < 4102444800000000; }
  return false;
}

/**
 * Text that announces itself as an example.
 *
 * Word-bounded. An earlier version wrote the article as `an?`, which under the
 * `i` flag matched the leading 'A' of every `AKIA...` key and quietly
 * suppressed real AWS credentials — the exact failure this file exists to
 * prevent. Single-letter alternatives are gone and `\b` is mandatory.
 */
export const PLACEHOLDER = /^(?:(?:your|my|our|the|some|example|sample|test|testing|dummy|fake|changeme|change_me|replace|replaceme|insert|todo|placeholder|redacted|removed|hidden|value|string|none|null|undefined|xxx+|aaa+)\b|<|\{\{|\$\{|\.\.\.|\*\*\*)/i;

/** A repeated or near-repeated run, e.g. aaaaaaaa or 12121212. */
export function isRepetitive(s) {
  if (/^(.)\1+$/.test(s)) return true;
  for (let len = 2; len <= 4; len++) {
    if (s.length % len === 0) {
      const unit = s.slice(0, len);
      if (unit.repeat(s.length / len) === s) return true;
    }
  }
  return false;
}

/** A strictly ascending or descending run, e.g. 123456789 or abcdef. */
export function isSequential(s) {
  if (s.length < 5) return false;
  let up = true;
  let down = true;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (d !== 1) up = false;
    if (d !== -1) down = false;
  }
  return up || down;
}

/**
 * The gate every candidate passes through.
 * @param {string} value the matched text
 * `placeholder` is opt-in: a rule anchored on a prefix nothing else uses
 * (AKIA, ghp_, xoxb-) should report its match whatever the surrounding words
 * look like, because a real key pasted into a document about examples is still
 * a real key. Only the generic and entropy rules ask for it.
 *
 * @param {string} value the matched text
 * @param {{hex?: boolean, digits?: boolean, placeholder?: boolean}} opts
 */
export function isBenign(value, opts = {}) {
  const s = String(value);
  if (UUID.test(s)) return true;
  if (isRepetitive(s) || isSequential(s)) return true;
  if (opts.placeholder && PLACEHOLDER.test(s)) return true;
  if (opts.hex !== false && HEX_DIGEST.test(s)) return true;
  if (opts.digits !== false && isEpoch(s)) return true;
  return false;
}

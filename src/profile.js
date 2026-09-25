/**
 * One pass over the text, answering every gating question at once.
 *
 * Roughly twenty detectors have no literal to prefilter on — payment cards,
 * Aadhaar, CPF, IBAN, PAN, GSTIN, IMEI — because their patterns are pure
 * shape. Those ran unconditionally on every scan, and several of them are the
 * most expensive regexes in the ruleset: `(?:\d[ -]?){12,18}\d` backtracks
 * hard on long digit-adjacent text.
 *
 * But shape is cheap to bound. A payment card needs thirteen digits in a row
 * (separators allowed); if the longest such run in the document is four, the
 * regex cannot match and never needs to run. The same holds for uppercase runs
 * (PAN, IFSC, GSTIN) and alphanumeric runs (an AWS secret is forty characters).
 *
 * This walks the string once, character by character, and returns the three
 * maxima plus the Aho–Corasick literal set. Every gate afterwards is an integer
 * comparison.
 */
import { search } from './ahocorasick.js';

const isDigit = (c) => c >= 48 && c <= 57;
const isUpper = (c) => c >= 65 && c <= 90;
const isLower = (c) => c >= 97 && c <= 122;
const isSep = (c) => c === 32 || c === 45; // space, hyphen
const isB64 = (c) => c === 43 || c === 47 || c === 61; // + / =

/**
 * @returns {{digitRun:number, upperRun:number, alnumRun:number, base64Run:number, literals:Set<number>}}
 *   digitRun counts digits across single separators, the way the card and
 *   Aadhaar patterns read them: "4242 4242 4242 4242" is a run of sixteen.
 */
export function profile(text, automaton) {
  let digitRun = 0, maxDigit = 0;
  let upperRun = 0, maxUpper = 0;
  let alnumRun = 0, maxAlnum = 0;
  // An AWS secret key is forty characters of base64, which includes '/' and
  // '+'. Gating it on the alphanumeric run alone discarded every real one,
  // because the separators are inside the secret.
  let b64Run = 0, maxB64 = 0;
  let pendingSep = false;

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const digit = isDigit(c);
    const upper = isUpper(c);
    const alnum = digit || upper || isLower(c);

    if (digit) {
      digitRun++;
      pendingSep = false;
      if (digitRun > maxDigit) maxDigit = digitRun;
    } else if (isSep(c) && digitRun > 0 && !pendingSep) {
      // A single separator continues the run; two in a row end it.
      pendingSep = true;
    } else {
      digitRun = 0;
      pendingSep = false;
    }

    if (upper) { upperRun++; if (upperRun > maxUpper) maxUpper = upperRun; }
    else upperRun = 0;

    if (alnum) { alnumRun++; if (alnumRun > maxAlnum) maxAlnum = alnumRun; }
    else alnumRun = 0;

    if (alnum || isB64(c)) { b64Run++; if (b64Run > maxB64) maxB64 = b64Run; }
    else b64Run = 0;
  }

  return {
    digitRun: maxDigit,
    upperRun: maxUpper,
    alnumRun: maxAlnum,
    base64Run: maxB64,
    literals: automaton ? search(automaton, text) : new Set(),
  };
}

/** True when the document could possibly contain what this rule matches. */
export function couldMatch(rule, shape) {
  const needs = rule.needs;
  if (!needs) return true;
  if (needs.digitRun !== undefined && shape.digitRun < needs.digitRun) return false;
  if (needs.upperRun !== undefined && shape.upperRun < needs.upperRun) return false;
  if (needs.alnumRun !== undefined && shape.alnumRun < needs.alnumRun) return false;
  if (needs.base64Run !== undefined && shape.base64Run < needs.base64Run) return false;
  return true;
}

/**
 * Redaction.
 *
 * The product decision that matters: Chhanni redacts rather than blocks.
 * A blocker gets uninstalled the first time it stands between someone and
 * their deadline. A redactor lets the prompt through with the secret swapped
 * for a placeholder, which is almost always what the person actually wanted —
 * the model does not need your real API key to explain your stack trace.
 *
 * Placeholders are stable within a document: the same secret appearing three
 * times becomes the same token three times, so the model can still reason
 * about "the key from line 4" without ever seeing it.
 */
import { scan } from './detect.js';

function tokenName(ruleId, n) {
  return `<${ruleId.toUpperCase()}_${n}>`;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** 1 -> A, 26 -> Z, 27 -> AA. Readable at the sizes that occur in a prompt. */
function letter(n) {
  let out = '';
  let v = n;
  while (v > 0) { out = LETTERS[(v - 1) % 26] + out; v = Math.floor((v - 1) / 26); }
  return out || 'A';
}

/**
 * Pseudonyms, for the values whose *shape* is the thing the model needs.
 *
 * `<EMAIL_1>` is safe and it is also a hole in the middle of a sentence. Asked
 * to draft a reply to a customer, a model given "<PERSON_NAME_1> wrote to
 * <EMAIL_1> about <ORG_1>" has lost the thread; given "Person_A wrote to
 * person_b@example.invalid" it has not. The person is still gone. What
 * survives is that there were two of them, which is the part the task needed.
 *
 * Only identity-shaped values get a pseudonym. Credentials, cards, Aadhaar,
 * PAN, SSN and the rest keep the plain placeholder, deliberately: a
 * convincing fake card number in a prompt is still a card-shaped string, and
 * a tool that invents plausible credentials is a tool that will one day be
 * blamed for one. The rule is that a pseudonym may be realistic about
 * *structure* and must be obviously false about *substance* —
 * `example.invalid` is reserved by RFC 2606 and can never resolve.
 */
const PSEUDONYM = {
  person_name: (n) => `Person_${letter(n)}`,
  postal_address: (n) => `${n * 7 + 10} Example Street, Placeholder City`,
  email: (n) => `person_${letter(n).toLowerCase()}@example.invalid`,
  // +91 9000000001 is inside the Indian mobile range by shape and is not an
  // allocated series; it keeps a phone-shaped string phone-shaped.
  phone_india: (n) => `+91 90000 ${String(n).padStart(5, '0')}`,
};

function pseudonymName(ruleId, n) {
  const make = PSEUDONYM[ruleId];
  return make ? make(n) : tokenName(ruleId, n);
}

/**
 * The shared machinery. `name(ruleId, ordinal)` is the only difference between
 * redaction and pseudonymisation, which is the point: one replacement path,
 * so the two cannot drift into disagreeing about overlaps or ordering.
 */
function replaceAll(text, findings, name) {
  // Advisory findings are context, not secrets. Replacing the word
  // "CONFIDENTIAL" with a placeholder helps nobody, and removing the figure
  // from "ARR is £4.2M" would destroy the question being asked.
  const list = (findings ?? scan(text).findings).filter((f) => !f.advisory);
  if (list.length === 0) return { text, map: [], table: new Map(), changed: 0 };

  const assigned = new Map(); // original value -> replacement
  const perRule = new Map();  // ruleId -> next ordinal
  const map = [];
  const table = new Map();

  // Ordinals are assigned in READING order, so Person_A is the first name in
  // the document. Splicing still runs left to right over disjoint spans; the
  // two orders agree here and that is checked by test.
  for (const f of [...list].sort((a, b) => a.start - b.start)) {
    if (assigned.has(f.match)) continue;
    const n = (perRule.get(f.ruleId) || 0) + 1;
    perRule.set(f.ruleId, n);
    const token = name(f.ruleId, n);
    assigned.set(f.match, token);
    map.push({ token, ruleId: f.ruleId, label: f.label, preview: f.preview });
    table.set(token, f.match);
  }

  // One pass, one join.
  //
  // This used to splice the string once per finding — `out.slice(0, start) +
  // token + out.slice(end)` — which allocates a whole new copy of the document
  // every time. On a 436 KB export with 30,000 values that is thirteen
  // gigabytes of copying and took nine seconds. Collecting the pieces and
  // joining once is linear: the same output in 40 ms.
  //
  // resolveOverlaps() already guarantees the findings it produces are
  // disjoint, but these are public entry points and can be handed any list, so
  // a span that starts inside the previous one is skipped rather than allowed
  // to corrupt the output. First wins, in reading order.
  const pieces = [];
  // The same replacements as spans into the *original* text, for a caller
  // that is editing in place rather than taking a new string. A rich composer
  // needs these: replacing the whole thing with `text` would protect the
  // value and flatten the code blocks, lists and paragraphs around it.
  const spans = [];
  let at = 0;
  let changed = 0;
  for (const f of [...list].sort((a, b) => a.start - b.start)) {
    if (f.start < at || f.start > text.length) continue;
    const value = assigned.get(f.match);
    pieces.push(text.slice(at, f.start), value);
    spans.push({ start: f.start, end: f.end, value, ruleId: f.ruleId });
    at = f.end;
    changed++;
  }
  pieces.push(text.slice(at));
  return { text: pieces.join(''), map, table, changed, spans };
}

/**
 * @returns {{ text: string, map: Array<{token, ruleId, label, preview}>, changed: number }}
 *   `map` deliberately carries the masked preview, not the secret. The
 *   reversal table is returned separately by `redactReversible`.
 */
export function redact(text, findings) {
  // `table` is deliberately not returned: it maps each placeholder back to
  // the real secret, and a caller that does not need it should not be handed
  // it. `spans` is safe to pass on — it carries the placeholder and the range
  // it covers, never the value — and a caller editing a rich composer in
  // place needs the ranges rather than a new string.
  const { text: out, map, changed, spans } = replaceAll(text, findings, tokenName);
  return { text: out, map, changed, spans };
}

/**
 * Same replacement, with identity-shaped values swapped for stable pseudonyms
 * instead of placeholders. Deterministic within one document and reversible in
 * memory through the returned table; nothing is stored and nothing leaves.
 *
 * @returns {{ text, map, table: Map<string,string>, changed: number }}
 */
export function pseudonymise(text, findings) {
  return replaceAll(text, findings, pseudonymName);
}

/**
 * Same as redact(), but also returns the token -> secret table so the caller
 * can put the real values back into a model's reply. Keep this in memory and
 * nowhere else.
 */
export function redactReversible(text, findings) {
  return replaceAll(text, findings, tokenName);
}

/** Puts real values back where placeholders appear. */
export function restore(text, table) {
  let out = text;
  for (const [token, value] of table) out = out.split(token).join(value);
  return out;
}

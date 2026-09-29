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

/**
 * @returns {{ text: string, map: Array<{token: string, ruleId: string, preview: string}>, changed: number }}
 *   `map` deliberately carries the masked preview, not the secret. The
 *   reversal table is returned separately by `redactReversible`.
 */
export function redact(text, findings) {
  // Advisory findings are context, not secrets. Replacing the word
  // "CONFIDENTIAL" with a placeholder helps nobody, and removing the figure
  // from "ARR is £4.2M" would destroy the question being asked.
  const list = (findings ?? scan(text).findings).filter((f) => !f.advisory);
  if (list.length === 0) return { text, map: [], changed: 0 };

  const assigned = new Map(); // secret value -> token
  const perRule = new Map(); // ruleId -> next ordinal
  const map = [];

  // Ordinals are assigned in READING order, so <PERSON_NAME_1> is the first
  // name in the document. Splicing still runs right to left, so earlier
  // offsets stay valid — the two orders are deliberately different.
  for (const f of [...list].sort((a, b) => a.start - b.start)) {
    if (assigned.has(f.match)) continue;
    const n = (perRule.get(f.ruleId) || 0) + 1;
    perRule.set(f.ruleId, n);
    const token = tokenName(f.ruleId, n);
    assigned.set(f.match, token);
    map.push({ token, ruleId: f.ruleId, label: f.label, preview: f.preview });
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
  // disjoint, but redact() is public and can be handed any list, so a span
  // that starts inside the previous one is skipped rather than allowed to
  // corrupt the output. First wins, in reading order.
  const pieces = [];
  let at = 0;
  let changed = 0;
  for (const f of [...list].sort((a, b) => a.start - b.start)) {
    if (f.start < at || f.start > text.length) continue;
    pieces.push(text.slice(at, f.start), assigned.get(f.match));
    at = f.end;
    changed++;
  }
  pieces.push(text.slice(at));
  return { text: pieces.join(''), map, changed };
}

/**
 * Same as redact(), but also returns the token -> secret table so the caller
 * can put the real values back into a model's reply. Keep this in memory and
 * nowhere else.
 */
export function redactReversible(text, findings) {
  const list = (findings ?? scan(text).findings).filter((f) => !f.advisory);
  const result = redact(text, list);
  const table = new Map();
  const assigned = new Map();
  const perRule = new Map();
  // Same reading order as redact(), so the tokens agree.
  for (const f of [...list].sort((a, b) => a.start - b.start)) {
    if (assigned.has(f.match)) continue;
    const n = (perRule.get(f.ruleId) || 0) + 1;
    perRule.set(f.ruleId, n);
    const token = tokenName(f.ruleId, n);
    assigned.set(f.match, token);
    table.set(token, f.match);
  }
  return { ...result, table };
}

/** Puts real values back where placeholders appear. */
export function restore(text, table) {
  let out = text;
  for (const [token, value] of table) out = out.split(token).join(value);
  return out;
}

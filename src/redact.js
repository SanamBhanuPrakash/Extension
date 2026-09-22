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
  const list = findings ?? scan(text).findings;
  if (list.length === 0) return { text, map: [], changed: 0 };

  const assigned = new Map(); // secret value -> token
  const perRule = new Map(); // ruleId -> next ordinal
  const map = [];

  // Right to left, so earlier offsets stay valid as we splice.
  const ordered = [...list].sort((a, b) => b.start - a.start);
  let out = text;
  for (const f of ordered) {
    let token = assigned.get(f.match);
    if (!token) {
      const n = (perRule.get(f.ruleId) || 0) + 1;
      perRule.set(f.ruleId, n);
      token = tokenName(f.ruleId, n);
      assigned.set(f.match, token);
      map.push({ token, ruleId: f.ruleId, label: f.label, preview: f.preview });
    }
    out = out.slice(0, f.start) + token + out.slice(f.end);
  }

  map.reverse();
  return { text: out, map, changed: ordered.length };
}

/**
 * Same as redact(), but also returns the token -> secret table so the caller
 * can put the real values back into a model's reply. Keep this in memory and
 * nowhere else.
 */
export function redactReversible(text, findings) {
  const list = findings ?? scan(text).findings;
  const result = redact(text, list);
  const table = new Map();
  const assigned = new Map();
  const perRule = new Map();
  for (const f of [...list].sort((a, b) => b.start - a.start)) {
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

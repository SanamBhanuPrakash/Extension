/**
 * Local history.
 *
 * Everything here lives in chrome.storage.local and is never synced, never
 * uploaded and never leaves the profile. What we keep is deliberately the
 * *masked* preview and a salted fingerprint, not the secret.
 *
 * The fingerprint earns its place: it lets the popup say "you have pasted
 * this same key 6 times" without ever holding the key. It is SHA-256 over a
 * random per-install salt and the value, truncated to 128 bits.
 *
 * What that is not: a guarantee. The masked preview keeps the first and last
 * few characters, which is the point — you have to be able to recognise your
 * own key — and for a short, predictable value those characters plus the
 * hostname and the timestamp narrow things considerably. This store is
 * designed so a leak of it is not a leak of your credentials. It is not
 * designed to survive an attacker who already has your browser profile, and
 * neither is anything else in it.
 */
const MAX_LOG = 120;
const KEY = 'history';

export const EMPTY = { events: [], caught: 0, redacted: 0, sent: 0 };

export async function read() {
  try {
    const got = await chrome.storage.local.get(KEY);
    return { ...EMPTY, ...(got[KEY] || {}) };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * @param {Array} findings  findings from scan(); `match` is ignored on purpose
 * @param {{host: string, action: 'redacted'|'sent'|'dismissed'}} context
 */
export async function record(findings, { host, action }) {
  if (!findings.length) return;
  const state = await read();
  const at = Date.now();
  const events = findings.map((f) => ({
    ruleId: f.ruleId,
    label: f.label,
    severity: f.severity,
    preview: f.preview,
    fingerprint: f.fingerprint,
    host,
    action,
    at,
  }));
  state.events = [...events, ...state.events].slice(0, MAX_LOG);
  state.caught += findings.length;
  if (action === 'redacted') state.redacted += findings.length;
  if (action === 'sent') state.sent += findings.length;
  try { await chrome.storage.local.set({ [KEY]: state }); } catch { /* quota; drop it */ }
}

export async function clear() {
  try { await chrome.storage.local.set({ [KEY]: { ...EMPTY } }); } catch { /* ignore */ }
}

/** Top rule ids by count, for the popup's breakdown. */
export function breakdown(events, limit = 4) {
  const by = new Map();
  for (const e of events) {
    const row = by.get(e.ruleId) || { label: e.label, severity: e.severity, n: 0 };
    row.n++;
    by.set(e.ruleId, row);
  }
  return [...by.values()].sort((a, b) => b.n - a.n).slice(0, limit);
}

/** How many distinct secrets, rather than how many pastes. */
export function distinctSecrets(events) {
  return new Set(events.map((e) => e.fingerprint)).size;
}

export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

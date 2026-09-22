/**
 * The scanner.
 *
 * scan(text) -> { findings, counts, verdict }
 *
 * Findings never carry the raw secret to anything that persists. `match` is
 * available in-process for redaction; `preview` is the masked form and
 * `fingerprint` is a one-way hash, which is what logging and telemetry may
 * use. There is no telemetry in this project, but the shape matters: someone
 * will fork this and add some, and the fork should be safe by construction.
 */
import { RULES, RULES_BY_ID } from './rules.js';

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const CONFIDENCE_RANK = { certain: 3, likely: 2, possible: 1 };

export const DEFAULT_POLICY = {
  /** Severities that make scan() return verdict 'block'. */
  block: ['critical'],
  /** Severities that make scan() return verdict 'warn'. */
  warn: ['high', 'medium'],
  /** Rule ids to skip entirely. */
  disabled: [],
  /** Literal strings that are never a finding, e.g. a shared test fixture. */
  allow: [],
};

/** Masked form: enough to recognise your own key, not enough to use it. */
export function mask(value) {
  const s = String(value);
  if (s.length <= 8) return '*'.repeat(s.length);
  const keep = s.length > 24 ? 6 : 3;
  return `${s.slice(0, keep)}${'*'.repeat(Math.min(12, s.length - keep * 2))}${s.slice(-keep)}`;
}

/** Stable non-reversible id for a value. FNV-1a, 32-bit, hex. */
export function fingerprint(value) {
  let h = 0x811c9dc5;
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function line(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/**
 * Two findings conflict when their spans overlap. The stronger one wins,
 * ranked by severity, then confidence, then length. This is what stops
 * `api_key=sk-ant-...` reporting both a generic credential-shaped value and
 * the actual Anthropic key.
 */
function resolveOverlaps(findings) {
  const ordered = [...findings].sort((a, b) => {
    const s = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (s !== 0) return s;
    const c = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
    if (c !== 0) return c;
    const len = (b.end - b.start) - (a.end - a.start);
    if (len !== 0) return len;
    return a.start - b.start;
  });
  const kept = [];
  for (const f of ordered) {
    const clashes = kept.some((k) => f.start < k.end && k.start < f.end);
    if (!clashes) kept.push(f);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export function scan(text, policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const disabled = new Set(p.disabled);
  const allow = new Set(p.allow);
  const raw = [];

  if (typeof text !== 'string' || text.length === 0) {
    return { findings: [], counts: {}, verdict: 'clean', scanned: 0 };
  }

  for (const rule of RULES) {
    if (disabled.has(rule.id)) continue;
    // Each scan gets its own regex so lastIndex is never shared across calls.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      // Zero-length matches would spin forever.
      if (m[0].length === 0) { re.lastIndex++; continue; }

      const groupIndex = rule.group ?? (m[1] !== undefined ? 1 : 0);
      const value = m[groupIndex] ?? m[0];
      if (!value) continue;
      const start = m.index + m[0].indexOf(value);
      const end = start + value.length;

      if (allow.has(value)) continue;

      const ctx = { text, index: start, full: m[0] };
      if (rule.validate && !rule.validate(value, ctx)) continue;

      const extra = rule.enrich ? rule.enrich(value, ctx) : {};
      raw.push({
        ruleId: rule.id,
        label: rule.label,
        severity: extra.severity ?? rule.severity,
        confidence: extra.confidence ?? rule.confidence,
        note: extra.note ?? rule.note ?? null,
        start,
        end,
        match: value,
        preview: mask(value),
        fingerprint: fingerprint(value),
        line: line(text, start),
      });
    }
  }

  const findings = resolveOverlaps(raw);
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  const blockSet = new Set(p.block);
  const warnSet = new Set(p.warn);
  let verdict = 'clean';
  if (findings.some((f) => blockSet.has(f.severity))) verdict = 'block';
  else if (findings.some((f) => warnSet.has(f.severity))) verdict = 'warn';

  return { findings, counts, verdict, scanned: text.length };
}

/** One-line human summary, e.g. "1 AWS access key ID, 2 email addresses". */
export function summarise(findings) {
  const byLabel = new Map();
  for (const f of findings) byLabel.set(f.label, (byLabel.get(f.label) || 0) + 1);
  return [...byLabel.entries()]
    .map(([label, n]) => (n === 1 ? label : `${n}× ${label}`))
    .join(', ');
}

export { RULES, RULES_BY_ID };

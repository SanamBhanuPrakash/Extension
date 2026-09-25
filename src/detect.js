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
import { detectTable, tableSeverity, describeTable } from './tabular.js';
import { exposureScore, BAND_TEXT } from './risk.js';
import { regimesFor, regimeNames } from './regulations.js';
import { findNames, findAddresses } from './ner.js';
import { build as buildAutomaton, search as searchAutomaton } from './ahocorasick.js';

/**
 * Compiled once at import, not per scan.
 *
 * Two costs used to be paid on every keystroke-sized paste: ~92 `new RegExp`
 * compilations, and ~250 separate `String.includes` passes for the prefilter.
 * Both are now amortised to module load.
 */
const COMPILED = new Map();      // ruleId -> RegExp, for the main pass
const CELL_COMPILED = new Map(); // ruleId -> RegExp, for table-cell scanning
function compiled(cache, rule) {
  let re = cache.get(rule.id);
  if (!re) { re = new RegExp(rule.pattern.source, rule.pattern.flags); cache.set(rule.id, re); }
  re.lastIndex = 0;
  return re;
}

// Every prefilter literal, flattened, with a map back to the rules that need it.
const PREFILTER_LITERALS = [];
const LITERAL_OWNERS = [];       // literal index -> rule ids
{
  const index = new Map();
  for (const rule of RULES) {
    if (!rule.prefilter) continue;
    for (const literal of rule.prefilter) {
      let id = index.get(literal.toLowerCase());
      if (id === undefined) {
        id = PREFILTER_LITERALS.length;
        index.set(literal.toLowerCase(), id);
        PREFILTER_LITERALS.push(literal);
        LITERAL_OWNERS.push([]);
      }
      LITERAL_OWNERS[id].push(rule.id);
    }
  }
}
const AUTOMATON = buildAutomaton(PREFILTER_LITERALS);

/**
 * Hard limits. A content script shares a thread with someone's actual work, so
 * "slow" and "crashed" are the same outcome to them. Everything below is a
 * ceiling that trades completeness for never hanging the page.
 */
const MAX_SCAN_BYTES = 2_000_000;   // beyond this we scan a prefix and say so
const MAX_MATCHES_PER_RULE = 500;   // a pathological input cannot spin forever
const MAX_TOTAL_FINDINGS = 2000;
// Name and address detection walks every token, so it costs more per byte than
// the pattern rules. Past this size the marginal value is low (a 300 KB paste
// is a data dump, which the table detector already characterises) and the
// latency is not worth it.
const MAX_NER_BYTES = 200_000;

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

export function scan(input, policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const disabled = new Set(p.disabled);
  const allow = new Set(p.allow);
  const raw = [];

  if (typeof input !== 'string' || input.length === 0) {
    return {
      findings: [], counts: {}, verdict: 'clean', scanned: 0, truncated: false,
      table: null, risk: exposureScore([], null), regimes: [], regimeNames: [],
      advisories: [], errors: [],
    };
  }

  const truncated = input.length > MAX_SCAN_BYTES;
  const text = truncated ? input.slice(0, MAX_SCAN_BYTES) : input;
  const errors = [];

  // One pass answers the prefilter question for every rule at once.
  const presentLiterals = searchAutomaton(AUTOMATON, text);
  const eligible = new Set();
  for (const id of presentLiterals) for (const ruleId of LITERAL_OWNERS[id]) eligible.add(ruleId);

  for (const rule of RULES) {
    if (disabled.has(rule.id) || rule.synthetic) continue;
    // Prefilter: a cheap substring test before an expensive backtracking regex.
    // Most detectors are anchored on a literal nothing else uses (AKIA, ghp_,
    // xoxb-), so on ordinary prose the overwhelming majority are skipped
    // outright. This is what keeps an 81-detector scan cheap on a large paste.
    if (rule.prefilter && !eligible.has(rule.id)) continue;
    if (raw.length >= MAX_TOTAL_FINDINGS) break;

    // Every rule runs inside its own try/catch. One malformed pattern, one
    // validator that throws on an input nobody anticipated, must degrade that
    // single detector — never the scan, and never the page the scan runs in.
    try {
      const re = compiled(COMPILED, rule);
      let m;
      let hits = 0;
      while ((m = re.exec(text)) !== null) {
        if (++hits > MAX_MATCHES_PER_RULE) break;
        // Zero-length matches would spin forever.
        if (m[0].length === 0) { re.lastIndex++; continue; }

        const groupIndex = rule.group ?? (m[1] !== undefined ? 1 : 0);
        const value = m[groupIndex] ?? m[0];
        if (!value) continue;
        const start = m.index + m[0].indexOf(value);
        const end = start + value.length;

        if (allow.has(value)) continue;

        const ctx = { text, index: start, full: m[0] };
        let extra = {};
        try {
          if (rule.validate && !rule.validate(value, ctx)) continue;
          if (rule.enrich) extra = rule.enrich(value, ctx) || {};
        } catch (err) {
          errors.push({ ruleId: rule.id, stage: 'validate', message: String(err && err.message) });
          continue;
        }

        raw.push({
          ruleId: rule.id,
          label: rule.label,
          severity: extra.severity ?? rule.severity,
          confidence: extra.confidence ?? rule.confidence,
          note: extra.note ?? rule.note ?? null,
          advisory: Boolean(rule.advisory),
          audience: rule.audience ?? null,
          start,
          end,
          match: value,
          preview: rule.advisory ? value.slice(0, 64) : mask(value),
          fingerprint: fingerprint(value),
          line: line(text, start),
        });
      }
    } catch (err) {
      errors.push({ ruleId: rule.id, stage: 'match', message: String(err && err.message) });
    }
  }

  // ── names and addresses in prose ──────────────────────────────────────
  // The pattern rules above cannot see "Priya Nair, 14 Koregaon Park Road".
  // This pass can, and it is the majority of how personal data actually
  // appears outside a database export.
  if (p.ner !== false && text.length <= MAX_NER_BYTES
      && !disabled.has('person_name') && !disabled.has('postal_address')) {
    try {
      // Everything the pattern rules already claimed is off-limits to NER:
      // a capitalised run inside an AWS key or a private-key blob is part of
      // the credential, not a person.
      const alreadyFound = raw.map((f) => ({ start: f.start, end: f.end }));
      const addresses = findAddresses(text);
      for (const a of addresses) {
        raw.push({
          ruleId: 'postal_address', label: 'Postal address',
          severity: 'high', confidence: a.parts >= 3 ? 'likely' : 'possible',
          note: `Structural match: ${a.evidence.join(', ')}.`,
          advisory: false, audience: 'everyone',
          start: a.start, end: a.end, match: a.text,
          preview: mask(a.text), fingerprint: fingerprint(a.text), line: line(text, a.start),
        });
      }
      for (const n of findNames(text, { claimed: [...addresses, ...alreadyFound] })) {
        raw.push({
          ruleId: 'person_name', label: 'Person name',
          severity: 'medium',
          confidence: n.score >= 0.95 ? 'likely' : 'possible',
          note: n.evidence.length ? `Read as a name from: ${n.evidence.join(', ')}.` : null,
          advisory: false, audience: 'everyone',
          start: n.start, end: n.end, match: n.text,
          preview: mask(n.text), fingerprint: fingerprint(n.text), line: line(text, n.start),
        });
      }
    } catch (err) {
      errors.push({ ruleId: 'ner', stage: 'detect', message: String(err && err.message) });
    }
  }

  const findings = resolveOverlaps(raw);
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  // Bulk-record detection runs last and gets a probe into the same engine,
  // with context rules off: a column is classified by its values, and a
  // document-level signal is not a property of a single cell.
  let table = null;
  if (p.tables !== false) {
    try {
      table = detectTable(text, (cell) => scanCell(cell, disabled, allow));
    } catch (err) {
      errors.push({ ruleId: 'table', stage: 'detect', message: String(err && err.message) });
    }
  }

  const blockSet = new Set(p.block);
  const warnSet = new Set(p.warn);
  let verdict = 'clean';
  if (findings.some((f) => blockSet.has(f.severity))) verdict = 'block';
  else if (findings.some((f) => warnSet.has(f.severity))) verdict = 'warn';
  if (table) {
    const sev = tableSeverity(table.rows);
    if (blockSet.has(sev)) verdict = 'block';
    else if (verdict === 'clean' && warnSet.has(sev)) verdict = 'warn';
    table.severity = sev;
    table.description = describeTable(table);
  }

  const risk = exposureScore(findings, table);

  return {
    findings,
    groups: groupFindings(findings),
    advisories: findings.filter((f) => f.advisory),
    counts,
    verdict,
    scanned: text.length,
    truncated,
    table,
    risk,
    band: BAND_TEXT[risk.band],
    regimes: regimesFor(findings, table),
    regimeNames: regimeNames(findings, table),
    errors,
  };
}

/**
 * Collapses findings by detector for display.
 *
 * `findings` stays complete because redaction needs every span. What a person
 * reads should be one row per detector with a count: a pasted customer export
 * produces 368 findings and exactly two facts.
 */
export function groupFindings(findings) {
  const by = new Map();
  for (const f of findings) {
    const row = by.get(f.ruleId);
    if (row) { row.occurrences++; continue; }
    by.set(f.ruleId, {
      ruleId: f.ruleId, label: f.label, severity: f.severity,
      confidence: f.confidence, advisory: f.advisory, audience: f.audience,
      note: f.note, preview: f.preview, line: f.line, occurrences: 1,
    });
  }
  const rank = { critical: 4, high: 3, medium: 2, low: 1 };
  return [...by.values()].sort((a, b) =>
    (rank[b.severity] - rank[a.severity]) || (b.occurrences - a.occurrences));
}

/**
 * A minimal scan used only to classify a table cell. Skips context signals and
 * table detection, so column inference cannot recurse or be skewed by
 * document-level language appearing inside one cell.
 */
function scanCell(cell, disabled, allow) {
  const out = [];
  if (typeof cell !== 'string' || !cell || cell.length > 400) return out;
  for (const rule of RULES) {
    if (rule.advisory || rule.synthetic || disabled.has(rule.id)) continue;
    if (rule.prefilter && !rule.prefilter.some((n) => cell.includes(n))) continue;
    try {
      const re = compiled(CELL_COMPILED, rule);
      const m = re.exec(cell);
      if (!m) continue;
      const value = m[rule.group ?? (m[1] !== undefined ? 1 : 0)] ?? m[0];
      if (!value || allow.has(value)) continue;
      const ctx = { text: cell, index: m.index, full: m[0] };
      if (rule.validate && !rule.validate(value, ctx)) continue;
      out.push({ ruleId: rule.id });
    } catch { /* one rule failing must not break column inference */ }
  }
  return out;
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

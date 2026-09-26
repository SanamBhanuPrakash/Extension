/**
 * The scanner.
 *
 * scan(text) -> { findings, counts, verdict }
 *
 * Findings never carry the raw secret to anything that persists. `match` is
 * available in-process for redaction; `preview` is the masked form and
 * `fingerprint` is a salted SHA-256, which is what logging and telemetry may
 * use. There is no telemetry in this project, but the shape matters: someone
 * will fork this and add some, and the fork should be safe by construction.
 */
import { RULES, RULES_BY_ID } from './rules.js';
import { detectTable, tableSeverity, describeTable } from './tabular.js';
import { exposureScore, BAND_TEXT } from './risk.js';
import { regimesFor, regimeNames } from './regulations.js';
import { findNames, findAddresses } from './ner.js';
import { detectInjection } from './injection.js';
import { codenameRule } from './managed.js';
import { build as buildAutomaton } from './ahocorasick.js';
import { profile, couldMatch } from './profile.js';
import { sha256hex } from './sha256.js';

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
const MAX_SCAN_BYTES = 2_000_000;   // total bytes examined on a huge input
const MAX_MATCHES_PER_RULE = 500;   // a pathological input cannot spin forever
const MAX_TOTAL_FINDINGS = 2000;

/**
 * Where those two million bytes are spent.
 *
 * The old behaviour was to take a prefix, which is the worst possible choice:
 * an .env dump, a key block or a signature is at the *end* of a file far more
 * often than in the middle of it, and "scanned the first 2 MB" reliably misses
 * exactly the part that matters. A head and a tail catch both ends of a large
 * paste, and what falls between them is reported by size rather than passed
 * over.
 *
 * The two windows are joined by a run of newlines wide enough that no
 * detector can match across the seam, and any finding that touches it is
 * discarded rather than reported at a fabricated offset.
 */
const HEAD_BYTES = 1_400_000;
const TAIL_BYTES = 600_000;
const SEAM_LINES = 8;
const SEAM = '\n'.repeat(SEAM_LINES);
/** Past this, counting the newlines in the skipped middle is not worth it. */
const MAX_LINE_COUNT_BYTES = 32_000_000;

/**
 * Name and address detection walks every token, so it costs more per byte than
 * the pattern rules — around 4 MB/s against 9 for the rule pass.
 *
 * This was 200 KB, chosen when NER was slower and before documents were read
 * at all. A 400-row spreadsheet exported as CSV clears 200 KB easily and is
 * precisely the case where person names matter most, so the ceiling was
 * cutting off the useful cases rather than the pathological ones. At 800 KB
 * the worst case is roughly 200 ms, on an action the person took deliberately
 * by pasting most of a megabyte.
 */
const MAX_NER_BYTES = 800_000;

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
  /**
   * Per-install random string mixed into every fingerprint. The extension
   * generates one on first run; the CLI leaves it empty so digests are
   * reproducible across machines. See fingerprint().
   */
  fingerprintSalt: '',
};

/** Masked form: enough to recognise your own key, not enough to use it. */
export function mask(value) {
  const s = String(value);
  if (s.length <= 8) return '*'.repeat(s.length);
  const keep = s.length > 24 ? 6 : 3;
  return `${s.slice(0, keep)}${'*'.repeat(Math.min(12, s.length - keep * 2))}${s.slice(-keep)}`;
}

/**
 * A stable id for a value, for dedupe and for anything a fork might log.
 *
 * SHA-256 truncated to 128 bits, over a salt and the value. It replaced a
 * 32-bit FNV-1a hash that the documentation called "one-way": four billion
 * outputs is a table anyone can build, and a chosen collision was trivial.
 *
 * The salt is what makes this non-reversible *in practice*, and it matters
 * more than the hash upgrade did. An email address has perhaps 30 bits of
 * real entropy; an unsalted digest of one is recovered by trying candidates,
 * no matter how strong the hash. With a per-install random salt there is no
 * shared table to build and no cross-install correlation — a fingerprint is
 * only comparable to other fingerprints from the same browser profile.
 *
 * The CLI leaves the salt empty on purpose: a build pipeline wants the same
 * value to fingerprint the same way on every machine. That is a deliberate
 * trade, and it is written down in docs/LIMITATIONS.md rather than implied.
 *
 * @param {string} value
 * @param {string} [salt] per-install random string; '' for a portable digest
 */
export function fingerprint(value, salt = '') {
  return sha256hex(`${salt}\u0000${value}`).slice(0, 32);
}

/**
 * Line numbers for a whole scan, in one pass.
 *
 * The previous version walked the text from position zero for every finding.
 * That is O(n) per finding and O(n\u00b7f) for a scan, which went unnoticed while
 * the largest realistic input was a pasted paragraph. On a 200 KB document
 * producing two thousand findings it was 73% of the entire scan — measured,
 * with --cpu-prof, not guessed. Collecting the newline offsets once and
 * binary-searching per finding makes it O(n + f log n).
 */
function lineIndex(text) {
  const offsets = [];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) offsets.push(i);
  return offsets;
}

function lineAt(offsets, index) {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < index) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/** Newlines in [from, to), for restoring line numbers across a skipped middle. */
function countLines(text, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Moves a finding from the joined head+tail text back onto the original input.
 * Returns null for a finding that straddles the seam, which is a match that
 * never existed in the real document.
 */
function toOriginal(f, coverage) {
  if (!coverage) return f;
  if (f.end <= coverage.seamStart) return f;
  if (f.start < coverage.seamEnd) return null;
  const out = { ...f, start: f.start + coverage.shift, end: f.end + coverage.shift };
  if (coverage.skippedLines === null) out.line = null;
  else out.line = f.line - SEAM_LINES + coverage.skippedLines;
  return out;
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
  const salt = p.fingerprintSalt || '';
  const fp = (v) => fingerprint(v, salt);
  const raw = [];

  if (typeof input !== 'string' || input.length === 0) {
    return {
      findings: [], groups: [], counts: {}, verdict: 'clean', scanned: 0,
      truncated: false, coverage: null, table: null, risk: exposureScore([], null),
      regimes: [], regimeNames: [], advisories: [], errors: [],
    };
  }

  const truncated = input.length > MAX_SCAN_BYTES;
  let text = input;
  let coverage = null;
  if (truncated) {
    text = input.slice(0, HEAD_BYTES) + SEAM + input.slice(input.length - TAIL_BYTES);
    const skipped = input.length - HEAD_BYTES - TAIL_BYTES;
    coverage = {
      total: input.length,
      head: HEAD_BYTES,
      tail: TAIL_BYTES,
      skipped,
      // Offset from a position in the joined text to the same position in the
      // original, for anything after the seam.
      shift: skipped - SEAM.length,
      seamStart: HEAD_BYTES,
      seamEnd: HEAD_BYTES + SEAM.length,
      skippedLines: skipped <= MAX_LINE_COUNT_BYTES
        ? countLines(input, HEAD_BYTES, input.length - TAIL_BYTES)
        : null,
    };
  }
  const errors = [];
  const lines = lineIndex(text);
  const line = (index) => lineAt(lines, index);

  // One pass answers every gating question at once: which prefilter literals
  // are present, and the longest digit, uppercase and alphanumeric runs.
  const shape = profile(text, AUTOMATON);
  const eligible = new Set();
  for (const id of shape.literals) for (const ruleId of LITERAL_OWNERS[id]) eligible.add(ruleId);

  // An organisation's codenames are theirs, differ per install, and must never
  // be baked into a published package — so the rule is built per scan from
  // policy rather than shipped.
  const orgRule = p.codenames && p.codenames.length ? codenameRule(p.codenames) : null;
  const activeRules = orgRule ? [...RULES, orgRule] : RULES;

  for (const rule of activeRules) {
    if (disabled.has(rule.id) || rule.synthetic) continue;
    // Prefilter: a cheap substring test before an expensive backtracking regex.
    // Most detectors are anchored on a literal nothing else uses (AKIA, ghp_,
    // xoxb-), so on ordinary prose the overwhelming majority are skipped
    // outright. This is what keeps an 81-detector scan cheap on a large paste.
    if (rule.prefilter && !eligible.has(rule.id)) continue;
    // Shape gate: a pattern that needs thirteen consecutive digits cannot
    // match a document whose longest digit run is four.
    if (!couldMatch(rule, shape)) continue;
    if (raw.length >= MAX_TOTAL_FINDINGS) break;

    // Every rule runs inside its own try/catch. One malformed pattern, one
    // validator that throws on an input nobody anticipated, must degrade that
    // single detector — never the scan, and never the page the scan runs in.
    try {
      // The per-install codename rule is not in the module-level cache.
      const re = rule.id === 'org_codename'
        ? Object.assign(rule.pattern, { lastIndex: 0 })
        : compiled(COMPILED, rule);
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
          fingerprint: fp(value),
          line: line(start),
        });
      }
    } catch (err) {
      errors.push({ ruleId: rule.id, stage: 'match', message: String(err && err.message) });
    }
  }

  // ── indirect prompt injection ─────────────────────────────────────────
  // The only check here where the user is the carrier rather than the leaker:
  // text pasted from a web page, a ticket or a CV that carries instructions
  // aimed at the assistant rather than at the reader.
  if (p.injection !== false && !disabled.has('prompt_injection')) {
    try {
      const inj = detectInjection(text);
      if (inj) {
        raw.push({
          ruleId: 'prompt_injection',
          label: 'Instructions aimed at the assistant',
          severity: inj.severity,
          confidence: inj.score >= 3 ? 'likely' : 'possible',
          note: `This text contains ${inj.signals.map((sig) => sig.label).join('; ')}. You are the carrier here, not the target.`,
          advisory: true, audience: 'everyone',
          start: 0, end: Math.min(text.length, 64),
          match: text.slice(0, 64),
          preview: inj.signals.map((sig) => sig.id).join(', '),
          fingerprint: fp(inj.signals.map((sig) => sig.id).join(',')),
          line: 1,
        });
      }
    } catch (err) {
      errors.push({ ruleId: 'prompt_injection', stage: 'detect', message: String(err && err.message) });
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
      // The same ceiling the rule pass obeys. A 700 KB customer export finds
      // thousands of names, and past a couple of thousand the reader learns
      // nothing further while resolveOverlaps starts costing real time.
      const room = () => raw.length < MAX_TOTAL_FINDINGS;
      for (const a of addresses) {
        if (!room()) break;
        raw.push({
          ruleId: 'postal_address', label: 'Postal address',
          severity: 'high', confidence: a.parts >= 3 ? 'likely' : 'possible',
          note: `Structural match: ${a.evidence.join(', ')}.`,
          advisory: false, audience: 'everyone',
          start: a.start, end: a.end, match: a.text,
          preview: mask(a.text), fingerprint: fp(a.text), line: line(a.start),
        });
      }
      for (const n of findNames(text, { claimed: [...addresses, ...alreadyFound] })) {
        if (!room()) break;
        raw.push({
          ruleId: 'person_name', label: 'Person name',
          severity: 'medium',
          confidence: n.score >= 0.95 ? 'likely' : 'possible',
          note: n.evidence.length ? `Read as a name from: ${n.evidence.join(', ')}.` : null,
          advisory: false, audience: 'everyone',
          start: n.start, end: n.end, match: n.text,
          preview: mask(n.text), fingerprint: fp(n.text), line: line(n.start),
        });
      }
    } catch (err) {
      errors.push({ ruleId: 'ner', stage: 'detect', message: String(err && err.message) });
    }
  }

  const findings = resolveOverlaps(raw)
    .map((f) => toOriginal(f, coverage))
    .filter(Boolean);
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  // Bulk-record detection runs last and gets a probe into the same engine,
  // with context rules off: a column is classified by its values, and a
  // document-level signal is not a property of a single cell.
  let table = null;
  if (p.tables !== false) {
    try {
      table = detectTable(text, (cell) => scanCell(cell, disabled, allow));
      if (table) {
        table.severity = tableSeverity(table.rows);
        table.description = describeTable(table);
      }
    } catch (err) {
      errors.push({ ruleId: 'table', stage: 'detect', message: String(err && err.message) });
    }
  }

  // A detected table's personal columns produce findings for their own cells,
  // which is both more accurate than guessing value by value and what makes a
  // pasted export redactable.
  if (table && typeof table.cellSpans === 'function') {
    try {
      // Sorted once and searched by bisection. Scanning the whole array per
      // cell was O(n^2) and hung on a 5,000-row export.
      const claimed = findings
        .map((f) => ({ start: f.start, end: f.end }))
        .sort((a, b) => a.start - b.start);
      const overlapsClaimed = (start, end) => {
        let lo = 0;
        let hi = claimed.length - 1;
        let idx = claimed.length;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (claimed[mid].start >= start) { idx = mid; hi = mid - 1; } else lo = mid + 1;
        }
        // The first span starting at or after `start`, and the one before it.
        if (idx < claimed.length && claimed[idx].start < end) return true;
        if (idx > 0 && claimed[idx - 1].end > start) return true;
        return false;
      };
      const KIND_RULE = {
        email: 'email', phone: 'phone_india', ssn: 'us_ssn', aadhaar: 'aadhaar',
        pan: 'pan_india', gstin: 'gstin', card: 'payment_card', account: 'iban',
        passport: 'indian_passport', name: 'person_name', address: 'postal_address',
        dob: 'person_name', salary: 'person_name', health: 'health_information',
        device: 'imei', secret: 'high_entropy_assignment',
      };
      for (const cell of table.cellSpans()) {
        if (overlapsClaimed(cell.start, cell.end)) continue;
        findings.push({
          ruleId: KIND_RULE[cell.kind] || 'person_name',
          label: cell.label || 'Personal data',
          severity: table.severity === 'critical' ? 'high' : 'medium',
          confidence: 'likely',
          note: null,
          advisory: false,
          audience: 'everyone',
          start: cell.start, end: cell.end, match: cell.value,
          preview: mask(cell.value), fingerprint: fp(cell.value),
          line: line(cell.start),
        });
      }
      findings.sort((a, b) => a.start - b.start);
    } catch (err) {
      errors.push({ ruleId: 'table', stage: 'cells', message: String(err && err.message) });
    }
  }

  const blockSet = new Set(p.block);
  const warnSet = new Set(p.warn);
  let verdict = 'clean';
  if (findings.some((f) => blockSet.has(f.severity))) verdict = 'block';
  else if (findings.some((f) => warnSet.has(f.severity))) verdict = 'warn';
  if (table) {
    if (blockSet.has(table.severity)) verdict = 'block';
    else if (verdict === 'clean' && warnSet.has(table.severity)) verdict = 'warn';
  }

  const risk = exposureScore(findings, table);

  return {
    findings,
    groups: groupFindings(findings),
    advisories: findings.filter((f) => f.advisory),
    counts,
    verdict,
    scanned: coverage ? coverage.head + coverage.tail : text.length,
    truncated,
    coverage,
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

/**
 * Secrets that arrive encoded.
 *
 * The engine reads text, and the most common way a real secret appears in text
 * a developer pastes is not as text. A Kubernetes Secret's `data:` values are
 * *always* Base64 — that is the format, not an evasion — so "why is my pod not
 * picking this up?" followed by the manifest is a credential in a prompt that
 * no pattern in `rules.js` can see. The same is true of a `Basic` auth header,
 * of `client-key-data` in a kubeconfig, of a `.env` file Base64'd for a CI
 * variable, and of a `data:` URI.
 *
 * Measured before this existed, on `AWS_ACCESS_KEY_ID=AKIA…`:
 *
 *   plain                       caught
 *   Base64                      clean
 *   Base64 with a label         clean
 *   Base64url                   clean
 *   URL-encoded                 clean
 *   inside a data: URI          clean
 *   hex                         clean
 *
 * Nine of fourteen encodings went through silently. This module finds the
 * encoded runs, decodes them, and hands the result back to be scanned — so the
 * detectors stay a single source of truth and nothing here knows what a secret
 * looks like.
 *
 * Three rules it keeps to, each of which is a constraint rather than a
 * nicety:
 *
 *   It can only add.  A decode never clears a finding, never lowers a
 *   severity, and never turns `partial` coverage into `clean`. If the decode
 *   is wrong, the worst case is a finding nobody wanted — not a secret
 *   waved through.
 *
 *   It is bounded.  This runs on every paste, including a 5 MB one, and on
 *   text an attacker may have composed. The budgets below cap the number of
 *   candidates, the bytes decoded, and the depth — a Base64 of a Base64 is
 *   real (a k8s Secret holding a kubeconfig) and a Base64 of a Base64 of a
 *   Base64 is somebody probing for a stack overflow.
 *
 *   It says the finding was encoded.  A value that is not literally in the
 *   text cannot be redacted by replacing itself, and pretending otherwise
 *   would be the exact substitution this project exists to prevent. Each
 *   decoded finding carries the span of the *encoded* run it came from, so
 *   the caller can replace that instead, and a label saying how it was
 *   hidden.
 */

/** Budgets. Changing any of these changes what a hostile paste can cost. */
export const LIMITS = {
  minRun: 24,          // shortest encoded run worth decoding
  maxRun: 262144,      // longest; beyond this it is a payload, not a secret
  maxCandidates: 64,   // how many runs one scan will decode
  maxDecodedBytes: 262144,
  maxDepth: 2,         // decodes, not nesting levels: a Secret holding a
                       // kubeconfig needs two; a third is somebody probing
  minPrintable: 0.9,   // a decode that is mostly bytes is not text
};

/**
 * A run of Base64, standard or URL-safe.
 *
 * `minRun` is 24 because that is below any credential worth carrying — a bare
 * AWS key id Base64s to 28 characters — and far enough above a UUID without
 * dashes (32 hex characters, which this would otherwise decode on every
 * sighting) that the candidate count on ordinary source stays small.
 *
 * The two alphabets are separate expressions rather than one union, because
 * `+/` and `-_` do not mix in any real encoder and allowing both at once
 * matches long identifiers that are neither.
 */
const B64 = /[A-Za-z0-9+/]{24,}={0,2}/g;
const B64URL = /[A-Za-z0-9_-]{24,}={0,2}/g;
const HEX = /\b(?:[0-9A-Fa-f]{2}){12,}\b/g;

/**
 * Percent-encoding is not a run of escapes, it is a URL with escapes in it.
 *
 * The first version of this looked for three or more `%XX` in a row, which
 * finds a deliberately obfuscated string and misses every real one:
 * `AWS_ACCESS_KEY_ID%3DAKIA…` has exactly one escape, and that one escape is
 * enough to hide the `=` the detector needs for its context. So the run is
 * the surrounding region of URL-legal characters, and it qualifies if there
 * is an escape anywhere in it.
 */
const URLISH = /[A-Za-z0-9._~%:/?#\[\]@!$&'()*+,;=-]{12,}/g;
const HAS_ESCAPE = /%[0-9A-Fa-f]{2}/;

/** `&#65;` and `&#x41;` — HTML that was escaped on the way into a page. */
const ENTITIES = /(?:&#(?:x[0-9A-Fa-f]{1,6}|[0-9]{1,7});){6,}/g;

/** `\x41` and `\u0041` — a string literal written to be unreadable. */
const ESCAPES = /(?:\\(?:x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|u\{[0-9A-Fa-f]{1,6}\})){6,}/g;

/** Is this plausibly the text somebody encoded, rather than compressed bytes? */
function looksLikeText(s) {
  if (!s) return false;
  let printable = 0;
  let letters = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) printable++;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters++;
  }
  return printable / s.length >= LIMITS.minPrintable && letters >= 4;
}

function fromBase64(run, urlSafe) {
  // A run whose length is not a multiple of four is a slice of something, or
  // an identifier that happens to use the alphabet. Padding it is guessing.
  const body = run.replace(/=+$/, '');
  if (body.length % 4 === 1) return null;
  const std = urlSafe ? body.replace(/-/g, '+').replace(/_/g, '/') : body;
  try {
    const bytes = Uint8Array.from(atob(std + '='.repeat((4 - (std.length % 4)) % 4)),
      (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch { return null; }
}

function fromPercent(run) {
  try { return decodeURIComponent(run); } catch { return null; }
}

function fromHex(run) {
  if (run.length % 2) return null;
  let out = '';
  for (let i = 0; i < run.length; i += 2) out += String.fromCharCode(parseInt(run.slice(i, i + 2), 16));
  return out;
}

function fromEntities(run) {
  return run.replace(/&#(x[0-9A-Fa-f]{1,6}|[0-9]{1,7});/g, (_, d) =>
    String.fromCodePoint(d[0] === 'x' || d[0] === 'X' ? parseInt(d.slice(1), 16) : Number(d)));
}

function fromEscapes(run) {
  return run.replace(/\\x([0-9A-Fa-f]{2})|\\u\{([0-9A-Fa-f]{1,6})\}|\\u([0-9A-Fa-f]{4})/g,
    (_, x, braced, u) => String.fromCodePoint(parseInt(x || braced || u, 16)));
}

const DECODERS = [
  { how: 'Base64', re: B64, decode: (r) => fromBase64(r, false) },
  { how: 'Base64url', re: B64URL, decode: (r) => fromBase64(r, true) },
  { how: 'URL encoding', re: URLISH, decode: fromPercent, gate: HAS_ESCAPE },
  { how: 'hexadecimal', re: HEX, decode: fromHex },
  { how: 'HTML escaping', re: ENTITIES, decode: fromEntities },
  { how: 'string escaping', re: ESCAPES, decode: fromEscapes },
];

/**
 * Every decodable run in `text`, with where it was and how it was hidden.
 *
 * Returns `{ start, end, how, text, depth }` for each, outermost first. The
 * spans are positions in the *original* text at depth 0; a nested decode
 * carries the span of its outermost ancestor, because that is the only span a
 * caller can usefully replace.
 *
 * @param {string} text
 * @param {object} [limits]
 */
export function decodedRuns(text, limits = LIMITS) {
  const out = [];
  if (typeof text !== 'string' || text.length < limits.minRun) return out;
  let budget = limits.maxDecodedBytes;

  // Identical decodes of the same span, however many decoders produced them.
  // `[A-Za-z0-9]` is in both Base64 alphabets, so a run with no `+/-_` in it
  // matches twice and decodes to the same string twice — which reached the
  // panel as "AWS access key ID x2" for a single key.
  const produced = new Set();

  const walk = (haystack, depth, span) => {
    // `>=`, not `>`. `maxDepth` counts decodes, and with `>` a maxDepth of 2
    // ran at depths 0, 1 and 2 — three of them. The test that caught this
    // asserted the documented behaviour rather than the implemented one,
    // which is the only reason it was a failing test and not a comment.
    if (depth >= limits.maxDepth || out.length >= limits.maxCandidates || budget <= 0) return;

    /**
     * Gather every candidate first, then take the longest.
     *
     * The alphabets overlap, and that is not only a duplicate-work problem.
     * A Base64url run ending `w7vDv8O-` is matched by the standard-alphabet
     * expression too — up to but not including the `-` — and that truncated
     * prefix decodes to *almost* the same text. So the same secret was
     * reported twice, once labelled "Base64" and once "Base64url", and the
     * first of those was both a duplicate and a lie about how it was hidden.
     *
     * Longest wins, and a candidate contained inside one already accepted is
     * dropped. Decoders are tried in declaration order on an exact tie, so a
     * run that is valid in both alphabets is reported as plain Base64 —
     * which is what it is.
     */
    const candidates = [];
    for (let i = 0; i < DECODERS.length; i++) {
      const { how, re, decode, gate } = DECODERS[i];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(haystack)) !== null) {
        const run = m[0];
        if (run.length > limits.maxRun || run.length < limits.minRun) continue;
        if (gate && !gate.test(run)) continue;
        candidates.push({ how, decode, run, start: m.index, end: m.index + run.length, order: i });
        if (candidates.length > limits.maxCandidates * 8) break;
      }
    }
    candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start)
      || a.start - b.start || a.order - b.order);

    const accepted = [];
    const contained = (c) => accepted.some((a) => c.start >= a.start && c.end <= a.end);

    for (const c of candidates) {
      if (out.length >= limits.maxCandidates || budget <= 0) return;
      if (contained(c)) continue;

      let decoded;
      try { decoded = c.decode(c.run); } catch { decoded = null; }
      if (!decoded || !looksLikeText(decoded)) continue;
      // A decode that returns its own input is an identity, not a decode:
      // percent-encoding with nothing to unescape, hex of ASCII hex.
      if (decoded === c.run) continue;

      const here = span || { start: c.start, end: c.end };
      const made = `${here.start}:${here.end}:${decoded}`;
      if (produced.has(made)) continue;
      produced.add(made);
      budget -= decoded.length;
      accepted.push(c);

      out.push({ ...here, how: c.how, text: decoded, depth });
      walk(decoded, depth + 1, here);
    }
  };

  walk(text, 0, null);
  return out;
}

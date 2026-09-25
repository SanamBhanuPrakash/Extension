/**
 * Indirect prompt injection, in text the user is about to paste.
 *
 * The threat runs the other way from everything else in this engine. Here the
 * user is not the leaker — they are the carrier. Someone pastes a web page, a
 * support ticket, a CV or a scraped document into an assistant, and that text
 * contains instructions aimed at the model rather than at the reader.
 *
 * OWASP lists this as LLM01 and an empirical 2026 study found it in the wild.
 * The payloads that matter are the ones a human skims past: white-on-white
 * text, zero-width characters, HTML comments, and polite imperatives addressed
 * to "the assistant".
 *
 * Detection is advisory. A document can legitimately discuss prompt injection
 * — this file does — so the finding says "this text contains instructions
 * aimed at an assistant", and the person decides.
 */

/**
 * The qualifier is mandatory, not optional.
 *
 * An earlier version made "previous / prior / above / system" optional, so
 * the phrase "ignore rules" matched — and a .gitignore file explaining ignore
 * rules was reported as a prompt-injection attack. A real payload points at
 * something: *these* instructions, *your* system prompt, the text *above*.
 */
const IMPERATIVE = /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|every\s+)?(?:of\s+)?(?:the\s+|your\s+|these\s+|those\s+|my\s+)?(?:previous|prior|above|earlier|preceding|foregoing|original|initial|system|prior\s+system)\s+(?:instruction|prompt|rule|direction|guideline|message|context)s?\b/i;
const ROLE_ADDRESS = /\b(?:you\s+are\s+now|from\s+now\s+on,?\s+you|new\s+instructions?:|system\s*(?:prompt|message)\s*:|act\s+as\s+(?:a\s+|an\s+)?(?:unrestricted|jailbroken|different)|pretend\s+(?:you\s+are|to\s+be))/i;
/**
 * A destination is mandatory. Without it, "leak secrets" in a threat model and
 * "send the token" in API documentation both matched — descriptive prose, not
 * instructions.
 */
const EXFIL = /\b(?:send|post|forward|upload|transmit|exfiltrate|email)\s+(?:the\s+|all\s+|your\s+|this\s+|any\s+|our\s+){0,2}(?:conversation(?:\s+history)?|chat\s+(?:history|log)|message\s+history|transcript|system\s+prompt|credentials?|api\s+keys?|tokens?|secrets?)\s+(?:to|at|via|using|through)\s+\S/i;
const TOOL_ABUSE = /\b(?:call|invoke|execute|run)\s+(?:the\s+)?(?:tool|function|command|shell|bash)\b.{0,40}\b(?:curl|wget|fetch|http|eval|exec)\b/i;
const MARKDOWN_EXFIL = /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*\{[^}]*\}[^)]*\)/;

/**
 * Characters that carry meaning to a model and nothing to a reader.
 *
 * ZWJ (U+200D) and ZWNJ (U+200C) are deliberately absent. Both are REQUIRED
 * for correct rendering of Devanagari, Arabic and emoji sequences — a family
 * emoji is four people joined by three ZWJ — and counting them flagged
 * ordinary multilingual text as an attack. What remains has no legitimate use
 * in running prose.
 *
 * Built from code points rather than written as escapes: an earlier edit
 * literalised the escapes into actual invisible characters in this file,
 * which is both unreadable and impossible to review in a diff.
 */
const charClass = (points, flags) =>
  new RegExp('[' + points.map((c) => String.fromCodePoint(c)).join('') + ']', flags);

const ZERO_WIDTH = charClass([0x200b, 0x2060, 0xfeff, 0x180e], 'g');

/**
 * Unicode tag block: an invisible channel for smuggling instructions past a
 * reader. It has no legitimate use in text, so it counts on its own.
 *
 * Two forms, on purpose. RegExp.prototype.test is stateful on a global regex,
 * so a /g version would return false on every other call.
 */
const TAG_CHARS = /[\u{e0000}-\u{e007f}]/u;
const TAG_CHARS_G = /[\u{e0000}-\u{e007f}]/gu;

const BIDI_OVERRIDE = charClass([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069], 'g');

/** Text hidden from a reader by CSS but delivered to the model in full. */
const HIDDEN_CSS = /<[^>]+style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0|color\s*:\s*(?:#fff(?:fff)?|white|transparent))[^"']*["']/i;
const HTML_COMMENT = /<!--[\s\S]{0,4000}?-->/;

export const SIGNALS = [
  { id: 'override', label: 'instructions telling an assistant to ignore its rules', test: (t) => IMPERATIVE.test(t), weight: 3 },
  { id: 'role', label: 'an attempt to reassign the assistant’s role', test: (t) => ROLE_ADDRESS.test(t), weight: 3 },
  { id: 'exfil', label: 'a request to send the conversation or credentials somewhere', test: (t) => EXFIL.test(t), weight: 3 },
  { id: 'tool', label: 'an attempt to make the assistant run a command', test: (t) => TOOL_ABUSE.test(t), weight: 3 },
  { id: 'image-exfil', label: 'a markdown image URL that would carry data out', test: (t) => MARKDOWN_EXFIL.test(t), weight: 3 },
  { id: 'hidden-css', label: 'text hidden by CSS but still sent to the model', test: (t) => HIDDEN_CSS.test(t), weight: 2 },
  { id: 'comment', label: 'instructions inside an HTML comment', test: (t) => HTML_COMMENT.test(t) && (IMPERATIVE.test(t) || ROLE_ADDRESS.test(t)), weight: 2 },
  {
    id: 'invisible',
    label: 'invisible characters that a model reads and you cannot see',
    // A stray zero-width joiner is normal in many scripts; a cluster is not.
    // The Unicode tag block has no legitimate use in prose, so it counts on
    // its own; a cluster of zero-width joiners is suspicious but weaker.
    // Density, not a raw count: a long document may legitimately carry a few.
    test: (t) => {
      if (TAG_CHARS.test(t)) return true;
      const zw = (t.match(ZERO_WIDTH) || []).length;
      if (zw >= 8 && zw / Math.max(1, t.length) > 0.0008) return true;
      return (t.match(BIDI_OVERRIDE) || []).length >= 2;
    },
    weight: 3,
  },
];

/**
 * @returns {{score:number, signals:Array<{id,label}>, severity:string}|null}
 */
export function detectInjection(text) {
  if (typeof text !== 'string' || text.length < 24) return null;
  const hit = [];
  let weight = 0;
  for (const signal of SIGNALS) {
    let fired = false;
    try { fired = signal.test(text); } catch { fired = false; }
    if (fired) { hit.push({ id: signal.id, label: signal.label }); weight += signal.weight; }
  }
  // One weak signal is not enough. Reporting on a single weight-2 signal
  // produced false positives on ordinary documents; a real payload trips
  // either a strong signal or two weak ones together.
  if (weight < 3) return null;
  return {
    score: weight,
    signals: hit,
    // One weak signal is a warning; a strong one, or two together, is not.
    severity: weight >= 3 ? 'critical' : 'high',
  };
}

/** Strips the invisible channels, leaving the visible text intact. */
export function stripInvisible(text) {
  return String(text).replace(ZERO_WIDTH, '').replace(TAG_CHARS_G, '').replace(BIDI_OVERRIDE, '');
}

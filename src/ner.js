/**
 * Names and addresses in ordinary prose.
 *
 * The gap every version of this project has documented. A pattern engine sees
 * `AKIA…` and is blind to "Priya Nair, 14 Koregaon Park Road, Pune 411001" —
 * which is the form most personal data actually takes outside a database
 * export.
 *
 * ── Why this is not just the classifier ──────────────────────────────────
 *
 * `nameweights.js` holds a logistic regression over hashed character n-grams,
 * trained on 30,675 person names from 75 locales against 46,528 hard negatives
 * (cities, companies, products, animals, job titles, months, vocabulary). It
 * reaches **F1 71.7%** on held-out tokens, and more training does not help.
 *
 * That ceiling is real, not a tuning failure: a Yoruba place name and a Yoruba
 * person name share their morphology, so no amount of character evidence
 * separates them. "Austin", "Paris" and "Virginia" are person names and places
 * simultaneously — 1,900 such tokens were dropped from training rather than
 * labelled arbitrarily.
 *
 * So the classifier is one piece of evidence among several, combined in log-odds
 * with structural evidence that *is* decisive: an honorific in front, a second
 * name-like token beside it, a verb of communication after it, a signature
 * block around it. This is the same shape as Microsoft Presidio's design
 * (recogniser plus context enhancement), and the pipeline measures far better
 * than its classifier does — see `bench/ner.js`.
 */
import { features } from './namefeatures.js';
import { SCALE, BIAS, THRESHOLD, PACKED } from './nameweights.js';
import { isCommonWord } from './commonwords.js';
import { isKnownName } from './nonlatinnames.js';

// ── model ────────────────────────────────────────────────────────────────

let WEIGHTS = null;
function weights() {
  if (WEIGHTS) return WEIGHTS;
  // Decoded once, lazily: a content script that never sees a capitalised token
  // should not pay for this.
  const bin = typeof atob === 'function'
    ? Uint8Array.from(atob(PACKED), (c) => c.charCodeAt(0))
    : Uint8Array.from(Buffer.from(PACKED, 'base64'));
  WEIGHTS = new Int8Array(bin.buffer, bin.byteOffset, bin.byteLength);
  return WEIGHTS;
}

const seen = new Map();

/** P(token is a person name) from character evidence alone. */
export function nameScore(token) {
  if (seen.has(token)) return seen.get(token);
  const w = weights();
  let z = BIAS;
  features(token, (i) => { z += w[i] * SCALE; });
  const p = 1 / (1 + Math.exp(-z));
  if (seen.size < 4000) seen.set(token, p);
  return p;
}

// ── lexicons ─────────────────────────────────────────────────────────────

const HONORIFIC = /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Professor|Sir|Madam|Shri|Smt|Sri|Kum|Capt|Col|Maj|Lt|Rev|Hon|Fr|Sr|Jr)\.?$/i;

/** Capitalised tokens that are systematically not people. */
const STOP = new Set(`January February March April May June July August September October November December
Monday Tuesday Wednesday Thursday Friday Saturday Sunday Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec
Mon Tue Tues Wed Thu Thur Thurs Fri Sat Sun Today Tomorrow Yesterday
The A An And Or But If Then Else When While For In On At To From With Without By Of As Is Are Was Were Be Been
This That These Those There Here It Its We Our You Your They Their He She His Her I My Me Us Them Not No Yes
Please Thanks Thank Regards Best Hi Hello Dear Hey Good Morning Afternoon Evening Night
Q1 Q2 Q3 Q4 FY CEO CTO CFO COO CIO CISO VP SVP EVP HR IT PR QA UX UI API SDK URL HTTP HTTPS JSON XML CSV PDF SQL
AWS GCP Azure Google Microsoft Amazon Apple Meta OpenAI Anthropic GitHub GitLab Slack Notion Figma Linear Stripe
React Node Python Java Ruby Rust Docker Kubernetes Linux Windows MacOS Android iOS Chrome Firefox Safari Edge
Monday's Inc Ltd LLC LLP Pvt Plc Corp Corporation Company Limited Group Holdings Ventures Partners Capital
North South East West Central Street Road Avenue Lane Drive Boulevard Block Sector Phase Floor Suite Unit
Note NOTE TODO FIXME Error Warning Info Debug Fatal Exception Traceback Stack Request Response Status
Mr Mrs Ms Mx Dr Prof Professor Sir Madam Shri Smt Sri Kum Capt Col Maj Lt Rev Hon Fr
Confidential Privileged Internal Restricted Proprietary Draft Final Version Revision Update Summary Report`
  .split(/\s+/).filter(Boolean));

/** Words that, sitting next to a capitalised token, argue it is a person. */
const BEFORE_CUE = /(?:\b(?:name is|named|called|contact|spoke (?:to|with)|met|met with|according to|signed by|reported by|assigned to|owner|manager|lead|from|cc|to|attn|attention|regards|sincerely|thanks|thank you|hi|hello|dear|hey|mr|mrs|ms|dr|prof|shri|smt|sri)\b[\s,:]*)$/i;
const AFTER_CUE = /^[\s,]*(?:said|says|wrote|asked|replied|confirmed|reported|mentioned|added|noted|resigned|joined|left|is|was|has|had|will|can|'s|’s|\(|<|@)/i;
const JOB_CUE = /^[\s,(]*(?:CEO|CTO|CFO|COO|CIO|CISO|VP|Director|Manager|Head|Lead|Engineer|Designer|Analyst|Consultant|Partner|Founder|President|Chair|Officer|Advisor|Counsel|Attorney|Doctor|Nurse|Professor)\b/i;

/**
 * Words that argue a capitalised token is a *place* or a *thing*, not a person.
 * Many city names are also given names — Sydney, Austin, Paris, Georgia — so
 * character evidence cannot settle it and the surrounding words must.
 */
const PLACE_BEFORE = /\b(?:the|in|at|from|to|near|across|within|our|their)\s+$/i;
const PLACE_AFTER = /^[\s,]*(?:region|regions|office|offices|branch|branches|team|cluster|clusters|server|servers|datacent(?:re|er)|data cent(?:re|er)|timezone|time zone|market|markets|store|stores|warehouse|campus|airport|zone|instance|node|endpoint|environment|deployment|release|version|API|SDK|repo|repository|pipeline|build)\b/i;

/**
 * Nouns that belong to document titles and headings rather than to people.
 *
 * This matters far more now that Chhanni reads .docx and .pptx than it did
 * when it only ever saw pasted prose: the first thing a document extractor
 * hands over is the title, and "Master Services Agreement" has precisely the
 * shape of a three-part name — three capitalised words, none of them a common
 * English word the existing gate would catch.
 *
 * These are trimmed from the ends of a run rather than used to reject it, so
 * "Priya Nair Agreement" still reports Priya Nair. Occupational surnames
 * (Baker, Marshall, Carpenter, Park) are deliberately absent: they are real
 * surnames, and the cost of losing one is higher than the cost of a heading.
 */
const TITLE_NOUN = /^(?:agreement|services?|review|reports?|summary|memo|memorandum|minutes|proposal|statement|policy|overview|plan|update|notes?|deck|agenda|invoice|receipt|contract|addendum|annexure|annex|appendix|schedule|exhibit|terms?|conditions|disclosure|confidential|privileged|draft|final|version|roadmap|strategy|budget|forecast|analysis|assessment|audit|charter|guidelines?|handbook|manual|specification|requirements|template|checklist|register|ledger|balance|sheet|board|committee|meeting|quarter|quarterly|annual|monthly|weekly|master|standard|framework|process|procedure|protocol|records?|room|letter|intent|offer|quote|quotation|purchase|payroll|expenses?|reimbursement|onboarding|offboarding|incident|postmortem|retrospective|runbook|playbook|dashboard|metrics|objectives|targets|confidentiality|amendment|renewal|termination|invoicing|remittance|advice|slip|form|application|declaration|undertaking|affidavit|deed|title|clause|section|article)$/i;

// ── address lexicons ─────────────────────────────────────────────────────

const STREET_WORD = /^(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Place|Pl|Terrace|Way|Close|Crescent|Parade|Square|Sq|Highway|Hwy|Parkway|Pkwy|Circle|Cir|Trail|Marg|Nagar|Colony|Vihar|Puram|Layout|Cross|Main|Sector|Enclave|Extension|Chowk|Gali|Pura|Bagh|Garden|Gardens|Park|Estate|Township|Society|Complex|Heights|Residency|Apartments|Towers)\.?$/i;
const UNIT_WORD = /^(?:Flat|Apt|Apartment|Suite|Unit|Plot|House|Door|Room|Block|Tower|Wing|Floor|No|Shop|Villa|Bungalow|PO|P\.?O\.?)\.?$/i;

/** Postcodes, by country. Each is anchored and checked whole. */
const POSTCODE = [
  { re: /^[1-9][0-9]{5}$/, label: 'PIN code', country: 'IN' },
  { re: /^[0-9]{5}(?:-[0-9]{4})?$/, label: 'ZIP code', country: 'US' },
  { re: /^[A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2}$/i, label: 'postcode', country: 'UK' },
  { re: /^[A-Z][0-9][A-Z]\s?[0-9][A-Z][0-9]$/i, label: 'postal code', country: 'CA' },
  { re: /^[0-9]{4}$/, label: 'postcode', country: 'AU' },
  { re: /^[0-9]{5}-?[0-9]{3}$/, label: 'CEP', country: 'BR' },
];

// ── tokenisation ─────────────────────────────────────────────────────────

// No '.' inside a token. An earlier version allowed it, so "Nair." was a
// single token and the run-joiner saw only a space before the next sentence's
// "Dr." — merging two people across a full stop into one span.
const TOKEN = /[\p{L}][\p{L}'’-]*|\d+[\w-]*/gu;

/**
 * A cheap line-level gate for address detection.
 *
 * Tokenising every line and testing six postcode patterns against every token
 * was the single most expensive thing in the pipeline — roughly 48,000 regex
 * tests on a 46 KB document. Every address this detector accepts contains a
 * street or unit word, so one test per line decides whether the line is worth
 * tokenising at all.
 *
 * The cost is stated rather than hidden: an address written with no street or
 * unit word ("Koregaon Park, Pune 411001") is not found. That is a deliberate
 * trade for roughly a 6x speed-up on ordinary text.
 */
const ADDRESS_HINT = /\b(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Place|Pl|Terrace|Way|Close|Crescent|Parade|Square|Sq|Highway|Hwy|Parkway|Pkwy|Circle|Cir|Trail|Marg|Nagar|Colony|Vihar|Puram|Layout|Cross|Main|Sector|Enclave|Extension|Chowk|Gali|Pura|Bagh|Garden|Gardens|Park|Estate|Township|Society|Complex|Heights|Residency|Apartments|Towers|Flat|Apt|Apartment|Suite|Unit|Plot|House|Door|Room|Block|Tower|Wing|Floor|Shop|Villa|Bungalow)\b/i;

/** Only worth testing a token against the postcode table if it could be one. */
const POSTCODE_SHAPE = /^[0-9A-Za-z][0-9A-Za-z -]{2,9}$/;

// Name detection only ever examines capitalised tokens. Matching those
// directly skips every lowercase word in the document, which on ordinary prose
// is the overwhelming majority of it.
const CAPITALISED = /\p{Lu}[\p{L}'’-]*/gu;

// Compiled once. `lastIndex` is reset by the caller before each use.
const TOKEN_RE = new RegExp(TOKEN.source, TOKEN.flags);

function tokenize(text) {
  const out = [];
  let m;
  const re = TOKEN_RE;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    if (out.length > 20000) break; // bound the work on a huge paste
  }
  return out;
}

const isCapitalised = (t) => /^[\p{Lu}]/u.test(t) && /[\p{Ll}]/u.test(t) && t.length > 1;

/**
 * True when a position sits inside a long unbroken run of non-space characters
 * — base64, a hash, a key blob. Random base64 contains capitalised runs that
 * score as names, and a person's name in prose is always surrounded by spaces.
 */
function insideBlob(text, start, end) {
  let left = start;
  while (left > 0 && !/\s/.test(text[left - 1]) && start - left < 48) left--;
  let right = end;
  while (right < text.length && !/\s/.test(text[right]) && right - end < 48) right++;
  return right - left >= 44;
}

/**
 * True when this token opens a sentence, where capitalisation means nothing.
 *
 * An abbreviation's full stop is not a sentence boundary. Without this, the
 * period in "Dr." marked the name it introduces as sentence-initial and the
 * -2.2 penalty cancelled the +3.4 the honorific had just earned — so
 * "Dr. Venkataraman" scored lower than a bare capitalised word.
 */
const ABBREV_END = /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Ave|Rd|No|vs|etc|eg|ie|approx|Inc|Ltd|Co|Corp|Capt|Col|Maj|Lt|Rev|Hon|Fr|Shri|Smt|Sri)\.\s*$/i;

function opensSentence(text, token, index) {
  if (index === 0) return true;
  const before = text.slice(Math.max(0, token.start - 12), token.start);
  if (ABBREV_END.test(before)) return false;
  return /[.!?:;\n•\-*]\s*$/.test(before);
}

// ── name detection ───────────────────────────────────────────────────────

const logit = (p) => Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p));

/**
 * @returns {Array<{start,end,text,score,evidence:string[]}>}
 */
export function findNames(text, options = {}) {
  const minScore = options.minScore ?? 0.72;
  // A city inside a postal address is part of the address, not a separate
  // person. Address spans are computed first and claim their territory.
  const claimed = options.claimed ?? findAddresses(text);

  const tokens = [];
  {
    const re = new RegExp(CAPITALISED.source, CAPITALISED.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
      if (tokens.length > 8000) break; // bound the work on a huge paste
    }
  }
  const spans = [];
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];
    if (!isCapitalised(tok.text) || STOP.has(tok.text)) { i++; continue; }

    // Greedily take the run of capitalised tokens (first, middle, last).
    let j = i;
    const run = [];
    while (j < tokens.length && isCapitalised(tokens[j].text) && !STOP.has(tokens[j].text) && run.length < 4) {
      // Only join tokens separated by a single space or a hyphen.
      if (run.length && text.slice(tokens[j - 1].end, tokens[j].start).replace(/[ \-]/g, '') !== '') break;
      run.push(tokens[j]);
      j++;
    }
    if (!run.length) { i++; continue; }

    // Heading words come off the ends first. See TITLE_NOUN.
    while (run.length && TITLE_NOUN.test(run[run.length - 1].text)) run.pop();
    while (run.length && TITLE_NOUN.test(run[0].text)) run.shift();
    if (!run.length) { i = j; continue; }

    // A run made entirely of ordinary English words is title-cased prose, not a
    // person: "All Hands", "Public Holiday", "Funnel Reports", "Settings".
    // Character evidence cannot decide this, because the characters really are
    // word-like — only the vocabulary can.
    if (run.every((t) => isCommonWord(t.text))) { i = j; continue; }

    const before = text.slice(Math.max(0, run[0].start - 40), run[0].start);
    const after = text.slice(run[run.length - 1].end, run[run.length - 1].end + 40);

    // Character evidence: the strongest token in the run carries the run.
    const scores = run.map((t) => nameScore(t.text.replace(/[.'’-]+$/, '')));
    const charEvidence = Math.max(...scores);

    let z = logit(charEvidence);
    const evidence = [];

    const honorific = HONORIFIC.test(before.trimEnd());
    if (honorific) { z += 3.4; evidence.push('honorific'); }
    else if (BEFORE_CUE.test(before)) { z += 1.9; evidence.push('introduced'); }
    if (AFTER_CUE.test(after)) { z += 1.2; evidence.push('acts'); }
    if (JOB_CUE.test(after)) { z += 1.6; evidence.push('job title'); }
    // Two or three capitalised tokens together is the shape of a full name and
    // is by far the most useful single signal.
    if (run.length >= 2) { z += 1.5 + 0.4 * (run.length - 2); evidence.push('full name'); }
    // A lone capitalised word opening a sentence is usually just a sentence.
    // An honorific in front settles it; position no longer matters.
    if (run.length === 1 && !honorific && opensSentence(text, run[0], i)) {
      z -= 2.2; evidence.push('sentence-initial');
    }
    // A single capitalised word with nothing around it to support it is the
    // highest false-positive case there is — every city, product and brand
    // lands here. Character evidence alone has to be overwhelming.
    // A lone capitalised token needs evidence that actually implies a person.
    // "Grafana, confirmed by..." has a verb after it, which is not enough:
    // products act in sentences too.
    const STRONG = new Set(['honorific', 'introduced', 'full name', 'job title', 'matching email']);
    if (run.length === 1 && !evidence.some((e) => STRONG.has(e))) z -= 1.9;
    // The classifier's negative set is Latin-only, so it has never seen an
    // ordinary Cyrillic, Greek or Armenian word and scores them all as names.
    // In those scripts character evidence is not admissible on its own.
    if (!/\p{Script=Latin}/u.test(run[0].text)) {
      const known = run.some((t) => isKnownName(t.text));
      if (known) { z += 2.2; evidence.push('known name'); }
      else if (!evidence.some((e) => STRONG.has(e))) { z -= 4.0; evidence.push('unverified script'); }
    }
    // Place and product context, which beats character evidence outright.
    if (PLACE_AFTER.test(after)) { z -= 4.6; evidence.push("followed by a place word"); }
    else if (run.length === 1 && PLACE_BEFORE.test(before)) { z -= 2.6; evidence.push("preposition"); }
    // Possessive reads as a person far more often than not.
    if (/^['’]s\b/.test(after)) { z += 0.9; evidence.push('possessive'); }
    // An email address on the same line that shares the name's letters.
    const line = text.slice(text.lastIndexOf('\n', run[0].start) + 1,
      text.indexOf('\n', run[0].end) === -1 ? text.length : text.indexOf('\n', run[0].end));
    const local = run[0].text.toLowerCase().slice(0, 4);
    if (local.length >= 3 && new RegExp(`${local}[a-z0-9._%-]*@`, 'i').test(line)) {
      z += 1.4; evidence.push('matching email');
    }

    const score = 1 / (1 + Math.exp(-z));
    const first = run[0];
    const last = run[run.length - 1];
    // A name-like substring inside something already identified — a key, a
    // token, an address — belongs to that thing, not to a person.
    const inside = claimed.some((a) => first.start >= a.start && last.end <= a.end)
      || insideBlob(text, first.start, last.end);
    if (score >= minScore && !inside) {
      spans.push({
        start: run[0].start,
        end: run[run.length - 1].end,
        text: text.slice(run[0].start, run[run.length - 1].end),
        score,
        evidence,
      });
    }
    i = j;
  }

  // Scripts without case are handled separately and merged in document order.
  for (const span of findNonLatinNames(text)) {
    const clash = spans.some((p) => span.start < p.end && p.start < span.end)
      || claimed.some((a) => span.start >= a.start && span.end <= a.end);
    if (!clash) spans.push(span);
  }
  spans.sort((a, b) => a.start - b.start);

  return spans;
}

// ── names in scripts without case ────────────────────────────────────────
//
// Everything above leans on capitalisation, which is a Latin-shaped assumption
// that quietly excludes most of the world. Arabic, Hebrew, Devanagari, Thai,
// Han, Hangul and the kana have no case at all, so the strongest feature in
// the pipeline does not exist for them.
//
// Two different instruments are needed, because the scripts differ in a way
// that matters more than the alphabet: whether words are separated by spaces.

/** Space-separated, uncased: a token is a unit, so a gazetteer hit is decisive. */
const SPACED_UNCASED = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Hangul}\u0640\u200c\u200d]+/gu;

/**
 * Dense scripts write without spaces, so there are no token boundaries to use.
 * A sliding window finds candidates, and because a two-character window will
 * inevitably collide with ordinary words, these additionally require a context
 * cue and are reported at lower confidence.
 */
const DENSE_UNCASED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\u30fc]+/gu;

function contextAround(text, start, end) {
  const before = text.slice(Math.max(0, start - 40), start);
  const after = text.slice(end, end + 40);
  return {
    honorific: HONORIFIC.test(before.trimEnd()),
    cue: BEFORE_CUE.test(before) || AFTER_CUE.test(after) || JOB_CUE.test(after),
  };
}

export function findNonLatinNames(text) {
  const spans = [];

  // Space-separated scripts: each run is a word; adjacent known names join.
  {
    const re = new RegExp(SPACED_UNCASED.source, SPACED_UNCASED.flags);
    let m;
    let pending = null;
    while ((m = re.exec(text)) !== null) {
      const token = m[0];
      const hit = token.length >= 2 && isKnownName(token);
      if (hit) {
        // Join to the previous match when only a space separates them, so a
        // given name and a family name become one span.
        if (pending && text.slice(pending.end, m.index).trim() === '') {
          pending.end = m.index + token.length;
          pending.parts++;
        } else {
          if (pending) spans.push(pending);
          pending = { start: m.index, end: m.index + token.length, parts: 1 };
        }
      } else if (pending) { spans.push(pending); pending = null; }
    }
    if (pending) spans.push(pending);
  }

  // Dense scripts: slide a window, longest match wins, context required.
  {
    const re = new RegExp(DENSE_UNCASED.source, DENSE_UNCASED.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const run = m[0];
      if (run.length < 2 || run.length > 80) continue;
      for (let i = 0; i < run.length; ) {
        let matched = 0;
        // Longest match first, up to the longest name in the gazetteer.
        // A four-character ceiling silently missed every Thai name.
        for (let len = Math.min(14, run.length - i); len >= 2; len--) {
          if (isKnownName(run.slice(i, i + len))) { matched = len; break; }
        }
        if (matched) {
          const start = m.index + i;
          const ctx = contextAround(text, start, start + matched);
          if (ctx.honorific || ctx.cue) {
            spans.push({ start, end: start + matched, parts: 1, dense: true });
          }
          i += matched;
        } else i++;
      }
    }
  }

  return spans.map((sp) => {
    const ctx = contextAround(text, sp.start, sp.end);
    const evidence = ['known name'];
    if (ctx.honorific) evidence.push('honorific');
    else if (ctx.cue) evidence.push('introduced');
    if (sp.parts > 1) evidence.push('full name');
    // A dense-script window is weaker evidence than a whole token, and a
    // multi-part span is stronger than a single one.
    const score = sp.dense ? 0.80 : sp.parts > 1 ? 0.97 : (ctx.honorific || ctx.cue) ? 0.95 : 0.88;
    return { start: sp.start, end: sp.end, text: text.slice(sp.start, sp.end), score, evidence };
  });
}

// ── address detection ────────────────────────────────────────────────────

/**
 * A postal address is a structure, not a vocabulary. Scored by how many of its
 * parts are present — a house number, a street word, a unit marker, a
 * postcode — so "45 Nursery Road" and "Flat 3B, 14 Koregaon Park Road, Pune
 * 411001" are both found, and "the Road ahead" is not.
 */
export function findAddresses(text, options = {}) {
  const minParts = options.minParts ?? 2;
  const lines = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    lines.push({ text: line, start: offset });
    offset += line.length + 1;
  }

  const spans = [];
  for (const line of lines) {
    if (line.text.length < 8 || line.text.length > 300) continue;
    // Every address this detector will accept is anchored by a number, so a
    // line with no digit cannot produce one. Skipping those before
    // tokenisation removes most of the work on ordinary prose.
    if (!/\d/.test(line.text) || !ADDRESS_HINT.test(line.text)) continue;
    const tokens = tokenize(line.text);
    if (tokens.length < 2) continue;

    let parts = 0;
    const evidence = [];
    let first = null;
    let last = null;
    const mark = (tok) => {
      if (first === null || tok.start < first) first = tok.start;
      if (last === null || tok.end > last) last = tok.end;
    };

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const bare = t.text.replace(/[.,]+$/, '');

      if (STREET_WORD.test(bare)) {
        // A street word only counts with something in front of it.
        if (i > 0 && (/^\d/.test(tokens[i - 1].text) || isCapitalised(tokens[i - 1].text))) {
          parts++; evidence.push('street'); mark(tokens[i - 1]); mark(t);
        }
        continue;
      }
      if (UNIT_WORD.test(bare) && i + 1 < tokens.length && /^[\d#]/.test(tokens[i + 1].text)) {
        parts++; evidence.push('unit'); mark(t); mark(tokens[i + 1]);
        continue;
      }
      if (!POSTCODE_SHAPE.test(bare) || !/\d/.test(bare)) {
        // Fall through to the house-number check below.
      } else for (const pc of POSTCODE) {
        if (pc.re.test(bare)) {
          // A bare 4- or 5-digit number is only a postcode with an address
          // around it, so it never counts on its own.
          if (parts > 0) { parts++; evidence.push(pc.label); mark(t); }
          break;
        }
      }
      // A house number: any number immediately before a capitalised word or a
      // street word, anywhere on the line. Restricting this to the first token
      // missed "...was sent to 221B Baker Street".
      if (/^\d{1,5}[A-Za-z]?$/.test(t.text) && i + 1 < tokens.length
          && (STREET_WORD.test(tokens[i + 1].text.replace(/[.,]+$/, '')) || isCapitalised(tokens[i + 1].text))) {
        parts++; evidence.push('house number'); mark(t); mark(tokens[i + 1]);
      }
    }

    // A postal address is anchored by a number: a house number or a postcode.
    // Without one, capitalised street words are just a sentence about roads.
    const anchored = evidence.includes('house number') || evidence.includes('unit')
      || evidence.some((e) => /code$/i.test(e) || e === 'CEP');
    if (parts >= minParts && anchored && first !== null) {
      spans.push({
        start: line.start + first,
        end: line.start + last,
        text: line.text.slice(first, last),
        parts,
        evidence: [...new Set(evidence)],
      });
    }
  }
  return spans;
}

/** Clears the memo, for benchmarks that want cold timings. */
export function resetCache() { seen.clear(); }

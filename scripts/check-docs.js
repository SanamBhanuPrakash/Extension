#!/usr/bin/env node
/**
 * Does the documentation still describe this code?
 *
 * This project leans on its documentation to explain where its boundaries are
 * — the threat model, the limitations, the four guarantees — so documentation
 * that has drifted is not a tidiness problem, it is a correctness problem. An
 * audit found the README claiming 96 tests against a repository with 97, which
 * is harmless on its own and is exactly the shape of the thing that is not.
 *
 * So the numbers the docs assert are checked against the numbers the code
 * produces, in CI, and a drift fails the build.
 *
 *   node scripts/check-docs.js
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES, PROOFS } from '../src/rules.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const tty = process.stdout.isTTY && !process.argv.includes('--no-color');
const c = (code, s) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const dim = (s) => c('2', s);

const problems = [];
const checks = [];

/** Like check(), but only the first match: the newest entry in a changelog. */
function checkFirst(what, actual, where, pattern) {
  const text = read(where);
  const first = [...text.matchAll(pattern)][0];
  if (!first) {
    problems.push(`${where}: no "${what}" figure found at all — the check itself has rotted`);
    return;
  }
  if (Number(first[1]) !== actual) {
    problems.push(`${where}: the newest entry says ${first[1]} ${what}, code says ${actual}`);
  } else {
    checks.push(`${what}: ${actual} ${dim(`(newest entry in ${where})`)}`);
  }
}

function check(what, actual, where, pattern) {
  const text = read(where);
  const found = [...text.matchAll(pattern)].map((m) => Number(m[1]));
  if (!found.length) {
    problems.push(`${where}: no "${what}" figure found at all — the check itself has rotted`);
    return;
  }
  const wrong = [...new Set(found.filter((n) => n !== actual))];
  if (wrong.length) {
    problems.push(`${where}: says ${wrong.join(', ')} ${what}, code says ${actual}`);
  } else {
    checks.push(`${what}: ${actual} ${dim(`(${found.length} mention${found.length === 1 ? '' : 's'} in ${where})`)}`);
  }
}

// ── how many tests there are ─────────────────────────────────────────────
//
// Counted from the source rather than by running the suite. Shelling out to
// `node --test` made this check depend on the runner's own output format,
// which differs between Node versions — it passed on 22 and failed on 24, in
// CI, for a repository whose documentation was correct. A checker that is
// wrong about the thing it checks is worse than no checker.
const testFiles = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.js'));
const tests = testFiles
  .reduce((n, f) => n + (read(`test/${f}`).match(/^test\(/gm) || []).length, 0);
if (!tests) {
  problems.push('found no tests at all — the check itself has rotted');
} else {
  check('tests', tests, 'README.md', /# (?:tests|pass) (\d+)/g);
  // Only the newest entry. A released changelog entry states what was true at
  // that release, and a guard that demands every historical line match the
  // current count is a guard that asks for history to be rewritten — which
  // this one did, for three entries, the first time the test count moved
  // after it was written.
  checkFirst('tests', tests, 'CHANGELOG.md', /^- (\d+) tests,/gm);
}

// ── detectors, and the ones that prove rather than match a shape ─────────
const detectors = RULES.length;
const proven = RULES.filter((r) => r.proof).length;
check('detectors', detectors, 'README.md', /\*\*(\d+) detectors/g);
check('detectors', detectors, 'docs/ARCHITECTURE.md', /(\d+) detectors/g);
check('detectors', detectors, 'docs/LIMITATIONS.md', /There are (\d+) detectors/g);
check('proofs', proven, 'README.md', /(\d+) prove the match/g);

if (Object.keys(PROOFS).length !== proven) {
  problems.push(`PROOFS names ${Object.keys(PROOFS).length} detectors, ${proven} rules carry a proof`);
}

// ── the store listing has a hard limit ───────────────────────────────────
const manifest = JSON.parse(read('extension/manifest.json'));
if (manifest.description.length > 132) {
  problems.push(`manifest description is ${manifest.description.length} characters; the Chrome limit is 132`);
} else {
  checks.push(`store description: ${manifest.description.length}/132 characters`);
}
const pkg = JSON.parse(read('package.json'));
// The `&& manifest.version !== '0.1.0'` that used to be on the end of this
// condition is why the drift survived: the check existed, and then the one
// value it needed to catch was whitelisted. scripts/build.js stamps the source
// manifest now, so there is nothing left to exempt.
if (pkg.version !== manifest.version) {
  problems.push(`package.json is ${pkg.version} and extension/manifest.json is ${manifest.version} — run node scripts/build.js`);
} else {
  checks.push(`version: ${pkg.version} in package.json and the manifest`);
}

// ── claims about where data goes, which must name their subject ──────────
//
// "Nothing ever leaves your browser" is true of Chhanni and false about the
// user's prompt, which goes to the AI provider the moment they send it. It is
// the single most dangerous sentence this project can write, because it is the
// one a reader cannot check, so it is checked here instead.
const SUBJECTLESS = [
  /nothing (?:you type|is|was) (?:ever )?(?:sent|transmitted)(?! to Chhanni)/i,
  /never leaves your browser/i,
  /nothing (?:ever )?leaves your (?:browser|machine|device)/i,
  /nothing was sent anywhere/i,
  /nothing is sent out/i,
];
const COPY_SURFACES = [
  'extension/content.js', 'extension/options.html', 'extension/popup.html',
  'PRIVACY.md', 'README.md', 'docs/PUBLISHING.md',
];
let subjectless = 0;
for (const file of COPY_SURFACES) {
  let text;
  try { text = read(file); } catch { continue; }
  for (const line of text.split('\n')) {
    // The lines explaining *why* the claim is wrong are allowed to quote it.
    if (/would be|used to|earlier draft|does not appear|instead of|rather than/i.test(line)) continue;
    for (const re of SUBJECTLESS) {
      if (re.test(line)) {
        problems.push(`${file}: a claim about sending does not name its subject — ${line.trim().slice(0, 80)}`);
        subjectless++;
      }
    }
  }
}
if (!subjectless) checks.push('every claim about sending names Chhanni as its subject');

// ── the permission count the UI states must be the one the manifest asks ──
const stated = read('extension/options.html').match(/asks for (one|two|three) permissions?/);
const WORDS = { one: 1, two: 2, three: 3 };
if (stated && WORDS[stated[1]] !== manifest.permissions.length) {
  problems.push(`options.html says the manifest asks for ${stated[1]} permission(s); it asks for ${manifest.permissions.length}`);
} else if (stated) {
  checks.push(`permissions: the options page and the manifest both say ${manifest.permissions.length}`);
}

// ── LIMITATIONS says how many sections it has, in several places ─────────
const sections = (read('docs/LIMITATIONS.md').match(/^## \d+\./gm) || []).length;
const words = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty'];
for (const where of ['README.md', 'docs/THREAT-MODEL.md']) {
  const claimed = [...read(where).matchAll(/in (\w+)\s*\n?sections/g)].map((m) => m[1]);
  for (const claim of claimed) {
    if (words.indexOf(claim) !== sections) {
      problems.push(`${where}: says LIMITATIONS has ${claim} sections, it has ${words[sections] || sections}`);
    }
  }
}
checks.push(`LIMITATIONS sections: ${sections}`);

// Spelled-out numbers drift just as easily, and read as more considered.
for (const [where, pattern, actual, what] of [
  ['docs/THREAT-MODEL.md', /it proves (\w+) of them arithmetically/g, proven, 'proofs'],
  ['docs/DECISIONS.md', null, null, null],
]) {
  if (!pattern) continue;
  for (const [, word] of read(where).matchAll(pattern)) {
    if (words.indexOf(word) !== actual) {
      problems.push(`${where}: says it proves ${word} ${what}, code says ${words[actual] || actual}`);
    }
  }
}

// DECISIONS numbers its records, and the README says how many there are.
const records = (read('docs/DECISIONS.md').match(/^### \d+[a-z]?\. /gm) || []).length;
for (const [, word] of read('README.md').matchAll(/\| \[DECISIONS\][^|]*\| ([\w-]+) decision records/g)) {
  // Handles any "<tens>-<unit>" compound rather than just the twenties, which
  // is what it understood until there were thirty-one of these.
  const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };
  const lower = word.toLowerCase();
  const [tens, unit] = lower.split('-');
  const value = TENS[tens] !== undefined
    ? TENS[tens] + (unit ? words.indexOf(unit) : 0)
    : words.indexOf(lower);
  if (value !== records) {
    problems.push(`README.md: says ${word} decision records, DECISIONS.md has ${records}`);
  }
}
checks.push(`decision records: ${records}`);

// ── the browser suite's own count ────────────────────────────────────────
//
// There is exactly one place in the documentation that says how many
// end-to-end cases run, and it went from fifteen to twenty-six without the
// sentence changing. A count stated once is a count nobody re-reads.
const WORDS_TO_N = (word) => {
  const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };
  const [tens, unit] = String(word).toLowerCase().split('-');
  return TENS[tens] !== undefined
    ? TENS[tens] + (unit ? words.indexOf(unit) : 0)
    : words.indexOf(String(word).toLowerCase());
};
const e2e = (read('test/e2e/run.mjs').match(/^await test\(/gm) || []).length;
if (!e2e) {
  problems.push('found no end-to-end cases at all — the check itself has rotted');
} else {
  let stated = 0;
  for (const [, word] of read('docs/TESTING.md').matchAll(/^([\w-]+) cases run\./gm)) {
    stated++;
    if (WORDS_TO_N(word) !== e2e) {
      problems.push(`docs/TESTING.md: says ${word} end-to-end cases run, test/e2e/run.mjs has ${e2e}`);
    }
  }
  if (!stated) problems.push('docs/TESTING.md: no end-to-end case count found at all');
  else checks.push(`end-to-end cases: ${e2e}`);
}

// ── a bundled font ships its licence ─────────────────────────────────────
//
// The extension bundles Inter rather than loading it from
// fonts.googleapis.com, because a webfont request would carry the fact that
// somebody is being shown a warning to a third party and would falsify the
// one promise this project makes. That is the right call and it has a
// condition attached. OFL-1.1, clause 2, verbatim:
//
//   "Original or Modified Versions of the Font Software may be bundled,
//    redistributed and/or sold with any software, provided that each copy
//    contains the above copyright notice and this license."
//
// Each copy. The store package is a copy. It shipped the .woff2 with no
// licence file in it at all — a CSS comment saying "Inter is OFL-1.1
// licensed" is not the licence, and the README is not inside the ZIP. For a
// project whose whole argument is that a claim must be checkable, shipping
// somebody else's work on the strength of an unaccompanied assertion was the
// wrong way round. This is the check that stops it coming back.
{
  let fonts = [];
  try {
    fonts = readdirSync(join(root, 'extension', 'fonts'))
      .filter((f) => /\.(woff2?|ttf|otf)$/i.test(f));
  } catch { /* no fonts directory */ }
  for (const font of fonts) {
    const licences = readdirSync(join(root, 'extension', 'fonts'))
      .filter((f) => /^(LICENSE|LICENCE|OFL)/i.test(f));
    if (!licences.length) {
      problems.push(`extension/fonts/${font} is redistributed with no licence beside it `
        + '— OFL-1.1 requires the copyright notice and the licence in every copy');
      break;
    }
    const text = licences.map((f) => read(`extension/fonts/${f}`)).join('\n');
    if (!/Copyright \(c\)/i.test(text)) {
      problems.push(`extension/fonts/${licences[0]} carries no copyright notice`);
    } else if (!/SIL OPEN FONT LICENSE|Apache License|MIT License/i.test(text)) {
      problems.push(`extension/fonts/${licences[0]} does not contain a licence this check recognises`);
    } else {
      checks.push(`bundled fonts: ${fonts.length}, licence shipped beside them`);
    }
    break;
  }
}

// ── the security claims a reader actually acts on ────────────────────────
//
// These drifted for weeks without anything noticing, and they are not
// cosmetic: PRIVACY.md told people their allowlist was synchronised to their
// other devices after that had stopped being true, THREAT-MODEL.md claimed
// one permission after there were two, and both named a hash function the
// code had replaced because the old one had no collision resistance.
//
// The permission count was already checked. What was missing is that the
// *prose* around it, and the storage architecture, and the hash, are claims a
// reader uses to decide whether to trust the thing. They get checked here.
{
  const manifest2 = JSON.parse(read('extension/manifest.json'));
  const perms = manifest2.permissions || [];
  // No document may say "one permission" while there are two, in any phrasing
  // that names a count.
  for (const where of ['docs/THREAT-MODEL.md', 'docs/PUBLISHING.md', 'PRIVACY.md', 'README.md']) {
    const text = read(where);
    if (/\b(one|a single|exactly one) permission\b/i.test(text) && perms.length !== 1) {
      problems.push(`${where}: says one permission, the manifest asks for ${perms.length}`);
    }
    if (/permissions === \['storage'\]/.test(text) && perms.length !== 1) {
      problems.push(`${where}: asserts permissions === ['storage'], the manifest asks for ${perms.join(', ')}`);
    }
  }

  /**
   * The allowlist's storage area, which is the claim the privacy policy makes.
   *
   * Checked against one canonical sentence rather than inferred from prose.
   *
   * The version before this scanned for the word "allowlist" near
   * `storage.sync` and excluded windows containing phrases like "never
   * synchronised". Two failures: an earlier attempt used `[^.]{0,120}` as the
   * window, which can never span `chrome.storage.sync` because that string is
   * full of dots; and the window that replaced it was wide enough that a
   * legitimate neighbouring sentence switched the check off. It passed a test
   * drift twice.
   *
   * Prose cannot be policed by proximity. So PRIVACY.md states the area in
   * one fixed shape — `**Your allowlist** (`chrome.storage.<area>`)` — and
   * that area is compared to the code. A contradiction elsewhere in the file
   * is a writing problem; this is the sentence a reader acts on.
   */
  const policy = read('extension/policy.js');
  const declared = policy.match(/LOCAL_FIELDS = \[([^\]]*)\]/);
  if (!declared) problems.push('extension/policy.js no longer declares LOCAL_FIELDS');
  const localFields = declared ? [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  if (declared && !localFields.includes('allow')) {
    problems.push('extension/policy.js does not keep the allowlist out of storage.sync');
  }
  {
    const text = read('PRIVACY.md');
    const claim = text.match(/\*\*Your allowlist\*\* \(`chrome\.storage\.(\w+)`\)/);
    if (!claim) {
      problems.push('PRIVACY.md no longer states which storage area holds the allowlist');
    } else if (claim[1] !== 'local') {
      problems.push(`PRIVACY.md says the allowlist lives in chrome.storage.${claim[1]}; `
        + 'policy.js keeps it in storage.local');
    }
    // And the file must still say so in words, not only in a parenthesis.
    if (!/never\s+synchronised/i.test(text)) {
      problems.push('PRIVACY.md no longer says the allowlist is never synchronised');
    }
  }

  // The fingerprint function, outside a sentence that is explicitly historical.
  for (const where of ['docs/THREAT-MODEL.md', 'PRIVACY.md', 'README.md']) {
    for (const line of read(where).split('\n')) {
      if (!/FNV/.test(line)) continue;
      if (/early version|used to|replaced|no longer|previously/i.test(line)) continue;
      problems.push(`${where}: names FNV-1a as current; fingerprints are salted SHA-256`);
      break;
    }
  }
  checks.push('security claims: permissions, allowlist storage and the hash all agree with the code');
}

// ── the plan documents cannot quietly go missing ─────────────────────────
//
// SYSTEM-DESIGN, V1-CONTRACT, RELEASE-GATE and PROVIDERS are the frozen
// architecture and the definition of done. They are the answer to this
// project's actual failure mode — endless auditing with no shape to fix
// things into — and a repository that lost one of them would be back to it.
for (const plan of ['docs/SYSTEM-DESIGN.md', 'docs/V1-CONTRACT.md',
  'docs/RELEASE-GATE.md', 'docs/PROVIDERS.md', 'docs/SHIP.md']) {
  if (!existsSync(join(root, plan))) problems.push(`${plan} is missing`);
}
// Every criterion the gate checks must be named in RELEASE-GATE.md, so the
// script and the document cannot drift apart.
{
  const gate = read('scripts/gate.js');
  const doc = read('docs/RELEASE-GATE.md');
  const criteria = [...gate.matchAll(/^gate\('[A-Z]+', '([^']+)'/gm)].map((m) => m[1]);
  const missing = criteria.filter((name) => !doc.includes(name));
  if (!criteria.length) problems.push('scripts/gate.js declares no criteria — the check has rotted');
  else if (missing.length) {
    problems.push(`docs/RELEASE-GATE.md does not list ${missing.length} gate criteri${missing.length === 1 ? 'on' : 'a'}: ${missing[0]}`);
  } else {
    checks.push(`release gate: ${criteria.length} criteria, all named in the document`);
  }
}

// The matrix is numbers; these sections are what a number means. The harness
// rewrites `## The matrix` in place precisely so these survive a
// certification run, and this guard is here because when the harness used to
// replace the whole file, every machine-readable invariant happened to live in
// the part that survived — so `check-docs.js` reported that the documentation
// agreed with the code while the explanation of the evidence had been deleted.
{
  const matrix = read('docs/PROVIDERS.md');
  const needed = ['## Cell meanings', '## The matrix',
    '## What V1 needs from this file', '## A pass expires'];
  const gone = needed.filter((h) => !matrix.includes(h));
  if (gone.length) problems.push(`docs/PROVIDERS.md lost ${gone.length} section(s): ${gone[0]}`);
  else if (!/\| `UNSUPPORTED` \|/.test(matrix)) {
    problems.push('docs/PROVIDERS.md no longer defines what each cell means');
  } else checks.push(`provider matrix: ${needed.length} explanatory sections intact`);
}

// The V1/V1.x boundary lives in two places that must agree: `V1_PATHS` in the
// provider harness, and the `(V1)` markers in the matrix the harness writes.
// `scripts/gate.js` reads the markers to decide whether V1 is blocked, so a
// disagreement between them does not fail loudly — it silently moves what the
// release promises. That is the defect class this whole pass is about.
{
  const harness = read('test/provider/run.mjs');
  const matrix = read('docs/PROVIDERS.md');
  const decl = harness.match(/const V1_PATHS = new Set\(\[([^\]]*)\]\)/);
  if (!decl) problems.push('test/provider/run.mjs no longer declares V1_PATHS');
  else {
    const declared = [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    const marked = matrix.split('\n')
      .filter((l) => /^\| .+ \(V1\) \|/.test(l))
      .map((l) => l.split('|')[1].trim().replace(/ \(V1\)$/, '')).sort();
    if (!marked.length) problems.push('docs/PROVIDERS.md marks no row (V1); the gate cannot find the boundary');
    else if (declared.join('|') !== marked.join('|')) {
      problems.push(`V1 paths disagree: harness says [${declared.join(', ')}], `
        + `docs/PROVIDERS.md marks [${marked.join(', ')}]`);
    } else checks.push(`V1 send paths: ${declared.length}, and the harness and the matrix agree`);

    // And the gate must see every row the harness writes. Both the gate's
    // criteria select matrix rows with /^\| [a-z]/ — a path named with a
    // capital would be silently invisible, including to the scan that fails
    // the build when a cell says FAIL. A leak the gate cannot see is worse
    // than one it reports.
    const paths = harness.match(/const PATHS = \[([\s\S]*?)\];/);
    const names = paths ? [...paths[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
    const visible = matrix.split('\n')
      .filter((l) => /^\| [a-z]/.test(l) && l.split('|').length > 5 && !/^\| path \|/.test(l));
    if (!names.length) problems.push('test/provider/run.mjs no longer declares PATHS');
    else if (visible.length !== names.length) {
      problems.push(`the gate sees ${visible.length} of the harness's ${names.length} matrix rows`
        + ' — a row it cannot select is a cell it cannot fail on');
    } else checks.push(`provider matrix: all ${names.length} paths visible to the gate`);
  }
}

// The gate's exit codes are a contract with whoever runs it in CI. The old
// document claimed the exit code answered "can this ship" while the script
// exited 0 on a PRE-PRODUCTION verdict, which is the substitution this
// product exists to catch, committed by the gate itself.
{
  const gate = read('scripts/gate.js');
  const doc = read('docs/RELEASE-GATE.md');
  const table = gate.match(/const EXIT = \{([^}]*)\}/);
  if (!table) problems.push('scripts/gate.js no longer declares its EXIT table');
  else {
    const named = [...table[1].matchAll(/(\w+):\s*(\d)/g)];
    const codes = [...new Set(named.map((m) => m[2]))];
    // Every declared code must be reachable from the exit expression, or the
    // table is documentation pretending to be a contract.
    // Anchored to the line start: gate.js also embeds a `process.exit(1)` in
    // a string it hands to a subprocess, and that one is not this contract.
    const exitLine = (gate.match(/^process\.exit\(([\s\S]*?)\);$/m) || [, ''])[1];
    const unused = named.filter((m) => !exitLine.includes(`EXIT.${m[1]}`)).map((m) => m[1]);
    if (unused.length) problems.push(`scripts/gate.js declares EXIT.${unused[0]} and never exits with it`);
    const documented = [...doc.matchAll(/^\| `(\d)` \|/gm)].map((m) => m[1]);
    const undocumented = codes.filter((x) => !documented.includes(x));
    const phantom = documented.filter((x) => !codes.includes(x));
    if (!documented.length) problems.push('docs/RELEASE-GATE.md documents no gate exit code');
    else if (undocumented.length || phantom.length) {
      problems.push(`gate exit codes: script uses [${codes.join(', ')}], `
        + `docs/RELEASE-GATE.md documents [${documented.join(', ')}]`);
    } else checks.push(`release gate: exit codes ${codes.sort().join('/')} match the document`);
    if (!/--release/.test(gate)) problems.push('scripts/gate.js has no --release mode');
    if (!/--release/.test(doc)) problems.push('docs/RELEASE-GATE.md does not document --release');
  }
}

// `docs/SHIP.md` is the only document whose job is to be executed by a person
// rather than read. Every command it names must exist, because the step it
// describes is the one blocking a release — and because this project has
// already shipped a documented step with no code behind it once.
{
  const ship = read('docs/SHIP.md');
  const scripts = JSON.parse(read('package.json')).scripts || {};
  const named = [...new Set([...ship.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]))];
  const missing = named.filter((n) => !scripts[n]);
  if (!named.length) problems.push('docs/SHIP.md names no command to run');
  else if (missing.length) {
    problems.push(`docs/SHIP.md tells a person to run \`npm run ${missing[0]}\`, `
      + 'which package.json does not define');
  } else checks.push(`ship checklist: ${named.length} command(s), all defined in package.json`);
}

// ── every doc link resolves ──────────────────────────────────────────────
for (const where of ['README.md', 'docs/LIMITATIONS.md', 'docs/BENCHMARK.md', 'docs/ARCHITECTURE.md',
  'docs/THREAT-MODEL.md', 'docs/ROADMAP.md', 'docs/DECISIONS.md', 'CHANGELOG.md', 'PRIVACY.md']) {
  for (const [, target] of read(where).matchAll(/\]\((?!https?:|#)([^)#]+)[^)]*\)/g)) {
    const from = where.includes('/') ? dirname(where) : '.';
    if (!existsSync(join(root, from, target))) {
      problems.push(`${where}: link to ${target} does not resolve`);
    }
  }
}
checks.push('every relative documentation link resolves');

for (const line of checks) console.log(`  ${green('ok')}  ${line}`);
if (problems.length) {
  console.log();
  for (const p of problems) console.log(`  ${red('drift')}  ${p}`);
  console.log(red(`\n${problems.length} place${problems.length === 1 ? '' : 's'} where the documentation and the code disagree.\n`));
  process.exit(1);
}
console.log(green('\ndocumentation agrees with the code\n'));

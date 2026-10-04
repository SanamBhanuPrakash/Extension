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
  check('tests', tests, 'CHANGELOG.md', /^- (\d+) tests,/gm);
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

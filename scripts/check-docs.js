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
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

// ── how many tests actually run ──────────────────────────────────────────
let tests = 0;
try {
  const out = execFileSync('node', ['--test', 'test/detect.test.js', 'test/documents.test.js', 'test/fuzz.test.js'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  tests = Number(/^# tests (\d+)$/m.exec(out)?.[1] ?? 0);
} catch (err) {
  // A failing suite still prints its totals; a broken runner does not.
  tests = Number(/^# tests (\d+)$/m.exec(String(err.stdout ?? ''))?.[1] ?? 0);
}
if (!tests) {
  problems.push('could not determine the test count — the suite did not report one');
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
if (pkg.version !== manifest.version && manifest.version !== '0.1.0') {
  problems.push(`package.json is ${pkg.version} and the manifest is ${manifest.version}`);
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
  const asWord = words.indexOf(word.toLowerCase().replace('twenty-', ''));
  const value = word.toLowerCase().startsWith('twenty-') ? 20 + asWord : asWord;
  if (value !== records) {
    problems.push(`README.md: says ${word} decision records, DECISIONS.md has ${records}`);
  }
}
checks.push(`decision records: ${records}`);

// ── every doc link resolves ──────────────────────────────────────────────
import { existsSync } from 'node:fs';
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

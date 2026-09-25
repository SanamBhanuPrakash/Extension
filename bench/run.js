#!/usr/bin/env node
/**
 * The benchmark.
 *
 * Scores the engine against a labelled corpus and prints precision, recall and
 * F1 — overall, and per detector. Published figures for regex-and-entropy
 * secret scanners sit between 25% and 75% precision; this exists so the claim
 * this project makes about itself is a number anyone can reproduce with
 * `node bench/run.js` rather than an adjective in a README.
 *
 *   --failures   print every miss and every false positive
 *   --json       machine-readable
 *   --seed N     regenerate the corpus with a different seed
 */
import { scan } from '../src/detect.js';
import { RULES } from '../src/rules.js';
import { buildCorpus } from './corpus.js';
import { makeRng } from './random.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const seedArg = argv.indexOf('--seed');
const seed = seedArg >= 0 ? Number(argv[seedArg + 1]) : 20260925;

const tty = process.stdout.isTTY && !flag('--no-color');
const c = (code, s) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);

const corpus = buildCorpus(seed);

let tp = 0;
let fp = 0;
let fn = 0;
const perRule = new Map();
const failures = [];

const bump = (id, field) => {
  if (!perRule.has(id)) perRule.set(id, { tp: 0, fp: 0, fn: 0 });
  perRule.get(id)[field]++;
};

for (const testCase of corpus) {
  const fired = new Set(scan(testCase.text).findings.map((f) => f.ruleId));
  const expected = new Set(testCase.expect);

  for (const id of expected) {
    if (fired.has(id)) { tp++; bump(id, 'tp'); }
    else { fn++; bump(id, 'fn'); failures.push({ kind: 'missed', id, ...testCase }); }
  }
  for (const id of fired) {
    if (!expected.has(id)) {
      fp++; bump(id, 'fp');
      failures.push({ kind: 'false positive', id, ...testCase });
    }
  }
}

const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// ------------------------------------------------------------- throughput
function throughput() {
  const r = makeRng(7);
  const paragraphs = [];
  for (let i = 0; i < 400; i++) {
    paragraphs.push(`  at Object.${r.lower(8)} (/srv/app/src/${r.lower(6)}/${r.lower(9)}.ts:${r.int(900)}:${r.int(80)})`);
    paragraphs.push(`${r.lower(7)}: the ${r.lower(5)} service returned ${r.int(500)} after ${r.int(9000)}ms`);
  }
  // One real credential buried in the middle, so the scan cannot short-circuit.
  paragraphs.splice(400, 0, 'AWS_ACCESS_KEY_ID=AKIA' + r.base32(16));
  const doc = paragraphs.join('\n');

  for (let i = 0; i < 20; i++) scan(doc); // warm
  const runs = 50;
  const started = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) scan(doc);
  const ns = Number(process.hrtime.bigint() - started) / runs;
  return { bytes: doc.length, ms: ns / 1e6, mbPerSec: (doc.length / 1e6) / (ns / 1e9) };
}

const perf = throughput();

if (flag('--json')) {
  console.log(JSON.stringify({
    seed,
    cases: corpus.length,
    positives: corpus.filter((x) => x.expect.length).length,
    negatives: corpus.filter((x) => !x.expect.length).length,
    tp, fp, fn, precision, recall, f1,
    perf,
    perRule: Object.fromEntries(perRule),
  }, null, 2));
  process.exit(fp + fn === 0 ? 0 : 1);
}

console.log(bold('\nChhanni benchmark'));
console.log(dim(`seed ${seed} · ${corpus.length} cases · ${corpus.filter((x) => x.expect.length).length} positive · ${corpus.filter((x) => !x.expect.length).length} hard negative\n`));

const paint = (x) => (x >= 0.99 ? green : x >= 0.95 ? yellow : red)(pct(x));
console.log(`  precision   ${paint(precision)}   ${dim(`${tp} true / ${fp} false positives`)}`);
console.log(`  recall      ${paint(recall)}   ${dim(`${fn} missed`)}`);
console.log(`  F1          ${paint(f1)}`);
console.log(dim(`\n  ${perf.bytes.toLocaleString()} byte document scanned in ${perf.ms.toFixed(2)}ms (${perf.mbPerSec.toFixed(1)} MB/s), ${RULES.length} detectors\n`));

const imperfect = [...perRule.entries()].filter(([, s]) => s.fp || s.fn);
if (imperfect.length) {
  console.log(bold('  detectors that are not perfect'));
  for (const [id, s] of imperfect.sort((a, b) => (b[1].fp + b[1].fn) - (a[1].fp + a[1].fn))) {
    const p = s.tp + s.fp === 0 ? 1 : s.tp / (s.tp + s.fp);
    const rc = s.tp + s.fn === 0 ? 1 : s.tp / (s.tp + s.fn);
    console.log(`    ${id.padEnd(26)} ${dim('P')} ${pct(p).padStart(6)}  ${dim('R')} ${pct(rc).padStart(6)}  ${dim(`${s.fp} fp, ${s.fn} fn`)}`);
  }
  console.log();
} else {
  console.log(green('  every detector is perfect on this corpus\n'));
}

if (flag('--failures')) {
  for (const f of failures.slice(0, 60)) {
    const tag = f.kind === 'missed' ? red('missed     ') : yellow('false pos  ');
    console.log(`  ${tag} ${bold(f.id.padEnd(24))} ${dim(f.why || '')}`);
    console.log(`    ${dim(JSON.stringify(f.text.length > 110 ? f.text.slice(0, 110) + '…' : f.text))}`);
  }
  if (failures.length > 60) console.log(dim(`  …and ${failures.length - 60} more`));
  console.log();
}

process.exit(0);

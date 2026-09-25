#!/usr/bin/env node
/**
 * Scores the name and address detectors against annotated prose.
 *
 * The classifier alone reaches F1 71.7% on held-out tokens, and that ceiling
 * is real. What ships is the pipeline — classifier plus structural context —
 * and this measures the pipeline, because that is what a user experiences.
 *
 *   --failures   show every miss and every false positive
 *   --json       machine-readable
 */
import { findNames, findAddresses } from '../src/ner.js';
import { DOCUMENTS } from './ner-corpus.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const tty = process.stdout.isTTY && !flag('--no-color');
const c = (code, s) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const green = (s) => c('32', s);

/** A prediction is correct when it overlaps a gold span. */
function overlaps(a, b) { return a.start < b.end && b.start < a.end; }

function goldSpans(text, strings) {
  const out = [];
  for (const s of strings) {
    let from = 0;
    let found = 0;
    for (;;) {
      const start = text.indexOf(s, from);
      if (start === -1) break;
      out.push({ start, end: start + s.length, text: s });
      from = start + 1;
      found++;
    }
    if (!found) throw new Error(`corpus error: ${JSON.stringify(s)} is not in its document`);
  }
  return out;
}

function score(kind, predictFn) {
  let tp = 0, fp = 0, fn = 0;
  const failures = [];
  for (const doc of DOCUMENTS) {
    const gold = goldSpans(doc.text, doc[kind]);
    const predicted = predictFn(doc.text);
    const matchedGold = new Set();

    for (const p of predicted) {
      const hit = gold.find((g) => overlaps(p, g));
      if (hit) { tp++; matchedGold.add(hit.start); }
      else { fp++; failures.push({ kind: 'false positive', doc: doc.id, text: p.text }); }
    }
    for (const g of gold) {
      if (!matchedGold.has(g.start)) { fn++; failures.push({ kind: 'missed', doc: doc.id, text: g.text }); }
    }
  }
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  return {
    precision, recall,
    f1: (2 * precision * recall) / Math.max(1e-9, precision + recall),
    tp, fp, fn, failures,
  };
}

const names = score('names', (t) => findNames(t));
const addresses = score('addresses', (t) => findAddresses(t));

// Throughput: NER runs on every paste, so its cost has to be stated.
const corpusText = DOCUMENTS.map((d) => d.text).join('\n\n');
const doc = corpusText.repeat(20);
for (let i = 0; i < 5; i++) { findNames(doc); findAddresses(doc); }
const started = process.hrtime.bigint();
const RUNS = 20;
for (let i = 0; i < RUNS; i++) { findNames(doc); findAddresses(doc); }
const ms = Number(process.hrtime.bigint() - started) / RUNS / 1e6;

if (flag('--json')) {
  console.log(JSON.stringify({ names, addresses, bytes: doc.length, ms }, null, 2));
  process.exit(0);
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const paint = (x) => (x >= 0.95 ? green : x >= 0.85 ? yellow : red)(pct(x));

console.log(bold('\nChhanni — names and addresses in prose'));
console.log(dim(`${DOCUMENTS.length} annotated documents · ${DOCUMENTS.filter((d) => !d.names.length && !d.addresses.length).length} of them hard negatives\n`));

for (const [label, m] of [['names', names], ['addresses', addresses]]) {
  console.log(`  ${bold(label.padEnd(10))} precision ${paint(m.precision)}   recall ${paint(m.recall)}   F1 ${paint(m.f1)}   ${dim(`${m.tp} found / ${m.fp} false / ${m.fn} missed`)}`);
}
console.log(dim(`\n  ${doc.length.toLocaleString()} bytes of prose in ${ms.toFixed(1)}ms (${((doc.length / 1e6) / (ms / 1e3)).toFixed(1)} MB/s)\n`));

if (flag('--failures')) {
  for (const [label, m] of [['names', names], ['addresses', addresses]]) {
    for (const f of m.failures) {
      const tag = f.kind === 'missed' ? red('missed    ') : yellow('false pos ');
      console.log(`  ${tag} ${dim(label.padEnd(10))} ${bold(f.doc.padEnd(18))} ${JSON.stringify(f.text)}`);
    }
  }
  console.log();
}

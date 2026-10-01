#!/usr/bin/env node
/**
 * Hostile input, against the parsers.
 *
 * The benchmarks measure whether the engine is *right*. This measures whether
 * it can be made to misbehave — which is a different question, and the one
 * that matters now that attachments are attacker-controlled bytes going into
 * hand-written readers for ZIP, OOXML, PDF, TIFF and PNG.
 *
 *   node bench/fuzz.js                 4,000 cases over the fixtures
 *   node bench/fuzz.js --cases 50000   longer run
 *   node bench/fuzz.js --seed 12345    start elsewhere
 *   node bench/fuzz.js --replay 8821   re-run one case and print what it was
 *
 * Five invariants:
 *
 *   1. never throws           extractDocument() resolves, always
 *   2. never crashes inside   and does not quietly catch its own TypeError
 *   3. always classified      readable | partial | metadata | opaque
 *   4. bounded time           no case may take longer than SLOW_MS
 *   5. bounded output         extracted text cannot exceed MAX_OUTPUT
 *
 * Invariant 2 exists because invariant 1 was vacuous. `extractDocument` wraps
 * everything in a try/catch so a malformed attachment cannot take the page
 * down with it, which also means an honest programming error inside a parser
 * emerges as `status: 'opaque'` and looks exactly like a file with nothing in
 * it. Two hundred thousand mutations passed while every .xlsx in the project
 * was throwing a TypeError. The caught message is now on the result, and an
 * internal crash is a failure here even though it is survivable in production.
 *
 * Invariant 5 is the decompression-bomb check: a 2 KB input must not become
 * fifty megabytes of text just because its length fields say so.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDocument } from '../src/documents.js';
import { scan } from '../src/detect.js';
import { mutate } from './mutate.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const cases = flag('cases', 4000);
const startSeed = flag('seed', 1);
const replay = argv.includes('--replay') ? flag('replay', 0) : null;
const quiet = argv.includes('--quiet');

const tty = process.stdout.isTTY && !argv.includes('--no-color');
const c = (code, s) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);

const SLOW_MS = 2000;
const MAX_OUTPUT = 64 * 1024 * 1024;
/**
 * The decompression-bomb bound. A legitimate DOCX is XML and compresses very
 * well, so a high ratio is normal — the fixtures peak around 40x. Anything
 * past 500x from a file this small is the shape of an attack, not a document.
 */
const MAX_EXPANSION = 500;
const RATIO_FLOOR = 4096; // below this, ratios are meaningless
const STATUSES = new Set(['readable', 'partial', 'metadata', 'opaque']);

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const seeds = readdirSync(fixtures)
  .filter((f) => !f.startsWith('.'))
  .map((name) => ({ name, bytes: new Uint8Array(readFileSync(join(fixtures, name))) }));

if (!seeds.length) {
  console.error('no fixtures: run `python3 tools/make-fixtures.py` first');
  process.exit(2);
}

/**
 * Hand-built cases, for the shapes a random mutation is unlikely to reach.
 * Each one is a structure that is internally consistent and lying.
 */
function handBuilt() {
  const out = [];
  const enc = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
  const cat = (...parts) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const b = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { b.set(p, at); at += p.length; }
    return b;
  };
  const u32 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  const u16 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);

  // An end-of-central-directory claiming four billion entries.
  out.push({
    name: 'zip: 4bn entries claimed',
    bytes: cat(enc('PK\u0003\u0004'), new Uint8Array(40),
      enc('PK\u0005\u0006'), u16(0), u16(0), u16(0xffff), u16(0xffff),
      u32(0xffffffff), u32(0), u16(0)),
  });
  // A local header whose sizes point far past the end of the file.
  out.push({
    name: 'zip: sizes past EOF',
    bytes: cat(enc('PK\u0003\u0004'), u16(20), u16(0), u16(8), u32(0),
      u32(0), u32(0xfffffff0), u32(0xfffffff0), u16(4), u16(0), enc('a.xml'),
      enc('PK\u0005\u0006'), u16(0), u16(0), u16(1), u16(1), u32(46), u32(4), u16(0)),
  });
  // A PDF whose stream says it is four gigabytes long.
  out.push({
    name: 'pdf: /Length 4GB',
    bytes: enc(`%PDF-1.4\n1 0 obj\n<< /Length ${0xffffffff} /Filter /FlateDecode >>\nstream\n`
      + 'x'.repeat(200) + '\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'),
  });
  // A PDF that is nothing but stream markers.
  out.push({ name: 'pdf: only markers', bytes: enc('%PDF-1.7\n' + 'stream\nendstream\n'.repeat(4000)) });
  // EXIF whose GPS IFD pointer points at itself.
  out.push({
    name: 'jpeg: self-referential IFD',
    bytes: cat(enc('ÿØÿá'), new Uint8Array([0, 40]), enc('Exif\u0000\u0000'),
      enc('MM\u0000*'), new Uint8Array([0, 0, 0, 8]),
      new Uint8Array([0, 1]), new Uint8Array([0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 8]),
      new Uint8Array([0, 0, 0, 0]), enc('ÿÙ')),
  });
  // A PNG with a chunk longer than the file.
  out.push({
    name: 'png: chunk longer than file',
    bytes: cat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      new Uint8Array([0xff, 0xff, 0xff, 0xf0]), enc('tEXt'), enc('Author\u0000x')),
  });
  // Deeply nested XML inside a real container shape.
  out.push({ name: 'xml: 50k nested tags', bytes: enc('<a>'.repeat(50000) + 'x' + '</a>'.repeat(50000)) });
  // A text file that is one very long line.
  out.push({ name: 'text: 4 MB single line', bytes: enc('A'.repeat(4 * 1024 * 1024)) });
  return out;
}

let checked = 0;
let failures = 0;
let slowest = { ms: 0, what: null };
let widest = { ratio: 0, what: null };
const byStatus = new Map();
const byMutator = new Map();
const started = Date.now();

async function check(what, bytes, filename) {
  const t0 = process.hrtime.bigint();
  let doc;
  try {
    doc = await extractDocument(bytes, filename);
  } catch (err) {
    console.log(red(`  THREW   ${what}: ${err && err.message}`));
    failures++;
    return;
  }
  // Whatever came out has to survive the scanner too.
  try {
    if (doc.text) scan(doc.text, { ner: false });
  } catch (err) {
    console.log(red(`  THREW (scan)  ${what}: ${err && err.message}`));
    failures++;
    return;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  checked++;

  if (doc.error) {
    console.log(red(`  CRASHED ${what}: ${doc.error}`));
    failures++;
  }
  if (!STATUSES.has(doc.status)) {
    console.log(red(`  UNCLASSIFIED  ${what}: status=${JSON.stringify(doc.status)}`));
    failures++;
  }
  if (typeof doc.text === 'string' && doc.text.length > MAX_OUTPUT) {
    console.log(red(`  UNBOUNDED  ${what}: ${(doc.text.length / 1048576).toFixed(1)} MB of text from ${bytes.length} bytes`));
    failures++;
  }
  if (typeof doc.text === 'string' && bytes.length >= RATIO_FLOOR
      && doc.text.length > bytes.length * MAX_EXPANSION) {
    console.log(red(`  EXPANSION  ${what}: ${bytes.length} bytes -> ${doc.text.length} chars (${Math.round(doc.text.length / bytes.length)}x)`));
    failures++;
  }
  if (ms > SLOW_MS) {
    console.log(red(`  SLOW    ${what}: ${ms.toFixed(0)} ms`));
    failures++;
  }
  if (ms > slowest.ms) slowest = { ms, what };
  if (typeof doc.text === 'string' && bytes.length >= RATIO_FLOOR) {
    const ratio = doc.text.length / bytes.length;
    if (ratio > widest.ratio) widest = { ratio, what };
  }
  byStatus.set(doc.status, (byStatus.get(doc.status) || 0) + 1);
}

if (replay !== null) {
  const seed = replay;
  const base = seeds[seed % seeds.length];
  const { bytes, mutator } = mutate(base.bytes, seed);
  console.log(`seed ${seed}: ${mutator} of ${base.name} -> ${bytes.length} bytes`);
  const doc = await extractDocument(bytes, base.name);
  console.log(`status ${doc.status}, kind ${doc.kind}, ${doc.text ? doc.text.length : 0} chars of text`);
  if (doc.reason) console.log(`reason: ${doc.reason}`);
  process.exit(0);
}

console.log(bold('\nChhanni fuzz — hostile input against the parsers'));
console.log(dim(`${seeds.length} fixtures · ${cases.toLocaleString()} mutations from seed ${startSeed} · ${handBuilt().length} hand-built\n`));

for (const one of handBuilt()) {
  await check(`hand:${one.name}`, one.bytes, 'probe');
}

for (let i = 0; i < cases; i++) {
  const seed = startSeed + i;
  const base = seeds[seed % seeds.length];
  const { bytes, mutator } = mutate(base.bytes, seed);
  byMutator.set(mutator, (byMutator.get(mutator) || 0) + 1);
  await check(`seed ${seed} (${mutator} of ${base.name})`, bytes, base.name);
  if (!quiet && i && i % 1000 === 0) process.stdout.write(dim(`  ${i.toLocaleString()}…\n`));
}

const seconds = (Date.now() - started) / 1000;
console.log(bold(`\n  ${checked.toLocaleString()} inputs parsed in ${seconds.toFixed(1)}s`));
console.log(`    ${[...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
console.log(dim(`    slowest: ${slowest.ms.toFixed(0)} ms — ${slowest.what}`));
console.log(dim(`    widest expansion: ${widest.ratio.toFixed(1)}x — ${widest.what || 'none'}`));
console.log(failures === 0
  ? green(`\n  no throws, no internal crashes, no unclassified results, nothing over ${SLOW_MS} ms, ${MAX_OUTPUT / 1048576} MB or ${MAX_EXPANSION}x\n`)
  : red(`\n  ${failures} failure${failures === 1 ? '' : 's'} — reproduce with: node bench/fuzz.js --replay <seed>\n`));
process.exit(failures === 0 ? 0 : 1);

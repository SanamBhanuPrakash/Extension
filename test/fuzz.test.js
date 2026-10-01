/**
 * Hostile input, as a gate rather than an exercise.
 *
 * `bench/fuzz.js` is the long run — 200,000 mutations in about a minute. This
 * is the fixed, seeded slice of it that has to pass before anything ships, so
 * a regression in the ZIP reader, the PDF scanner or the EXIF walker fails the
 * build rather than waiting for somebody to run the fuzzer by hand.
 *
 * The invariants are the ones that distinguish a parser bug from a parser
 * *vulnerability*: throwing is survivable, hanging and allocating are not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDocument } from '../src/documents.js';
import { scan } from '../src/detect.js';
import { mutate, MUTATORS, MUTATOR_NAMES } from '../bench/mutate.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const seeds = readdirSync(fixtures)
  .filter((f) => !f.startsWith('.'))
  .map((name) => ({ name, bytes: new Uint8Array(readFileSync(join(fixtures, name))) }));

const STATUSES = new Set(['readable', 'partial', 'metadata', 'opaque']);
const CASES = 3000;
const SLOW_MS = 2000;
const MAX_OUTPUT = 64 * 1024 * 1024;

test('the fixtures a fuzz run mutates are actually present', () => {
  assert.ok(seeds.length >= 7, 'run tools/make-fixtures.py');
  assert.ok(seeds.every((s) => s.bytes.length > 0));
});

test('mutation is deterministic, and every mutator gets exercised', () => {
  const base = seeds[0].bytes;
  const a = mutate(base, 4242);
  const b = mutate(base, 4242);
  assert.equal(a.mutator, b.mutator);
  assert.deepEqual(Array.from(a.bytes), Array.from(b.bytes));

  const used = new Set();
  for (let s = 0; s < 400; s++) for (const m of mutate(base, s).mutator.split('+')) used.add(m);
  assert.deepEqual([...used].sort(), [...MUTATOR_NAMES].sort());
});

test('no mutation of a real document makes a parser throw, hang or over-allocate', async () => {
  let slowest = 0;
  for (let i = 0; i < CASES; i++) {
    const seed = 1 + i;
    const base = seeds[seed % seeds.length];
    const { bytes, mutator } = mutate(base.bytes, seed);
    const where = `seed ${seed} (${mutator} of ${base.name})`;

    const t0 = process.hrtime.bigint();
    let doc;
    try {
      doc = await extractDocument(bytes, base.name);
    } catch (err) {
      assert.fail(`${where} threw: ${err && err.message}`);
    }
    // Whatever text came out has to survive the scanner too — a malformed
    // document that yields a pathological string is the same problem one
    // layer along.
    if (doc.text) {
      try { scan(doc.text, { ner: false }); } catch (err) {
        assert.fail(`${where} produced text that broke scan(): ${err && err.message}`);
      }
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    slowest = Math.max(slowest, ms);

    // A caught crash is survivable in production and is still a bug. The
    // whole suite passed for a long time while every .xlsx threw a TypeError
    // that extractDocument turned into "this file could not be read".
    assert.ok(!doc.error, `${where} crashed inside a parser: ${doc.error}`);
    assert.ok(STATUSES.has(doc.status), `${where} returned status ${JSON.stringify(doc.status)}`);
    assert.ok(typeof doc.text === 'string', `${where} returned no text field`);
    assert.ok(doc.text.length <= MAX_OUTPUT,
      `${where} produced ${doc.text.length} characters from ${bytes.length} bytes`);
    assert.ok(ms < SLOW_MS, `${where} took ${ms.toFixed(0)} ms`);
  }
  assert.ok(slowest < SLOW_MS);
});

test('a structure that lies about its own size does not become an allocation', async () => {
  // The cases a random mutation is unlikely to reach: internally consistent
  // headers with impossible numbers in them.
  const enc = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
  const cat = (...parts) => {
    const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { b.set(p, at); at += p.length; }
    return b;
  };
  const u32 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  const u16 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);

  const hostile = [
    ['a ZIP claiming 65,535 entries and a 4 GB directory',
      cat(enc('PK\u0003\u0004'), new Uint8Array(40), enc('PK\u0005\u0006'),
        u16(0), u16(0), u16(0xffff), u16(0xffff), u32(0xffffffff), u32(0), u16(0))],
    ['a ZIP entry whose sizes point past EOF',
      cat(enc('PK\u0003\u0004'), u16(20), u16(0), u16(8), u32(0), u32(0),
        u32(0xfffffff0), u32(0xfffffff0), u16(5), u16(0), enc('a.xml'),
        enc('PK\u0005\u0006'), u16(0), u16(0), u16(1), u16(1), u32(46), u32(4), u16(0))],
    ['a PDF stream declaring /Length 4294967295',
      enc('%PDF-1.4\n1 0 obj\n<< /Length 4294967295 /Filter /FlateDecode >>\nstream\n'
        + 'x'.repeat(200) + '\nendstream\nendobj\n%%EOF')],
    ['a PDF that is nothing but 4,000 stream markers',
      enc('%PDF-1.7\n' + 'stream\nendstream\n'.repeat(4000))],
    ['a PNG chunk longer than the file',
      cat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        new Uint8Array([0xff, 0xff, 0xff, 0xf0]), enc('tEXt'), enc('Author\u0000x'))],
    ['an EXIF GPS pointer aimed at its own IFD',
      cat(enc('ÿØÿá'), new Uint8Array([0, 40]), enc('Exif\u0000\u0000'),
        enc('MM\u0000*'), new Uint8Array([0, 0, 0, 8]), new Uint8Array([0, 1]),
        new Uint8Array([0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 8]),
        new Uint8Array([0, 0, 0, 0]), enc('ÿÙ'))],
    ['50,000 nested XML tags', enc('<a>'.repeat(50000) + 'x' + '</a>'.repeat(50000))],
  ];

  for (const [what, bytes] of hostile) {
    const t0 = process.hrtime.bigint();
    const doc = await extractDocument(bytes, 'probe');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(!doc.error, `${what} crashed inside a parser: ${doc.error}`);
    assert.ok(STATUSES.has(doc.status), `${what}: status ${doc.status}`);
    assert.ok(doc.text.length <= MAX_OUTPUT, `${what}: ${doc.text.length} characters out`);
    assert.ok(ms < SLOW_MS, `${what}: ${ms.toFixed(0)} ms`);
  }
});

test('truncating a real document at every prefix length is safe', async () => {
  // Not random: every parser that reads a header and then trusts it breaks
  // somewhere in here, and a prefix sweep finds the exact byte.
  for (const seed of seeds) {
    const step = Math.max(1, Math.floor(seed.bytes.length / 120));
    for (let n = 0; n <= seed.bytes.length; n += step) {
      const doc = await extractDocument(seed.bytes.subarray(0, n), seed.name);
      assert.ok(!doc.error, `${seed.name} truncated to ${n} crashed: ${doc.error}`);
      assert.ok(STATUSES.has(doc.status), `${seed.name} truncated to ${n}: status ${doc.status}`);
    }
  }
});

test('a zip bomb is refused by what it produces, not by what it claims', async () => {
  // A 510 KB archive whose central directory declares `size = 1000` and whose
  // deflate stream expands to 512 MB. The declared size passed every header
  // check; `new Response(stream).arrayBuffer()` then read it to completion and
  // allocated the lot — measured at 512 MB in 9.1 seconds before this.
  const { deflateRawSync } = await import('node:zlib');
  const deflated = deflateRawSync(Buffer.alloc(512 * 1024 * 1024, 0x41), { level: 9 });
  assert.ok(deflated.length < 1024 * 1024, 'the bomb has to actually be small');

  const enc = (t) => Buffer.from(t, 'latin1');
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const name = enc('word/document.xml');
  const local = Buffer.concat([enc('PK\u0003\u0004'), u16(20), u16(0), u16(8), u32(0), u32(0),
    u32(deflated.length), u32(1000), u16(name.length), u16(0), name, deflated]);
  const central = Buffer.concat([enc('PK\u0001\u0002'), u16(20), u16(20), u16(0), u16(8), u32(0),
    u32(0), u32(deflated.length), u32(1000), u16(name.length), u16(0), u16(0), u16(0), u16(0),
    u32(0), u32(0), name]);
  const eocd = Buffer.concat([enc('PK\u0005\u0006'), u16(0), u16(0), u16(1), u16(1),
    u32(central.length), u32(local.length), u16(0)]);
  const zip = new Uint8Array(Buffer.concat([local, central, eocd]));

  const started = Date.now();
  const doc = await extractDocument(zip, 'bomb.docx');
  assert.ok(Date.now() - started < 5000, 'must refuse quickly, not after inflating');
  assert.equal(doc.text.length, 0);
  assert.ok(['opaque', 'partial'].includes(doc.status));
});

test('bounded inflation stops at the cap and passes legitimate entries through', async () => {
  const { inflateBounded } = await import('../src/zipreader.js');
  const { deflateRawSync } = await import('node:zlib');

  const huge = deflateRawSync(Buffer.alloc(64 * 1024 * 1024, 0x41), { level: 9 });
  assert.equal(await inflateBounded(new Uint8Array(huge), 'deflate-raw', 1024 * 1024), null);

  const small = deflateRawSync(Buffer.alloc(4096, 0x42));
  const out = await inflateBounded(new Uint8Array(small), 'deflate-raw', 1024 * 1024);
  assert.equal(out.length, 4096);

  // A truncated stream is a null, not a throw.
  assert.equal(await inflateBounded(new Uint8Array(small).subarray(0, 4), 'deflate-raw', 1024), null);
});

test('a ZIP64 field larger than a safe integer is refused, not rounded', async () => {
  const { readCentralDirectory } = await import('../src/zipreader.js');
  const enc = (t) => Buffer.from(t, 'latin1');
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };

  // An EOCD64 whose directory offset is 2^63. Number() would turn that into
  // 9223372036854776000 — a plausible-looking integer that is not the value in
  // the file, and that every later bounds check would then be reasoning about.
  const eocd64 = Buffer.concat([enc('PK\u0006\u0006'), u64(44n), u16(45), u16(45), u32(0), u32(0),
    u64(1n), u64(1n), u64(46n), u64(0x8000000000000000n)]);
  const locator = Buffer.concat([enc('PK\u0006\u0007'), u32(0), u64(0n), u32(1)]);
  const eocd = Buffer.concat([enc('PK\u0005\u0006'), u16(0), u16(0), u16(0xffff), u16(0xffff),
    u32(0xffffffff), u32(0xffffffff), u16(0)]);
  const zip = new Uint8Array(Buffer.concat([eocd64, locator, eocd]));

  const entries = readCentralDirectory(zip);
  assert.ok(entries === null || entries.length === 0, 'an impossible offset yields no entries');
});

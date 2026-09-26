/**
 * Document extraction, against real files.
 *
 * Every fixture is a genuine container built by tools/make-fixtures.py with
 * the standard library: a real ZIP with real OOXML parts, a real PDF with
 * FlateDecode content streams, a real JPEG with a real EXIF TIFF block, a real
 * PNG with real tEXt chunks. A parser that reads these reads the ones a word
 * processor writes, because the format is the same.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDocument, sniff, describeKind, rewriteMode, rewriteBytes } from '../src/documents.js';
import { readImageMetadata, describeImageMetadata, stripImageMetadata } from '../src/imagemeta.js';
import { scan } from '../src/detect.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const bytes = (name) => new Uint8Array(readFileSync(join(fixtures, name)));

test('files are identified by what they are, not by what they are called', () => {
  // An extension is a claim a file makes about itself. A .txt that is really
  // a ZIP is exactly the case where being wrong matters.
  assert.equal(sniff(bytes('contract.docx'), 'contract.docx'), 'zip');
  assert.equal(sniff(bytes('invoice.pdf'), 'anything.txt'), 'pdf');
  assert.equal(sniff(bytes('photo.jpg'), 'photo.pdf'), 'image/jpeg');
  assert.equal(sniff(bytes('screenshot.png'), 'screenshot'), 'image/png');
  assert.equal(sniff(new TextEncoder().encode('hello world'), 'x.docx'), 'text');
  assert.equal(describeKind('pdf'), 'PDF');
});

test('a DOCX gives up its text, its tables and its document properties', async () => {
  const doc = await extractDocument(bytes('contract.docx'), 'contract.docx');
  assert.equal(doc.status, 'readable');
  assert.equal(doc.kind, 'word');
  assert.match(doc.text, /PRIVILEGED AND CONFIDENTIAL/);
  assert.match(doc.text, /priya\.nair@northwind\.co\.in/);
  // core.xml properties are text too, and they name people.
  assert.equal(doc.metadata.author, 'Anita Deshpande');
  assert.match(doc.note, /Anita Deshpande/);

  const found = scan(doc.text).findings.map((f) => f.ruleId);
  for (const id of ['legal_privilege', 'payment_card', 'aws_access_key_id', 'pan_india', 'iban']) {
    assert.ok(found.includes(id), `${id} should be found inside the .docx`);
  }
});

test('an XLSX reads as rows, so the bulk-record detector can see it', async () => {
  const doc = await extractDocument(bytes('employees.xlsx'), 'employees.xlsx');
  assert.equal(doc.status, 'readable');
  assert.equal(doc.kind, 'spreadsheet');
  // Emitted as comma-separated lines on purpose: six people in a spreadsheet
  // is one bulk disclosure, not thirty separate findings.
  const result = scan(doc.text);
  assert.ok(result.table, 'a spreadsheet should read as a table');
  assert.equal(result.table.rows, 6);
  assert.match(result.table.description, /bulk disclosure/);
});

test('a PPTX and an ODT are read the same way', async () => {
  const pptx = await extractDocument(bytes('board.pptx'), 'board.pptx');
  assert.equal(pptx.kind, 'presentation');
  assert.ok(scan(pptx.text).findings.some((f) => f.ruleId === 'mnpi'));

  const odt = await extractDocument(bytes('notes.odt'), 'notes.odt');
  assert.equal(odt.status, 'readable');
  assert.equal(odt.kind, 'word');
  const found = scan(odt.text).findings.map((f) => f.ruleId);
  assert.ok(found.includes('health_information'));
  assert.ok(found.includes('aadhaar'));
});

test('a text-based PDF is read, and says how many pages it read', async () => {
  const doc = await extractDocument(bytes('invoice.pdf'), 'invoice.pdf');
  assert.equal(doc.status, 'readable');
  assert.equal(doc.kind, 'pdf');
  assert.match(doc.note, /1 page read/);
  const found = scan(doc.text).findings.map((f) => f.ruleId);
  assert.ok(found.includes('payment_card'));
  assert.ok(found.includes('aws_access_key_id'));
  assert.ok(found.includes('postal_address'));
});

test('an image gives up its metadata and says plainly that it kept its pixels', async () => {
  const doc = await extractDocument(bytes('photo.jpg'), 'photo.jpg');
  assert.equal(doc.status, 'metadata');
  assert.equal(doc.kind, 'image/jpeg');
  assert.match(doc.note, /GPS coordinates 18\.52, 73\.855/);
  assert.match(doc.note, /Priya Nair/);
  // The honesty requirement: silence must never imply the file was checked.
  assert.match(doc.reason, /no OCR/);
  assert.equal(doc.strippable, true);
  // The metadata itself is scanned — an Artist field is a person's name.
  assert.ok(scan(doc.text).findings.some((f) => f.ruleId === 'person_name'));
});

test('EXIF and PNG text chunks can be removed, and the image survives', () => {
  for (const [name, expected] of [['photo.jpg', 'APP1'], ['screenshot.png', 'tEXt']]) {
    const original = bytes(name);
    assert.ok(describeImageMetadata(readImageMetadata(original)), `${name} starts with metadata`);

    const stripped = stripImageMetadata(original);
    assert.ok(stripped, `${name} should be strippable`);
    assert.ok(stripped.removed.includes(expected));
    assert.ok(stripped.bytes.length < original.length);

    const after = readImageMetadata(stripped.bytes);
    assert.equal(describeImageMetadata(after), null, `${name} should have nothing left to describe`);
    assert.deepEqual(after.metadata, {});
    assert.equal(after.gps ?? null, null);

    // Still the same image: the header changed, the image data did not.
    assert.equal(sniff(stripped.bytes, name), sniff(original, name));
    assert.equal(stripImageMetadata(stripped.bytes), null, 'nothing left to remove');
  }
});

test('the rewrite offered for each file is one the format can actually deliver', async () => {
  // A .docx is a ZIP of XML parts held together by relationship ids.
  // Substituting a placeholder and re-zipping produces a file that opens
  // differently or not at all, so the honest offer is the text.
  for (const name of ['contract.docx', 'employees.xlsx', 'board.pptx', 'notes.odt', 'invoice.pdf']) {
    const doc = await extractDocument(bytes(name), name);
    const plan = rewriteMode(doc);
    assert.equal(plan.mode, 'convert', name);
    assert.match(plan.explain, /formatting does not/);
    const out = rewriteBytes(bytes(name), doc, 'redacted text');
    assert.equal(out.name(name), `${name}.redacted.txt`);
  }

  for (const name of ['photo.jpg', 'screenshot.png']) {
    const doc = await extractDocument(bytes(name), name);
    assert.equal(rewriteMode(doc).mode, 'strip', name);
    const out = rewriteBytes(bytes(name), doc, '');
    assert.equal(out.name(name), name, 'an image keeps its name');
    assert.ok(out.bytes.length < bytes(name).length);
  }

  // Assembled from parts: AWS's own documentation example, but GitHub's push
  // protection scans added lines and cannot tell that from a live key.
  const key = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
  const text = new TextEncoder().encode(`AWS_ACCESS_KEY_ID=${key}\n`);
  const plain = await extractDocument(text, 'sample.env');
  assert.equal(rewriteMode(plain).mode, 'text');
  assert.equal(rewriteBytes(text, plain, 'cleaned').name('sample.env'), 'sample.env');
});

test('what cannot be read says so instead of coming back clean', async () => {
  // A pre-2007 .doc is an OLE2 compound file.
  const ole2 = new Uint8Array(600);
  ole2.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const legacy = await extractDocument(ole2, 'old.doc');
  assert.equal(legacy.status, 'opaque');
  assert.match(legacy.reason, /pre-2007/);
  assert.equal(rewriteMode(legacy).mode, 'none');

  // A ZIP that is not an Office document.
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(200).fill(0x41)]);
  const archive = await extractDocument(zip, 'photos.zip');
  assert.equal(archive.status, 'opaque');

  // Truncated and malformed input must degrade, never throw.
  for (const bad of [new Uint8Array(0), new Uint8Array([0x25, 0x50, 0x44, 0x46]), bytes('contract.docx').subarray(0, 120)]) {
    const r = await extractDocument(bad, 'broken');
    assert.ok(['opaque', 'metadata', 'readable', 'partial'].includes(r.status));
  }
});

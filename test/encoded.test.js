import test from 'node:test';
import assert from 'node:assert/strict';
import { scan, fingerprint } from '../src/detect.js';
import { redact } from '../src/redact.js';
import { decodedRuns, LIMITS } from '../src/encoded.js';

// Never a real credential. AWS publishes this one in its own documentation.
const KEY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const ASSIGN = `AWS_ACCESS_KEY_ID=${KEY}`;
const b64 = (s) => Buffer.from(s).toString('base64');
const b64url = (s) => Buffer.from(s).toString('base64url');
const hex = (s) => Buffer.from(s).toString('hex');
const entities = (s) => [...s].map((c) => `&#${c.charCodeAt(0)};`).join('');
const escapes = (s) => [...s].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');

const ids = (text, policy) => scan(text, { ner: false, ...policy }).findings.map((f) => f.ruleId);

// ----------------------------------------------------------- the encodings
//
// Measured before this module existed: nine of fourteen encodings of the same
// assignment went through with verdict `clean`. Each line here was one of them.

test('a Base64 credential is found', () => {
  assert.ok(ids(b64(ASSIGN)).includes('aws_access_key_id'));
  assert.ok(ids(`credentials: ${b64(ASSIGN)}`).includes('aws_access_key_id'));
});

test('a Kubernetes Secret is the case this exists for', () => {
  const manifest = `apiVersion: v1\nkind: Secret\nmetadata:\n  name: app\ndata:\n  creds: ${b64(ASSIGN)}\n`;
  const r = scan(manifest, { ner: false });
  assert.equal(r.verdict, 'block');
  const f = r.findings.find((x) => x.ruleId === 'aws_access_key_id');
  assert.ok(f, 'a Secret’s data values are always Base64; that is the format, not an evasion');
  assert.equal(f.encoded.how, 'Base64');
});

test('percent-encoding, hex, HTML entities and string escapes', () => {
  for (const [how, encoded] of [
    ['URL encoding', encodeURIComponent(ASSIGN)],
    ['hexadecimal', hex(ASSIGN)],
    ['HTML escaping', entities(ASSIGN)],
    ['string escaping', escapes(ASSIGN)],
  ]) {
    const f = scan(encoded, { ner: false }).findings.find((x) => x.ruleId === 'aws_access_key_id');
    assert.ok(f, `${how} was not decoded`);
    assert.equal(f.encoded.how, how);
  }
});

test('Base64url is only a distinct encoding when it differs', () => {
  // `AWS_ACCESS_KEY_ID=AKIA…` Base64s without a `+` or a `/` in it, so its
  // url-safe form differs only in the padding Node strips, and calling that
  // "Base64url" would be inventing a distinction. The label earns itself
  // only on a payload whose standard form actually needs translating.
  const unpadded = (x) => x.replace(/=+$/, '');
  assert.equal(unpadded(b64url(ASSIGN)), unpadded(b64(ASSIGN)));
  const f1 = scan(b64url(ASSIGN), { ner: false }).findings.find((x) => x.ruleId === 'aws_access_key_id');
  assert.equal(f1.encoded.how, 'Base64');

  const payload = `${ASSIGN} \u00fb\u00ff\u00fe`;
  assert.notEqual(b64url(payload), b64(payload), 'this payload must differ, or the test proves nothing');
  const f2 = scan(b64url(payload), { ner: false }).findings.find((x) => x.ruleId === 'aws_access_key_id');
  assert.ok(f2, 'a url-safe payload was not decoded');
  assert.equal(f2.encoded.how, 'Base64url');
});

test('a single percent escape is enough to hide a key, so one is enough to look for', () => {
  // `AWS_ACCESS_KEY_ID%3DAKIA…` has exactly one escape, and that escape hides
  // the `=` the detector needs for its context. An earlier version required
  // three in a row and found none of the real cases.
  assert.ok(ids(`https://api.example.com/?v=${encodeURIComponent(ASSIGN)}`).includes('aws_access_key_id'));
});

test('a Basic auth header is Base64 of a credential', () => {
  assert.ok(ids(`Authorization: Basic ${b64(`admin:${KEY}`)}`).includes('aws_access_key_id'));
});

test('two layers deep is real; three is somebody probing', () => {
  assert.ok(ids(b64(b64(ASSIGN))).includes('aws_access_key_id'));
  assert.equal(LIMITS.maxDepth, 2);
  assert.ok(!ids(b64(b64(b64(ASSIGN)))).includes('aws_access_key_id'));
});

// -------------------------------------------------------------- not findings

test('a decode that yields bytes rather than text is not scanned', () => {
  const bytes = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37) % 256));
  const runs = decodedRuns(bytes.toString('base64'));
  assert.equal(runs.length, 0, 'compressed or binary payloads decode to noise, not to text');
});

test('hashes and ids are not decoded into findings', () => {
  // A git SHA is 40 hex characters and a UUID without dashes is 32; both are
  // in the Base64 alphabet and both decode to bytes.
  for (const s of [
    'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
    '9f2b7c1e4d6a8b0c2e4f6a8b0c2e4f6a',
    'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
  ]) {
    assert.deepEqual(scan(s, { ner: false }).findings.filter((f) => f.encoded), []);
  }
});

test('a run that decodes to itself is not a decode', () => {
  // Percent-decoding a string with nothing to unescape returns its input, and
  // reporting that as "hidden by URL encoding" would be a lie about the text.
  assert.deepEqual(decodedRuns('https://example.com/a/perfectly/ordinary/path/with/length'), []);
});

test('one run is reported once, however many decoders match it', () => {
  // `[A-Za-z0-9]` is in both Base64 alphabets, so a run without `+/-_` matches
  // twice. This reached the panel as "AWS access key ID x2" for one key.
  const found = scan(b64(ASSIGN), { ner: false }).findings.filter((f) => f.ruleId === 'aws_access_key_id');
  assert.equal(found.length, 1);
});

// ------------------------------------------------------------ what it claims

test('the span is the encoded run, so redaction removes the whole value', () => {
  const encoded = b64(ASSIGN);
  const text = `creds: ${encoded}`;
  const r = scan(text, { ner: false });
  const f = r.findings.find((x) => x.encoded);
  assert.equal(f.match, encoded, 'a value that is not literally in the text cannot replace itself');
  const out = redact(text, r.findings);
  assert.ok(!out.text.includes(encoded));
  assert.ok(!out.text.includes(KEY));
  assert.ok(out.text.startsWith('creds: '), 'the surrounding document survives');
});

test('the preview shows what was inside, not the encoding', () => {
  const f = scan(b64(ASSIGN), { ner: false }).findings.find((x) => x.encoded);
  assert.ok(f.preview.startsWith('AKI'), 'the person has to be able to recognise their own key');
  assert.ok(!f.preview.includes(KEY), 'and the panel still never holds the whole value');
});

test('the same key fingerprints the same whether it was encoded or not', () => {
  const plain = scan(ASSIGN, { ner: false }).findings.find((f) => f.ruleId === 'aws_access_key_id');
  const coded = scan(b64(ASSIGN), { ner: false }).findings.find((f) => f.ruleId === 'aws_access_key_id');
  assert.equal(coded.fingerprint, plain.fingerprint,
    'otherwise "you have pasted this key six times" misses five of them');
  assert.equal(plain.fingerprint, fingerprint(KEY));
});

test('a decoded finding says it was decoded', () => {
  const f = scan(b64(ASSIGN), { ner: false }).findings.find((x) => x.encoded);
  assert.match(f.note, /Base64/);
  assert.match(f.note, /replaces the whole encoded value/);
});

test('decode: false turns it off entirely', () => {
  assert.ok(!ids(b64(ASSIGN), { decode: false }).includes('aws_access_key_id'));
  assert.ok(ids(ASSIGN, { decode: false }).includes('aws_access_key_id'), 'and changes nothing else');
});

// ------------------------------------------------------------------ bounded

test('the candidate count is capped', () => {
  const many = Array.from({ length: 400 }, (_, i) => b64(`${ASSIGN}${i}`)).join('\n');
  const runs = decodedRuns(many);
  assert.ok(runs.length <= LIMITS.maxCandidates, `${runs.length} runs decoded`);
});

test('the decoded byte budget is capped', () => {
  const big = Array.from({ length: 40 }, () => b64('x'.repeat(40000))).join('\n');
  const total = decodedRuns(big).reduce((n, r) => n + r.text.length, 0);
  assert.ok(total <= LIMITS.maxDecodedBytes + LIMITS.maxRun, `${total} bytes decoded`);
});

test('a hostile paste of nested encodings terminates', () => {
  let s = ASSIGN;
  for (let i = 0; i < 12; i++) s = b64(s);
  const started = Date.now();
  scan(s, { ner: false });
  assert.ok(Date.now() - started < 2000, 'depth and budget bound this, not luck');
});

test('decoding never clears a finding the plain scan made', () => {
  const text = `${ASSIGN}\nand also ${b64(ASSIGN)}`;
  const r = scan(text, { ner: false });
  assert.equal(r.verdict, 'block');
  const plain = r.findings.filter((f) => !f.encoded && f.ruleId === 'aws_access_key_id');
  assert.equal(plain.length, 1, 'the literal key is still reported in its own right');
});

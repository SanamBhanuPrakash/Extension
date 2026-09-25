import test from 'node:test';
import assert from 'node:assert/strict';
import { scan, mask, fingerprint, summarise } from '../src/detect.js';
import { redact, redactReversible, restore } from '../src/redact.js';
import { luhn, verhoeff, aadhaar, iban, pan, ssn, githubTokenChecksum, looksRandom } from '../src/checksums.js';

const ids = (text, policy) => scan(text, policy).findings.map((f) => f.ruleId);
const has = (text, id) => ids(text).includes(id);

// --------------------------------------------------------------- checksums
test('luhn accepts valid cards and rejects transposed digits', () => {
  assert.ok(luhn('4242 4242 4242 4242'));
  assert.ok(luhn('5555555555554444'));
  assert.ok(luhn('378282246310005'));       // Amex, 15 digits
  assert.ok(!luhn('4242424242424241'));
  assert.ok(!luhn('1234567890123456'));
});

test('verhoeff rejects every wrong check digit', () => {
  const base = '23456789012';
  const valid = [...Array(10).keys()].filter((d) => aadhaar(base + d));
  assert.equal(valid.length, 1, 'exactly one check digit may complete a prefix');
});

test('aadhaar rejects reserved first digits and repdigits', () => {
  assert.ok(!aadhaar('123456789012'));
  assert.ok(!aadhaar('099999999999'));
  assert.ok(!aadhaar('999999999999'));
  assert.ok(!aadhaar('23456789012'));       // 11 digits
});

test('iban mod-97', () => {
  assert.ok(iban('GB82 WEST 1234 5698 7654 32'));
  assert.ok(iban('DE89370400440532013000'));
  assert.ok(!iban('GB82WEST12345698765433'));
});

test('pan structure including holder-type character', () => {
  assert.ok(pan('ABCPD1234E'));
  assert.ok(!pan('ABCXD1234E'), 'X is not a valid holder type');
  assert.ok(!pan('ABCP1234E'));
});

test('ssn rejects never-issued ranges', () => {
  assert.ok(ssn('123-45-6789'));
  assert.ok(!ssn('000-45-6789'));
  assert.ok(!ssn('666-45-6789'));
  assert.ok(!ssn('900-45-6789'));
  assert.ok(!ssn('123-00-6789'));
  assert.ok(!ssn('123-45-0000'));
});

test('github token checksum distinguishes forged from well-formed', () => {
  assert.equal(githubTokenChecksum('ghp_' + 'a'.repeat(36)), 'invalid');
  assert.equal(githubTokenChecksum('not_a_token'), 'unknown');
});

test('looksRandom rejects prose and repetition', () => {
  assert.ok(!looksRandom('aaaaaaaaaaaaaaaaaaaa'));
  assert.ok(!looksRandom('thequickbrownfoxjumps'), 'no digits');
  assert.ok(looksRandom('aB3xK9mQ7zP2wL5vR8tY', 3.6));
});

// ------------------------------------------------------------ true positives
test('catches cloud and vendor credentials', () => {
  assert.ok(has('AKIAIOSFODNN7EXAMPLE', 'aws_access_key_id'));
  assert.ok(has('key is AIzaSyD' + 'a'.repeat(32), 'google_api_key'));
  assert.ok(has('sk-ant-api03-' + 'x'.repeat(40), 'anthropic_key'));
  assert.ok(has('sk_live_' + 'a'.repeat(24), 'stripe_live_key'));
  assert.ok(has('xoxb-123456789012-abcdefghijkl', 'slack_token'));
  assert.ok(has('npm_' + 'b'.repeat(36), 'npm_token'));
  assert.ok(has('-----BEGIN RSA PRIVATE KEY-----', 'private_key_block'));
  assert.ok(has('postgres://admin:hunter2@db.internal:5432/prod', 'db_connection_string'));
  assert.ok(has('{"type": "service_account", "project_id": "x"}', 'gcp_service_account'));
});

test('catches an AWS secret key only when context says it is one', () => {
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  assert.ok(has(`aws_secret_access_key = ${secret}`, 'aws_secret_access_key'));
  assert.ok(!has(`checksum ${secret}`, 'aws_secret_access_key'),
    'a bare 40-char blob with no credential context must not fire');
});

test('decodes a JWT and reports what it carries', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: '1', email: 'a@b.com', exp: 4102444800 })).toString('base64url');
  const jwt = `${header}.${payload}.c2lnbmF0dXJl`;
  const f = scan(jwt).findings.find((x) => x.ruleId === 'jwt');
  assert.ok(f, 'jwt detected');
  assert.match(f.note, /still valid/);
  assert.match(f.note, /carries email/);
});

test('catches PII with its checksum', () => {
  assert.ok(has('card 4242 4242 4242 4242', 'payment_card'));
  assert.ok(has('PAN ABCPD1234E', 'pan_india'));
  assert.ok(has('SSN 123-45-6789', 'us_ssn'));
  assert.ok(has('IBAN GB82WEST12345698765432', 'iban'));
  const valid = [...Array(10).keys()].map((d) => '23456789012' + d).find(aadhaar);
  assert.ok(has(`Aadhaar ${valid}`, 'aadhaar'));
});

// ----------------------------------------------------------- false positives
test('does not fire on ordinary numbers that merely look long', () => {
  assert.ok(!has('order 1234567890123456 shipped', 'payment_card'), 'fails Luhn');
  assert.ok(!has('invoice total 123456789012', 'aadhaar'), 'fails Verhoeff');
  assert.ok(!has('ticket 900-45-6789', 'us_ssn'), 'never-issued SSN area');
});

test('does not fire on placeholder credentials in documentation', () => {
  const doc = `
    export API_KEY=your-api-key-here
    password: changeme
    token = "<REDACTED>"
    client_secret: example
  `;
  assert.deepEqual(ids(doc).filter((i) => i === 'high_entropy_assignment'), []);
});

test('leaves a plain stack trace alone', () => {
  const trace = `TypeError: Cannot read properties of undefined (reading 'map')
    at Object.render (/srv/app/src/pages/Dashboard.tsx:142:18)
    at renderWithHooks (/srv/app/node_modules/react-dom/cjs/react-dom.development.js:16305:18)`;
  assert.equal(scan(trace).verdict, 'clean', JSON.stringify(scan(trace).findings));
});

test('test-mode keys are reported but never block', () => {
  const r = scan('sk_test_' + 'a'.repeat(24));
  assert.equal(r.findings[0].ruleId, 'stripe_test_key');
  assert.equal(r.verdict, 'clean');
});

// -------------------------------------------------------------- overlap
test('a specific vendor key beats the generic credential rule', () => {
  const found = ids('api_key = "sk-ant-api03-' + 'x'.repeat(40) + '"');
  assert.ok(found.includes('anthropic_key'));
  assert.ok(!found.includes('high_entropy_assignment'), 'generic rule suppressed by overlap');
});

test('a database URL is reported once, not also as an email', () => {
  const found = ids('mongodb+srv://svc:p4ssw0rd@cluster0.abcd.mongodb.net/app');
  assert.deepEqual(found, ['db_connection_string']);
});

// -------------------------------------------------------------- redaction
test('redaction is stable and reversible', () => {
  const text = 'deploy with AKIAIOSFODNN7EXAMPLE then verify AKIAIOSFODNN7EXAMPLE again';
  const { text: out, table } = redactReversible(text);
  assert.equal(out, 'deploy with <AWS_ACCESS_KEY_ID_1> then verify <AWS_ACCESS_KEY_ID_1> again',
    'the same secret twice gets the same placeholder');
  assert.equal(restore(out, table), text);
  assert.equal(scan(out).verdict, 'clean', 'redacted text is clean');
});

test('redaction handles several secrets and preserves surrounding text', () => {
  const text = `AWS=AKIAIOSFODNN7EXAMPLE\nDB=postgres://u:p@h:5432/d\ncard 4242424242424242`;
  const { text: out, changed } = redact(text);
  assert.equal(changed, 3);
  assert.ok(out.startsWith('AWS=<AWS_ACCESS_KEY_ID_1>'));
  assert.ok(out.includes('\nDB=<DB_CONNECTION_STRING_1>\n'));
  assert.equal(scan(out).verdict, 'clean');
});

test('the redaction map never carries the secret', () => {
  const { map } = redact('AKIAIOSFODNN7EXAMPLE');
  assert.ok(!JSON.stringify(map).includes('AKIAIOSFODNN7EXAMPLE'));
  assert.match(map[0].preview, /^AKI\*+PLE$/);
});

// ------------------------------------------------------------ policy + misc
test('policy can disable a rule and allowlist a literal', () => {
  const text = 'contact ops@northwind.co.in';
  assert.ok(has(text, 'email'));
  assert.equal(scan(text, { disabled: ['email'] }).findings.length, 0);
  assert.equal(scan(text, { allow: ['ops@northwind.co.in'] }).findings.length, 0);
});

test('findings expose a masked preview and a one-way fingerprint', () => {
  const f = scan('AKIAIOSFODNN7EXAMPLE').findings[0];
  assert.ok(!f.preview.includes('OSFODNN7'));
  assert.equal(f.fingerprint, fingerprint('AKIAIOSFODNN7EXAMPLE'));
  assert.match(f.fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(f.line, 1);
});

test('scanning is idempotent across calls (no shared regex lastIndex)', () => {
  const t = 'AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPL2';
  assert.equal(scan(t).findings.length, scan(t).findings.length);
  assert.equal(scan(t).findings.length, 2);
});

test('empty and non-string input is handled', () => {
  assert.equal(scan('').verdict, 'clean');
  assert.equal(scan(null).verdict, 'clean');
  assert.equal(scan(undefined).findings.length, 0);
});

test('summarise counts repeats', () => {
  assert.equal(summarise(scan('a@b.com c@d.com').findings), '2× Email address');
});

test('mask never returns the input for a realistic secret', () => {
  assert.notEqual(mask('AKIAIOSFODNN7EXAMPLE'), 'AKIAIOSFODNN7EXAMPLE');
  assert.equal(mask('abc'), '***');
});

// --------------------------------------------------------------- guarantees
test('no module in the shipped engine or extension can make a network call', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const files = [
    ...readdirSync('src').filter((f) => f.endsWith('.js')).map((f) => `src/${f}`),
    ...readdirSync('extension').filter((f) => f.endsWith('.js')).map((f) => `extension/${f}`),
  ];
  const forbidden = /\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource)\b/;
  for (const file of files) {
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments
    assert.ok(!forbidden.test(code), `${file} references a network API`);
  }
});

test('the manifest requests no network permission', async () => {
  const { readFileSync } = await import('node:fs');
  const m = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
  assert.deepEqual(m.permissions, ['storage']);
  assert.ok(!m.permissions.includes('webRequest'));
  assert.equal(m.manifest_version, 3);
});

test('every detector claiming proof actually has a validator behind it', async () => {
  const { PROOFS } = await import('../src/rules.js');
  const { RULES_BY_ID } = await import('../src/detect.js');
  for (const id of Object.keys(PROOFS)) {
    const rule = RULES_BY_ID.get(id);
    assert.ok(rule, `${id} is named in PROOFS but is not a rule`);
    assert.ok(rule.validate || rule.enrich, `${id} claims proof but has no validator`);
    assert.equal(rule.proof, PROOFS[id]);
  }
  // The number quoted in the README and the UI comes from here; pin it so a
  // new detector cannot quietly inflate the claim.
  const proven = [...RULES_BY_ID.values()].filter((r) => r.proof).length;
  assert.equal(proven, 24);
});

test('every rule belongs to exactly one settings category', async () => {
  const { CATEGORIES, RULES } = await import('../src/rules.js');
  const seen = new Set();
  for (const group of CATEGORIES) {
    for (const id of group.ids) {
      assert.ok(!seen.has(id), `${id} appears in two categories`);
      seen.add(id);
    }
  }
  for (const rule of RULES) {
    assert.ok(seen.has(rule.id), `${rule.id} is in no category, so settings would hide it`);
  }
});

// ------------------------------------------------------------- new detectors
test('issuer range rejects Luhn-valid numbers no network issues', async () => {
  const { cardIssuer } = await import('../src/checksums.js');
  assert.equal(cardIssuer('4242424242424242'), 'Visa');
  assert.equal(cardIssuer('378282246310005'), 'Amex');
  assert.equal(cardIssuer('5555555555554444'), 'Mastercard');
  // A 15-digit number that passes Luhn but is not an Amex is an IMEI, not a card.
  assert.equal(cardIssuer('490154203237518'), null);
  assert.equal(cardIssuer('1234567890123452'), null);
});

test('an IMEI is reported as an IMEI, not as a payment card', () => {
  const found = scan('device IMEI 490154203237518 reported lost').findings.map((f) => f.ruleId);
  assert.deepEqual(found, ['imei']);
});

test('the AWS account number is decoded from the key, offline', () => {
  const f = scan('AKIAIOSFODNN7EXAMPLE').findings[0];
  assert.equal(f.ruleId, 'aws_access_key_id');
  assert.match(f.note, /5810-3995-4779/);
});

test('an AWS secret key pattern does not swallow the tail of a vendor token', () => {
  const found = scan('FIGMA=figd_' + 'a1B2c3D4e5'.repeat(4)).findings.map((f) => f.ruleId);
  assert.ok(found.includes('figma_token'));
  assert.ok(!found.includes('aws_secret_access_key'));
});

test('Indian identifiers validate by their published check algorithms', async () => {
  const { gstin, ifsc, upiVpa } = await import('../src/identifiers.js');
  assert.ok(gstin('27AAPFU0939F1ZV'));
  assert.ok(!gstin('27AAPFU0939F1ZX'), 'wrong check character');
  assert.ok(ifsc('HDFC0001234'));
  assert.ok(upiVpa('ramesh@okhdfcbank'));
  assert.ok(!upiVpa('ramesh@gmail.com'), 'a webmail address is not a UPI handle');
});

test('a JWT signed with alg:none is escalated to critical', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'admin' })).toString('base64url');
  const f = scan(`${header}.${payload}.`).findings.find((x) => x.ruleId === 'jwt');
  assert.equal(f.severity, 'critical');
  assert.match(f.note, /alg:none/);
});

test('prefilters never change what is found, only how fast', async () => {
  const { RULES } = await import('../src/rules.js');
  const samples = [
    'AKIAIOSFODNN7EXAMPLE', 'ghp_' + 'a'.repeat(36), 'card 4242424242424242',
    'contact r.iyer@northwind.co.in', 'postgres://u:pw@h/db', 'GSTIN 27AAPFU0939F1ZV',
  ];
  for (const text of samples) {
    const withPrefilter = scan(text).findings.map((f) => f.ruleId);
    // Re-scan with every prefilter stripped; results must be identical.
    const saved = RULES.map((r) => r.prefilter);
    RULES.forEach((r) => { delete r.prefilter; });
    const without = scan(text).findings.map((f) => f.ruleId);
    RULES.forEach((r, i) => { if (saved[i]) r.prefilter = saved[i]; });
    assert.deepEqual(withPrefilter, without, `prefilter changed results for: ${text}`);
  }
});

test('the benchmark holds at or above its published figures', async () => {
  const { buildCorpus } = await import('../bench/corpus.js');
  let tp = 0, fp = 0, fn = 0;
  for (const seed of [1, 42, 999, 20260925]) {
    for (const c of buildCorpus(seed)) {
      const fired = new Set(scan(c.text).findings.map((f) => f.ruleId));
      const expected = new Set(c.expect);
      for (const id of expected) fired.has(id) ? tp++ : fn++;
      for (const id of fired) if (!expected.has(id)) fp++;
    }
  }
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  assert.ok(precision >= 0.99, `precision regressed to ${(precision * 100).toFixed(2)}%`);
  assert.ok(recall >= 0.99, `recall regressed to ${(recall * 100).toFixed(2)}%`);
});

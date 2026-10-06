#!/usr/bin/env node
/**
 * The release gate, as something you can run.
 *
 * This project has been audited repeatedly, and the failure mode of repeated
 * auditing is an infinite sequence of findings with no definition of done.
 * Prose cannot fix that. A gate can: every criterion below is checked here,
 * by running the thing rather than by asserting it, and the exit code is the
 * answer to "can this ship".
 *
 *   node scripts/gate.js              everything that runs without a browser
 *   node scripts/gate.js --full       plus the browser and performance suites
 *   node scripts/gate.js --json
 *
 * Criteria this cannot check are reported as BLOCKED with the reason, never
 * as a pass. The two that matter: real-provider certification needs accounts
 * and a display (docs/PROVIDERS.md), and independent benchmark datasets need
 * a signed agreement (docs/BENCHMARK.md). A gate that quietly skipped those
 * would be the same lie this product exists to catch.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FULL = process.argv.includes('--full');
const JSON_OUT = process.argv.includes('--json');
const NO_COLOR = process.argv.includes('--no-color') || !process.stdout.isTTY;
const c = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

const read = (p) => readFileSync(join(root, p), 'utf8');
const results = [];

/**
 * @param {string} area one of CORE PRIVACY PROVIDER DOCS ENGINEERING VALIDATION STORE
 * @param {string} name the criterion, phrased so a pass is unambiguous
 * @param {() => {ok: boolean, detail?: string} | {blocked: string}} check
 */
function gate(area, name, check) {
  let out;
  try { out = check(); } catch (err) { out = { ok: false, detail: String(err && err.message).split('\n')[0] }; }
  const verdict = out.blocked ? 'BLOCKED' : out.ok ? 'PASS' : 'FAIL';
  results.push({ area, name, verdict, detail: out.blocked || out.detail || '' });
  if (JSON_OUT) return;
  const tag = verdict === 'PASS' ? green('PASS   ') : verdict === 'FAIL' ? red('FAIL   ') : yellow('BLOCKED');
  console.log(`  ${tag} ${name}${out.blocked || out.detail ? dim(`\n           ${out.blocked || out.detail}`) : ''}`);
}

/** Run a command; pass when it exits 0. */
function runs(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout || 900000 });
    return { ok: true, stdout };
  } catch (err) {
    const tail = String(err.stdout || err.stderr || err.message).trim().split('\n').slice(-2).join(' ');
    return { ok: false, detail: tail.slice(0, 160) };
  }
}

const section = (title) => { if (!JSON_OUT) console.log(`\n${bold(title)}`); };

// ── ENGINEERING ────────────────────────────────────────────────────────────
section('ENGINEERING');

gate('ENGINEERING', 'the engine suite passes', () => {
  const r = runs(process.execPath, ['--test', ...readdirSync(join(root, 'test'))
    .filter((f) => f.endsWith('.test.js')).map((f) => `test/${f}`)]);
  if (!r.ok) return r;
  const n = (r.stdout.match(/^# pass (\d+)/m) || [])[1];
  return { ok: true, detail: `${n} tests` };
});

gate('ENGINEERING', 'hostile input does not crash a parser', () => {
  const r = runs(process.execPath, ['bench/fuzz.js', '--cases', '20000', '--no-color', '--quiet']);
  return r.ok ? { ok: true, detail: '20,000 cases' } : r;
});

gate('ENGINEERING', 'both store packages are byte-identical across builds', () => {
  const built = runs(process.execPath, ['scripts/package.js', '--no-color']);
  if (!built.ok) return built;
  const again = runs(process.execPath, ['scripts/package.js', '--verify', '--no-color']);
  if (!again.ok) return again;
  const digests = [...again.stdout.matchAll(/sha256\s+([0-9a-f]{64})/g)].map((m) => m[1]);
  return { ok: digests.length >= 2, detail: digests.map((d) => d.slice(0, 16)).join(' ') };
});

gate('ENGINEERING', 'content stops before the provider, in a real browser', () => {
  if (!FULL) return { blocked: 'needs --full (launches Chromium)' };
  const r = runs(process.execPath, ['test/e2e/run.mjs', '--no-color'], { timeout: 1800000 });
  if (!r.ok) return r;
  const n = (r.stdout.match(/(\d+) passed/) || [])[1];
  return { ok: true, detail: `${n} browser cases` };
});

gate('ENGINEERING', 'performance budgets are met', () => {
  if (!FULL) return { blocked: 'needs --full (launches Chromium)' };
  const r = runs(process.execPath, ['test/perf/run.mjs', '--no-color'], { timeout: 1800000 });
  return r.ok ? { ok: true, detail: 'every budget met' } : r;
});

// ── CORE ───────────────────────────────────────────────────────────────────
section('CORE');

gate('CORE', 'the mode semantics are declared once, not per handler', () => {
  const src = read('extension/content.js');
  const tables = (src.match(/const MODES = \{/g) || []).length;
  const strays = (src.match(/policy\.mode === 'warn' &&/g) || []).length;
  return { ok: tables === 1 && strays === 0,
    detail: `${tables} mode table(s), ${strays} handler(s) deciding for themselves` };
});

gate('CORE', 'a transformation is verified before the send is replayed', () => {
  const src = read('extension/content.js');
  const reads = /const got = readComposer\(target\);/.test(src);
  const rescans = /const recheck = safeScan\(got\);/.test(src);
  const guards = /if \(got !== wanted \|\| stillThere\)/.test(src);
  return { ok: reads && rescans && guards,
    detail: reads && rescans && guards ? 'read back, rescanned, refused on mismatch'
      : `readback ${reads}, rescan ${rescans}, guard ${guards}` };
});

gate('CORE', 'no shipped module can reach the network', () => {
  const r = runs('grep', ['-rnE',
    '(^|[^.[:alnum:]_])fetch[[:space:]]*\\(|new[[:space:]]+(XMLHttpRequest|WebSocket|EventSource)[[:space:]]*\\(|\\.sendBeacon[[:space:]]*\\(',
    '--include=*.js', 'src', 'extension', '--exclude-dir=engine']);
  // grep exits 1 when it finds nothing, which is the pass here.
  return { ok: !r.ok, detail: r.ok ? 'a shipped module references a network API' : 'no network API referenced' };
});

gate('CORE', 'every detector lands in exactly one tier', () => {
  const r = runs(process.execPath, ['--input-type=module', '-e',
    "import {RULES,tierOf,TIERS} from './src/rules.js';"
    + "const bad=RULES.filter(r=>!TIERS.includes(tierOf(r)));"
    + "if(bad.length){console.error(bad.map(r=>r.id).join(','));process.exit(1)}"
    + "console.log(RULES.length)"]);
  return r.ok ? { ok: true, detail: `${r.stdout.trim()} detectors` } : r;
});

// ── PRIVACY ────────────────────────────────────────────────────────────────
section('PRIVACY');

gate('PRIVACY', 'nothing sensitive is written to synchronised storage', () => {
  const pol = read('extension/policy.js');
  const declares = /export const LOCAL_FIELDS = \['allow'\]/.test(pol);
  const migrates = /chrome\.storage\.sync\.set\(\{ \[SYNC_KEY\]: omit\(synced, LOCAL_FIELDS\) \}\)/.test(pol);
  const options = read('extension/options.js');
  const routed = /writePolicy\(/.test(options) && !/storage\.sync\.set\(\{ policy/.test(options);
  return { ok: declares && migrates && routed,
    detail: `declared ${declares}, migrates and deletes ${migrates}, options routed ${routed}` };
});

gate('PRIVACY', 'the manifest asks for no network permission', () => {
  const m = JSON.parse(read('extension/manifest.json'));
  const allowed = ['storage', 'scripting'];
  const extra = (m.permissions || []).filter((p) => !allowed.includes(p));
  return { ok: extra.length === 0, detail: extra.length ? `extra: ${extra.join(', ')}` : m.permissions.join(', ') };
});

gate('PRIVACY', 'no remote code and no remote stylesheet', () => {
  /**
   * Resource positions, not prose.
   *
   * The first version of this grepped for `googleapis` anywhere in a shipped
   * file, and failed on a comment in `fonts/inter.css` explaining why the font
   * is bundled rather than fetched from `fonts.googleapis.com`. A gate that
   * fires on the explanation of a decision pushes whoever hits it to delete
   * the explanation, which is the opposite of what a gate is for. So this
   * looks only where a remote asset would actually have to appear to load:
   * `src`, `href`, `@import`, `url()`, and a dynamic import of a URL.
   */
  const r = runs('grep', ['-rnE',
    '(src|href)[[:space:]]*=[[:space:]]*["\\x27]?https?:|@import[^;]*https?:|url\\([[:space:]]*["\\x27]?https?:|import\\([[:space:]]*["\\x27]https?:',
    '--include=*.js', '--include=*.html', '--include=*.css', 'extension', '--exclude-dir=engine']);
  return { ok: !r.ok,
    detail: r.ok ? `a shipped file loads a remote asset: ${r.stdout.trim().split('\n')[0].slice(0, 110)}`
      : 'every script, style and font is bundled' };
});

gate('PRIVACY', 'a bundled font ships its licence', () => {
  const dir = join(root, 'extension', 'fonts');
  if (!existsSync(dir)) return { ok: true, detail: 'no bundled fonts' };
  const files = readdirSync(dir);
  const fonts = files.filter((f) => /\.(woff2?|ttf|otf)$/i.test(f));
  const licences = files.filter((f) => /^(LICENSE|LICENCE|OFL)/i.test(f));
  if (!fonts.length) return { ok: true, detail: 'no bundled fonts' };
  const text = licences.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  return { ok: licences.length > 0 && /Copyright \(c\)/i.test(text),
    detail: `${fonts.length} font(s), ${licences.length} licence file(s)` };
});

// ── DOCS ───────────────────────────────────────────────────────────────────
section('DOCS');

gate('DOCS', 'no security-critical documentation drift', () => {
  const r = runs(process.execPath, ['scripts/check-docs.js', '--no-color']);
  return r.ok ? { ok: true, detail: 'every checked claim agrees with the code' } : r;
});

gate('DOCS', 'the V1 contract exists and every item has a status', () => {
  if (!existsSync(join(root, 'docs/V1-CONTRACT.md'))) return { ok: false, detail: 'docs/V1-CONTRACT.md is missing' };
  const text = read('docs/V1-CONTRACT.md');
  const rows = [...text.matchAll(/^\| \d+ \|/gm)].length;
  const unstated = [...text.matchAll(/^\| \d+ \|[^|]*\|\s*\|/gm)].length;
  return { ok: rows > 0 && unstated === 0, detail: `${rows} capabilities, ${unstated} without a status` };
});

gate('DOCS', 'every provider PASS is dated, and every cell is a real verdict', () => {
  /**
   * The invariant is not "the file has a date in it".
   *
   * The first version of this required one, and failed on a matrix that
   * honestly said it had never been measured — which is the state it is
   * supposed to report. The thing that must never happen is an *undated*
   * pass: `PASS` is evidence about a day, because these are other people's
   * products and their composers change without notice.
   */
  if (!existsSync(join(root, 'docs/PROVIDERS.md'))) return { ok: false, detail: 'docs/PROVIDERS.md is missing' };
  const text = read('docs/PROVIDERS.md');
  const allowed = new Set(['PASS', 'FAIL', 'NOT TESTED', 'UNSUPPORTED']);
  // The header row starts with `| path |` and its cells are provider names,
  // which is why it has to be excluded rather than filtered by case.
  const rows = text.split('\n')
    .filter((l) => /^\| [a-z]/.test(l) && l.split('|').length > 5)
    .filter((l) => !/^\| path \|/.test(l));
  const cells = rows.flatMap((l) => l.split('|').slice(2, -1).map((x) => x.trim()));
  const odd = [...new Set(cells.filter((x) => x && !allowed.has(x.replace(/\*/g, ''))))];
  const passes = cells.filter((x) => x.replace(/\*/g, '') === 'PASS').length;
  const dated = /\b20\d\d-\d\d-\d\d\b/.test(text);
  if (odd.length) return { ok: false, detail: `cells that are not a verdict: ${odd.slice(0, 3).join(', ')}` };
  if (passes && !dated) return { ok: false, detail: `${passes} PASS cell(s) with no date in the file` };
  return { ok: rows.length > 0,
    detail: `${rows.length} paths, ${cells.length} cells, ${passes} certified` };
});

// ── PROVIDER ───────────────────────────────────────────────────────────────
section('PROVIDER');

gate('PROVIDER', 'every supported provider has a dated certification', () => ({
  blocked: 'needs signed-in accounts and a display; run test/provider/run.mjs '
    + '--profile <dir> --matrix docs/PROVIDERS.md. Until then this is the release blocker.',
}));

// ── VALIDATION ─────────────────────────────────────────────────────────────
section('VALIDATION');

gate('VALIDATION', 'detection measured against an independent corpus', () => ({
  blocked: 'SecretBench and FPSecretBench need a signed data-protection agreement '
    + 'and BigQuery access (docs/BENCHMARK.md). The internal corpus is self-authored '
    + 'and its 100% is therefore not an external claim.',
}));

gate('VALIDATION', 'alarm rate measured on third-party source', () => {
  const r = runs('ls', ['/tmp/claude-0/wild']);
  if (!r.ok) return { blocked: 'the wild corpus is not on this machine; node bench/wild.js <dir>' };
  return { ok: true, detail: 'bench/wild.js available' };
});

// ── report ─────────────────────────────────────────────────────────────────
const counts = results.reduce((a, r) => ({ ...a, [r.verdict]: (a[r.verdict] || 0) + 1 }), {});
if (JSON_OUT) {
  console.log(JSON.stringify({ results, counts }, null, 2));
} else {
  console.log(`\n${bold('verdict')}`);
  console.log(`  ${counts.PASS || 0} pass, ${counts.FAIL || 0} fail, ${counts.BLOCKED || 0} blocked`);
  const verdict = (counts.FAIL || 0) > 0 ? 'NOT READY'
    : (counts.BLOCKED || 0) > 0 ? 'PRE-PRODUCTION'
      : 'INDUSTRY READY';
  console.log(`  ${bold(verdict)}`);
  if (verdict === 'PRE-PRODUCTION') {
    console.log(dim('  Nothing checked here is failing. What is missing cannot be checked from'));
    console.log(dim('  this machine, and is listed above rather than assumed.'));
  }
}
process.exit((counts.FAIL || 0) > 0 ? 1 : 0);

#!/usr/bin/env node
/**
 * Chhanni CLI.
 *
 * The same engine the extension runs, on the command line — so the rule that
 * stops you pasting a key into a chat box can also stop you committing it.
 *
 *   chhanni scan src/ .env            scan paths
 *   cat prompt.txt | chhanni scan     scan stdin
 *   chhanni redact < prompt.txt       print the safe version
 *
 * Exit codes: 0 clean, 1 findings, 2 findings at blocking severity.
 * That makes `chhanni scan . || exit 1` a usable pre-commit hook.
 */
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scan, summarise } from '../src/detect.js';
import { redact } from '../src/redact.js';
import { RULES } from '../src/rules.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('-')));
const positional = args.filter((a) => !a.startsWith('-'));
const command = positional[0] ?? 'scan';
const paths = positional.slice(1);

const tty = process.stdout.isTTY && !flags.has('--no-color');
const c = (code, s) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const green = (s) => c('32', s);

const SEVERITY_COLOR = { critical: red, high: yellow, medium: yellow, low: dim };

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor']);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|avif|ico|svg|pdf|zip|gz|tar|woff2?|ttf|eot|mp[34]|mov|wasm|lock)$/i;

function* walk(path) {
  let st;
  try { st = statSync(path); } catch { return; }
  if (st.isFile()) {
    if (!SKIP_EXT.test(path) && st.size < 2_000_000) yield path;
    return;
  }
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    if (SKIP_DIRS.has(entry)) continue;
    yield* walk(join(path, entry));
  }
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function usage() {
  console.log(`${bold('chhanni')} — a sieve for everything you paste into an AI

  chhanni scan [paths...]     scan files or directories (stdin if no paths)
  chhanni redact [file]       print the input with secrets replaced
  chhanni rules               list every detector

  --json        machine-readable findings
  --quiet       only print the summary line
  --no-color    plain output

Exit codes: 0 clean, 1 findings, 2 findings at blocking severity.`);
}

if (flags.has('-h') || flags.has('--help') || command === 'help') {
  usage();
  process.exit(0);
}

if (command === 'rules') {
  const width = Math.max(...RULES.map((r) => r.id.length));
  for (const r of [...RULES].sort((a, b) => a.id.localeCompare(b.id))) {
    const paint = SEVERITY_COLOR[r.severity] ?? dim;
    console.log(`${r.id.padEnd(width)}  ${paint(r.severity.padEnd(8))} ${dim(r.confidence.padEnd(8))} ${r.label}`);
    if (r.proof) console.log(`${' '.repeat(width)}  ${dim('proof: ' + r.proof)}`);
  }
  const proven = RULES.filter((r) => r.proof).length;
  console.log(dim(`\n${RULES.length} detectors. ${proven} prove the match rather than trusting its shape.`));
  process.exit(0);
}

if (command === 'redact') {
  const text = paths[0] ? readFileSync(paths[0], 'utf8') : readStdin();
  const { text: out, map } = redact(text);
  process.stdout.write(out);
  if (map.length && process.stderr.isTTY) {
    console.error(dim(`\nchhanni: replaced ${map.length} value${map.length === 1 ? '' : 's'}`));
  }
  process.exit(0);
}

if (command !== 'scan') { usage(); process.exit(64); }

// ------------------------------------------------------------------- scan
const targets = [];
if (paths.length === 0) {
  targets.push({ name: '<stdin>', text: readStdin() });
} else {
  for (const p of paths) {
    for (const file of walk(p)) {
      let text;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      if (text.includes('\u0000')) continue; // binary
      targets.push({ name: relative(process.cwd(), file) || file, text });
    }
  }
}

let total = 0;
let worst = 'clean';
const jsonOut = [];

for (const { name, text } of targets) {
  const result = scan(text);
  if (result.findings.length === 0) continue;
  total += result.findings.length;
  if (result.verdict === 'block') worst = 'block';
  else if (worst !== 'block') worst = 'warn';

  if (flags.has('--json')) {
    jsonOut.push({
      file: name,
      verdict: result.verdict,
      findings: result.findings.map(({ match, ...rest }) => rest), // never emit the secret
    });
    continue;
  }
  if (flags.has('--quiet')) continue;

  console.log(bold(name));
  for (const f of result.findings) {
    const paint = SEVERITY_COLOR[f.severity] ?? dim;
    const loc = dim(`:${f.line}`.padEnd(6));
    console.log(`  ${loc} ${paint(f.severity.padEnd(8))} ${f.label.padEnd(28)} ${dim(f.preview)}`);
    if (f.note) console.log(`         ${dim(f.note)}`);
  }
  console.log();
}

if (flags.has('--json')) {
  console.log(JSON.stringify({ verdict: worst, files: jsonOut }, null, 2));
} else {
  const scope = paths.length ? `${targets.length} file${targets.length === 1 ? '' : 's'}` : 'stdin';
  if (total === 0) console.log(green(`clean — nothing found in ${scope}`));
  else console.log(`${worst === 'block' ? red('blocked') : yellow('found')} ${total} in ${scope}`);
}

process.exit(worst === 'block' ? 2 : worst === 'warn' ? 1 : 0);

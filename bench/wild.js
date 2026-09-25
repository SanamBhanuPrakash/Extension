#!/usr/bin/env node
/**
 * Alarm rate on real code.
 *
 * The generated corpus in `corpus.js` is adversarial but self-authored: a rule
 * that is wrong in a way its author did not think to test scores perfectly.
 * The third-party datasets that would settle this — SecretBench and
 * FPSecretBench — require a signed data-protection agreement and BigQuery
 * access (see BENCHMARK.md), so they cannot be run here.
 *
 * What can be run is the nearest honest thing: scan large public repositories
 * that nobody wrote for this benchmark, and count how often the engine speaks.
 * A tool that fires constantly on ordinary source gets uninstalled in a week,
 * whatever its benchmark says.
 *
 *   node bench/wild.js /path/to/checkouts --show
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { scan } from '../src/detect.js';

const root = process.argv[2] || '/tmp/claude-0/wild';
const show = process.argv.includes('--show');
const tty = process.stdout.isTTY && !process.argv.includes('--no-color');
const c = (code, s) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor', '__pycache__']);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|avif|ico|svg|pdf|zip|gz|tar|woff2?|ttf|eot|mp[34]|mov|wasm|lock|min\.js|map)$/i;

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (!SKIP_EXT.test(entry.name)) yield full;
  }
}

const repos = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

let totalFiles = 0;
let totalBytes = 0;
let totalFindings = 0;
const byRule = new Map();
const samples = [];
const started = Date.now();

for (const repo of repos) {
  let files = 0;
  let findings = 0;
  for (const file of walk(join(root, repo))) {
    let text;
    try {
      const st = statSync(file);
      if (st.size > 1_500_000) continue;
      text = readFileSync(file, 'utf8');
    } catch { continue; }
    if (text.includes('\u0000')) continue;
    files++;
    totalBytes += text.length;

    // NER off: person names in CONTRIBUTORS, changelogs and copyright headers
    // are correct detections, not false ones, and would drown the signal this
    // measures — whether the credential rules fire on ordinary code.
    const result = scan(text, { ner: false });
    for (const f of result.findings) {
      findings++;
      byRule.set(f.ruleId, (byRule.get(f.ruleId) || 0) + 1);
      if (samples.length < 400) {
        samples.push({ repo, file: relative(root, file), ruleId: f.ruleId, line: f.line, preview: f.preview, severity: f.severity });
      }
    }
  }
  totalFiles += files;
  totalFindings += findings;
  console.log(`  ${bold(repo.padEnd(12))} ${String(files).padStart(6)} files   ${String(findings).padStart(5)} findings   ${dim(`${(findings / Math.max(1, files) * 100).toFixed(2)}% of files`)}`);
}

const seconds = (Date.now() - started) / 1000;
console.log(bold('\n  total'));
console.log(`    ${totalFiles.toLocaleString()} files, ${(totalBytes / 1e6).toFixed(1)} MB of real source`);
console.log(`    ${totalFindings.toLocaleString()} findings — ${dim(`one every ${Math.round(totalFiles / Math.max(1, totalFindings))} files`)}`);
console.log(`    ${seconds.toFixed(1)}s (${(totalBytes / 1e6 / seconds).toFixed(1)} MB/s)\n`);

if (byRule.size) {
  console.log(bold('  by detector'));
  for (const [id, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${id.padEnd(28)} ${String(n).padStart(5)}`);
  }
  console.log();
}

if (show) {
  for (const s of samples.slice(0, 60)) {
    console.log(`  ${s.severity.padEnd(8)} ${s.ruleId.padEnd(24)} ${dim(`${s.file}:${s.line}`)}  ${s.preview}`);
  }
}

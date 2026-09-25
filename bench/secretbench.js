#!/usr/bin/env node
/**
 * Adapter for SecretBench and FPSecretBench.
 *
 * These are the datasets that would make the precision claim independent:
 * SecretBench is 97,479 candidate secrets from 818 real GitHub repositories,
 * 15,084 of them labelled true; FPSecretBench is the false positives nine
 * tools reported on it.
 *
 * Neither can be run here. Both require a signed data-protection agreement
 * with the authors and access through Google BigQuery, because they contain
 * live credentials and committers' email addresses. That is a reasonable
 * restriction and not one to route around.
 *
 * So the harness exists and the data does not. To run it:
 *
 *   1. Email the authors (sbasak4@ncsu.edu) and sign the agreement.
 *   2. Export from BigQuery to CSV:
 *
 *        SELECT secret, label, file_type, file_identifier
 *        FROM `dev-range-332204.secretbench.secrets`
 *
 *   3. node bench/secretbench.js secrets.csv
 *
 * Expect the number to be lower than this project's own corpus reports.
 * Publishing that drop is the entire point of running it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { scan } from '../src/detect.js';

const path = process.argv[2];
if (!path || !existsSync(path)) {
  console.log(`
  SecretBench adapter — the dataset is not bundled and cannot be.

  SecretBench and FPSecretBench require a signed data-protection agreement
  and BigQuery access, because they contain live credentials. See the header
  of this file, and docs/BENCHMARK.md, for how to obtain them.

  Usage: node bench/secretbench.js <exported.csv>

  Expected columns: secret, label  (label true/false), optionally file_type.
`);
  process.exit(path ? 1 : 0);
}

/** Minimal RFC 4180 reader: the export quotes secrets that contain commas. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const rows = parseCsv(readFileSync(path, 'utf8'));
const header = rows[0].map((h) => h.trim().toLowerCase());
const iSecret = header.indexOf('secret');
const iLabel = header.indexOf('label');
if (iSecret < 0 || iLabel < 0) {
  console.error('  Expected columns "secret" and "label".');
  process.exit(1);
}

const truthy = (v) => /^(true|1|yes|t)$/i.test(String(v).trim());
let tp = 0;
let fp = 0;
let fn = 0;
let tn = 0;
const missedTypes = new Map();

for (const row of rows.slice(1)) {
  const secret = row[iSecret];
  if (!secret) continue;
  const isTrue = truthy(row[iLabel]);
  // Each candidate is scored on its own, the way the tools in the study were.
  const found = scan(secret, { ner: false, tables: false, injection: false }).findings.length > 0;
  if (isTrue && found) tp++;
  else if (isTrue && !found) {
    fn++;
    const key = row[header.indexOf('file_type')] || 'unknown';
    missedTypes.set(key, (missedTypes.get(key) || 0) + 1);
  } else if (!isTrue && found) fp++;
  else tn++;
}

const precision = tp / Math.max(1, tp + fp);
const recall = tp / Math.max(1, tp + fn);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

console.log(`\n  SecretBench — ${(tp + fp + fn + tn).toLocaleString()} candidates\n`);
console.log(`    precision  ${pct(precision)}   ${tp.toLocaleString()} true / ${fp.toLocaleString()} false positives`);
console.log(`    recall     ${pct(recall)}   ${fn.toLocaleString()} missed`);
console.log(`    F1         ${pct((2 * precision * recall) / Math.max(1e-9, precision + recall))}\n`);

if (missedTypes.size) {
  console.log('    most-missed file types');
  for (const [type, n] of [...missedTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`      ${String(type).padEnd(20)} ${n}`);
  }
  console.log();
}

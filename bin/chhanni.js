#!/usr/bin/env node
/**
 * Chhanni CLI.
 *
 * The same engine the extension runs, on the command line — so the rule that
 * stops you pasting a key into a chat box can also stop you committing it.
 *
 *   chhanni scan src/ .env            scan paths
 *   chhanni scan contract.docx        scan a document, not just its name
 *   cat prompt.txt | chhanni scan     scan stdin
 *   chhanni redact < prompt.txt       print the safe version
 *   chhanni strip photo.jpg           write a copy without its metadata
 *
 * Attachments go through the same extraction the extension uses, so a PDF, a
 * DOCX, an XLSX, a PPTX, an ODT or a photograph's EXIF is read here too. What
 * cannot be read is printed as such rather than passed over in silence: a
 * scanner that stays quiet about a file it never opened is worse than no
 * scanner, because it is trusted.
 *
 * Exit codes: 0 clean, 1 findings, 2 findings at blocking severity.
 * That makes `chhanni scan . || exit 1` a usable pre-commit hook.
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, basename, extname } from 'node:path';
import { scan, summarise } from '../src/detect.js';
import { redact } from '../src/redact.js';
import { RULES } from '../src/rules.js';
import { extractDocument, describeKind, rewriteMode } from '../src/documents.js';
import { stripImageMetadata, describeImageMetadata, readImageMetadata } from '../src/imagemeta.js';

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
// Not "everything binary" any more — PDFs, Office documents and images are
// read now. What stays out is what genuinely holds no readable text: media,
// fonts, compiled objects, general archives and lockfiles.
const SKIP_EXT = /\.(ico|svg|woff2?|ttf|otf|eot|mp[34]|mov|avi|mkv|webm|wav|flac|wasm|so|dylib|dll|a|o|zip|gz|bz2|xz|tar|7z|rar|lock)$/i;
const MAX_BYTES = 16 * 1024 * 1024;

function* walk(path) {
  let st;
  try { st = statSync(path); } catch { return; }
  if (st.isFile()) {
    if (!SKIP_EXT.test(path) && st.size < MAX_BYTES) yield path;
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
  chhanni strip <image...>    rewrite a JPEG or PNG without its metadata
  chhanni rules               list every detector

  --json        machine-readable findings
  --quiet       only print the summary line
  --in-place    strip writes over the original instead of a .clean copy
  --no-color    plain output

PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP, RTF and image metadata are read
directly. There is no OCR, so text that exists only as pixels is not seen,
and scan says so for every file it could not read.

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
  // A document goes through extraction first, so `chhanni redact deal.docx`
  // prints the safe text rather than a wall of ZIP bytes. What comes out is
  // text, never a rewritten .docx: see rewriteMode() for why.
  let text;
  if (paths[0]) {
    const doc = await extractDocument(new Uint8Array(readFileSync(paths[0])), paths[0]);
    if (doc.status === 'opaque' && !doc.text) {
      console.error(red(`chhanni: ${doc.reason || 'nothing readable in this file'}`));
      process.exit(3);
    }
    text = doc.text;
    if (doc.status !== 'readable' && process.stderr.isTTY) {
      console.error(dim(`chhanni: ${doc.reason || 'partially read'}`));
    }
  } else {
    text = readStdin();
  }
  const { text: out, map } = redact(text);
  process.stdout.write(out);
  if (map.length && process.stderr.isTTY) {
    console.error(dim(`\nchhanni: replaced ${map.length} value${map.length === 1 ? '' : 's'}`));
  }
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────── strip
//
// The other half of reading an image's metadata: being able to hand back the
// same image without it. No re-encoding — the JPEG's APPn segments and the
// PNG's ancillary chunks are dropped and the image data is copied through, so
// the picture is byte-for-byte the one you had.
if (command === 'strip') {
  if (!paths.length) { console.error('chhanni strip: name at least one image'); process.exit(64); }
  let changed = 0;
  for (const file of paths) {
    let bytes;
    try { bytes = new Uint8Array(readFileSync(file)); } catch {
      console.error(red(`${file}: could not be read`)); continue;
    }
    const before = describeImageMetadata(readImageMetadata(bytes));
    const stripped = stripImageMetadata(bytes);
    if (!stripped) {
      console.log(`${bold(file)} ${dim(before
        ? 'carries metadata, but this format cannot be rewritten safely'
        : 'has no metadata to remove')}`);
      continue;
    }
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';
    const out = flags.has('--in-place')
      ? file
      : join(dir, `${basename(file, extname(file))}.clean${extname(file)}`);
    writeFileSync(out, stripped.bytes);
    changed++;
    console.log(`${bold(file)} → ${out}`);
    if (before) {
      console.log(`  ${dim('removed: ' + before
        .replace(/^This image carries /, '')
        .replace(/ in its metadata\.$/, ''))}`);
    }
    console.log(`  ${dim(`${stripped.removed.join(', ')} dropped, ${bytes.length} → ${stripped.bytes.length} bytes`)}`);
  }
  process.exit(changed ? 0 : 1);
}

if (command !== 'scan') { usage(); process.exit(64); }

// ------------------------------------------------------------------- scan
//
// Kinds where "could not read" is worth saying out loud. A .wasm or a compiled
// object in a directory sweep is noise; a PDF, a legacy .doc or a photograph
// is a file someone expected to be checked.
const SPEAK_UP = (kind) =>
  kind === 'pdf' || kind === 'ole2' || kind === 'zip' || kind === 'postscript'
  || kind === 'oversize' || String(kind).startsWith('image/');

const targets = [];
if (paths.length === 0) {
  targets.push({ name: '<stdin>', text: readStdin(), status: 'readable', kind: 'text' });
} else {
  for (const p of paths) {
    for (const file of walk(p)) {
      let bytes;
      try { bytes = new Uint8Array(readFileSync(file)); } catch { continue; }
      const doc = await extractDocument(bytes, file);
      targets.push({ name: relative(process.cwd(), file) || file, ...doc });
    }
  }
}

let total = 0;
let worst = 'clean';
let unread = 0;
const jsonOut = [];

for (const target of targets) {
  const { name, text, status, kind, note, reason } = target;
  const result = text ? scan(text) : { findings: [], verdict: 'clean' };
  const speak = status !== 'readable' && SPEAK_UP(kind);
  if (speak) unread++;
  if (result.findings.length === 0 && !speak) continue;

  total += result.findings.length;
  if (result.verdict === 'block') worst = 'block';
  else if (worst !== 'block' && result.findings.length) worst = 'warn';

  if (flags.has('--json')) {
    jsonOut.push({
      file: name,
      kind,
      read: status,
      note: note || null,
      notRead: speak ? reason : null,
      verdict: result.verdict,
      findings: result.findings.map(({ match, ...rest }) => rest), // never emit the secret
    });
    continue;
  }
  if (flags.has('--quiet')) continue;

  console.log(bold(name) + (status === 'readable' ? '' : dim(`  [${describeKind(kind)}, ${status}]`)));
  for (const f of result.findings) {
    const paint = SEVERITY_COLOR[f.severity] ?? dim;
    const loc = dim(`:${f.line}`.padEnd(6));
    console.log(`  ${loc} ${paint(f.severity.padEnd(8))} ${f.label.padEnd(28)} ${dim(f.preview)}`);
    if (f.note) console.log(`         ${dim(f.note)}`);
  }
  if (note) console.log(`  ${yellow('metadata')} ${note}`);
  if (speak) console.log(`  ${dim('not read')} ${reason || 'nothing readable in this file'}`);
  if (rewriteMode(target).mode === 'strip') {
    console.log(`  ${dim('fix     ')} ${dim(`chhanni strip ${name}`)}`);
  }
  console.log();
}

if (flags.has('--json')) {
  console.log(JSON.stringify({ verdict: worst, files: jsonOut }, null, 2));
} else {
  const scope = paths.length ? `${targets.length} file${targets.length === 1 ? '' : 's'}` : 'stdin';
  const caveat = unread ? dim(`  (${unread} not fully read)`) : '';
  if (total === 0) console.log(green(`clean — nothing found in ${scope}`) + caveat);
  else console.log(`${worst === 'block' ? red('blocked') : yellow('found')} ${total} in ${scope}` + caveat);
}

process.exit(worst === 'block' ? 2 : worst === 'warn' ? 1 : 0);

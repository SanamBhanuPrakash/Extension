#!/usr/bin/env node
/**
 * The store package, built the same way twice.
 *
 * Packaging used to be two lines of shell printed at the end of the build and
 * run by hand. That is the step where a security extension gets shipped from
 * the wrong directory, at the wrong version, with a stale engine in it, and
 * nobody can tell afterwards because a ZIP made by `zip -r` embeds the clock.
 *
 * So: one command, one artifact per target, and a digest. Same commit, same
 * command, same bytes — which is the only way a reviewer can check that what
 * is on the store is what is in the repository. Entries are sorted, mtimes are
 * fixed, and compression is deterministic, because all three of those leak
 * into the bytes otherwise.
 *
 *   node scripts/package.js            both targets
 *   node scripts/package.js --verify   rebuild and fail if the digest moved
 *
 * No dependency: the ZIP writer is below, in about ninety lines, and the
 * project has read ZIPs since 0.3.
 */
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const NO_COLOR = process.argv.includes('--no-color') || !process.stdout.isTTY;
const dim = (s) => (NO_COLOR ? s : `\u001b[2m${s}\u001b[0m`);
const bold = (s) => (NO_COLOR ? s : `\u001b[1m${s}\u001b[0m`);
const red = (s) => (NO_COLOR ? s : `\u001b[31m${s}\u001b[0m`);

const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * A fixed DOS timestamp. The clock is the single largest source of
 * irreproducibility in a ZIP, and the mtime of a build artifact carries no
 * information anybody wants: the commit does.
 */
const DOS_TIME = 0;                 // 00:00:00
const DOS_DATE = (2026 - 1980) << 9 | (1 << 5) | 1;   // 2026-01-01

function* walk(dir, base = dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, base);
    else yield relative(base, full).split(sep).join('/');
  }
}

function zip(dir) {
  const names = [...walk(dir)].sort();          // sorted, so order is not the filesystem's opinion
  const locals = [];
  const central = [];
  let offset = 0;

  for (const name of names) {
    const raw = readFileSync(join(dir, name));
    const deflated = deflateRawSync(raw, { level: 9 });
    // Only compress when it helps; "stored" is deterministic by definition.
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags: none, so no data descriptor
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // no extra field: another clock hides there
    locals.push(local, nameBuf, data);

    const dirEntry = Buffer.alloc(46);
    dirEntry.writeUInt32LE(0x02014b50, 0);
    dirEntry.writeUInt16LE(20, 4);         // version made by
    dirEntry.writeUInt16LE(20, 6);         // version needed
    dirEntry.writeUInt16LE(0, 8);
    dirEntry.writeUInt16LE(method, 10);
    dirEntry.writeUInt16LE(DOS_TIME, 12);
    dirEntry.writeUInt16LE(DOS_DATE, 14);
    dirEntry.writeUInt32LE(sum, 16);
    dirEntry.writeUInt32LE(data.length, 20);
    dirEntry.writeUInt32LE(raw.length, 24);
    dirEntry.writeUInt16LE(nameBuf.length, 28);
    dirEntry.writeUInt32LE(offset, 42);
    central.push(dirEntry, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return { bytes: Buffer.concat([...locals, centralBuf, end]), count: names.length };
}

const TARGETS = ['chrome', 'firefox'];
const verify = process.argv.includes('--verify');
const results = [];
let failed = false;

for (const target of TARGETS) {
  const dir = join(root, 'dist', target);
  if (!existsSync(join(dir, 'manifest.json'))) {
    console.error(red(`dist/${target} is missing. Run \`node scripts/build.js\` first.`));
    process.exit(1);
  }
  // The package must say the same version as the repository, or the upload is
  // a different product from the commit.
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    console.error(red(`dist/${target} is version ${manifest.version}, package.json is ${pkg.version}. Rebuild.`));
    process.exit(1);
  }
  // A dist tree without an engine loads, reports no error, and guards nothing.
  if (!existsSync(join(dir, 'engine', 'detect.js'))) {
    console.error(red(`dist/${target} has no engine/. Rebuild.`));
    process.exit(1);
  }

  const out = join(root, 'dist', `chhanni-${target}-${pkg.version}.zip`);
  const { bytes, count } = zip(dir);
  const digest = createHash('sha256').update(bytes).digest('hex');

  if (verify && existsSync(out)) {
    const was = createHash('sha256').update(readFileSync(out)).digest('hex');
    if (was !== digest) {
      console.error(red(`${target}: the package is not reproducible — ${was.slice(0, 16)} then, ${digest.slice(0, 16)} now`));
      // Deliberately leave the existing file alone. A verification step that
      // overwrites the artifact it has just found to differ destroys the
      // baseline, so the *next* verification fails too and the real
      // difference is one run behind where anyone looks for it.
      failed = true;
      results.push({ target, out: relative(root, out), count, size: bytes.length, digest: `${digest}  (NOT WRITTEN)` });
      continue;
    }
  }
  writeFileSync(out, bytes);
  results.push({ target, out: relative(root, out), count, size: bytes.length, digest });
}

// Stale packages from older versions sitting beside the current one is exactly
// how the wrong file gets uploaded.
for (const name of readdirSync(join(root, 'dist'))) {
  if (!name.endsWith('.zip')) continue;
  if (results.some((r) => r.out.endsWith(name))) continue;
  rmSync(join(root, 'dist', name));
  console.log(dim(`removed stale package ${name}`));
}

console.log();
for (const r of results) {
  console.log(`${bold(r.out)}  ${dim(`${r.count} files, ${(r.size / 1024).toFixed(0)} KB`)}`);
  console.log(`  sha256  ${r.digest}`);
}
console.log();
console.log(dim('Upload these files. Do not zip extension/ or dist/<target> by hand —'));
console.log(dim('this is the only path that checks the version and the engine first.'));
process.exit(failed ? 1 : 0);

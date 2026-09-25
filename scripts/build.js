/**
 * Build.
 *
 * Produces a loadable extension for each store from one source tree:
 *
 *   dist/chrome/    Chrome, Edge, Brave, Opera, Arc  (Chromium MV3)
 *   dist/firefox/   Firefox and Firefox for Android  (Gecko MV3)
 *
 * It also refreshes extension/engine/ in place, which is what `Load unpacked`
 * points at during development.
 *
 * Still no bundler. The differences between the two targets are small and
 * declarative, so they are expressed as a manifest patch rather than a
 * toolchain.
 */
import { mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    const dst = join(to, entry);
    if (statSync(src).isDirectory()) copyTree(src, dst);
    else copyFileSync(src, dst);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

// ── 1. refresh the in-place engine copy, for `Load unpacked` during dev ──
const engineDir = join(root, 'extension', 'engine');
mkdirSync(engineDir, { recursive: true });
let modules = 0;
for (const file of readdirSync(join(root, 'src'))) {
  if (!file.endsWith('.js')) continue;
  copyFileSync(join(root, 'src', file), join(engineDir, file));
  modules++;
}

// ── 2. Chromium ──────────────────────────────────────────────────────────
const chromeDir = join(root, 'dist', 'chrome');
rmSync(chromeDir, { recursive: true, force: true });
copyTree(join(root, 'extension'), chromeDir);

const base = JSON.parse(readFileSync(join(chromeDir, 'manifest.json'), 'utf8'));
base.version = pkg.version;
writeFileSync(join(chromeDir, 'manifest.json'), JSON.stringify(base, null, 2) + '\n');

// ── 3. Gecko ─────────────────────────────────────────────────────────────
const firefoxDir = join(root, 'dist', 'firefox');
rmSync(firefoxDir, { recursive: true, force: true });
copyTree(join(root, 'extension'), firefoxDir);

const gecko = JSON.parse(JSON.stringify(base));
// Firefox requires a stable add-on id, and will not install an MV3 extension
// without one. Everything else in the manifest is already Gecko-compatible:
// there is no background service worker to convert, and no chrome-only API in
// use beyond chrome.* itself, which Firefox aliases.
gecko.browser_specific_settings = {
  gecko: {
    id: 'chhanni@sanambhanuprakash.github.io',
    strict_min_version: '128.0',
  },
};
// Gecko serves web-accessible resources from a per-install moz-extension://
// origin; the match pattern is the same, but the id above is what makes those
// URLs resolvable at all.
writeFileSync(join(firefoxDir, 'manifest.json'), JSON.stringify(gecko, null, 2) + '\n');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`chhanni: ${modules} engine modules -> extension/engine/`);
console.log(`chhanni: dist/chrome   ${kb(dirSize(chromeDir))}   (Chrome, Edge, Brave, Opera, Arc)`);
console.log(`chhanni: dist/firefox  ${kb(dirSize(firefoxDir))}   (Firefox, Firefox for Android)`);
console.log('\nPackage for upload:');
console.log('  cd dist/chrome  && zip -r ../chhanni-chrome.zip  . -x ".*"');
console.log('  cd dist/firefox && zip -r ../chhanni-firefox.zip . -x ".*"');

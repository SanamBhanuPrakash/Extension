/**
 * Copies the engine into the extension so the content script and the CLI
 * share one source of truth. No bundler: the modules are plain ESM and the
 * content script loads them with a dynamic import of a web-accessible URL.
 */
import { mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'extension', 'engine');
mkdirSync(out, { recursive: true });

let n = 0;
for (const file of readdirSync(join(root, 'src'))) {
  if (!file.endsWith('.js')) continue;
  copyFileSync(join(root, 'src', file), join(out, file));
  n++;
}
console.log(`chhanni: copied ${n} engine modules into extension/engine/`);

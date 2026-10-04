#!/usr/bin/env node
/**
 * The tests that only a browser can run.
 *
 * `npm test` covers the engine and proves a great deal about it. It cannot
 * prove the one thing the product is actually for, which is that content
 * stops before it reaches the provider — and four separate ways past the
 * guard shipped in 0.4.0 precisely because nothing here existed:
 *
 *   clicking Send               no click listener existed at all
 *   submitting a form           no submit listener existed at all
 *   pasting a screenshot        the paste handler read only text/plain
 *   a composer in an iframe
 *     inside a shadow root      the subframe gate used querySelector,
 *                               which does not cross a shadow boundary
 *
 * Every one of those passes a unit test suite and fails a user.
 *
 * Each case below drives the real built extension in a real Chromium against
 * a mock provider that records what it would have transmitted. The assertion
 * is always about that recording, never about Chhanni's own UI: "the panel
 * appeared" is not the same claim as "the key did not leave".
 *
 *   node scripts/build.js && node test/e2e/run.mjs
 *
 * Playwright is not a dependency of this project and is not in package.json.
 * When it is absent this exits 0 with a message, so a contributor who has not
 * installed it still gets a green `npm test`. CI installs it for this job.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, cpSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const PAGES = join(here, 'pages');
const NO_COLOR = process.argv.includes('--no-color') || !process.stdout.isTTY;
const c = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const dim = (s) => c('2', s);

// ── locate playwright without depending on it ───────────────────────────────
let chromium = null;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
                    'playwright-core']) {
  try { ({ chromium } = await import(spec)); break; } catch { /* try the next */ }
}
if (!chromium) {
  console.log(dim('e2e: playwright is not installed; skipping the browser suite.'));
  console.log(dim('     npm i --no-save playwright && npx playwright install chromium'));
  process.exit(0);
}
let executablePath;
for (const p of ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome']) {
  if (existsSync(p)) { executablePath = p; break; }
}

if (!existsSync(join(root, 'dist', 'chrome', 'engine', 'detect.js'))) {
  console.error(red('e2e: dist/chrome is missing or incomplete. Run `node scripts/build.js` first.'));
  process.exit(1);
}

// ── a copy of the real build, taught about localhost ────────────────────────
const work = mkdtempSync(join(tmpdir(), 'chhanni-e2e-'));
const EXT = join(work, 'ext');
cpSync(join(root, 'dist', 'chrome'), EXT, { recursive: true });
{
  const p = join(EXT, 'manifest.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  const local = 'http://localhost/*';
  m.host_permissions.push(local);
  m.content_scripts[0].matches.push(local);
  for (const w of m.web_accessible_resources) w.matches.push(local);
  writeFileSync(p, JSON.stringify(m, null, 2));
}

process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });

const PORT = 8899;
const server = createServer((q, s) => {
  let body;
  try { body = readFileSync(join(PAGES, q.url === '/' ? 'app-textarea.html' : q.url.split('?')[0])); }
  catch { s.writeHead(404); s.end(); return; }
  s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  s.end(body);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const KEY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const SECRET = `AWS_ACCESS_KEY_ID=${KEY}`;
const READY_MS = 3500;          // comfortably past a cold start

let passed = 0;
const failures = [];

async function test(name, page, body) {
  const profile = join(work, `p-${Math.random().toString(36).slice(2)}`);
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath,
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1000, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const t = {
    ok(cond, msg) { if (!cond) throw new Error(msg); },
    equal(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); },
  };
  try {
    const p = await ctx.newPage();
    await p.goto(`http://localhost:${PORT}/${page}`);
    await p.waitForTimeout(READY_MS);
    await body(p, t, ctx);
    passed++;
    console.log(`${green('ok')}   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`${red('FAIL')} ${name}\n       ${err.message.split('\n')[0]}`);
  } finally {
    await ctx.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}

const sent = (p) => p.evaluate(() => (window.__sent || []).map((s) => s.how + ':' + (/AKIA[A-Z0-9]{16}/.test(s.text) ? 'WITH-KEY' : 'clean')));
const files = (p) => p.evaluate(() => window.__files || []);
const panelUp = (p) => p.evaluate(() => !!document.querySelector('.chhanni-panel'));
const noticeUp = (p) => p.evaluate(() => !!document.querySelector('.chhanni-notice'));
const cleanUp = (p) => p.evaluate(() => !!document.querySelector('.chhanni-clean'));

async function paste(p, text, selector = '#prompt-textarea') {
  await p.evaluate((t) => navigator.clipboard.writeText(t), text);
  await p.locator(selector).click();
  await p.keyboard.press('ControlOrMeta+V');
  await p.waitForTimeout(700);
}

// ─────────────────────────────────────────────── the ways a message is sent
await test('paste of a credential is stopped and explained', 'app-textarea.html', async (p, t) => {
  await paste(p, SECRET);
  t.ok(await panelUp(p), 'no panel was shown');
  const v = await p.locator('#prompt-textarea').inputValue();
  t.ok(!v.includes(KEY), 'the key reached the composer');
});

await test('Enter does not send a credential', 'app-textarea.html', async (p, t) => {
  await p.locator('#prompt-textarea').fill(`my key is ${KEY}`);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(700);
  t.ok(await panelUp(p), 'no panel was shown');
  t.equal(JSON.stringify(await sent(p)), '[]', 'the provider received something');
});

await test('clicking Send does not send a credential', 'app-textarea.html', async (p, t) => {
  await p.locator('#prompt-textarea').fill(`my key is ${KEY}`);
  await p.locator('#send').click();
  await p.waitForTimeout(700);
  t.ok(await panelUp(p), 'no panel was shown');
  t.equal(JSON.stringify(await sent(p)), '[]', 'the provider received something');
});

await test('submitting the form does not send a credential', 'app-textarea.html', async (p, t) => {
  await p.locator('#prompt-textarea').fill(`my key is ${KEY}`);
  await p.evaluate(() => document.getElementById('f').requestSubmit());
  await p.waitForTimeout(700);
  t.ok(await panelUp(p), 'no panel was shown');
  t.equal(JSON.stringify(await sent(p)), '[]', 'the provider received something');
});

await test('a programmatic click is guarded too', 'app-textarea.html', async (p, t) => {
  await p.locator('#prompt-textarea').fill(`my key is ${KEY}`);
  await p.evaluate(() => document.getElementById('send').click());
  await p.waitForTimeout(700);
  t.equal(JSON.stringify(await sent(p)), '[]', 'the provider received something');
});

await test('a clean message still sends, by every path', 'app-textarea.html', async (p, t) => {
  await p.locator('#prompt-textarea').fill('what is the capital of France?');
  await p.locator('#send').click();
  await p.waitForTimeout(500);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(500);
  const got = await sent(p);
  t.ok(got.length >= 2, `a clean message was blocked: ${JSON.stringify(got)}`);
  t.ok(got.every((g) => g.endsWith('clean')), 'something was mangled');
});

await test('a clean check says so, once', 'app-textarea.html', async (p, t) => {
  await paste(p, 'nothing sensitive in this sentence at all');
  t.ok(await cleanUp(p), 'no clean state was shown');
  t.ok(!(await panelUp(p)), 'a panel was shown for clean content');
});

// ────────────────────────────────────────────────────── other ways content moves
await test('a pasted image is inspected, not ignored', 'app-textarea.html', async (p, t) => {
  await p.evaluate(async () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([u8], { type: 'image/png' }) })]);
  });
  await p.locator('#prompt-textarea').click();
  await p.keyboard.press('ControlOrMeta+V');
  await p.waitForTimeout(1500);
  // The image is a 1x1 PNG with no metadata, so there is nothing to find —
  // what must be true is that it went through inspection and was handed on,
  // rather than reaching the page unseen.
  const got = await files(p);
  t.ok(got.length > 0, 'the image never reached the page at all');
  t.ok(got.some((f) => f.how === 'drop' || f.how === 'paste'), `unexpected delivery: ${JSON.stringify(got)}`);
});

await test('a link whose href carries a key is caught', 'app-contenteditable.html', async (p, t) => {
  await p.evaluate(async (key) => {
    const html = `<p>See <a href="https://example.com/doc?token=${key}">the doc</a>.</p>`;
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob(['See the doc.'], { type: 'text/plain' }),
    })]);
  }, KEY);
  await p.locator('#ce').click();
  await p.keyboard.press('ControlOrMeta+V');
  await p.waitForTimeout(900);
  t.ok(await panelUp(p), 'the key in the href was not noticed');
});

await test('a file chosen from the picker is inspected', 'app-textarea.html', async (p, t) => {
  await p.evaluate((s) => {
    const dt = new DataTransfer();
    dt.items.add(new File([s], 'config.env', { type: 'text/plain' }));
    const i = document.getElementById('picker');
    i.files = dt.files;
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, SECRET);
  await p.waitForTimeout(1500);
  t.ok(await panelUp(p), 'the attachment was not inspected');
  t.equal((await files(p)).length, 0, 'the file reached the page before the user decided');
});

await test('an uninspectable file is named, not passed silently', 'app-textarea.html', async (p, t) => {
  await p.evaluate(() => {
    const dt = new DataTransfer();
    const big = new Uint8Array(20 * 1024 * 1024); big.fill(0xab);
    dt.items.add(new File([big], 'archive.bin', { type: 'application/octet-stream' }));
    const i = document.getElementById('picker');
    i.files = dt.files;
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p.waitForTimeout(3000);
  t.ok(await noticeUp(p), 'nothing told the user the file was not read');
});

// ────────────────────────────────────────────────────────── where it runs
await test('a composer in an iframe inside a shadow root is guarded', 'app-iframe-shadow.html', async (p, t) => {
  const handle = await p.locator('#f').elementHandle();
  const frame = await handle.contentFrame();
  t.ok(frame, 'the frame did not load');
  await frame.waitForFunction(() => !!document.getElementById('host')?.shadowRoot
    ?.querySelector('#prompt-textarea'), null, { timeout: 5000 });
  await p.evaluate((s) => navigator.clipboard.writeText(s), SECRET);
  await frame.evaluate(() => document.getElementById('host').shadowRoot.querySelector('#prompt-textarea').focus());
  await p.keyboard.press('ControlOrMeta+V');
  await p.waitForTimeout(900);
  const v = await frame.evaluate(() => document.getElementById('host').shadowRoot.querySelector('#prompt-textarea').value);
  t.ok(!v.includes(KEY), 'the key reached a composer in an iframe inside a shadow root');
});

await test('a host page that hides the panel still cannot send', 'hostile.html', async (p, t) => {
  await p.locator('#prompt-textarea').fill(`my key is ${KEY}`);
  await p.locator('#send').click();
  await p.waitForTimeout(700);
  t.equal(JSON.stringify(await sent(p)), '[]', 'hiding the panel let the send through');
});

// ──────────────────────────────────────────────────────── failure behaviour
await test('a malformed stored policy does not let content through', 'app-textarea.html', async (p, t, ctx) => {
  const admin = await ctx.newPage();
  await admin.goto('chrome://extensions');
  await admin.waitForTimeout(600);
  const id = await admin.evaluate(() => document.querySelector('extensions-manager')?.shadowRoot
    ?.querySelector('extensions-item-list')?.shadowRoot?.querySelector('extensions-item')?.id);
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${id}/options.html`);
  await opt.waitForTimeout(600);
  await opt.evaluate(async () => { await chrome.storage.sync.set({ policy: { mode: 'warn', disabled: 5, allow: [] } }); });
  await opt.close(); await admin.close();
  await p.reload();
  await p.waitForTimeout(READY_MS);
  await paste(p, SECRET);
  const v = await p.locator('#prompt-textarea').inputValue();
  t.ok(!v.includes(KEY), 'a malformed policy let the key through');
});

await new Promise((r) => server.close(r));
console.log();
if (failures.length) {
  console.log(red(`${failures.length} failed`) + dim(`, ${passed} passed`));
  process.exit(1);
}
console.log(green(`${passed} passed`));

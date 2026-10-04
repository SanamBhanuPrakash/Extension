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
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, cpSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
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
/**
 * Find a Chromium that can actually load an extension.
 *
 * This is the line that turned the suite green here and red on CI, so it is
 * worth being explicit about. Since Playwright 1.49 `headless: true` runs
 * `chromium_headless_shell` by default, and the headless shell **cannot load
 * extensions at all** — it does not fail loudly, it simply starts a browser
 * where nothing is installed and every assertion about interception fails.
 * The first version of this file hardcoded one absolute path that happened to
 * exist on the machine it was written on, so CI silently fell through to the
 * shell.
 *
 * Order: an explicit override, then any full Chromium Playwright has
 * installed (the GitHub runner puts it under ~/.cache/ms-playwright), then
 * the `chromium` channel, which also resolves to the full browser.
 */
/** Where each browser installs itself, per platform. */
const BROWSER_PATHS = {
  brave: {
    win32: ['C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
            'C:/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe',
            join(process.env.LOCALAPPDATA || '', 'BraveSoftware/Brave-Browser/Application/brave.exe')],
    darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    linux: ['/usr/bin/brave-browser', '/usr/bin/brave', '/opt/brave.com/brave/brave'],
  },
  chrome: {
    win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  },
  edge: {
    win32: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            'C:/Program Files/Microsoft/Edge/Application/msedge.exe'],
    darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: ['/usr/bin/microsoft-edge'],
  },
};

/**
 * Find a browser that can actually load an extension.
 *
 * This is the line that turned the suite green locally and red on CI, so it is
 * worth being explicit about. Since Playwright 1.49 `headless: true` runs
 * `chromium_headless_shell` by default, and the headless shell **cannot load
 * extensions at all** — it does not fail loudly, it starts a browser where
 * nothing is installed and every assertion about interception fails. The first
 * version of this file hardcoded one absolute path that happened to exist on
 * the machine it was written on, so CI silently fell through to the shell.
 *
 *   node test/e2e/run.mjs                 whatever Playwright has installed
 *   node test/e2e/run.mjs --browser brave
 *   node test/e2e/run.mjs --browser "C:/path/to/brave.exe"
 *   CHHANNI_E2E_BROWSER=brave node test/e2e/run.mjs
 *
 * Brave, Edge, Opera, Arc and Vivaldi are Chromium at the same extension API
 * level, so the same fifteen assertions are meaningful in all of them. Running
 * them there is the only way to find out whether that is true in practice —
 * Brave in particular ships Shields below the layer an extension can reach.
 */
function findBrowser() {
  const flag = process.argv.indexOf('--browser');
  const want = (flag !== -1 ? process.argv[flag + 1] : process.env.CHHANNI_E2E_BROWSER || '').trim();

  if (want && (want.includes('/') || want.includes('\\'))) {
    if (!existsSync(want)) throw new Error(`--browser ${want} does not exist`);
    return { executablePath: want, label: want };
  }
  if (want) {
    const known = BROWSER_PATHS[want.toLowerCase()];
    if (!known) throw new Error(`unknown browser "${want}" — try brave, chrome, edge, or a full path`);
    for (const p of known[process.platform] || []) {
      if (p && existsSync(p)) return { executablePath: p, label: `${want} (${p})` };
    }
    throw new Error(`${want} is not installed where this expects it on ${process.platform}. `
      + `Pass the full path: --browser "<path to the executable>"`);
  }

  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'ms-playwright'),
    join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    '/opt/pw-browsers',
    '/ms-playwright',
  ].filter(Boolean);
  for (const root of roots) {
    let entries;
    try { entries = readdirSync(root); } catch { continue; }
    // chromium-1234, never chromium_headless_shell-1234.
    for (const dir of entries.filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
                         'chrome-win/chrome.exe']) {
        const p = join(root, dir, rel);
        if (existsSync(p)) return { executablePath: p, label: `playwright chromium (${p})` };
      }
    }
  }
  return { channel: 'chromium', label: 'chromium channel' };
}
let browser;
try { browser = findBrowser(); }
catch (err) { console.error(red(`e2e: ${err.message}`)); process.exit(1); }
const { label: browserLabel, ...launchBrowser } = browser;

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

// Port 0, not a fixed number: a hardcoded port makes two runs on one machine
// collide with EADDRINUSE, and on a developer's laptop something else may hold
// it already. The fixture server has no reason to be findable.
const server = createServer((q, s) => {
  let body;
  try { body = readFileSync(join(PAGES, q.url === '/' ? 'app-textarea.html' : q.url.split('?')[0])); }
  catch { s.writeHead(404); s.end(); return; }
  s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  s.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]; return (c ^ -1) >>> 0; }

const KEY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
// Assembled rather than written out, for the same reason the AWS one is:
// GitHub's push protection reads the file, not the intent, and a literal that
// matches a live-key pattern blocks the push however fake the value is.
const STRIPE = ['sk', 'live', '51H8xQ2eZvKYlo2C0abcdefghij'].join('_');
const SECRET = `AWS_ACCESS_KEY_ID=${KEY}`;
const READY_MS = 3500;          // only used where readiness cannot be observed
const THROTTLE = (() => {
  const i = process.argv.indexOf('--throttle');
  return i !== -1 ? Number(process.argv[i + 1]) || 1 : 1;
})();

let passed = 0;
const failures = [];

/**
 * Before asserting anything, prove the extension is actually running.
 *
 * Every test below asserts that something did NOT happen — that the provider
 * did not receive the key. That shape of assertion passes trivially in a
 * browser where the extension failed to load and the page therefore never
 * submitted anything, and it passes trivially if the mock page is broken. So
 * the suite starts by proving the opposite direction: a known secret is
 * intercepted, and a known-clean message still gets through. If either is
 * wrong, nothing below is evidence of anything and the run stops here.
 */
async function preflight() {
  const profile = join(work, 'preflight');
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true, ...launchBrowser,
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1000, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           '--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const p = await ctx.newPage();
    await p.goto(`http://localhost:${PORT}/app-textarea.html`);
    await waitReady(p, '#prompt-textarea');

    // Polled, not slept. A fixed wait here made the preflight itself flaky,
    // and a guard that fails at random is worse than no guard: it teaches
    // whoever sees it to re-run until it passes, which is the habit that lets
    // a real failure through.

    // 1. the mock provider works at all
    await p.locator('#prompt-textarea').fill('hello');
    await p.locator('#send').click();
    await p.waitForFunction(() => (window.__sent || []).length === 1, null, { timeout: 5000 })
      .catch(() => {});
    const clean = await p.evaluate(() => (window.__sent || []).length);
    if (clean !== 1) {
      throw new Error(`the mock provider recorded ${clean} sends for a clean message, expected 1 — the fixture is broken, not the extension`);
    }

    // 2. the extension is loaded and intercepting
    await p.evaluate((t) => navigator.clipboard.writeText(t), SECRET);
    await p.locator('#prompt-textarea').fill('');
    await p.locator('#prompt-textarea').click();
    await p.keyboard.press('ControlOrMeta+V');
    await p.waitForFunction(() => !!document.querySelector('.chhanni-panel'), null, { timeout: 5000 })
      .catch(() => {});
    const panel = await p.evaluate(() => !!document.querySelector('.chhanni-panel'));
    const value = await p.locator('#prompt-textarea').inputValue();
    if (!panel || value.includes(KEY)) {
      throw new Error('the extension did not intercept a known credential — it is probably not loaded. '
        + `Browser: ${browserLabel}. Playwright's headless shell cannot load extensions; `
        + 'a full Chromium is required.');
    }
  } finally {
    await ctx.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}

console.log(dim(`browser: ${browserLabel}`));
try {
  await preflight();
  console.log(dim('preflight: the extension is loaded and intercepting\n'));
} catch (err) {
  console.error(red(`\npreflight FAILED — the suite below would prove nothing, so it did not run.`));
  console.error(`  ${err.message}`);
  await new Promise((r) => server.close(r));
  process.exit(1);
}

/**
 * Wait until the extension is demonstrably working on this page.
 *
 * Every wait here used to be `waitForTimeout(3500)`, chosen because the cold
 * start measured about two seconds on the machine the suite was written on.
 * That is not a test, it is a bet on the hardware. Measured with CDP CPU
 * throttling, against the same build:
 *
 *   1x   live at 2,922 ms      578 ms of margin
 *   4x   live at 3,514 ms      already past the wait
 *   8x   live at 10,417 ms     hopeless
 *
 * A GitHub runner is a shared two-core VM, so the suite passed locally and
 * failed there — twice, for two different reasons, both of them this one.
 *
 * The probe is product behaviour rather than a test-only hook: paste something
 * harmless and wait for the "checked, nothing found" state, which only appears
 * after a scan, which requires the engine. Nothing is added to the shipped
 * extension to make this work, and nothing here is faster than the thing it is
 * waiting for.
 */
async function waitReady(p, selector) {
  if (!selector) { await p.waitForTimeout(READY_MS); return; }
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      await p.evaluate(() => navigator.clipboard.writeText('chhanni readiness probe'));
      await p.locator(selector).first().click({ timeout: 2000 });
      await p.keyboard.press('ControlOrMeta+V');
      const live = await p.waitForFunction(() => !!document.querySelector('.chhanni-clean'),
        null, { timeout: 1500 }).then(() => true).catch(() => false);
      // Clear through the editor's own event, and blur. `fill('')` on a
      // contenteditable leaves a selection behind, and the next paste into it
      // then behaves differently — which cost one test before this line existed.
      await p.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return;
        if (el.tagName === 'TEXTAREA') el.value = '';
        else el.textContent = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.blur();
        window.getSelection()?.removeAllRanges();
      }, selector).catch(() => {});
      if (live) {
        // Let the pill go, so a later assertion cannot read this one.
        await p.waitForFunction(() => !document.querySelector('.chhanni-clean'),
          null, { timeout: 6000 }).catch(() => {});
        return;
      }
    } catch { /* the page is not up yet */ }
  }
  throw new Error('the extension never became demonstrably live on this page');
}

async function test(name, page, body, readySelector = '#prompt-textarea') {
  const profile = join(work, `p-${Math.random().toString(36).slice(2)}`);
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true, ...launchBrowser,
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
    // `--throttle 4` slows the renderer to roughly a shared CI runner, which is
    // how this suite's timing assumptions get checked rather than assumed. It
    // passed locally and failed on GitHub twice before anything here polled.
    if (THROTTLE > 1) {
      const cdp = await ctx.newCDPSession(p);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }).catch(() => {});
    }
    await p.goto(`http://localhost:${PORT}/${page}`);
    await waitReady(p, readySelector);
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
// ── images: delivery is not inspection ──────────────────────────────────────
//
// This block used to paste a 1x1 PNG with no metadata and assert that a file
// reached the page. That proves delivery and nothing else, which is a
// misleading thing for a security suite to assert — it would pass unchanged if
// inspection were removed entirely. Both fixtures below carry a photographer's
// name and a location, so the assertions can be about what was *removed*.
//
// Two doors, because they are different code paths: Chromium's async clipboard
// only accepts image/png on write, so the clipboard case uses a PNG with tEXt
// chunks and the attachment case uses the repository's EXIF JPEG fixture.
const PERSON = 'Priya Nair';
const PLACE = '18.52, 73.855';

/** A deterministic PNG carrying tEXt metadata. Built here so it is readable. */
function taggedPng() {
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(t));
    return Buffer.concat([len, t, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const text = (k, v) => chunk('tEXt', Buffer.from(`${k}\0${v}`, 'latin1'));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    text('Author', PERSON),
    text('Comment', `Taken at ${PLACE} on the Northwind handset`),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const TAGGED_PNG = taggedPng();
const PNG_B64 = TAGGED_PNG.toString('base64');
const JPEG = readFileSync(join(root, 'test', 'fixtures', 'photo.jpg'));

await test('a pasted image goes through inspection and its coverage is stated', 'app-textarea.html', async (p, t) => {
  // What this can and cannot assert, because it matters.
  //
  // Chromium re-encodes an image written through the async Clipboard API:
  // measured, 165 bytes in carrying tEXt chunks, 87 bytes out carrying only
  // IHDR/IDAT/IEND. So a test cannot put metadata on the clipboard and then
  // check that Chhanni removed it — the browser removed it first, and any
  // assertion to the contrary would be testing Chromium, not this extension.
  // (That measurement is for a page writing to the clipboard. Whether an
  // OS-level copy — a screenshot tool, "Copy image" in another application —
  // preserves metadata is not something this harness can reach, and
  // docs/LIMITATIONS.md says so rather than this suite implying otherwise.)
  //
  // What is worth asserting is the honest part: the image went through
  // inspection rather than past it, and the user was told what was not read.
  // The real blind spot for a pasted screenshot is the pixels, and saying so
  // is the product.
  await p.evaluate(async (b64) => {
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([u8], { type: 'image/png' }) })]);
  }, PNG_B64);
  await p.locator('#prompt-textarea').click();
  await p.keyboard.press('ControlOrMeta+V');
  await p.waitForTimeout(2000);
  const notice = await p.evaluate(() => document.querySelector('.chhanni-notice')?.innerText || '');
  t.ok(/not the pixels|no OCR/i.test(notice),
    `the user was not told the pixels went uninspected: ${JSON.stringify(notice.slice(0, 120))}`);
  const got = await files(p);
  t.ok(got.length === 1, `expected the image to be handed on after inspection, got ${got.length}`);
});

await test('an attached JPEG loses its EXIF before the page gets it', 'app-textarea.html', async (p, t) => {
  t.ok(JPEG.toString('latin1').includes(PERSON), 'the JPEG fixture lost its EXIF — the test is void');
  await p.evaluate(async (b64) => {
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u8], 'holiday.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('picker');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, JPEG.toString('base64'));
  await p.waitForTimeout(2000);
  t.ok(await panelUp(p), 'a JPEG with GPS and a photographer name raised nothing');
  await p.locator('.chhanni-panel .chhanni-primary').click();
  await p.waitForTimeout(1500);
  const got = await files(p);
  t.ok(got.length === 1, `expected one delivered file, got ${got.length}`);
  t.ok(!got[0].text.includes(PERSON), 'the photographer name survived into the delivered JPEG');
  t.ok(!got[0].text.includes('73.855'), 'the GPS longitude survived into the delivered JPEG');
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
}, '#ce');

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

// ─────────────────────────────── the composer's state, not its appearance
//
// The failure this is for: Chhanni replaces what the user *sees* with a
// placeholder, the panel honestly reports that it did, and the editor's own
// state still holds the original — so the provider receives the secret behind
// an accurate warning. Every real AI composer is a controlled component, and
// `writeComposer()` goes out of its way to write through the native setter and
// execCommand for exactly this reason.
//
// app-controlled.html transmits its STATE and never its DOM, so a write that
// does not reach state is invisible to it. These two cases fail if the
// write-back is cosmetic.

await test('redaction reaches a controlled textarea\'s state, not just its DOM', 'app-controlled.html', async (p, t) => {
  await p.evaluate((s) => navigator.clipboard.writeText(s), SECRET);
  await p.locator('#prompt-textarea').click();
  await p.keyboard.press('ControlOrMeta+V');
  await p.waitForTimeout(900);
  t.ok(await panelUp(p), 'the paste was not intercepted');
  await p.locator('.chhanni-panel .chhanni-primary').click();   // Redact and continue
  await p.waitForTimeout(600);

  const shown = await p.locator('#prompt-textarea').inputValue();
  const held = await p.evaluate(() => window.__state());
  t.ok(!shown.includes(KEY), 'the key is still visible in the composer');
  t.ok(!held.includes(KEY), `the DOM was corrected but the component state still holds the key: ${JSON.stringify(held.slice(0, 80))}`);

  // A re-render is what exposes a cosmetic write: the component paints its own
  // state back over whatever the DOM happens to say.
  await p.evaluate(() => window.__forceRender());
  const after = await p.locator('#prompt-textarea').inputValue();
  t.ok(!after.includes(KEY), 'the key came back on the next render');

  await p.locator('#send').click();
  await p.waitForTimeout(400);
  const sentText = await p.evaluate(() => (window.__sent[0] || {}).text || '');
  t.ok(!sentText.includes(KEY), 'the provider received the key from component state');
});

await test('redaction reaches a controlled contenteditable\'s model', 'app-controlled.html', async (p, t) => {
  await p.evaluate((s) => navigator.clipboard.writeText(s), SECRET);
  await p.locator('#ce').click();
  await p.keyboard.press('ControlOrMeta+V');
  await p.waitForTimeout(900);
  t.ok(await panelUp(p), 'the paste into the contenteditable was not intercepted');
  await p.locator('.chhanni-panel .chhanni-primary').click();
  await p.waitForTimeout(600);

  const model = await p.evaluate(() => window.__model());
  t.ok(!model.includes(KEY), `the editor model still holds the key: ${JSON.stringify(model.slice(0, 80))}`);
  await p.evaluate(() => window.__forceRenderCe());
  const after = await p.evaluate(() => document.getElementById('ce').innerText);
  t.ok(!after.includes(KEY), 'the key came back on the next render');
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
  // No top-level composer on this page, so readiness cannot be probed through
  // one; the frame gate is the thing under test anyway.
}, null);

await test('a host page that hides the panel still cannot send', 'hostile.html', async (p, t) => {
  await p.locator('#prompt-textarea').fill(`my key is ${KEY}`);
  await p.locator('#send').click();
  await p.waitForTimeout(700);
  t.equal(JSON.stringify(await sent(p)), '[]', 'hiding the panel let the send through');
  // This page hides .chhanni-clean along with everything else, so the probe
  // cannot see it — which is the point of the page.
}, null);

// ─────────────────────────────────── the three modes, and what they promise
//
// The settings page makes three specific promises. They were measured across
// every mode and every severity, and one of them was false: `low` sat in
// neither the block nor the warn set, so a pasted email produced a finding, a
// verdict of 'clean' and silence — in strict too, whose label names emails and
// phone numbers as the thing it catches. A settings page naming the two things
// that can never fire is the interface claiming coverage the engine does not
// have.

async function withMode(ctx, mode) {
  const admin = await ctx.newPage();
  await admin.goto('chrome://extensions'); await admin.waitForTimeout(700);
  const id = await admin.evaluate(() => document.querySelector('extensions-manager')?.shadowRoot
    ?.querySelector('extensions-item-list')?.shadowRoot?.querySelector('extensions-item')?.id);
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${id}/options.html`); await opt.waitForTimeout(500);
  await opt.evaluate(async (m) => { await chrome.storage.sync.set({ policy: { mode: m, disabled: [], allow: [] } }); }, mode);
  await opt.close(); await admin.close();
}

await test('strict stops a low-severity finding, which is what its label says', 'app-textarea.html', async (p, t, ctx) => {
  await withMode(ctx, 'strict');
  await p.reload(); await waitReady(p, '#prompt-textarea');
  await p.locator('#prompt-textarea').fill('mail me at ravi.iyer@acmecorp.in');
  await p.locator('#send').click();
  await p.waitForTimeout(800);
  t.ok(await panelUp(p), 'strict let a lone email through — its label names emails specifically');
  t.equal(JSON.stringify(await sent(p)), '[]', 'the provider received it anyway');
});

await test('warn shows a low-severity finding on paste but does not block the send', 'app-textarea.html', async (p, t, ctx) => {
  await withMode(ctx, 'warn');
  await p.reload(); await waitReady(p, '#prompt-textarea');
  await p.evaluate(() => navigator.clipboard.writeText('mail me at ravi.iyer@acmecorp.in'));
  await p.locator('#prompt-textarea').click();
  await p.keyboard.press('ControlOrMeta+V');
  await p.waitForTimeout(800);
  t.ok(await panelUp(p), 'warn showed nothing on paste; the label says low-risk findings are shown');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  await p.locator('#prompt-textarea').fill('mail me at ravi.iyer@acmecorp.in');
  await p.locator('#send').click();
  await p.waitForTimeout(800);
  t.ok((await sent(p)).length === 1, 'warn blocked a send it promises never to block');
});

await test('strict holds a file it could not inspect, rather than mentioning it', 'app-textarea.html', async (p, t, ctx) => {
  await withMode(ctx, 'strict');
  await p.reload(); await waitReady(p, '#prompt-textarea');
  await p.evaluate(() => {
    const dt = new DataTransfer();
    const big = new Uint8Array(20 * 1024 * 1024); big.fill(0xab);
    dt.items.add(new File([big], 'archive.bin', { type: 'application/octet-stream' }));
    const i = document.getElementById('picker'); i.files = dt.files;
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p.waitForTimeout(3000);
  t.ok(await panelUp(p), 'strict accepted an entirely uninspected 20 MB file with only a toast');
  t.equal((await files(p)).length, 0, 'the file reached the page before the user decided');
});

await test('off intercepts nothing at all', 'app-textarea.html', async (p, t, ctx) => {
  await withMode(ctx, 'off');
  // In off mode nothing is observable by design, so this one waits rather than
  // probes — the extension was already proved live before the mode changed.
  await p.reload(); await p.waitForTimeout(READY_MS);
  await p.locator('#prompt-textarea').fill(`my key is ${KEY}`);
  await p.locator('#send').click();
  await p.waitForTimeout(800);
  t.ok(!(await panelUp(p)), 'off showed a panel');
  t.ok((await sent(p)).length === 1, 'off blocked a send');
});


// ──────────────────────────────────────────── what an approval covers
//
// "Send as-is" is a decision about one message. It used to open a two-second
// window in which any Enter went through unchecked, so a completely different
// secret typed inside it left with no panel. The approval is now compared
// against the exact text and the exact composer — not a 32-bit hash of them,
// which on a hostile page is something that can be solved for — and spent when
// it is used.

await test('approving one message does not approve the next one', 'app-textarea.html', async (p, t) => {
  await p.locator('#prompt-textarea').fill(`first ${KEY}`);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(700);
  t.ok(await panelUp(p), 'the first secret was not caught');
  await p.locator('.chhanni-panel .chhanni-ghost').click();      // Send as-is
  await p.waitForTimeout(250);

  // Immediately, well inside the old window: a different secret entirely.
  await p.locator('#prompt-textarea').fill(`STRIPE=${STRIPE}`);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(700);
  t.ok(await panelUp(p), 'a different secret rode in on the previous approval');
  const sent = await p.evaluate(() => (window.__sent || []).map((x) => x.text));
  t.ok(!sent.some((x) => x.includes(STRIPE)), `the provider received the second secret: ${JSON.stringify(sent)}`);
});

await test('an approval is spent, not reusable for the same text twice', 'app-textarea.html', async (p, t) => {
  await p.locator('#prompt-textarea').fill(`same ${KEY}`);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(700);
  await p.locator('.chhanni-panel .chhanni-ghost').click();      // approved and sent once
  await p.waitForTimeout(500);
  const afterFirst = await p.evaluate(() => (window.__sent || []).length);
  t.ok(afterFirst === 1, `expected one send, got ${afterFirst}`);

  // The same text again must be scanned again, not waved through.
  await p.locator('#prompt-textarea').click();
  await p.keyboard.press('Enter');
  await p.waitForTimeout(700);
  t.ok(await panelUp(p), 'the same text went again on a spent approval');
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

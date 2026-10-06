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
  // A fixture that needs a credential in its *initial* HTML cannot hold one:
  // GitHub's push protection reads the file, not the intent, and a literal
  // that matches a live-key pattern blocks the push however fake the value
  // is. So the file carries a placeholder and the server fills it in.
  if (body.includes('__CREDENTIAL__')) body = Buffer.from(String(body).replaceAll('__CREDENTIAL__', KEY));
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
// Slack's own documented placeholder shape, assembled for the same reason.
const WEBHOOK = ['https://hooks.slack.com/services', 'T00000000', 'B00000000',
                 'XXXXXXXXXXXXXXXXXXXXXXXX'].join('/');
// A `high` credential rather than a `critical` one. Severity is the whole
// point of these cases: `high` is twenty-five detectors, and it was the tier
// that typed input sent without a word.
const HIGH_KEY = ['AIza', 'SyD', 'x'.repeat(32)].join('');
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

/**
 * Did the *response scanner* say something?
 *
 * Not `.chhanni-notice`: three unrelated things wear that class — the boot
 * hold, the engine-failure banner and this — and the first version of these
 * three tests asserted on it and passed against a build where the response
 * scanner never ran once. The boot hold in particular appears during
 * `waitReady`, which every test calls. `data-chhanni-kind` is the handle.
 */
const reported = (p, timeout = 15000) => p.waitForFunction(
  () => !!document.querySelector('.chhanni-notice[data-chhanni-kind="reply"]'),
  null, { timeout }).then(() => true).catch(() => false);

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
    // `readySelector: null` means do not touch this page. The readiness probe
    // pastes into the composer, and the extension answers by appending a pill
    // to document.body — which is a mutation the response scanner observes.
    // A test about what happens on a page nobody has touched cannot use it.
    if (readySelector) await waitReady(p, readySelector);
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
/**
 * Did the provider receive this substring?
 *
 * Answered inside the page and returned as a boolean, because `sent()` above
 * deliberately never hands the transmitted text back to the harness — so that
 * no failure message can print a key. A test that needs to assert on content
 * asks a yes/no question rather than widening that hole.
 */
const sentHas = (p, needle) => p.evaluate(
  (n) => (window.__sent || []).some((s) => String(s.text).includes(n)), needle);
const panelUp = (p) => p.evaluate(() => !!document.querySelector('.chhanni-panel'));
/**
 * A notice about the content, not about the extension's own startup.
 *
 * `.chhanni-notice` is worn by the boot hold, the engine-failure banner and
 * the real notices alike, and the boot one stays on screen for six seconds —
 * long enough to be the first match for a test that pastes something a moment
 * later. That is how CI went red on a test about a pasted image: it read the
 * startup notice and reported that the user had not been told about pixels.
 */
const CONTENT_NOTICE = '.chhanni-notice:not([data-chhanni-kind="starting"])'
  + ':not([data-chhanni-kind="started"]):not([data-chhanni-kind="engine-failed"])';
const noticeUp = (p) => p.evaluate((sel) => !!document.querySelector(sel), CONTENT_NOTICE);

/** Wait for the panel, rather than sleeping and hoping it is up by then. */
const waitPanel = (p, timeout = 20000) => p
  .waitForSelector('.chhanni-panel', { timeout, state: 'attached' })
  .then(() => true).catch(() => false);

/** Wait for any notice about the content. Same reasoning as waitPanel. */
const waitAnyNotice = (p, timeout = 20000) => p
  .waitForSelector(CONTENT_NOTICE, { timeout, state: 'attached' })
  .then(() => true).catch(() => false);

/**
 * Wait for a notice that says a particular thing, rather than sleeping and
 * hoping.
 *
 * This is the second time this suite has been red on GitHub for betting on the
 * hardware. The readiness waits were replaced with polling last time; the
 * per-assertion waits were left as fixed sleeps, and `waitForTimeout(2000)`
 * followed by "the user was not told about the pixels" is the same bet in a
 * smaller place. A runner two or three times slower than the machine this was
 * written on loses it.
 *
 * Returns the text if it arrives and '' if it does not, so the caller's own
 * assertion is what reports the failure.
 */
async function waitNotice(p, pattern, timeout = 15000) {
  const found = await p.waitForFunction(
    ([sel, src]) => {
      const el = document.querySelector(sel);
      return el && new RegExp(src, 'i').test(el.innerText) ? el.innerText : null;
    },
    [CONTENT_NOTICE, pattern.source], { timeout },
  ).then((h) => h.jsonValue()).catch(() => null);
  if (found) return found;
  // Nothing matched in time. Hand back whatever is there, so the failure
  // message names what the user would actually have seen.
  return p.evaluate((sel) => document.querySelector(sel)?.innerText || '', CONTENT_NOTICE);
}
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
  const notice = await waitNotice(p, /not the pixels|no OCR/);
  t.ok(/not the pixels|no OCR/i.test(notice),
    `the user was not told the pixels went uninspected: ${JSON.stringify(notice.slice(0, 120))}`);
  // Poll for the delivery too. Replacing the old fixed sleep with a poll for
  // the *notice* made this case intermittently red, because the notice can
  // appear before the page has finished recording the file — a poll for one
  // condition is not a poll for the other, and the sleep had been covering
  // both by accident.
  await p.waitForFunction(() => (window.__files || []).length > 0, null, { timeout: 20000 })
    .catch(() => {});
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
  t.ok(await waitPanel(p), 'a JPEG with GPS and a photographer name raised nothing');
  await p.locator('.chhanni-panel .chhanni-primary').click();
  // Until the *bytes* are there, not merely the record. The fixture fills
  // `text` from `arrayBuffer()`, so a poll on `length > 0` returns while
  // `text` is still null — which is a worse wait than the fixed sleep it
  // replaced, because it looks precise.
  await p.waitForFunction(() => (window.__files || []).some((f) => f.text !== null),
    null, { timeout: 20000 }).catch(() => {});
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
  t.ok(await waitPanel(p), 'the attachment was not inspected');
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
  t.ok(await waitAnyNotice(p), 'nothing told the user the file was not read');
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

/**
 * Raise the self-test card the way the popup does.
 *
 * Through `chrome.tabs.sendMessage` from an extension page, not by calling
 * anything in the page: the message path is part of what is being tested, and
 * the content script now refuses a message whose sender is not this
 * extension, so a shortcut here would test a route no user has.
 */
async function raiseSelfTest(ctx, page) {
  const admin = await ctx.newPage();
  await admin.goto('chrome://extensions');
  await admin.waitForTimeout(600);
  const id = await admin.evaluate(() => document.querySelector('extensions-manager')?.shadowRoot
    ?.querySelector('extensions-item-list')?.shadowRoot?.querySelector('extensions-item')?.id);
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${id}/options.html`);
  await opt.waitForTimeout(300);
  const url = page.url();
  await opt.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    await chrome.tabs.sendMessage(tab.id, { type: 'chhanni:self-test' });
  }, url);
  await opt.close();
  await admin.close();
  await page.bringToFront();
  return page.waitForSelector('.chhanni-selftest', { timeout: 10000, state: 'attached' })
    .then(() => true).catch(() => false);
}

const selfTestStatus = (p) => p.evaluate(() => {
  const el = document.querySelector('.chhanni-selftest-status');
  return el ? { text: el.innerText, kind: el.className.match(/chhanni-selftest-(ok|bad|wait)/)?.[1] } : null;
});

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
  t.ok(await waitPanel(p), 'strict accepted an entirely uninspected 20 MB file with only a toast');
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

/**
 * The response scanner, against a page that behaves like a chat page.
 *
 * These three are regression tests for a defect that shipped, was documented,
 * and did nothing on any of the twenty-three sites it was written for. The
 * scanner debounced on a MutationObserver with no ceiling, so any page that
 * mutated more often than the interval reset the timer forever. Every chat
 * product keeps something moving in the DOM — an indicator, a caret, a
 * shimmer — and so on every one of them the scanner never ran at all.
 *
 * Nothing in the unit suite could have caught it: there is no DOM there. The
 * other e2e fixtures could not either, because they are static, and against a
 * static page the scanner is correct and idle for the same reason.
 */
await test('the self-test says so when the guard works', 'app-textarea.html', async (p, t, ctx) => {
  t.ok(await raiseSelfTest(ctx, p), 'the self-test card never appeared');
  const before = await selfTestStatus(p);
  t.equal(before.kind, 'wait', `the card claimed an answer before anything was pasted: ${before.text}`);

  // The card hands over a line to paste; pasting it is what the person does.
  const line = await p.evaluate(() => document.querySelector('.chhanni-selftest-value').innerText);
  t.ok(line.includes(KEY), 'the card did not offer the documented key');
  await paste(p, line);

  const after = await selfTestStatus(p);
  t.equal(after.kind, 'ok', `the card did not report the interception: ${after.text}`);
});

await test('the self-test says so when the guard does not work', 'app-textarea.html', async (p, t, ctx) => {
  // The case the whole feature exists for. In `off` there is no paste handler
  // at all, which is exactly what a broken install looks like from the
  // outside — and a self-test that reported "working" here, or simply sat
  // waiting, would be worse than no self-test.
  await withMode(ctx, 'off');
  await p.reload();
  await p.waitForTimeout(READY_MS);
  t.ok(await raiseSelfTest(ctx, p), 'the self-test card never appeared');
  const line = await p.evaluate(() => document.querySelector('.chhanni-selftest-value').innerText);
  await paste(p, line);
  const after = await selfTestStatus(p);
  t.equal(after.kind, 'bad', `a credential went through unchallenged and the card said: ${after.text}`);
}, null);

// ──────────────────────── protecting a value must not cost the formatting
//
// `writeComposer` selected the whole composer and typed a plain string over
// it. For a textarea that is exactly right. For a rich composer it flattened
// an AI prompt — code blocks, lists, links, bold runs, paragraphs — into one
// line of plain text. The value was protected and the work was gone, and the
// button that did it is labelled "Redact 1 and continue".

await test('redacting a formatted prompt keeps the formatting', 'app-rich.html', async (p, t) => {
  // The readiness probe types into the composer and clears it, so the
  // structure is put back before anything is measured.
  await p.evaluate(() => window.__reset());
  const before = await p.evaluate(() => window.__shape());
  t.ok(before.pre === 1 && before.li === 3 && before.href.length === 1,
    `the fixture did not load with its structure: ${JSON.stringify(before)}`);

  await p.locator('#ce').click();
  await p.locator('#send').click();
  t.ok(await waitPanel(p), 'a credential inside a code block raised no panel');
  await p.locator('.chhanni-panel .chhanni-primary').click();
  await p.waitForFunction(() => (window.__sent || []).length > 0, null, { timeout: 20000 })
    .catch(() => {});

  const got = await sent(p);
  t.equal(got.length, 1, 'redact-and-continue did not send');
  t.equal(got[0], 'click:clean', 'the key reached the provider');
  t.ok(await sentHas(p, '<AWS_ACCESS_KEY_ID_1>'), 'the placeholder did not arrive');

  const after = await p.evaluate(() => window.__shape());
  t.equal(after.pre, before.pre, 'the code block was destroyed');
  t.equal(after.code, before.code, 'the code element was destroyed');
  t.equal(after.li, before.li, `the list went from ${before.li} items to ${after.li}`);
  t.equal(after.p, before.p, 'the paragraphs were merged');
  t.equal(after.strong, before.strong, 'the bold run was lost');
  t.equal(after.em, before.em, 'the italic run was lost');
  t.equal(JSON.stringify(after.href), JSON.stringify(before.href), 'the link lost its href');
  t.ok(await sentHas(p, 'ninety seconds'), 'the surrounding text was lost');
  t.ok(await sentHas(p, 'eu-west-1'), 'the rest of the code block was lost');
}, '#ce');

// ─────────────────────────── where a setting lives is a privacy question
//
// `chrome.storage.sync` is a network service: Chrome replicates it to every
// browser the person is signed into, through Google's servers. The whole
// policy used to go there, allowlist included — and the allowlist is made
// entirely of strings somebody typed *because* they are sensitive. "Never
// treat this as a finding" is how you tell Chhanni about a customer's email
// address or an internal codename.
//
// These assert on the storage areas directly, from an extension page, because
// that is the only place the claim can be checked.

/** Run `fn` on the extension's own options page, where chrome.storage exists. */
async function onExtensionPage(ctx, fn, arg) {
  const admin = await ctx.newPage();
  await admin.goto('chrome://extensions');
  await admin.waitForTimeout(600);
  const id = await admin.evaluate(() => document.querySelector('extensions-manager')?.shadowRoot
    ?.querySelector('extensions-item-list')?.shadowRoot?.querySelector('extensions-item')?.id);
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${id}/options.html`);
  await opt.waitForTimeout(500);
  const out = await opt.evaluate(fn, arg);
  await opt.close();
  await admin.close();
  return out;
}

await test('an allowlist entry never reaches storage.sync', 'app-textarea.html', async (p, t, ctx) => {
  const secretish = 'acme-project-thunderbird';
  const areas = await onExtensionPage(ctx, async (value) => {
    const { writePolicy, readPolicy } = await import('./policy.js');
    const { policy } = await readPolicy();
    await writePolicy({ allow: [value], mode: 'warn' }, policy);
    const sync = await chrome.storage.sync.get(null);
    const local = await chrome.storage.local.get(null);
    return { sync: JSON.stringify(sync), local: JSON.stringify(local) };
  }, secretish);

  t.ok(!areas.sync.includes(secretish),
    'an allowlist value was written to storage.sync, which Chrome replicates off the device');
  t.ok(areas.local.includes(secretish), 'the allowlist was not persisted locally either');
  // The preference itself is fine to sync: it says how cautious somebody is,
  // not who they work with.
  t.ok(areas.sync.includes('warn'), 'the interruption level should still follow the person');
});

await test('an allowlist already in storage.sync is moved out of it', 'app-textarea.html', async (p, t, ctx) => {
  // Shipping the split is not enough. A profile that already synced an
  // allowlist has those values sitting in a replicated store, and leaving
  // them there while quietly reading from somewhere else would fix the
  // behaviour and not the exposure.
  const stranded = 'contact@acquisition-target.example';
  const after = await onExtensionPage(ctx, async (value) => {
    await chrome.storage.sync.set({ policy: { mode: 'warn', disabled: [], allow: [value] } });
    const { readPolicy } = await import('./policy.js');
    const { policy, migrated } = await readPolicy();
    const sync = await chrome.storage.sync.get(null);
    const local = await chrome.storage.local.get(null);
    return { sync: JSON.stringify(sync), local: JSON.stringify(local), migrated, allow: policy.allow };
  }, stranded);

  t.ok(!after.sync.includes(stranded), 'the synced copy of the allowlist was left in place');
  t.ok(after.local.includes(stranded), 'the allowlist was dropped instead of moved');
  t.ok(after.allow.includes(stranded), 'the setting stopped working after the move');
  t.ok(after.migrated.includes('allow'), 'the move happened silently, with nothing to report');
});

// ───────────────────────────── the modes, as one table, on both paths
//
// `scanPolicy()` put everything but `critical` into `warn`, and
// `guardSubmission()` returned early in warn mode on any verdict that was not
// `block`. Composed, those two lines meant a pasted Google API key raised the
// panel and a *typed* one sent silently — and LIMITATIONS claimed the
// opposite. People do not only paste secrets. The path that was weaker was
// the one where nobody would notice.

await test('a typed high-severity credential stops the send in warn mode', 'app-textarea.html', async (p, t) => {
  await p.locator('#prompt-textarea').fill(`the key is ${HIGH_KEY}`);
  await p.locator('#send').click();
  t.ok(await waitPanel(p), 'a typed Google API key sent with no panel at all');
  t.equal(JSON.stringify(await sent(p)), '[]', 'the provider received it');
});

await test('pasting and typing the same credential behave the same way', 'app-textarea.html', async (p, t) => {
  // The asymmetry itself, asserted. Whatever the mode does, it must not
  // depend on how the characters arrived.
  await paste(p, `the key is ${HIGH_KEY}`);
  const onPaste = await panelUp(p);
  await p.reload();
  await waitReady(p, '#prompt-textarea');
  await p.locator('#prompt-textarea').fill(`the key is ${HIGH_KEY}`);
  await p.locator('#send').click();
  const onSend = await waitPanel(p);
  t.equal(onSend, onPaste, `paste raised ${onPaste} and send raised ${onSend}`);
});

await test('a lone email does not stop a send in warn mode', 'app-textarea.html', async (p, t) => {
  // The other half of the table. A mode most people leave on has to stay
  // usable, and interrupting a send over one email address would make it
  // unusable. `low` is detected and shown on paste; it does not block.
  await p.locator('#prompt-textarea').fill('please reply to priya.nair@example.com about this');
  await p.locator('#send').click();
  await p.waitForFunction(() => (window.__sent || []).length > 0, null, { timeout: 15000 }).catch(() => {});
  t.equal((await sent(p)).length, 1, 'a lone email address blocked the send');
});

// ──────────────────────────── "and continue" has to actually continue

await test('Redact and continue sends the redacted text, in one action', 'app-textarea.html', async (p, t) => {
  // The button said "Redact 1 and continue" and the handler wrote the text
  // back into the composer and stopped, so the person had to press Send
  // again. The gap between a label and its handler is a defect here.
  await p.locator('#prompt-textarea').fill(`my key is ${KEY} please help`);
  await p.locator('#send').click();
  t.ok(await waitPanel(p), 'no panel for a typed credential');
  await p.locator('.chhanni-panel .chhanni-primary').click();
  await p.waitForFunction(() => (window.__sent || []).length > 0, null, { timeout: 15000 }).catch(() => {});
  const got = await sent(p);
  t.equal(got.length, 1, 'redact-and-continue did not send anything');
  t.equal(got[0], 'click:clean', 'the redacted send still carried the key');
  t.ok(await sentHas(p, 'please help'), 'the rest of the message was lost');
  t.ok(await sentHas(p, '<AWS_ACCESS_KEY_ID_1>'), 'the placeholder did not reach the provider');
});

await test('a composer that reverts the redaction does not get sent', 'app-controlled.html', async (p, t) => {
  // The reason "and continue" is write-then-verify rather than write-then-send.
  // This page's editor is instrumented to refuse Chhanni's write, which is
  // what a provider changing its editor looks like from here. Replaying the
  // send after a failed write would transmit the original secret while the
  // panel claimed it had been redacted — strictly worse than doing nothing.
  // Typed first, *then* the editor starts refusing: setting the flag before
  // the fill makes the page refuse the typing too, and a guard that never saw
  // any text is not what this is testing.
  await p.locator('#prompt-textarea').fill(`my key is ${KEY}`);
  await p.evaluate(() => { window.__refuseWrites = true; });
  await p.locator('#send').click();
  t.ok(await waitPanel(p), 'no panel for a typed credential');
  await p.locator('.chhanni-panel .chhanni-primary').click();
  await p.waitForTimeout(900);
  const got = await sent(p);
  t.equal(JSON.stringify(got), '[]', 'a send went out after the redaction was reverted');
  t.ok(await waitPanel(p), 'nothing told the person the redaction had not taken');
});

await test('a Kubernetes Secret does not reach the provider', 'app-textarea.html', async (p, t) => {
  // A Secret's data values are always Base64 — that is the format, not an
  // evasion — and before `src/encoded.js` existed this whole manifest scanned
  // `clean` and went straight through. The assertion is on what the mock
  // provider received, not on whether a panel appeared.
  //
  // Typed rather than pasted, and then sent: a paste raises the panel over the
  // Send button, and the claim worth proving here is about the submit guard,
  // not about the paste handler that other cases already cover.
  const b64 = Buffer.from(SECRET).toString('base64');
  const manifest = `apiVersion: v1\nkind: Secret\nmetadata:\n  name: app\ndata:\n  creds: ${b64}\n`;
  await p.locator('#prompt-textarea').fill(manifest);
  await p.locator('#send').click();
  await p.waitForTimeout(900);
  t.ok(await panelUp(p), 'no panel was shown for a Secret manifest');
  t.equal(JSON.stringify(await sent(p)), '[]', 'the manifest reached the provider');
});

await test('a credential streamed into a reply is reported', 'app-live.html', async (p, t) => {
  await p.evaluate((reply) => window.__stream(reply, { chunk: 8, every: 20 }),
    `Set AWS_ACCESS_KEY_ID=${KEY} in the environment and restart the worker. `
    + 'The replica lag should settle within a minute of the cutover. '.repeat(4));
  t.ok(await reported(p), 'a credential arrived in a reply and Chhanni never said so');
});

await test('an animated indicator does not starve the response scanner', 'app-live.html', async (p, t) => {
  await p.evaluate(() => window.__ticker(400));
  await p.evaluate((reply) => window.__stream(reply, { chunk: 8, every: 20 }),
    `Set AWS_ACCESS_KEY_ID=${KEY} in the environment and restart the worker. `
    + 'The replica lag should settle within a minute of the cutover. '.repeat(4));
  const said = await reported(p);
  await p.evaluate(() => window.__stopTicker());
  t.ok(said, 'with an indicator ticking every 400 ms the scanner never ran — '
    + 'which is the state it shipped in on every site it matches');
});

await test('a high-severity credential in a reply is reported, not only a critical one', 'app-live.html', async (p, t) => {
  // The scanner reported `critical` findings only, and a Slack incoming
  // webhook is `high` — as are a SendGrid key, a Twilio key, a Notion token
  // and eighteen other shapes that are unmistakably live credentials. Every
  // one of them could be echoed back by the model into a conversation that
  // then travels with it, and about every one of them Chhanni said nothing.
  await p.evaluate((reply) => window.__stream(reply, { chunk: 10, every: 15 }),
    `You can post to the channel with ${WEBHOOK} from the worker. `
    + 'Keep the retry budget low so a failed post does not queue. '.repeat(4));
  t.ok(await reported(p), 'a Slack webhook arrived in a reply and Chhanni never said so');
});

await test('a reply on a page nobody has touched is read', 'app-settled.html', async (p, t) => {
  // Deliberately without the readiness probe, and with no interaction at all.
  // The credential is in the HTML the server sent and nothing on this page
  // ever mutates, so a scanner driven only by mutation never reads it. That
  // is the state somebody is in every time they reopen yesterday's
  // conversation and leave it sitting on screen.
  //
  // The window is wide because there is nothing to observe readiness from:
  // the engine loads in about 2 s, 3.5 s at --throttle 4, and the debounce is
  // 1.2 s on top. Twenty seconds is not a guess at the answer, it is a cap on
  // how long a failure takes to report.
  t.ok(await reported(p, 20000), 'a credential sitting in a settled transcript was never read');
}, null);

await new Promise((r) => server.close(r));
console.log();
if (failures.length) {
  console.log(red(`${failures.length} failed`) + dim(`, ${passed} passed`));
  process.exit(1);
}
console.log(green(`${passed} passed`));

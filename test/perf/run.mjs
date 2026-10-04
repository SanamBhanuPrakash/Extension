#!/usr/bin/env node
/**
 * What it costs to have Chhanni on the page, and whether it still works there.
 *
 * Every other test in this repository asks whether the extension is correct
 * on a small page. None of them asks what it costs on a big one, and cost is
 * what gets an extension uninstalled. Nobody files a bug saying "your content
 * script forces a layout every 1.2 seconds"; they notice ChatGPT feels slow
 * since they installed something, and the uninstall reason box stays empty.
 *
 * Two things had to be fixed about this file before its numbers meant
 * anything, and both are worth stating because both are easy to get wrong:
 *
 *   1. The window must start from quiet, not from `load`. A 1500-turn page
 *      spends over a second in parse and layout, which is the page's cost and
 *      not ours; windowing from `load` put a random amount of it in the
 *      measurement and the result moved by 500 ms between identical runs.
 *   2. The fixture must move. The response scanner is driven by a
 *      MutationObserver, so against static HTML it never runs once — the
 *      first version of this file reported "the extension on a long
 *      conversation" while measuring an extension that was asleep.
 *
 *   node scripts/build.js && node test/perf/run.mjs
 *   node test/perf/run.mjs --turns 1500
 *   node test/perf/run.mjs --baseline       also measure the page without us
 *
 * Playwright is not a dependency. Absent, this exits 0 like the e2e suite.
 */
import { createServer } from 'node:http';
import { readFileSync, readdirSync, cpSync, rmSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const NO_COLOR = process.argv.includes('--no-color') || !process.stdout.isTTY;
const c = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const dim = (s) => c('2', s);

let chromium = null;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs', 'playwright-core']) {
  try { ({ chromium } = await import(spec)); break; } catch { /* next */ }
}
if (!chromium) { console.log(dim('perf: playwright is not installed; skipping.')); process.exit(0); }

function findBrowser() {
  const flag = process.argv.indexOf('--browser');
  const want = (flag !== -1 ? process.argv[flag + 1] : process.env.CHHANNI_E2E_BROWSER || '').trim();
  if (want && (want.includes('/') || want.includes('\\'))) return { executablePath: want };
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(process.env.HOME || '', '.cache', 'ms-playwright'), '/opt/pw-browsers', '/ms-playwright'].filter(Boolean);
  for (const r of roots) {
    let entries; try { entries = readdirSync(r); } catch { continue; }
    for (const d of entries.filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = join(r, d, rel);
        if (existsSync(p)) return { executablePath: p };
      }
    }
  }
  return { channel: 'chromium' };
}
const launchBrowser = findBrowser();

if (!existsSync(join(root, 'dist', 'chrome', 'engine', 'detect.js'))) {
  console.error(red('perf: dist/chrome is missing. Run `node scripts/build.js` first.'));
  process.exit(1);
}

/**
 * `--throttle 4` slows the renderer to roughly a shared CI runner.
 *
 * The budgets below have to hold on the slowest machine that runs them, and
 * this suite's own history is the argument: the e2e suite was written against
 * numbers measured on a fast machine and went red on GitHub twice. So the
 * budgets are set from the throttled run, not this one.
 */
const THROTTLE = (() => {
  const i = process.argv.indexOf('--throttle');
  return i !== -1 ? Number(process.argv[i + 1]) || 1 : 1;
})();

const TURNS = (() => {
  const i = process.argv.indexOf('--turns');
  return i !== -1 ? [Number(process.argv[i + 1])] : [50, 600, 1500];
})();

/**
 * How many times each measurement is taken, and why more than once.
 *
 * On the 1500-turn fixture at --throttle 4 the *baseline* — the page with no
 * extension loaded at all — measured 3,982 ms, 4,357 ms and 4,810 ms of
 * blocking on three identical runs. A delta budget of 250 ms against a
 * control that swings 800 ms is a coin toss dressed as a gate, and a gate
 * that fails at random teaches whoever sees it to re-run until it passes.
 * Medians, and a budget set from medians.
 */
const REPEAT = (() => {
  const i = process.argv.indexOf('--repeat');
  return i !== -1 ? Math.max(1, Number(process.argv[i + 1]) || 1) : 2;
})();

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

/** Take a measurement REPEAT times and reduce each number to its median. */
async function measureMany(n, withExtension) {
  const runs = [];
  for (let i = 0; i < REPEAT; i++) runs.push(await measure(n, withExtension));
  const out = { n, withExtension, runs: runs.length };
  for (const k of Object.keys(runs[0])) {
    const vs = runs.map((r) => r[k]);
    if (vs.every((v) => typeof v === 'number' && Number.isFinite(v))) out[k] = median(vs);
    else if (vs.every((v) => typeof v === 'boolean')) out[k] = vs.every(Boolean);
    else out[k] = vs[0];
  }
  out.noticed = runs.every((r) => r.noticed !== false);
  if (!out.noticed) out.noticeMs = Infinity;
  return out;
}
const { conversation } = await import('./gen.mjs');

const work = mkdtempSync(join(tmpdir(), 'chhanni-perf-'));
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

const server = createServer((q, s) => {
  const n = Number((q.url.match(/(\d+)/) || [])[1] || 200);
  s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  s.end(conversation(n));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

// GitHub's own doc key. A real one never belongs in a test file.
const KEY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const REPLY = `Here is the configuration you asked for. Set AWS_ACCESS_KEY_ID=${KEY} in the environment `
  + 'and restart the worker. The replica lag should settle within a minute of the cutover. '
  + 'If it does not, check the binlog position on the writer before failing back. '.repeat(6);

/**
 * The budgets, and why each is where it is.
 *
 * These are not aspirations, they are the line past which a reasonable person
 * notices. Chrome's Total Blocking Time counts everything over 50 ms in a
 * task as blocking, and RAIL puts "this responded to me" at 100 ms.
 *
 * Most of them are stated `over` the same page measured without the
 * extension loaded, and that is not a convenience — an absolute budget here
 * would have been wrong. Measured at --throttle 4 on the 1500-turn fixture,
 * the page blocks the main thread for 4,235 ms while a reply streams *with no
 * extension installed at all*: 17,505 nodes relaid out on every frame of an
 * append. A budget of 150 ms against that number is a budget on Chromium's
 * layout engine, and "fixing" it would mean deleting features to chase a cost
 * that was never ours. What is ours is the difference.
 *
 *  idleBlockingMs    main-thread time we add over five seconds of the user
 *                    doing nothing. A chat tab is open for hours, so anything
 *                    here is pure waste and the budget is near zero.
 *  streamBlockingMs  what we add while a reply streams and for the four
 *                    seconds after it settles — the moment the page is most
 *                    obviously in use, because somebody is reading it.
 *  pasteMs           paste to verdict on screen, over the page's own paste.
 *  sendMs            how long Send is held, over the page's own click. Load-
 *                    bearing: the guard cancels the real click, scans, and
 *                    re-fires it, so every millisecond is one the product
 *                    added to the single action the user cares most about.
 *  noticeMs          how long a credential sits in a streamed reply before
 *                    Chhanni says so. Absolute, because there is no page to
 *                    compare against — an unguarded page never says anything
 *                    — and scaled by the throttle, because it is dominated by
 *                    the scanner's own 3 s ceiling. Not a comfort number: a
 *                    cap on it is the only thing that distinguishes "slow"
 *                    from "never", and `never` is the state this found. The
 *                    budget is twice the measured median rather than tight,
 *                    because what it has to catch is the difference between
 *                    three seconds and infinity, not between three and four.
 */
const BUDGET = {
  idleBlockingMs: { over: 50 },
  streamBlockingMs: { over: 250 },
  pasteMs: { over: 250 },
  sendMs: { over: 200 },
  noticeMs: { absolute: 6000, scale: true },
};

const PROBE = `
window.__long = [];
try {
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); })
    .observe({ entryTypes: ['longtask'] });
} catch {}
window.__blocking = (a, b) => window.__long.filter(([t]) => t >= a && t <= b)
  .reduce((s, [, d]) => s + Math.max(0, d - 50), 0);
window.__lastLong = () => (window.__long.length ? window.__long[window.__long.length - 1][0] + window.__long[window.__long.length - 1][1] : 0);
`;

async function open(n, withExtension) {
  const profile = join(work, `p-${n}-${withExtension ? 'ext' : 'bare'}-${Math.random().toString(36).slice(2)}`);
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true, ...launchBrowser,
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1200, height: 900 },
    args: [...(withExtension ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] : []),
           '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await ctx.newPage();
  if (THROTTLE > 1) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }).catch(() => {});
  }
  await page.addInitScript(PROBE);
  await page.goto(`http://localhost:${PORT}/conv-${n}.html`, { waitUntil: 'load' });
  return { ctx, page, profile };
}

/**
 * Wait until the page has stopped doing its own work.
 *
 * Measuring from `load` measures Chromium laying out 1.7 MB of transcript,
 * which is not a cost this extension imposes. Quiet is defined as no long
 * task for 1.2 s, and the clock for everything below starts there.
 */
async function quiet(page, settleMs = 1200, capMs = 30000) {
  const start = Date.now();
  for (;;) {
    const last = await page.evaluate(() => window.__lastLong());
    const now = await page.evaluate(() => performance.now());
    if (now - last > settleMs) return now;
    if (Date.now() - start > capMs) return now;
    await page.waitForTimeout(200);
  }
}
const blocking = (page, a, b) => page.evaluate(([x, y]) => Math.round(window.__blocking(x, y)), [a, b]);
const now = (page) => page.evaluate(() => performance.now());

async function measure(n, withExtension) {
  const { ctx, page, profile } = await open(n, withExtension);
  const out = { n, withExtension };
  try {
    out.quietAtMs = Math.round(await quiet(page));
    out.chars = await page.evaluate(() => document.body.innerText.length);
    out.nodes = await page.evaluate(() => document.body.querySelectorAll('*').length);
    out.innerTextMs = Math.round(await page.evaluate(() => {
      const t = performance.now();
      for (let i = 0; i < 5; i++) { void document.body.innerText.length; void document.body.querySelectorAll('*').length; }
      return (performance.now() - t) / 5;
    }) * 100) / 100;

    // ── idle: five seconds of the user doing nothing ───────────────────────
    const i0 = await now(page);
    await page.waitForTimeout(5000);
    out.idleBlockingMs = await blocking(page, i0, await now(page));

    // ── a reply streams in, carrying a credential ──────────────────────────
    //
    // Not awaited, because the clock has to start when the credential reaches
    // the screen rather than when the stream finishes: it sits 55 characters
    // into the reply, which is about 140 ms in. Measuring from the end would
    // report a latency the user never experiences and would hide the one they
    // do — how long a key sat on screen unremarked.
    const s0 = await now(page);
    const wall = Date.now();
    const streaming = page.evaluate((t) => window.__stream(t, { chunk: 8, every: 20 }), REPLY);
    if (withExtension) {
      const found = await page.waitForFunction(() => !!document.querySelector('.chhanni-notice[data-chhanni-kind="reply"]'),
        null, { timeout: 20000 }).then(() => true).catch(() => false);
      out.noticed = found;
      out.noticeMs = found ? Date.now() - wall : Infinity;
    }
    await streaming;
    out.streamMs = Math.round((await now(page)) - s0);
    await page.waitForTimeout(4000);                 // the debounce, and after
    out.streamBlockingMs = await blocking(page, s0, await now(page));
    if (withExtension) {
      await page.evaluate(() => document.querySelectorAll('.chhanni-notice[data-chhanni-kind="reply"]').forEach((e) => e.remove()));
    }

    // ── paste, with the page in motion the way a real one is ───────────────
    await page.evaluate(() => window.__ticker(500));
    await page.evaluate(() => navigator.clipboard.writeText('a perfectly ordinary question about the deployment'));
    await page.locator('#prompt-textarea').click();
    const p0 = Date.now();
    await page.keyboard.press('ControlOrMeta+V');
    await page.waitForFunction(
      withExtension ? () => !!document.querySelector('.chhanni-clean, .chhanni-panel')
                    : () => document.querySelector('#prompt-textarea').value.length > 0,
      null, { timeout: 15000 }).catch(() => { out.pasteTimedOut = true; });
    out.pasteMs = Date.now() - p0;

    const before = await page.evaluate(() => window.__sent.length);
    const c0 = Date.now();
    await page.locator('#send').click();
    await page.waitForFunction((b) => window.__sent.length > b, before, { timeout: 15000 })
      .catch(() => { out.sendTimedOut = true; });
    out.sendMs = Date.now() - c0;
    await page.evaluate(() => window.__stopTicker());

    out.heapMb = Math.round(await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0)) / 1048576 * 10) / 10;
  } finally {
    await ctx.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
  return out;
}

/**
 * The starvation case.
 *
 * Separate from the numbers above because it is not a performance question,
 * it is a correctness one. Every chat product on the match list keeps
 * something moving in the DOM: a typing indicator, a caret, a shimmer. The
 * response scanner's debounce restarts on every mutation, so if anything
 * mutates more often than the debounce interval the scanner's timer is reset
 * forever and it never runs. This streams a reply carrying a credential while
 * an indicator ticks, and asks whether Chhanni ever says a word.
 */
async function starvation(n) {
  const { ctx, page, profile } = await open(n, true);
  try {
    const q = await quiet(page);
    if (process.argv.includes('--verbose')) console.log(dim(`  starvation: quiet at ${Math.round(q)}ms`));
    await page.evaluate(() => window.__ticker(400));
    const t0 = Date.now();
    page.evaluate((t) => window.__stream(t, { chunk: 8, every: 20 }), REPLY).catch(() => {});
    // The cap scales with the throttle: on a page that already blocks four
    // seconds a second by itself, a fixed fifteen is a measurement of the
    // fixture. What is being tested is whether a pass ever runs, not when.
    const noticed = await page.waitForFunction(() => !!document.querySelector('.chhanni-notice[data-chhanni-kind="reply"]'),
      null, { timeout: 15000 * THROTTLE }).then(() => true).catch(() => false);
    return { noticed, ms: Date.now() - t0 };
  } finally {
    await ctx.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}

// The baseline is not optional. Without it the blocking numbers are a
// measurement of Chromium laying out a 1.7 MB document, which this extension
// neither causes nor can fix. `--no-baseline` halves the runtime when you
// only want the latency numbers.
const BASELINE = !process.argv.includes('--no-baseline');
if (THROTTLE > 1) console.log(dim(`renderer throttled ${THROTTLE}x`));
console.log(dim(`${REPEAT} run(s) per measurement, reported as medians`));
const rows = [];
for (const n of TURNS) {
  const bare = BASELINE ? await measureMany(n, false) : null;
  const ext = await measureMany(n, true);
  rows.push({ n, bare, ext });
  console.log(`${String(n).padStart(5)} turns  ${String(ext.chars).padStart(8)} chars  ${String(ext.nodes).padStart(6)} nodes  innerText ${String(ext.innerTextMs).padStart(6)}ms`);
  const pair = (k, unit = 'ms') => {
    const a = ext[k];
    if (!bare) return `${k} ${a}${unit}`;
    const d = a - bare[k];
    return `${k} ${a}${unit} (page ${bare[k]}, ${d >= 0 ? '+' : ''}${d})`;
  };
  console.log(`              ${pair('idleBlockingMs')}  ${pair('streamBlockingMs')}`);
  console.log(`              ${pair('pasteMs')}  ${pair('sendMs')}  `
    + `notice ${ext.noticed ? `${ext.noticeMs}ms` : red('never')}  heap ${ext.heapMb}MB`);
}

const starved = await starvation(TURNS[TURNS.length - 1]);
console.log(`\n  a reply carrying a credential, while an indicator ticks every 400 ms: `
  + (starved.noticed ? green(`noticed after ${starved.ms}ms`) : red('never noticed')));

console.log('');
let failed = 0;
for (const { n, bare, ext } of rows) {
  for (const [k, rule] of Object.entries(BUDGET)) {
    const got = ext[k];
    if (got === undefined) continue;
    if (rule.absolute !== undefined) {
      const limit = rule.scale ? rule.absolute * THROTTLE : rule.absolute;
      if (got > limit) {
        console.log(red(`  FAIL  ${n} turns: ${k} ${got === Infinity ? 'never' : got + 'ms'} > ${limit}ms`));
        failed++;
      }
      continue;
    }
    if (!bare) continue;                      // a delta needs both halves
    const delta = got - bare[k];
    if (delta > rule.over) {
      console.log(red(`  FAIL  ${n} turns: ${k} is ${delta}ms more than the page alone `
        + `(${got} vs ${bare[k]}), budget +${rule.over}ms`));
      failed++;
    }
  }
  if (ext.pasteTimedOut) { console.log(red(`  FAIL  ${n} turns: paste never produced a verdict`)); failed++; }
  if (ext.sendTimedOut) { console.log(red(`  FAIL  ${n} turns: the send never arrived`)); failed++; }
}
if (!starved.noticed) {
  console.log(red('  FAIL  a ticking indicator starves the response scanner forever'));
  failed++;
}

if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
await new Promise((r) => server.close(r));
if (failed) { console.log(red(`\n${failed} budget(s) exceeded.`)); process.exit(1); }
console.log(green(`\nevery budget met across ${rows.length} conversation size(s).`));

#!/usr/bin/env node
/**
 * What the provider actually received.
 *
 * Every other suite in this repository asserts against a mock. That is the
 * right way to test interception logic and it cannot answer the only question
 * the product exists to answer. "A fixture recorded nothing" and "ChatGPT
 * received nothing" are different claims, and the gap between them is where a
 * provider's own editor lives: a React textarea with internal state, a
 * ProseMirror document model, a composer that re-renders from a store a
 * moment after Chhanni wrote to the DOM.
 *
 * So this harness drives the real products with your own logged-in profile and
 * watches the network. The assertion is on the **request body the provider's
 * own code sent**, read through CDP — not on whether a panel appeared, not on
 * what the composer looks like afterwards. If the sentinel is in that body,
 * the guard failed, whatever the UI said.
 *
 *   node scripts/build.js
 *   node test/provider/run.mjs --profile ~/.chhanni-test-profile
 *
 * The first run opens a visible browser and stops, so you can sign in to
 * whichever providers you want covered. Logins persist in that profile
 * directory; every later run reuses them.
 *
 *   node test/provider/run.mjs --profile <dir> --only chatgpt
 *   node test/provider/run.mjs --profile <dir> --matrix docs/PROVIDERS.md
 *
 * ── the sentinel ──────────────────────────────────────────────────────────
 *
 * `AKIAIOSFODNN7EXAMPLE`, which AWS publishes in its own documentation. This
 * harness deliberately *attempts* sends that may succeed — that is the only
 * way to learn what a provider receives — so the value that might get through
 * has to be one whose escape costs nothing. Never put a real credential in
 * here, and never "improve" this by using a realistic-looking random key: a
 * random key that happens to be live somewhere is a real leak.
 *
 * ── why this cannot run in CI ─────────────────────────────────────────────
 *
 * It needs accounts, a visible browser, and it sends messages to a paid
 * service. It is a release gate a person runs, and the result belongs in a
 * dated matrix file, because a pass against ChatGPT in October says nothing
 * about ChatGPT in December. A cell nobody could drive is reported as "not
 * tested", never as a pass.
 */
import { readFileSync, readdirSync, cpSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const NO_COLOR = process.argv.includes('--no-color') || !process.stdout.isTTY;
const c = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
};

const SENTINEL = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const MESSAGE = `Please review this config: AWS_ACCESS_KEY_ID=${SENTINEL}`;

let chromium = null;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs', 'playwright-core']) {
  try { ({ chromium } = await import(spec)); break; } catch { /* next */ }
}
if (!chromium) {
  console.error(red('provider: playwright is required. npm i --no-save playwright'));
  process.exit(1);
}

/**
 * Each provider, and how to find the three things this needs.
 *
 * `api` is the important one: a predicate over the outgoing request that says
 * "this is the call carrying the message". Everything else is navigation.
 * These selectors are somebody else's markup and will rot; the harness checks
 * each one and reports `selector-not-found` rather than quietly passing a
 * test it never ran.
 */
const PROVIDERS = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    composer: ['#prompt-textarea', 'div[contenteditable="true"]'],
    send: ['button[data-testid="send-button"]', 'button[aria-label*="Send" i]'],
    api: (u) => /\/backend-api\/(f\/)?conversation/.test(u),
  },
  {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai/new',
    composer: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"]'],
    send: ['button[aria-label*="Send" i]'],
    api: (u) => /\/api\/organizations\/.*\/(chat_conversations|completion)/.test(u),
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com/app',
    composer: ['div.ql-editor[contenteditable="true"]', 'div[contenteditable="true"]'],
    send: ['button[aria-label*="Send" i]', 'button.send-button'],
    api: (u) => /StreamGenerate|assistant\.lamda|BardFrontendService/.test(u),
  },
  {
    id: 'copilot',
    name: 'Microsoft Copilot',
    url: 'https://copilot.microsoft.com/',
    composer: ['textarea#userInput', 'textarea', 'div[contenteditable="true"]'],
    send: ['button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]'],
    api: (u) => /\/c\/api\/|turing\/conversation|chathub/.test(u),
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    url: 'https://www.perplexity.ai/',
    composer: ['textarea[placeholder]', 'div[contenteditable="true"]'],
    send: ['button[aria-label*="Submit" i]', 'button[data-testid="submit-button"]'],
    api: (u) => /\/rest\/sse\/perplexity_ask|\/api\/ask/.test(u),
  },
];

/** The paths a secret can take out of a composer. Each is one row of the matrix. */
const PATHS = [
  'paste',
  'type + Enter',
  'type + click Send',
  'programmatic click',
  'form submit',
  'redact then send',
  'image paste',
  'file picker',
  're-render after redaction',
  'while a reply streams',
];

// ── the extension, taught nothing it does not already know ─────────────────
if (!existsSync(join(root, 'dist', 'chrome', 'engine', 'detect.js'))) {
  console.error(red('provider: dist/chrome is missing. Run `node scripts/build.js` first.'));
  process.exit(1);
}
const profileDir = arg('--profile');
if (!profileDir) {
  console.error(red('provider: --profile <dir> is required.'));
  console.error('  The directory holds your signed-in browser profile between runs.');
  console.error('  Use one you keep for testing, not your everyday profile.');
  process.exit(1);
}
mkdirSync(profileDir, { recursive: true });

const only = arg('--only');
const chosen = only ? PROVIDERS.filter((p) => p.id === only) : PROVIDERS;
if (!chosen.length) {
  console.error(red(`provider: no provider called "${only}". Known: ${PROVIDERS.map((p) => p.id).join(', ')}`));
  process.exit(1);
}

const EXT = join(root, 'dist', 'chrome');
/**
 * Visible by default, because the first run is a sign-in.
 *
 * `--headless` is for later runs on a machine with no display, once the
 * profile already holds the logins. It works because this launches a full
 * Chromium rather than Playwright's headless shell, which cannot load an
 * extension at all and does not say so.
 */
const headless = process.argv.includes('--headless');
let ctx;
try {
  ctx = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
} catch (err) {
  const why = String(err && err.message);
  console.error(red('provider: the browser did not start.'));
  if (/DISPLAY|X server|ozone/i.test(why)) {
    console.error('  This machine has no display, and the default is a visible browser because');
    console.error('  the first run is a sign-in. Either run it on a desktop, or:');
    console.error('');
    console.error('    xvfb-run -a node test/provider/run.mjs --profile <dir>');
    console.error('    node test/provider/run.mjs --profile <dir> --headless   (once signed in)');
  } else {
    console.error(`  ${why.split('\n')[0]}`);
  }
  process.exit(2);
}

/** Find the first selector that matches, or say which ones did not. */
async function firstOf(page, selectors, what) {
  for (const sel of selectors) {
    const n = await page.locator(sel).count().catch(() => 0);
    if (n > 0) return sel;
  }
  throw new Error(`${what}: none of ${selectors.join(', ')} matched — this provider's markup has changed`);
}

/**
 * Everything the provider's own code put on the wire, while `fn` ran.
 *
 * Request bodies only. This is the measurement: not the composer, not the
 * panel, not what Chhanni believes. If the sentinel is in here, it left.
 */
async function watchWire(page, isApi, fn) {
  const bodies = [];
  const onRequest = (req) => {
    try {
      if (!isApi(req.url())) return;
      const body = req.postData();
      if (body) bodies.push(body);
    } catch { /* a request with no readable body */ }
  };
  page.on('request', onRequest);
  try { await fn(); } finally {
    await page.waitForTimeout(2500);
    page.off('request', onRequest);
  }
  return bodies;
}

const results = [];
const record = (provider, path, verdict, detail) => {
  results.push({ provider: provider.name, path, verdict, detail });
  const mark = verdict === 'held' ? green('held')
    : verdict === 'LEAKED' ? red('LEAKED')
      : yellow(verdict);
  console.log(`  ${path.padEnd(28)} ${mark}${detail ? dim(`  ${detail}`) : ''}`);
};

for (const provider of chosen) {
  console.log(`\n${provider.name} ${dim(provider.url)}`);
  const page = await ctx.newPage();
  try {
    await page.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    let composer;
    let send;
    try {
      composer = await firstOf(page, provider.composer, 'composer');
      send = await firstOf(page, provider.send, 'send button');
    } catch (err) {
      // Not signed in, or the markup moved. Either way every row below would
      // be a test that did not run, and reporting those as passes is the one
      // thing this file must never do.
      for (const path of PATHS) record(provider, path, 'not tested', err.message.slice(0, 90));
      await page.close();
      continue;
    }
    console.log(dim(`  composer ${composer}   send ${send}`));

    // ── paste ────────────────────────────────────────────────────────────
    const pasted = await watchWire(page, provider.api, async () => {
      await page.evaluate((t) => navigator.clipboard.writeText(t), MESSAGE);
      await page.locator(composer).click();
      await page.keyboard.press('ControlOrMeta+V');
      await page.waitForTimeout(1500);
      // Try to send whatever is there now. If Chhanni held the paste, there
      // is nothing to send and this is a no-op.
      await page.locator(send).click({ timeout: 5000 }).catch(() => {});
    });
    record(provider, 'paste',
      pasted.some((b) => b.includes(SENTINEL)) ? 'LEAKED' : 'held',
      `${pasted.length} request(s) seen`);

    await page.goto(provider.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);

    // ── typed, then Enter ────────────────────────────────────────────────
    const typed = await watchWire(page, provider.api, async () => {
      await page.locator(composer).click();
      await page.keyboard.type(MESSAGE, { delay: 8 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
    });
    record(provider, 'type + Enter',
      typed.some((b) => b.includes(SENTINEL)) ? 'LEAKED' : 'held',
      `${typed.length} request(s) seen`);

    // ── the rest ─────────────────────────────────────────────────────────
    //
    // Driving these faithfully means knowing each provider's own behaviour —
    // which button re-renders, where the file input is, how a stream settles.
    // Guessing produces a cell that says "held" because nothing happened, and
    // a false green here is worse than a blank. They are listed so the matrix
    // shows its own holes.
    for (const path of PATHS.slice(2)) {
      record(provider, path, 'not tested', 'needs a per-provider driver');
    }
  } catch (err) {
    for (const path of PATHS) record(provider, path, 'not tested', String(err.message).slice(0, 90));
  } finally {
    await page.close().catch(() => {});
  }
}

await ctx.close().catch(() => {});

// ── the matrix ─────────────────────────────────────────────────────────────
const leaked = results.filter((r) => r.verdict === 'LEAKED');
const held = results.filter((r) => r.verdict === 'held');
const untested = results.filter((r) => r.verdict === 'not tested');

console.log(`\n${held.length} held, ${leaked.length} leaked, ${untested.length} not tested`);

const matrixPath = arg('--matrix');
if (matrixPath) {
  const providers = [...new Set(results.map((r) => r.provider))];
  const cell = (p, path) => {
    const r = results.find((x) => x.provider === p && x.path === path);
    if (!r) return '—';
    return r.verdict === 'held' ? 'held' : r.verdict === 'LEAKED' ? '**LEAKED**' : 'not tested';
  };
  const lines = [
    '# Provider compatibility',
    '',
    `Measured ${new Date().toISOString().slice(0, 10)} with \`node test/provider/run.mjs\`.`,
    '',
    'Each cell is a claim about the **request body the provider\'s own code sent**,',
    'read from the network, not about whether a panel appeared. `not tested` means',
    'exactly that: the harness could not drive that path, and a cell nobody drove is',
    'never reported as a pass.',
    '',
    `| path | ${providers.join(' | ')} |`,
    `|---|${providers.map(() => '---').join('|')}|`,
    ...PATHS.map((path) => `| ${path} | ${providers.map((p) => cell(p, path)).join(' | ')} |`),
    '',
    'A pass here expires. These are somebody else\'s products and their composers',
    'change without notice, so the date above is part of the result.',
    '',
  ];
  writeFileSync(join(root, matrixPath), lines.join('\n'));
  console.log(dim(`matrix written to ${matrixPath}`));
}

if (leaked.length) {
  console.log(red('\na secret reached a provider. That is the product failing, not a flaky test.'));
  process.exit(1);
}
if (!held.length) {
  console.log(yellow('\nnothing was actually tested — sign in to at least one provider in this profile.'));
  process.exit(2);
}

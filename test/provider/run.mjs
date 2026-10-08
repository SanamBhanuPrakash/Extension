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
 *   npm run certify                       sign in, then measure, in one go
 *   npm run certify -- --signin           sign in only, and stop
 *   npm run certify -- --only chatgpt     one provider
 *
 * or the long form, which is the same thing:
 *
 *   node scripts/build.js
 *   node test/provider/run.mjs --profile ~/.chhanni-test-profile --matrix docs/PROVIDERS.md
 *
 * The first run opens a visible browser, puts each provider in its own tab,
 * says which ones you are signed in to, and **waits** while you sign in to
 * the rest. Logins persist in that profile directory, so every later run
 * reuses them and needs no pause.
 *
 * For a long time this file's header promised that pause and no code
 * implemented it. A first run therefore drove all five providers straight
 * into their login walls, wrote `NOT TESTED` fifty times, and exited 2 —
 * so the one step between this repository and a finished V1 could not have
 * worked for anybody who tried it. The gate was honest about the evidence
 * being missing and silent about the reason being a missing twenty lines.
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
import { join, dirname, isAbsolute } from 'node:path';
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
// The control. Deliberately something Chhanni has no reason to stop, so a
// silent wire means the harness cannot see this provider rather than that the
// extension did its job.
const CONTROL = 'What is the capital of France? Answer in one word.';

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
/**
 * `--providers <file>` replaces this table with a JSON array of the same
 * shape, with `api` as a regular-expression source string.
 *
 * It exists so the sign-in phase can be tested. That phase was promised in
 * this file's header for weeks with no code behind it, and nothing caught it
 * because the only thing that exercises these five entries is a person with
 * five accounts. A local fixture can stand in for a provider that wants a
 * login and one that does not, which is all the phase needs to decide.
 *
 * It is a test seam, not a configuration surface: the real five are the
 * certification target and `docs/PROVIDERS.md` names them.
 */
const PROVIDERS_FILE = arg('--providers');

const PROVIDERS = PROVIDERS_FILE ? JSON.parse(readFileSync(PROVIDERS_FILE, 'utf8')).map((p) => ({
  ...p, api: (u) => new RegExp(p.api).test(u),
})) : [
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

/**
 * The paths V1 must certify, as opposed to the ones V1.x owns.
 *
 * V1 asks one question: does the boundary work against a real provider at
 * all? Two paths answer it — they are how every user actually sends, they
 * have drivers here that work on any provider without provider-specific
 * knowledge, and a `PASS` on both means the request body the provider's own
 * code sent did not contain the secret. The other eight need per-provider
 * drivers, and guessing at somebody else's re-render behaviour produces a
 * cell that reads `PASS` when nothing happened. They are V1.x.
 *
 * This set is the boundary between the two releases, and `scripts/gate.js`
 * reads it back out of the matrix by the `(V1)` marker below. Moving a path
 * in here moves it into V1's exit criteria; `scripts/check-docs.js` fails if
 * this set and `docs/PROVIDERS.md` stop agreeing.
 */
const V1_PATHS = new Set(['paste', 'type + Enter']);
const label = (path) => (V1_PATHS.has(path) ? `${path} (V1)` : path);

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
/** Sign in and stop, so the human part and the measuring part are separable. */
const SIGNIN_ONLY = process.argv.includes('--signin');
/**
 * Whether to stop and wait for a person.
 *
 * By default: yes, when there is a terminal and a visible browser, because
 * that is somebody sitting in front of it. `--no-wait` for a profile that
 * already holds the logins. `--wait` forces it the other way — stdin is a
 * pipe but something is still answering — which is also how the pause is
 * tested, because a pause reachable only behind `isTTY` is a pause no test
 * can watch, and that is how the missing one went unnoticed for weeks.
 */
const FORCE_WAIT = process.argv.includes('--wait');
const NO_WAIT = process.argv.includes('--no-wait')
  || (!FORCE_WAIT && (headless || !process.stdin.isTTY));
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

/**
 * The four verdicts, and the one rule that governs all of them.
 *
 * `PASS` means: the harness drove this path, saw the provider's own code put
 * a request on the wire, and the sentinel was not in it.
 *
 * It does **not** mean "no request contained the sentinel". The first version
 * of this file computed exactly that — `bodies.some(has sentinel) ? LEAKED :
 * held` — which turns zero observed requests into a pass. Zero requests has
 * at least seven causes and only one of them is Chhanni working: the send
 * never happened, the composer selector missed, the send button selector
 * missed, the API predicate did not recognise the endpoint, the provider
 * changed transport, the click landed on the wrong element, or the account
 * was not signed in. Reporting any of those as evidence of protection is the
 * false green this product's own documentation forbids, produced by the file
 * that exists to prevent it.
 *
 * So every path first runs a **control**: the same action with harmless text,
 * which must produce at least one matching request. If the control is silent
 * the harness has not established that it can see this provider's traffic at
 * all, and every verdict for that path is `NOT TESTED` with the reason.
 */
const VERDICTS = ['PASS', 'FAIL', 'NOT TESTED', 'UNSUPPORTED'];
const results = [];
const record = (provider, path, verdict, detail) => {
  if (!VERDICTS.includes(verdict)) throw new Error(`not a verdict: ${verdict}`);
  results.push({ provider: provider.name, path, verdict, detail });
  const mark = verdict === 'PASS' ? green('PASS      ')
    : verdict === 'FAIL' ? red('FAIL      ')
      : verdict === 'UNSUPPORTED' ? dim('UNSUPPORTED')
        : yellow('NOT TESTED');
  console.log(`  ${path.padEnd(28)} ${mark}${detail ? dim(`  ${detail}`) : ''}`);
};

/**
 * Drive one path twice: once with harmless text, once with the sentinel.
 *
 * @param {(text: string) => Promise<void>} drive performs the send
 * @returns {Promise<{verdict: string, detail: string}>}
 */
async function certify(page, isApi, drive) {
  const control = await watchWire(page, isApi, () => drive(CONTROL));
  if (!control.length) {
    return { verdict: 'NOT TESTED',
      detail: 'no request seen for a harmless message — this harness cannot observe '
        + 'this provider\u2019s traffic, so silence on the real one proves nothing' };
  }
  if (control.some((b) => b.includes(SENTINEL))) {
    return { verdict: 'NOT TESTED', detail: 'the control message carried the sentinel; the fixture is wrong' };
  }
  const real = await watchWire(page, isApi, () => drive(MESSAGE));
  if (real.some((b) => b.includes(SENTINEL))) {
    return { verdict: 'FAIL', detail: `the sentinel was in ${real.length} request body(ies)` };
  }
  if (!real.length) {
    // The control worked and this did not: the send was stopped, which is
    // what should happen — but it is still "no request", so it is reported as
    // what it is rather than as proof.
    return { verdict: 'PASS',
      detail: `${control.length} control request(s) seen, none for the sentinel \u2014 held before the wire` };
  }
  return { verdict: 'PASS', detail: `${real.length} request(s), sentinel in none` };
}

// ── the sign-in phase ──────────────────────────────────────────────────────
//
// Nothing here can be measured on a provider nobody is logged into, and only
// a person can log in. So this opens a tab per provider, says which ones are
// reachable, and then stops — with those tabs still open, so signing in
// happens in the very browser the measurement will use a moment later.
//
// Everything after this point treats "not signed in" as a distinct state from
// "the markup moved". They used to be the same message, which blamed ChatGPT's
// markup for the absence of an account.

/** A composer we can type into, or why not. */
async function readiness(page, provider) {
  try {
    await page.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    return { ready: false, why: 'unreachable', detail: String(err.message).split('\n')[0].slice(0, 80) };
  }
  await page.waitForTimeout(3500);
  for (const sel of provider.composer) {
    if (await page.locator(sel).count().catch(() => 0)) return { ready: true, composer: sel };
  }
  // No composer. Distinguish a login wall from a redesign, because the first
  // is the person's to fix in thirty seconds and the second is ours.
  const wall = await page.locator(
    'input[type="password"], input[type="email"], a[href*="login" i], a[href*="signin" i], '
    + 'button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Continue with")',
  ).count().catch(() => 0);
  const url = page.url();
  if (wall || /login|signin|sign-in|auth|account/i.test(url)) {
    return { ready: false, why: 'not signed in', detail: `no composer, a sign-in page at ${url.slice(0, 60)}` };
  }
  return { ready: false, why: 'markup moved',
    detail: `signed in, but none of ${provider.composer.join(', ')} matched` };
}

const waitForEnter = (what) => new Promise((resolve) => {
  process.stdout.write(what);
  process.stdin.resume();
  process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
});

const tabs = new Map();
const state = new Map();
console.log(`\nopening ${chosen.length} provider(s)…`);
for (const provider of chosen) {
  const page = await ctx.newPage();
  tabs.set(provider.id, page);
  state.set(provider.id, await readiness(page, provider));
}

const report = () => {
  for (const provider of chosen) {
    const r = state.get(provider.id);
    console.log(r.ready
      ? `  ${green('signed in')}  ${provider.name}`
      : `  ${yellow(r.why.padEnd(9))}  ${provider.name}  ${dim(r.detail)}`);
  }
};
report();

const missing = chosen.filter((p) => !state.get(p.id).ready && state.get(p.id).why === 'not signed in');
if (missing.length && !NO_WAIT) {
  console.log(`\n${missing.length} provider(s) need a sign-in. The tabs are open in the browser`);
  console.log('that just launched — sign in to the ones you want covered. You can skip any');
  console.log('you do not have an account for; they will read NOT TESTED, which is honest.');
  console.log(dim('\nLogins are saved in the profile directory, so this is a one-time step.'));
  await waitForEnter('\nPress Enter here when you are done (or now, to skip): ');
  console.log('\nre-checking…');
  for (const provider of missing) {
    state.set(provider.id, await readiness(tabs.get(provider.id), provider));
  }
  report();
} else if (missing.length) {
  console.log(dim(`\n${missing.length} not signed in, and this run cannot pause `
    + `(${process.argv.includes('--no-wait') ? '--no-wait' : headless ? '--headless' : 'no terminal'}).`));
  console.log(dim('Run `npm run certify -- --signin` once on a desktop to log in.'));
}

for (const page of tabs.values()) await page.close().catch(() => {});

/**
 * Nothing to measure.
 *
 * Without this, a first run on a machine with no accounts printed fifty
 * identical rows of the same error before admitting it had tested nothing.
 * The information was all there and the shape of it told the person the tool
 * was broken.
 */
const anyReady = chosen.some((p) => state.get(p.id).ready);
if (!anyReady && !SIGNIN_ONLY) {
  await ctx.close().catch(() => {});
  console.log(yellow(`\nno provider could be driven, so nothing was measured.`));
  const why = [...new Set(chosen.map((p) => state.get(p.id).why))];
  console.log(`Reason${why.length > 1 ? 's' : ''}: ${why.join(', ')}.`);
  console.log(why.includes('not signed in')
    ? 'Run `npm run certify -- --signin` on a desktop and log in first.'
    : 'The matrix is unchanged; nothing here is evidence either way.');
  process.exit(2);
}

if (SIGNIN_ONLY) {
  const in_ = chosen.filter((p) => state.get(p.id).ready).length;
  await ctx.close().catch(() => {});
  console.log(`\n${in_}/${chosen.length} provider(s) signed in and saved to ${profileDir}`);
  console.log(in_ ? 'Now run `npm run certify` to measure what they receive.'
    : yellow('Nothing is signed in, so there is nothing to measure yet.'));
  process.exit(in_ ? 0 : 2);
}

for (const provider of chosen) {
  console.log(`\n${provider.name} ${dim(provider.url)}`);
  const page = await ctx.newPage();
  try {
    // The sign-in phase already answered this, and said which of the two
    // reasons it is. Re-asking would only lose that distinction.
    const known = state.get(provider.id);
    if (!known.ready) {
      for (const path of PATHS) record(provider, path, 'NOT TESTED', `${known.why}: ${known.detail}`);
      console.log(`  ${yellow(known.why)} — skipped`);
      await page.close();
      continue;
    }

    await page.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    let composer;
    let send;
    try {
      composer = await firstOf(page, provider.composer, 'composer');
      send = await firstOf(page, provider.send, 'send button');
    } catch (err) {
      for (const path of PATHS) record(provider, path, 'NOT TESTED', err.message.slice(0, 90));
      await page.close();
      continue;
    }
    console.log(dim(`  composer ${composer}   send ${send}`));

    const freshTab = async () => {
      await page.goto(provider.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);
    };

    // ── paste ────────────────────────────────────────────────────────────
    const pasteDrive = async (text) => {
      await freshTab();
      await page.evaluate((t) => navigator.clipboard.writeText(t), text);
      await page.locator(composer).click();
      await page.keyboard.press('ControlOrMeta+V');
      await page.waitForTimeout(1500);
      // Send whatever is there now. If Chhanni held the paste there is
      // nothing to send and this is a no-op, which `certify` reads correctly
      // because the control proved the wire is observable.
      await page.locator(send).click({ timeout: 5000 }).catch(() => {});
    };
    const pasted = await certify(page, provider.api, pasteDrive);
    record(provider, 'paste', pasted.verdict, pasted.detail);

    // ── typed, then Enter ────────────────────────────────────────────────
    const typeDrive = async (text) => {
      await freshTab();
      await page.locator(composer).click();
      await page.keyboard.type(text, { delay: 8 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
    };
    const typed = await certify(page, provider.api, typeDrive);
    record(provider, 'type + Enter', typed.verdict, typed.detail);

    // ── the rest ─────────────────────────────────────────────────────────
    //
    // Driving these faithfully means knowing each provider's own behaviour —
    // which button re-renders, where the file input is, how a stream settles.
    // Guessing produces a cell that says "held" because nothing happened, and
    // a false green here is worse than a blank. They are listed so the matrix
    // shows its own holes.
    for (const path of PATHS.slice(2)) {
      record(provider, path, 'NOT TESTED', 'needs a per-provider driver');
    }
  } catch (err) {
    for (const path of PATHS) record(provider, path, 'NOT TESTED', String(err.message).slice(0, 90));
  } finally {
    await page.close().catch(() => {});
  }
}

await ctx.close().catch(() => {});

// ── the matrix ─────────────────────────────────────────────────────────────
const leaked = results.filter((r) => r.verdict === 'FAIL');
const held = results.filter((r) => r.verdict === 'PASS');
const untested = results.filter((r) => r.verdict === 'NOT TESTED');

console.log(`\n${held.length} PASS, ${leaked.length} FAIL, ${untested.length} NOT TESTED`);

// The V1 subset, reported separately, because that is the number that decides
// whether the release is blocked. 40 uncertified V1.x cells are a roadmap; two
// uncertified V1 cells are a shipping decision.
const v1 = results.filter((r) => V1_PATHS.has(r.path));
const v1Held = v1.filter((r) => r.verdict === 'PASS' || r.verdict === 'UNSUPPORTED').length;
if (v1.length) {
  console.log(v1Held === v1.length
    ? green(`V1 paths: ${v1Held}/${v1.length} certified — the V1 provider blocker is cleared`)
    : yellow(`V1 paths: ${v1Held}/${v1.length} certified — V1 stays blocked until all of them are`));
}

const matrixPath = arg('--matrix');
if (matrixPath) {
  const providers = [...new Set(results.map((r) => r.provider))];
  const cell = (p, path) => {
    const r = results.find((x) => x.provider === p && x.path === path);
    if (!r) return '—';
    return r.verdict === 'FAIL' ? '**FAIL**' : r.verdict;
  };
  const today = new Date().toISOString().slice(0, 10);

  /**
   * Just the matrix section: the heading, what was measured and when, and the
   * table.
   *
   * It used to be the whole file. That meant the single most valuable action
   * anybody can take on this repository — signing in to five products and
   * certifying the boundary — deleted the five hand-written sections that say
   * what the cells mean, which paths V1 promises, and why a pass expires. The
   * evidence landed and the explanation of the evidence was the price. Worse,
   * `check-docs.js` still reported that the documentation agreed with the
   * code, because every machine-readable invariant was in the part that
   * survived.
   */
  const section = [
    '## The matrix',
    '',
    `Measured: **${today}** by \`node test/provider/run.mjs\`. Sentinel:`,
    '`AKIAIOSFODNN7EXAMPLE` (AWS\'s published documentation key).',
    '',
    'Each cell is a claim about the **request body the provider\'s own code sent**,',
    'read from the network, not about whether a panel appeared.',
    '',
    'The two rows marked `(V1)` are the ones V1 must certify: they are how every',
    'user sends, and they are drivable without provider-specific knowledge. The',
    'other eight are V1.x, and need a per-provider driver each. `scripts/gate.js`',
    'reads that marker, so this is the boundary and not a note about it.',
    '',
    `| path | ${providers.join(' | ')} |`,
    `|---|${providers.map(() => '---').join('|')}|`,
    ...PATHS.map((path) => `| ${label(path)} | ${providers.map((p) => cell(p, path)).join(' | ')} |`),
    '',
  ].join('\n');

  // An absolute --matrix used to be silently reinterpreted under the repo
  // root, writing to a path nobody asked for or crashing on a missing parent.
  const target = isAbsolute(matrixPath) ? matrixPath : join(root, matrixPath);
  if (!existsSync(target)) {
    console.error(red(`provider: ${matrixPath} does not exist.`));
    console.error('  This rewrites the `## The matrix` section of an existing file rather than');
    console.error('  replacing the file, because the rest of it explains what the cells mean.');
    console.error('  Point --matrix at docs/PROVIDERS.md.');
    process.exit(1);
  }

  const before = readFileSync(target, 'utf8');
  // From the `## The matrix` heading to the next `## ` heading, exclusive.
  const at = before.indexOf('\n## The matrix\n');
  if (at === -1) {
    console.error(red(`provider: ${matrixPath} has no "## The matrix" section to replace.`));
    console.error('  Refusing to overwrite the file: the surrounding prose is the part that');
    console.error('  says what a cell means, and a matrix without it is numbers nobody can read.');
    process.exit(1);
  }
  const rest = before.slice(at + 1);
  const nextHeading = rest.slice(1).search(/\n## /);
  const after = nextHeading === -1 ? '' : rest.slice(1 + nextHeading + 1);
  writeFileSync(target, `${before.slice(0, at + 1)}${section}${after}`);
  console.log(dim(`matrix section of ${matrixPath} rewritten, dated ${today}`));
}

if (leaked.length) {
  console.log(red('\na secret reached a provider. That is the product failing, not a flaky test.'));
  process.exit(1);
}
if (!held.length) {
  console.log(yellow('\nnothing was actually tested — sign in to at least one provider in this profile.'));
  process.exit(2);
}

/**
 * The sign-in phase, exercised.
 *
 * This phase was described in `run.mjs`'s header for weeks with no code
 * behind it. Nothing caught that, because the only thing that drives the real
 * provider table is a person with five accounts — so the one step between
 * this repository and a finished V1 was the step no test touched.
 *
 * Two `file://` fixtures stand in: one with a composer (signed in), one with
 * a password field (a login wall). That is all the phase has to tell apart.
 *
 * They are files and not a local server on purpose. The first version served
 * them over HTTP from this process, which cannot work: the harness runs under
 * `execFileSync`, so the event loop is blocked for its whole lifetime and the
 * server never accepts a connection. Every provider read `unreachable` and
 * all four tests failed for a reason that had nothing to do with the code
 * under test.
 *
 * `--wait` makes the pause reachable over a pipe. A pause that exists only
 * behind `isTTY` is a pause no test can watch, which is how the missing one
 * survived.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const has = (cmd) => {
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
};
const skip = !existsSync(join(root, 'dist', 'chrome', 'engine', 'detect.js'))
  ? 'run `node scripts/build.js` first'
  : !has('xvfb-run') ? 'needs xvfb-run' : false;

const PAGES = {
  in: `<!doctype html><meta charset=utf-8><title>in</title>
    <div contenteditable="true" id="prompt-textarea"></div><button id="send">Send</button>`,
  out: `<!doctype html><meta charset=utf-8><title>log in</title>
    <form><input type="email"><input type="password"><button>Log in</button></form>`,
};

/** A providers.json pointing at file:// fixtures, and a scratch profile. */
function fixture(which) {
  const dir = mkdtempSync(join(tmpdir(), 'chhanni-signin-'));
  for (const [name, html] of Object.entries(PAGES)) writeFileSync(join(dir, `${name}.html`), html);
  const list = join(dir, 'providers.json');
  writeFileSync(list, JSON.stringify(which.map((w) => ({
    id: w, name: `Fixture ${w}`, url: pathToFileURL(join(dir, `${w}.html`)).href,
    composer: ['#prompt-textarea'], send: ['#send'], api: '/never-matches',
  }))));
  return { list, profile: join(dir, 'profile') };
}

/** Run the harness, returning its output whatever it exits with. */
function run(args, stdin = '') {
  try {
    return execFileSync('xvfb-run', ['-a', 'node', 'test/provider/run.mjs', ...args],
      { cwd: root, input: stdin, encoding: 'utf8', timeout: 180000 });
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
}

test('a login wall is told apart from a signed-in composer', { skip }, () => {
  const { list, profile } = fixture(['in', 'out']);
  const out = run(['--profile', profile, '--providers', list, '--signin', '--no-wait', '--no-color']);

  assert.match(out, /signed in\s+Fixture in/, 'a reachable composer was not reported as signed in');
  assert.match(out, /not signed in\s+Fixture out/,
    "a login wall was not named as one — it used to be blamed on the provider's markup");
  assert.match(out, /1\/2 provider\(s\) signed in/, 'the count was wrong');
});

test('it stops and waits, then looks again', { skip }, () => {
  // The defect itself: the header promised this pause and no code did it, so
  // a first run drove five login walls and wrote NOT TESTED fifty times.
  const { list, profile } = fixture(['out']);
  const out = run(['--profile', profile, '--providers', list, '--signin', '--wait', '--no-color'], '\n');

  assert.match(out, /need a sign-in/, 'it never said what the person has to do');
  assert.match(out, /Press Enter here/, 'it did not stop to wait');
  assert.match(out, /re-checking/, 'it never looked again after the person said they were done');
  assert.match(out, /0\/1 provider\(s\) signed in/, 'it claimed a sign-in that did not happen');
});

test('with no terminal it does not hang, and says why', { skip }, () => {
  // CI, cron, a piped shell: skipped, never deadlocked.
  const { list, profile } = fixture(['out']);
  const out = run(['--profile', profile, '--providers', list, '--no-color']);

  assert.match(out, /cannot pause/, 'it went ahead without saying why it did not wait');
  assert.match(out, /no provider could be driven/, 'it did not stop once nothing was drivable');
  assert.doesNotMatch(out, /Press Enter/, 'it offered a prompt nobody could answer');
});

test('a signed-in fixture is driven rather than skipped', { skip }, () => {
  // The other half: readiness gates the drive loop, it does not replace it.
  const { list, profile } = fixture(['in']);
  const out = run(['--profile', profile, '--providers', list, '--no-wait', '--no-color']);

  assert.match(out, /composer #prompt-textarea/, 'a signed-in provider was not driven at all');
  assert.doesNotMatch(out, /not signed in/, 'a reachable composer was called a login wall');
});

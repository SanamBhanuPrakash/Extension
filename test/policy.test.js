/**
 * The storage split, tested where its failures are deterministic.
 *
 * `extension/policy.js` owns the one privacy-relevant decision in the
 * settings layer: the allowlist is made entirely of strings somebody typed
 * *because they are sensitive*, so it lives in `chrome.storage.local` and
 * never in `chrome.storage.sync`, which Chrome replicates through Google's
 * servers.
 *
 * The end-to-end suite proves the migration works in a real browser. It
 * cannot prove what happens when the migration half-fails, because the
 * interesting half-failure — the local write succeeds and the deletion does
 * not — needs a storage area that lies, and in a real profile every context
 * that can see the change will race to perform the migration with the real
 * API. A fake store is the only place that branch is reachable on purpose.
 *
 * The branch matters more than the happy path. If the deletion fails and the
 * code reports success, the options page tells somebody their customer's
 * address has stopped being replicated while a copy of it is still on
 * Google's servers — a claim stronger than what was verified, which is the
 * single failure this product exists to refuse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** A storage area with the three behaviours that matter, and no more. */
function area(initial = {}) {
  let data = structuredClone(initial);
  const self = {
    refuse: null,                       // (items) => boolean: swallow this write
    throwOn: null,                      // (items) => boolean: reject this write
    async get(key) {
      if (key === null) return structuredClone(data);
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      if (self.throwOn && self.throwOn(items)) throw new Error('QUOTA_BYTES exceeded');
      if (self.refuse && self.refuse(items)) return;      // resolves, changes nothing
      Object.assign(data, structuredClone(items));
    },
    async remove(key) { delete data[key]; },
    get raw() { return data; },
  };
  return self;
}

/**
 * A fresh `policy.js` against a fresh fake `chrome`.
 *
 * The cache-busting query is not optional: the module is stateless but Node
 * caches it, and these cases install different `chrome` globals.
 */
async function withStorage(sync, local) {
  globalThis.chrome = { storage: { sync, local } };
  return import(`../extension/policy.js?case=${Math.random()}`);
}

const ALLOWLISTED = 'customer@acquisition-target.example';
const synced = (allow) => ({ policy: { mode: 'warn', disabled: [], allow } });

test('a stranded allowlist is moved to local and deleted from sync', async () => {
  const sync = area(synced([ALLOWLISTED]));
  const local = area();
  const { readPolicy } = await withStorage(sync, local);

  const { policy, migrated, migrationFailed } = await readPolicy();

  assert.deepEqual(migrated, ['allow'], 'the move was not reported');
  assert.equal(migrationFailed, null);
  assert.deepEqual(policy.allow, [ALLOWLISTED], 'the setting stopped working after the move');
  assert.ok(!JSON.stringify(sync.raw).includes(ALLOWLISTED),
    'the replicated copy was left in place, which fixes the behaviour and not the exposure');
  assert.ok(JSON.stringify(local.raw).includes(ALLOWLISTED), 'the values were dropped, not moved');
});

test('a deletion that silently does nothing is reported as a failure', async () => {
  // `set` resolves and changes nothing — a quota rejection that the polyfill
  // swallowed, a disabled sync area, an extension suspended mid-write.
  const sync = area(synced([ALLOWLISTED]));
  sync.refuse = (items) => Boolean(items.policy) && !items.policy.allow?.length;
  const local = area();
  const { readPolicy } = await withStorage(sync, local);

  const { policy, migrated, migrationFailed } = await readPolicy();

  assert.deepEqual(migrated, [], 'a move that did not happen was reported as done');
  assert.match(migrationFailed || '', /could not be removed/,
    'the options page would say the data had stopped being replicated');
  assert.ok(JSON.stringify(sync.raw).includes(ALLOWLISTED), 'the fixture did not reproduce the failure');
  assert.deepEqual(policy.allow, [ALLOWLISTED],
    'the allowlist stopped working while the migration was broken');
});

test('a local write that does not persist is reported as a failure', async () => {
  const sync = area(synced([ALLOWLISTED]));
  const local = area();
  local.refuse = () => true;
  const { readPolicy } = await withStorage(sync, local);

  const { migrated, migrationFailed } = await readPolicy();

  assert.deepEqual(migrated, []);
  assert.match(migrationFailed || '', /could not be saved/);
});

test('storage that throws is reported, not swallowed', async () => {
  const sync = area(synced([ALLOWLISTED]));
  const local = area();
  local.throwOn = () => true;
  const { readPolicy } = await withStorage(sync, local);

  const { migrated, migrationFailed, policy } = await readPolicy();

  assert.deepEqual(migrated, []);
  assert.match(migrationFailed || '', /storage refused the move/);
  assert.deepEqual(policy.allow, [ALLOWLISTED], 'the values stopped working for this session');
});

test('the notice outlives the call, and is forgotten once shown', async () => {
  // Whichever surface reads first performs the migration; the surface that
  // shows the notice is a different one. Before the outcome was persisted,
  // the popup opening before the options page meant nobody was ever told.
  const sync = area(synced([ALLOWLISTED]));
  const local = area();
  const { readPolicy, clearMigrationNotice } = await withStorage(sync, local);

  const first = await readPolicy();
  const second = await readPolicy();
  await clearMigrationNotice();
  const third = await readPolicy();

  assert.deepEqual(first.migrated, ['allow'], 'the surface that moved it was not told');
  assert.deepEqual(second.migrated, ['allow'], 'a later surface was told nothing');
  assert.deepEqual(third.migrated, [], 'the notice is shown forever, so people learn to ignore it');
});

test('a failed migration keeps saying so, because it is still true', async () => {
  const sync = area(synced([ALLOWLISTED]));
  sync.refuse = (items) => Boolean(items.policy) && !items.policy.allow?.length;
  const local = area();
  const { readPolicy, clearMigrationNotice } = await withStorage(sync, local);

  await readPolicy();
  await clearMigrationNotice();
  const after = await readPolicy();

  assert.match(after.migrationFailed || '', /could not be removed/,
    'a condition that is still true stopped being reported');
});

test('nothing to migrate reports nothing', async () => {
  const sync = area({ policy: { mode: 'strict', disabled: ['email'] } });
  const local = area({ policyLocal: { allow: ['already-local.example'] } });
  const { readPolicy } = await withStorage(sync, local);

  const { policy, migrated, migrationFailed } = await readPolicy();

  assert.deepEqual(migrated, []);
  assert.equal(migrationFailed, null);
  assert.equal(policy.mode, 'strict');
  assert.deepEqual(policy.disabled, ['email']);
  assert.deepEqual(policy.allow, ['already-local.example']);
});

test('writePolicy never routes an allowlist into sync', async () => {
  const sync = area();
  const local = area();
  const { writePolicy, DEFAULTS } = await withStorage(sync, local);

  await writePolicy({ allow: [ALLOWLISTED], mode: 'strict' }, DEFAULTS);

  assert.ok(!JSON.stringify(sync.raw).includes(ALLOWLISTED),
    'an allowlist value was written to a store Chrome replicates off the device');
  assert.ok(JSON.stringify(local.raw).includes(ALLOWLISTED), 'it was not persisted locally either');
  assert.equal(sync.raw.policy.mode, 'strict', 'the preference itself should still follow the person');
});

test('a local allowlist wins over a stranded synced one', async () => {
  // The local copy is the newer home, so a migration must not overwrite it
  // with whatever an older browser last replicated.
  const sync = area(synced(['stale-from-another-laptop.example']));
  const local = area({ policyLocal: { allow: ['typed-on-this-device.example'] } });
  const { readPolicy } = await withStorage(sync, local);

  const { policy } = await readPolicy();

  assert.deepEqual(policy.allow, ['typed-on-this-device.example']);
  assert.ok(!JSON.stringify(sync.raw).includes('stale-from-another-laptop.example'),
    'the stale replicated copy was left in place');
});

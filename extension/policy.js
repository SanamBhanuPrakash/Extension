/**
 * Where each setting lives, and why it is not all in one place.
 *
 * `chrome.storage.sync` is convenient and it is also a network service:
 * Chrome replicates it to every browser the person is signed into, which
 * means through Google's servers. Chrome's own documentation says not to put
 * confidential user information in it.
 *
 * The whole policy used to go there, allowlist included — and the allowlist is
 * the one field made entirely of strings the person typed because they are
 * sensitive. "Never treat this as a finding" is how you tell Chhanni about a
 * customer's email address, an internal codename, a shared test credential, a
 * project nobody outside the company knows the name of. Every one of those was
 * being replicated off the device by a product whose central claim is that
 * nothing leaves it.
 *
 * The claim was not false about Chhanni's own behaviour — there is still no
 * `fetch` in this codebase and no network permission in the manifest. It was
 * false about the outcome, which is the only thing a person actually cares
 * about, and "our code makes no request" is not an answer to "does my
 * customer's email address leave this laptop".
 *
 * So settings are split by what they reveal:
 *
 *   sync    the interruption level and which detectors are switched off.
 *           Preferences. They say something about how cautious somebody is,
 *           nothing about who they work with or what they are working on, and
 *           having them follow you to a new laptop is the point.
 *   local   the allowlist. Never replicated, never synced, never leaves the
 *           profile.
 *
 * A profile that already synced an allowlist is migrated on first read: the
 * values are written to local and *deleted from sync*, which removes them from
 * the replicated copy as well. Doing nothing would have left them there.
 */

export const DEFAULTS = { mode: 'warn', disabled: [], allow: [] };

/** Fields that reveal what a person works on, rather than how cautious they are. */
export const LOCAL_FIELDS = ['allow'];

const SYNC_KEY = 'policy';
const LOCAL_KEY = 'policyLocal';

/**
 * The outcome of the migration, kept until somebody has been told.
 *
 * The migration runs on first read from whichever surface opens first. Once
 * the popup started routing through this module — which it must, so that two
 * write paths cannot disagree about which fields may be replicated — the
 * popup became the likely first reader, and the popup does not show this
 * notice. The options page did, and would then find nothing stranded and say
 * nothing.
 *
 * Silently repairing a privacy defect is not the same as repairing it.
 * Somebody who typed a customer's address into the allowlist is owed the fact
 * that it had been leaving the device and has stopped — or, worse news, that
 * it has not. So the outcome outlives the call that produced it.
 */
const NOTICE_KEY = 'policyMigrationNotice';

const pick = (obj, keys) => Object.fromEntries(
  Object.entries(obj || {}).filter(([k]) => keys.includes(k)));
const omit = (obj, keys) => Object.fromEntries(
  Object.entries(obj || {}).filter(([k]) => !keys.includes(k)));

/**
 * The person's own settings, from both areas, migrating if needed.
 *
 * @returns {Promise<{policy: object, migrated: string[], migrationFailed: string|null}>}
 *   `migrated` names the fields this call moved out of sync **and verified
 *   gone**, so the caller can say so rather than quietly fixing it.
 *   `migrationFailed` is set instead when the move was attempted and could
 *   not be confirmed, because telling somebody their data has stopped being
 *   replicated when it has not is worse than saying nothing.
 */
export async function readPolicy() {
  let synced = {};
  let local = {};
  try { synced = (await chrome.storage.sync.get(SYNC_KEY))[SYNC_KEY] || {}; } catch { /* first run */ }
  try { local = (await chrome.storage.local.get(LOCAL_KEY))[LOCAL_KEY] || {}; } catch { /* first run */ }

  /**
   * Anything sensitive still in sync is moved out, not merely ignored.
   *
   * `migrated` is only populated once **both** writes have returned: the
   * local copy persisted, and the synchronised copy deleted. The first
   * version pushed the field name before either had happened, so a quota
   * error or a storage failure left the options page saying "it has been
   * moved to this device only, and the synchronised copy has been deleted"
   * about values still sitting in a replicated store.
   *
   * That is the same defect the architecture forbids — a claim stronger than
   * what was verified — committed by the code that exists to fix it. A
   * failure is reported as a failure now, and the caller is told the
   * synchronised copy is still there.
   */
  const stranded = LOCAL_FIELDS.filter((f) => Array.isArray(synced[f]) && synced[f].length);
  const migrated = [];
  let migrationFailed = null;
  if (stranded.length) {
    const moved = { ...local };
    for (const f of stranded) {
      // The local copy wins if it already has values: it is the newer home.
      if (!Array.isArray(moved[f]) || !moved[f].length) moved[f] = synced[f];
    }
    try {
      await chrome.storage.local.set({ [LOCAL_KEY]: moved });
      await chrome.storage.sync.set({ [SYNC_KEY]: omit(synced, LOCAL_FIELDS) });
      // Read both back. A `set` that resolved is not the same claim as a
      // store that holds what was asked of it, and this is the one place in
      // the product where the difference is a privacy outcome.
      const checkLocal = (await chrome.storage.local.get(LOCAL_KEY))[LOCAL_KEY] || {};
      const checkSync = (await chrome.storage.sync.get(SYNC_KEY))[SYNC_KEY] || {};
      const persisted = stranded.every((f) => Array.isArray(checkLocal[f]) && checkLocal[f].length);
      const deleted = LOCAL_FIELDS.every((f) => !Array.isArray(checkSync[f]) || !checkSync[f].length);
      if (persisted && deleted) {
        migrated.push(...stranded);
        local = moved;
      } else {
        migrationFailed = !deleted
          ? 'the synchronised copy could not be removed'
          : 'the local copy could not be saved';
        local = moved;            // the values still work this session
      }
    } catch (err) {
      migrationFailed = `storage refused the move (${String(err && err.message).slice(0, 60)})`;
      local = moved;
    }
  }

  // Record it for whoever shows the notice, and read back any record left by
  // an earlier call in another surface. This call's own result wins.
  let notice = {};
  try { notice = (await chrome.storage.local.get(NOTICE_KEY))[NOTICE_KEY] || {}; } catch { /* none */ }
  if (migrated.length || migrationFailed) {
    notice = { fields: migrated, failed: migrationFailed, at: Date.now() };
    try { await chrome.storage.local.set({ [NOTICE_KEY]: notice }); } catch { /* best effort */ }
  }

  return {
    policy: { ...DEFAULTS, ...omit(synced, LOCAL_FIELDS), ...pick(local, LOCAL_FIELDS) },
    migrated: migrated.length ? migrated : (notice.fields || []),
    migrationFailed: migrationFailed || notice.failed || null,
  };
}

/**
 * Forget the migration notice, once somebody has actually been shown it.
 *
 * Only the surface that displays it calls this. A failed migration is left in
 * place deliberately: it describes a condition that is still true.
 */
export async function clearMigrationNotice() {
  try { await chrome.storage.local.remove(NOTICE_KEY); } catch { /* nothing to forget */ }
}

/** Write a patch, routing each field to the area it belongs in. */
export async function writePolicy(patch, current) {
  const next = { ...DEFAULTS, ...current, ...patch };
  const syncPart = omit(next, [...LOCAL_FIELDS, 'managed', 'codenames', 'fingerprintSalt',
    'block', 'warn', 'requiredDetectors', 'neverAllow']);
  const localPart = pick(next, LOCAL_FIELDS);
  await chrome.storage.sync.set({ [SYNC_KEY]: syncPart });
  await chrome.storage.local.set({ [LOCAL_KEY]: localPart });
  return next;
}

/** Did a storage change touch the person's own settings? */
export const isPolicyChange = (changes, area) =>
  (area === 'sync' && changes && SYNC_KEY in changes)
  || (area === 'local' && changes && LOCAL_KEY in changes)
  || area === 'managed';

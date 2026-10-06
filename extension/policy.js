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

const pick = (obj, keys) => Object.fromEntries(
  Object.entries(obj || {}).filter(([k]) => keys.includes(k)));
const omit = (obj, keys) => Object.fromEntries(
  Object.entries(obj || {}).filter(([k]) => !keys.includes(k)));

/**
 * The person's own settings, from both areas, migrating if needed.
 *
 * @returns {Promise<{policy: object, migrated: string[]}>} `migrated` names
 *   the fields that were moved out of sync by this call, so the caller can
 *   say so rather than quietly fixing it.
 */
export async function readPolicy() {
  let synced = {};
  let local = {};
  try { synced = (await chrome.storage.sync.get(SYNC_KEY))[SYNC_KEY] || {}; } catch { /* first run */ }
  try { local = (await chrome.storage.local.get(LOCAL_KEY))[LOCAL_KEY] || {}; } catch { /* first run */ }

  // Anything sensitive still in sync is moved out, not merely ignored.
  const stranded = LOCAL_FIELDS.filter((f) => Array.isArray(synced[f]) && synced[f].length);
  const migrated = [];
  if (stranded.length) {
    const moved = { ...local };
    for (const f of stranded) {
      // The local copy wins if it already has values: it is the newer home.
      if (!Array.isArray(moved[f]) || !moved[f].length) moved[f] = synced[f];
      migrated.push(f);
    }
    try {
      await chrome.storage.local.set({ [LOCAL_KEY]: moved });
      await chrome.storage.sync.set({ [SYNC_KEY]: omit(synced, LOCAL_FIELDS) });
      local = moved;
    } catch { /* quota or no storage; the merge below still returns the values */ }
  }

  return {
    policy: { ...DEFAULTS, ...omit(synced, LOCAL_FIELDS), ...pick(local, LOCAL_FIELDS) },
    migrated,
  };
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

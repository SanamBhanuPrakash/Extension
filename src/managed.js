/**
 * Organisation policy, without a console and without a network call.
 *
 * The obvious way to sell this to a company is a cloud console: rules go down,
 * findings come up. The second half of that sentence is the thing this project
 * exists not to do, and adding it would make every claim in the threat model
 * false.
 *
 * Browsers already solved this. `chrome.storage.managed` is populated by the
 * administrator through Windows GPO, a macOS configuration profile, Chrome
 * Enterprise policy or Firefox's `policies.json`. The browser hands the values
 * to the extension **locally**. Policy flows in; nothing flows out; no
 * permission is added beyond the `storage` one already held.
 *
 * A CISO gets consistent rules across a fleet. The default install stays
 * silent. Those two things are usually sold as a trade-off and are not one.
 */

export const MANAGED_DEFAULTS = {
  mode: null,
  lockMode: false,
  requiredDetectors: [],
  disabled: [],
  allow: [],
  lockAllow: false,
  neverAllow: [],
  codenames: [],
  watchResponses: null,
  message: null,
};

/**
 * Merges an administrator's policy over a user's own settings.
 *
 * Precedence is deliberate and explained in the UI. The default is that an
 * organisation *adds* protection and may lock the interruption level, while a
 * user keeps their own allowlist on top: policy that silently removes
 * protection a user chose is a surprise, and surprises get extensions
 * uninstalled.
 *
 * The default was also, for a while, the only behaviour — which meant an
 * administrator could require a detector and then watch a user allowlist the
 * exact value it was there to catch. That is not a policy, it is a
 * suggestion. Two settings close it, and both are opt-in so the forgiving
 * default stays the default:
 *
 *   lockAllow    the managed allowlist is the whole allowlist
 *   neverAllow   specific values that may never be allowlisted by anyone
 *
 * `neverAllow` wins over both lists, including the managed one, so a policy
 * cannot contradict itself.
 */
export function mergePolicy(userPolicy, managed) {
  if (!managed || typeof managed !== 'object') return { ...userPolicy, managed: null };
  const m = { ...MANAGED_DEFAULTS, ...managed };

  const disabled = new Set(userPolicy.disabled || []);
  for (const id of m.disabled || []) disabled.add(id);
  // Required detectors win over a user switching them off.
  for (const id of m.requiredDetectors || []) disabled.delete(id);

  return {
    ...userPolicy,
    mode: m.lockMode && m.mode ? m.mode : (userPolicy.mode || m.mode || 'warn'),
    disabled: [...disabled],
    // An administrator who can add a detector but cannot stop a value being
    // allowlisted does not have a policy, they have a suggestion. `lockAllow`
    // makes the managed allowlist the whole allowlist; `neverAllow` is the
    // narrower form, for the handful of values that must always be reported
    // whatever else is configured.
    allow: (m.lockAllow
      ? [...new Set(m.allow || [])]
      : [...new Set([...(userPolicy.allow || []), ...(m.allow || [])])]
    ).filter((v) => !(m.neverAllow || []).includes(v)),
    neverAllow: [...new Set(m.neverAllow || [])],
    watchResponses: m.watchResponses !== null ? m.watchResponses : userPolicy.watchResponses,
    codenames: m.codenames || [],
    managed: {
      active: true,
      locked: Boolean(m.lockMode && m.mode),
      required: m.requiredDetectors || [],
      allowLocked: Boolean(m.lockAllow),
      neverAllowCount: (m.neverAllow || []).length,
      message: m.message || null,
      codenameCount: (m.codenames || []).length,
    },
  };
}

/**
 * Builds a detector for an organisation's internal codenames.
 *
 * Deliberately not shipped as a rule: the words are the organisation's, they
 * differ per install, and they must never be baked into a published package.
 * Matching is whole-word and case-insensitive.
 */
export function codenameRule(codenames) {
  const words = (codenames || [])
    .map((w) => String(w).trim())
    .filter((w) => w.length >= 3 && w.length <= 64);
  if (!words.length) return null;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return {
    id: 'org_codename',
    label: 'Internal project codename',
    severity: 'high',
    confidence: 'certain',
    advisory: true,
    audience: 'everyone',
    pattern: new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi'),
    note: 'Named as confidential by your organisation’s policy.',
  };
}

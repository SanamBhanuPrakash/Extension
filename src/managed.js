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
  codenames: [],
  watchResponses: null,
  message: null,
};

/**
 * Merges an administrator's policy over a user's own settings.
 *
 * Precedence is deliberate and explained in the UI: an organisation may *add*
 * protection and may lock the interruption level, but a user can always add
 * their own allowlist entries on top. Policy that silently removes protection
 * a user chose would be a surprise, and surprises get extensions uninstalled.
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
    allow: [...new Set([...(userPolicy.allow || []), ...(m.allow || [])])],
    watchResponses: m.watchResponses !== null ? m.watchResponses : userPolicy.watchResponses,
    codenames: m.codenames || [],
    managed: {
      active: true,
      locked: Boolean(m.lockMode && m.mode),
      required: m.requiredDetectors || [],
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

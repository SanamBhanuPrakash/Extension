/**
 * The ruleset.
 *
 * Each rule is a pattern plus, where one exists, a validator that decides
 * whether a match is real. Rules without a validator are held to a higher
 * structural bar or reported at lower confidence, never both silently.
 *
 * confidence:
 *   'certain'  - the match carries its own proof (checksum, magic prefix that
 *                nothing else uses, decodable structure).
 *   'likely'   - distinctive shape, no proof available.
 *   'possible' - shape alone; expect these to need an allowlist.
 *
 * severity drives the default policy: 'critical' blocks by default,
 * 'high' and 'medium' warn, 'low' is informational.
 */
import {
  luhn, aadhaar, iban, pan, ssn, githubTokenChecksum, looksRandom, entropy,
  jwtHeader, jwtPayload,
} from './checksums.js';

/** Card brand from IIN range, for the message only. */
function cardBrand(digits) {
  const s = digits.replace(/[^0-9]/g, '');
  if (/^4/.test(s)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]|7[01]|720))/.test(s)) return 'Mastercard';
  if (/^3[47]/.test(s)) return 'Amex';
  if (/^6(011|5|4[4-9])/.test(s)) return 'Discover';
  if (/^(60|65|81|82|508)/.test(s)) return 'RuPay/Maestro';
  if (/^3(0[0-5]|[68])/.test(s)) return 'Diners';
  return 'card';
}

/** True when the match sits next to a word that means "this is a credential". */
const SECRET_CONTEXT = /(?:secret|passwd|password|pwd|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth|bearer|credential)/i;
function nearSecretWord(text, index, window = 48) {
  return SECRET_CONTEXT.test(text.slice(Math.max(0, index - window), index));
}

export const RULES = [
  // ---------------------------------------------------------------- cloud
  {
    id: 'aws_access_key_id',
    label: 'AWS access key ID',
    severity: 'critical',
    confidence: 'certain',
    // The prefixes are AWS-assigned resource-type tags; nothing else uses them.
    pattern: /\b((?:AKIA|ASIA|AIDA|AROA|AGPA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16})\b/g,
    note: 'Pairs with a secret key to give full API access to the account.',
  },
  {
    id: 'aws_secret_access_key',
    label: 'AWS secret access key',
    severity: 'critical',
    confidence: 'likely',
    // 40 chars of base64 is far too generic on its own, so require both a
    // credential-ish neighbour word and real randomness.
    pattern: /\b([A-Za-z0-9/+=]{40})\b/g,
    validate: (m, ctx) => nearSecretWord(ctx.text, ctx.index) && looksRandom(m, 4.2),
  },
  {
    id: 'gcp_service_account',
    label: 'GCP service-account key file',
    severity: 'critical',
    confidence: 'certain',
    pattern: /"type"\s*:\s*"service_account"/g,
    note: 'A whole service-account JSON key was pasted.',
  },
  {
    id: 'google_api_key',
    label: 'Google API key',
    severity: 'high',
    confidence: 'certain',
    pattern: /\b(AIza[A-Za-z0-9_-]{35})\b/g,
  },
  {
    id: 'azure_storage_key',
    label: 'Azure storage connection string',
    severity: 'critical',
    confidence: 'certain',
    pattern: /AccountKey=[A-Za-z0-9/+=]{64,}/g,
  },

  // --------------------------------------------------------------- vendor
  {
    id: 'github_token',
    label: 'GitHub token',
    severity: 'critical',
    confidence: 'certain',
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36})\b/g,
    enrich: (m) => {
      const state = githubTokenChecksum(m);
      return state === 'valid'
        ? { note: 'CRC32 checksum valid — this is a live token format.' }
        : { confidence: 'likely', note: 'Checksum did not verify; treating as a token anyway.' };
    },
  },
  {
    id: 'github_pat_fine_grained',
    label: 'GitHub fine-grained PAT',
    severity: 'critical',
    confidence: 'certain',
    pattern: /\b(github_pat_[A-Za-z0-9_]{60,})\b/g,
  },
  {
    id: 'openai_key',
    label: 'OpenAI API key',
    severity: 'critical',
    confidence: 'certain',
    pattern: /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,})\b/g,
    validate: (m) => !m.startsWith('sk-ant-'),
  },
  {
    id: 'anthropic_key',
    label: 'Anthropic API key',
    severity: 'critical',
    confidence: 'certain',
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{24,})\b/g,
  },
  {
    id: 'stripe_live_key',
    label: 'Stripe live secret key',
    severity: 'critical',
    confidence: 'certain',
    pattern: /\b((?:sk|rk)_live_[A-Za-z0-9]{20,})\b/g,
    note: 'Live key — can move real money.',
  },
  {
    id: 'stripe_test_key',
    label: 'Stripe test key',
    severity: 'low',
    confidence: 'certain',
    pattern: /\b((?:sk|rk)_test_[A-Za-z0-9]{20,})\b/g,
    note: 'Test mode, no live funds at risk.',
  },
  {
    id: 'slack_token',
    label: 'Slack token',
    severity: 'critical',
    confidence: 'certain',
    pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    id: 'slack_webhook',
    label: 'Slack incoming webhook',
    severity: 'high',
    confidence: 'certain',
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+/g,
  },
  {
    id: 'sendgrid_key',
    label: 'SendGrid API key',
    severity: 'high',
    confidence: 'certain',
    pattern: /\b(SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g,
  },
  {
    id: 'twilio_key',
    label: 'Twilio account SID / key',
    severity: 'high',
    confidence: 'certain',
    pattern: /\b((?:AC|SK)[0-9a-fA-F]{32})\b/g,
  },
  {
    id: 'huggingface_token',
    label: 'Hugging Face token',
    severity: 'high',
    confidence: 'certain',
    pattern: /\b(hf_[A-Za-z0-9]{34,})\b/g,
  },
  {
    id: 'npm_token',
    label: 'npm access token',
    severity: 'critical',
    confidence: 'certain',
    pattern: /\b(npm_[A-Za-z0-9]{36})\b/g,
  },
  {
    id: 'pypi_token',
    label: 'PyPI upload token',
    severity: 'critical',
    confidence: 'certain',
    pattern: /\b(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,})\b/g,
  },

  // ------------------------------------------------------------- generic
  {
    id: 'private_key_block',
    label: 'Private key block',
    severity: 'critical',
    confidence: 'certain',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    note: 'An entire private key is in this prompt.',
  },
  {
    id: 'db_connection_string',
    label: 'Database URL with password',
    severity: 'critical',
    confidence: 'certain',
    // Only fires when credentials are actually embedded in the URL.
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql|clickhouse):\/\/[^\s:/@]+:[^\s@]+@[^\s/?#]+(?:\/[^\s?#]*)?(?:\?[^\s#]*)?/g,
  },
  {
    id: 'jwt',
    label: 'JSON Web Token',
    severity: 'high',
    confidence: 'certain',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{0,}/g,
    validate: (m) => jwtHeader(m) !== null,
    enrich: (m) => {
      const payload = jwtPayload(m);
      if (!payload) return {};
      const bits = [];
      if (payload.exp) {
        const expired = payload.exp * 1000 < Date.now();
        bits.push(expired ? 'already expired' : 'still valid');
      }
      for (const claim of ['email', 'sub', 'name', 'preferred_username']) {
        if (payload[claim]) { bits.push(`carries ${claim}`); break; }
      }
      return bits.length ? { note: `Decoded: ${bits.join(', ')}.` } : {};
    },
  },
  {
    id: 'bearer_header',
    label: 'Authorization header',
    severity: 'high',
    confidence: 'likely',
    pattern: /\b[Aa]uthorization\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/g,
  },
  {
    id: 'high_entropy_assignment',
    label: 'Credential-shaped value',
    severity: 'medium',
    confidence: 'possible',
    // The catch-all for formats nobody has published: a secret-ish name on
    // the left of an assignment, and something genuinely random on the right.
    pattern: /(?:secret|passwd|password|pwd|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|auth[_-]?key)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-/+=.]{16,})["']?/gi,
    group: 1,
    validate: (m) => looksRandom(m, 3.2) && !/^(?:your|my|the|example|changeme|redacted|xxx|placeholder|<)/i.test(m),
  },

  // ------------------------------------------------------------------ PII
  {
    id: 'payment_card',
    label: 'Payment card number',
    severity: 'critical',
    confidence: 'certain',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (m) => luhn(m),
    enrich: (m) => ({ note: `${cardBrand(m)}, passes Luhn.` }),
  },
  {
    id: 'aadhaar',
    label: 'Aadhaar number',
    severity: 'critical',
    confidence: 'certain',
    pattern: /\b([2-9]\d{3}[ -]?\d{4}[ -]?\d{4})\b/g,
    validate: (m) => aadhaar(m),
    note: 'Sensitive personal data under the DPDP Act, 2023.',
  },
  {
    id: 'pan_india',
    label: 'Indian PAN',
    severity: 'high',
    confidence: 'likely',
    pattern: /\b([A-Z]{5}[0-9]{4}[A-Z])\b/g,
    validate: (m) => pan(m),
  },
  {
    id: 'iban',
    label: 'IBAN',
    severity: 'high',
    confidence: 'certain',
    pattern: /\b([A-Z]{2}[0-9]{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4})\b/g,
    validate: (m) => iban(m),
  },
  {
    id: 'us_ssn',
    label: 'US Social Security number',
    severity: 'critical',
    confidence: 'likely',
    pattern: /\b(\d{3}-\d{2}-\d{4})\b/g,
    validate: (m) => ssn(m),
  },
  {
    id: 'email',
    label: 'Email address',
    severity: 'low',
    confidence: 'certain',
    pattern: /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    validate: (m) => !/@(?:example|test|localhost|invalid)\.(?:com|org|net)$/i.test(m),
  },
  {
    id: 'phone_india',
    label: 'Indian mobile number',
    severity: 'low',
    confidence: 'likely',
    pattern: /(?:\+?91[ -]?)?\b([6-9]\d{9})\b/g,
    group: 1,
  },
];

export const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));
export { entropy, nearSecretWord };

/**
 * Grouping, for the settings UI only. Kept out of the rule objects so the
 * detection engine stays free of presentation concerns.
 */
export const CATEGORIES = [
  { id: 'cloud', label: 'Cloud providers', ids: ['aws_access_key_id', 'aws_secret_access_key', 'gcp_service_account', 'google_api_key', 'azure_storage_key'] },
  { id: 'vendor', label: 'Developer services', ids: ['github_token', 'github_pat_fine_grained', 'openai_key', 'anthropic_key', 'stripe_live_key', 'stripe_test_key', 'slack_token', 'slack_webhook', 'sendgrid_key', 'twilio_key', 'huggingface_token', 'npm_token', 'pypi_token'] },
  { id: 'generic', label: 'Generic secrets', ids: ['private_key_block', 'db_connection_string', 'jwt', 'bearer_header', 'high_entropy_assignment'] },
  { id: 'pii', label: 'Personal data', ids: ['payment_card', 'aadhaar', 'pan_india', 'iban', 'us_ssn', 'email', 'phone_india'] },
];

for (const group of CATEGORIES) {
  for (const id of group.ids) {
    const rule = RULES_BY_ID.get(id);
    if (rule) rule.category = group.id;
  }
}

/**
 * Which detectors actually prove a match, and how.
 *
 * This is deliberately narrower than "has a validate function". Excluding
 * `example.com` from the email rule is a filter, not a proof; recomputing a
 * Verhoeff check digit is a proof. The distinction is the honest version of
 * the claim this project makes about itself, so it is written down rather
 * than inferred.
 */
export const PROOFS = {
  aws_secret_access_key: 'Shannon entropy ≥ 4.2 and a credential word within 48 characters',
  github_token: "CRC32 checksum carried in the token's own last 6 characters",
  jwt: 'base64-decodes to a JOSE header; the payload is read for expiry and claims',
  payment_card: 'Luhn mod-10',
  aadhaar: 'Verhoeff check digit, plus the reserved first-digit rules',
  pan_india: 'structural — the holder-type character must be a real code',
  iban: 'mod-97',
  us_ssn: 'never-issued area, group and serial ranges',
  high_entropy_assignment: 'Shannon entropy, with documentation placeholders excluded',
};

for (const [id, proof] of Object.entries(PROOFS)) {
  const rule = RULES_BY_ID.get(id);
  if (rule) rule.proof = proof;
}

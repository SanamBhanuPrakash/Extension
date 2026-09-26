/**
 * The ruleset.
 *
 * Each rule is a pattern, plus — where the format allows one — a validator
 * that decides whether the match is real. Published precision for
 * regex-and-entropy secret scanners runs between 25% and 75%; everything
 * structural in this file exists to beat that, and `bench/` measures whether
 * it does.
 *
 * Fields:
 *   confidence  'certain'  the match carries its own proof: a checksum, a
 *                          decodable structure, or a prefix no other format uses.
 *               'likely'   distinctive shape, no proof available.
 *               'possible' shape alone; expect to allowlist these.
 *   severity    drives policy: 'critical' blocks by default, 'high'/'medium'
 *               warn, 'low' is informational and never blocks.
 *   prefilter   literal substrings. If none appear in the text the regex is
 *               skipped entirely — this is what keeps a 70-detector scan cheap
 *               on a large paste.
 *   validate    (value, ctx) => boolean
 *   enrich      (value, ctx) => partial finding, for notes that earn attention
 */
import {
  luhn, aadhaar, iban, pan, ssn, githubTokenChecksum, looksRandom, entropy,
  jwtHeader, jwtPayload, cardIssuer,
} from './checksums.js';
import {
  gstin, ifsc, upiVpa, indianPassport, voterId, indianDrivingLicence,
  cpf, cnpj, sin, nino, abn, tfn, isin, imei, euVat,
  awsAccountId, formatAccountId,
} from './identifiers.js';
import { isBenign, HEX_DIGEST, isCodeIdentifier } from './negatives.js';
import { CONTEXT_RULES, CONTEXT_CATEGORY } from './context.js';

/** Card brand from the issuer identification number, for the note only. */
function cardBrand(value) {
  const s = value.replace(/[^0-9]/g, '');
  if (/^4/.test(s)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]|7[01]|720))/.test(s)) return 'Mastercard';
  if (/^3[47]/.test(s)) return 'Amex';
  if (/^6(011|5|4[4-9])/.test(s)) return 'Discover';
  if (/^(508[5-9]|60698[5-9]|6521|6522|81[0-9]{2})/.test(s)) return 'RuPay';
  if (/^3(0[0-5]|[68])/.test(s)) return 'Diners';
  if (/^(352[89]|35[3-8][0-9])/.test(s)) return 'JCB';
  return 'card';
}

const SECRET_CONTEXT = /(?:secret|passwd|password|pwd|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth|bearer|credential|conn(?:ection)?[_-]?str)/i;
function nearSecretWord(text, index, window = 48) {
  return SECRET_CONTEXT.test(text.slice(Math.max(0, index - window), index));
}

/** Shorthand for a vendor key whose prefix alone identifies it. */
const vendor = (id, label, pattern, prefilter, severity = 'critical', extra = {}) => ({
  id, label, severity, confidence: 'certain', pattern, prefilter, ...extra,
});

/**
 * ISO 3166-1 alpha-2, plus the X-codes ISIN reserves for issues that are not
 * tied to one country: XS for Euroclear and Clearstream, XA/XB/XC/XD for CUSIP
 * International, EU and QM/QS for other supranational ranges.
 */
/**
 * True when a run occupies its own line, or sits on the right of a single
 * assignment. Quotes, commas, semicolons and trailing backslashes are allowed
 * around it, because that is how values appear in real files.
 */
function standsAsValue(text, index, length) {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  let lineEnd = text.indexOf('\n', index + length);
  if (lineEnd < 0) lineEnd = text.length;
  const head = text.slice(lineStart, index);
  const tail = text.slice(index + length, lineEnd);

  // Nothing but decoration after it, on either reading below.
  if (!/^["'`,;\\\s)\]}]*$/.test(tail)) return false;
  // Alone on its line.
  if (/^[\s"'`>*#|-]*$/.test(head)) return true;

  // If a quote closes it, a quote has to open it.
  //
  // Django's signing documentation is full of 'My string:<signature>' — one
  // quoted string containing a colon, which reads as key:value and is not
  // one. The value's own opening quote is the difference: "key": "<value>"
  // has one, 'My string:<value>' does not.
  const quote = /^["'`]/.exec(tail);
  if (quote && !head.endsWith(quote[0])) return false;

  // The right-hand side of one assignment. `==`, `!=`, `<=`, `>=` and `=>`
  // cannot match: each puts a character before the separator that a key
  // cannot end with.
  return /(?:^|[\s,{(\[])["'`]?[\w.$-]{1,64}["'`]?\s*[=:]\s*["'`]?\s*$/.test(head);
}

/**
 * True when base64 decodes to something that was already something else: a
 * known file format, or text.
 *
 * The UTF-8 test is the strong one. A sequence of random bytes is valid UTF-8
 * with vanishing probability past a dozen bytes, so "decodes to valid UTF-8
 * made of printable code points" is a reliable way to say "this is an
 * encoding of something, not key material" — without knowing what either was.
 */
const B64_MAGIC = /^(?:R0lGOD|iVBORw0KGgo|\/9j\/|JVBERi0|UEsDB|H4sI|AAABAA|PHN2Zy|PD94bWw|Qk0|SUkq|TU0A|f0VMR|TVqQ|Q1JFQVR)/;

function encodesKnownContent(value) {
  if (B64_MAGIC.test(value)) return true;
  const s = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (s.length < 20 || /[^A-Za-z0-9+/]/.test(s)) return false;

  const bytes = [];
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64_INDEX[s.charCodeAt(i)];
    if (v < 0) return false;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    bytes.push((acc >> bits) & 0xff);
  }
  if (bytes.length < 15) return false;

  // Walk it as UTF-8. Anything that is not a printable code point, or any
  // malformed sequence, and this is not text.
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) {
      if (b < 0x20 && b !== 9 && b !== 10 && b !== 13) return false;
      continue;
    }
    let extra;
    if (b >= 0xc2 && b <= 0xdf) extra = 1;
    else if (b >= 0xe0 && b <= 0xef) extra = 2;
    else if (b >= 0xf0 && b <= 0xf4) extra = 3;
    else return false;
    // The last few bytes may be a truncated character; stop rather than fail.
    if (i + extra >= bytes.length) break;
    for (let k = 1; k <= extra; k++) {
      if ((bytes[i + k] & 0xc0) !== 0x80) return false;
    }
    i += extra;
  }
  return true;
}

/** True when an offset falls between a PEM BEGIN line and its END line. */
function insidePemBlock(text, index) {
  const begin = text.lastIndexOf('-----BEGIN', index);
  if (begin < 0) return false;
  const end = text.lastIndexOf('-----END', index);
  return end < begin;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;

/**
 * True when a string is base64 of something a person could read.
 *
 * A JWT's header decodes to `{"alg":"HS256","typ":"JWT"}`; an encoded config
 * decodes to YAML. Thirty random bytes decode to thirty random bytes, which
 * are not printable. This is the cheapest way to tell an encoding from a key
 * without knowing what either is supposed to be.
 */
function decodesToText(value) {
  const s = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (s.length < 16 || /[^A-Za-z0-9+/]/.test(s)) return false;
  let printable = 0;
  let total = 0;
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64_INDEX[s.charCodeAt(i)];
    if (v < 0) return false;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    const byte = (acc >> bits) & 0xff;
    total++;
    if ((byte >= 0x20 && byte < 0x7f) || byte === 0x09 || byte === 0x0a || byte === 0x0d) printable++;
  }
  return total >= 12 && printable / total >= 0.9;
}

/**
 * Runs of four or more lowercase letters, per character.
 *
 * The statistic that separates a random token from a name built out of words,
 * without needing a dictionary. React's benchmark fixture lists component
 * names one per line — FluxContainer_AdsPEBIGAdAccountSelectorContainer_8 —
 * which has enough case changes, digits and underscores to look random by
 * every other measure here. What it also has is four English words in it.
 *
 * Normalised by length, because a longer random string gets more runs by
 * chance: a uniform base62 string of any length sits near 0.010, and the
 * React names sit above 0.08.
 */
function wordiness(s) {
  let runs = 0;
  let run = 0;
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s.charCodeAt(i) : 0;
    if (c >= 97 && c <= 122) { run++; continue; }
    if (run >= 4) runs++;
    run = 0;
  }
  return runs / Math.max(1, s.length);
}

/**
 * How often a string changes character class, per character.
 *
 * The statistic that separates a random token from a long identifier without
 * needing a dictionary. Base62 drawn uniformly changes class roughly 0.62
 * times per character; `getUserProfileByOrganisationId` changes it about 0.1
 * times; a hex digest never changes it at all.
 */
function classTransitions(s) {
  const cls = (c) => (c >= 97 && c <= 122 ? 1 : c >= 65 && c <= 90 ? 2 : c >= 48 && c <= 57 ? 3 : 4);
  let changes = 0;
  for (let i = 1; i < s.length; i++) {
    if (cls(s.charCodeAt(i)) !== cls(s.charCodeAt(i - 1))) changes++;
  }
  return changes / Math.max(1, s.length - 1);
}

const ISIN_PREFIX = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ '
  + 'BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ '
  + 'DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT '
  + 'GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY '
  + 'KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX '
  + 'MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS '
  + 'RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN '
  + 'TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW '
  + 'XS XA XB XC XD XF XK EU QM QS').split(/\s+/));


export const RULES = [
  // ═══════════════════════════════════════════════════════ cloud providers
  {
    id: 'aws_access_key_id',
    label: 'AWS access key ID',
    severity: 'critical',
    confidence: 'certain',
    prefilter: ['AKIA', 'ASIA', 'AIDA', 'AROA', 'AGPA', 'AIPA', 'ANPA', 'ANVA', 'ABIA', 'ACCA'],
    pattern: /\b((?:AKIA|ASIA|AIDA|AROA|AGPA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z2-7]{16})\b/g,
    /**
     * The account number is inside the key. Decoding it turns "an AWS key is in
     * your prompt" into "the key for account 5810-3995-4779 is in your prompt",
     * which is the difference between a warning people dismiss and one they act on.
     */
    enrich: (m) => {
      const account = awsAccountId(m);
      const kind = m.startsWith('ASIA') ? 'Temporary STS credential' : 'Long-lived IAM key';
      return account
        ? { note: `${kind} for AWS account ${formatAccountId(account)} — decoded offline from the key itself.` }
        : { note: `${kind}. Pairs with a secret key for full API access.` };
    },
  },
  {
    id: 'aws_secret_access_key',
    needs: { base64Run: 40 },
    label: 'AWS secret access key',
    severity: 'critical',
    confidence: 'likely',
    // 40 base64 characters is far too generic alone, so demand a credential
    // neighbour word, real randomness, and not-a-git-SHA.
    // An AWS secret is a standalone token, never the tail of a longer
    // identifier. Without '_' and '-' in the guards this pattern matched the
    // last 40 characters of figd_/lin_api_/glc_ tokens and, being 'critical',
    // out-ranked the vendor rule that actually identified them.
    pattern: /(?<![A-Za-z0-9/+=_-])([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=_-])/g,
    validate: (m, ctx) =>
      !HEX_DIGEST.test(m) && !isBenign(m) &&
      nearSecretWord(ctx.text, ctx.index) && looksRandom(m, 4.2),
  },
  vendor('gcp_service_account', 'GCP service-account key file',
    /"type"\s*:\s*"service_account"/g, ['service_account'], 'critical',
    { note: 'An entire service-account JSON key.' }),
  vendor('google_api_key', 'Google API key',
    /\b(AIza[A-Za-z0-9_-]{35})\b/g, ['AIza'], 'high'),
  vendor('google_oauth_client', 'Google OAuth client ID',
    /\b([0-9]{10,14}-[0-9a-z]{32}\.apps\.googleusercontent\.com)\b/g,
    ['googleusercontent.com'], 'medium'),
  vendor('azure_storage_key', 'Azure storage connection string',
    /AccountKey=[A-Za-z0-9/+=]{64,}/g, ['AccountKey=']),
  vendor('digitalocean_token', 'DigitalOcean token',
    /\b(dop_v1_[0-9a-f]{64})\b/g, ['dop_v1_']),
  vendor('cloudflare_token', 'Cloudflare API token',
    /\b([A-Za-z0-9_-]{40})\b(?=[^A-Za-z0-9_-]*(?:cloudflare|CF_API))/gi, ['cloudflare', 'CF_API'], 'high',
    { confidence: 'likely' }),

  // ══════════════════════════════════════════════════════ source & packages
  {
    id: 'github_token',
    label: 'GitHub token',
    severity: 'critical',
    confidence: 'certain',
    prefilter: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'],
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36})\b/g,
    enrich: (m) => {
      const kind = { p: 'classic personal access token', o: 'OAuth token',
        u: 'user-to-server token', s: 'server-to-server (app installation) token',
        r: 'refresh token' }[m[2]];
      const state = githubTokenChecksum(m);
      return state === 'valid'
        ? { note: `GitHub ${kind}; CRC32 checksum valid.` }
        : { confidence: 'likely', note: `GitHub ${kind}; checksum did not verify, treated as a token anyway.` };
    },
  },
  vendor('github_pat_fine_grained', 'GitHub fine-grained PAT',
    /\b(github_pat_[A-Za-z0-9_]{60,})\b/g, ['github_pat_']),
  vendor('gitlab_token', 'GitLab token',
    /\b((?:glpat|glptt|gldt|glrt|glsoat|glimt|glagent)-[A-Za-z0-9_-]{20,})\b/g, ['glpat-', 'glptt-', 'gldt-', 'glrt-', 'glsoat-', 'glimt-', 'glagent-']),
  vendor('npm_token', 'npm access token',
    /\b(npm_[A-Za-z0-9]{36})\b/g, ['npm_']),
  vendor('pypi_token', 'PyPI upload token',
    /\b(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,})\b/g, ['pypi-AgEIcHlwaS5vcmc']),
  vendor('rubygems_token', 'RubyGems API key',
    /\b(rubygems_[0-9a-f]{48})\b/g, ['rubygems_']),
  vendor('terraform_token', 'Terraform Cloud token',
    /\b([A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_-]{50,})\b/g, ['.atlasv1.']),
  vendor('jfrog_token', 'JFrog Artifactory token',
    /\b(cmVmdGtuOjAxO[A-Za-z0-9+/=]{20,})\b/g, ['cmVmdGtuOjAxO']),
  vendor('sonarqube_token', 'SonarQube token',
    /\b(sq[pau]_[0-9a-f]{40})\b/g, ['sqp_', 'sqa_', 'squ_'], 'high'),

  // ═══════════════════════════════════════════════════════════ AI providers
  {
    id: 'openai_key',
    label: 'OpenAI API key',
    severity: 'critical',
    confidence: 'certain',
    prefilter: ['sk-'],
    pattern: /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,})\b/g,
    validate: (m) => !m.startsWith('sk-ant-') && !m.startsWith('sk-or-'),
  },
  vendor('anthropic_key', 'Anthropic API key',
    /\b(sk-ant-(?:api|admin)[0-9]{2}-[A-Za-z0-9_-]{24,})\b/g, ['sk-ant-']),
  vendor('openrouter_key', 'OpenRouter API key',
    /\b(sk-or-v1-[0-9a-f]{64})\b/g, ['sk-or-v1-']),
  vendor('groq_key', 'Groq API key',
    /\b(gsk_[A-Za-z0-9]{52})\b/g, ['gsk_']),
  vendor('xai_key', 'xAI API key',
    /\b(xai-[A-Za-z0-9]{70,90})\b/g, ['xai-']),
  vendor('replicate_key', 'Replicate API token',
    /\b(r8_[A-Za-z0-9]{37})\b/g, ['r8_']),
  vendor('huggingface_token', 'Hugging Face token',
    /\b(hf_[A-Za-z0-9]{34,})\b/g, ['hf_'], 'high'),
  vendor('perplexity_key', 'Perplexity API key',
    /\b(pplx-[A-Za-z0-9]{32,})\b/g, ['pplx-']),
  vendor('fireworks_key', 'Fireworks AI key',
    /\b(fw_[A-Za-z0-9]{24,})\b/g, ['fw_']),
  vendor('langsmith_key', 'LangSmith API key',
    /\b(lsv2_(?:pt|sk)_[0-9a-f]{32}_[0-9a-f]{10})\b/g, ['lsv2_']),

  // ═══════════════════════════════════════════════════════════════ payments
  vendor('stripe_live_key', 'Stripe live secret key',
    /\b((?:sk|rk)_live_[A-Za-z0-9]{20,})\b/g, ['sk_live_', 'rk_live_'], 'critical',
    { note: 'Live key — can move real money.' }),
  vendor('stripe_test_key', 'Stripe test key',
    /\b((?:sk|rk)_test_[A-Za-z0-9]{20,})\b/g, ['sk_test_', 'rk_test_'], 'low',
    { note: 'Test mode, no live funds at risk.' }),
  vendor('square_token', 'Square access token',
    /\b((?:sq0atp|sq0csp|EAAA)[A-Za-z0-9_-]{22,})\b/g, ['sq0atp', 'sq0csp', 'EAAA']),
  vendor('razorpay_key', 'Razorpay key',
    /\b(rzp_(?:live|test)_[A-Za-z0-9]{14,})\b/g, ['rzp_live_', 'rzp_test_']),
  vendor('paypal_token', 'PayPal/Braintree token',
    /\b(access_token\$production\$[a-z0-9]{16}\$[0-9a-f]{32})\b/g, ['access_token$production$']),

  // ═════════════════════════════════════════════════════════ communications
  vendor('slack_token', 'Slack token',
    /\b(xox[baprse]-[A-Za-z0-9-]{10,})\b/g, ['xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-', 'xoxe-']),
  vendor('slack_webhook', 'Slack incoming webhook',
    /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+/g,
    ['hooks.slack.com'], 'high'),
  vendor('discord_bot_token', 'Discord bot token',
    /\b([MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38})\b/g, ['.'], 'high',
    { confidence: 'likely' }),
  vendor('telegram_bot_token', 'Telegram bot token',
    /\b([0-9]{8,10}:AA[A-Za-z0-9_-]{32,34})\b/g, [':AA'], 'high'),
  vendor('sendgrid_key', 'SendGrid API key',
    /\b(SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g, ['SG.'], 'high'),
  vendor('twilio_key', 'Twilio account SID / key',
    /\b((?:AC|SK)[0-9a-f]{32})\b/g, ['AC', 'SK'], 'high'),
  vendor('mailgun_key', 'Mailgun API key',
    /\b(key-[0-9a-f]{32})\b/g, ['key-'], 'high'),
  vendor('mailchimp_key', 'Mailchimp API key',
    /\b([0-9a-f]{32}-us[0-9]{1,2})\b/g, ['-us'], 'high'),

  // ═══════════════════════════════════════════════════════ data & platform
  vendor('shopify_token', 'Shopify access token',
    /\b(shp(?:at|ss|ca|pa)_[0-9a-f]{32})\b/g, ['shpat_', 'shpss_', 'shpca_', 'shppa_']),
  vendor('databricks_token', 'Databricks token',
    /\b(dapi[0-9a-f]{32}(?:-[0-9]+)?)\b/g, ['dapi']),
  vendor('supabase_key', 'Supabase service key',
    /\b(sbp_[0-9a-f]{40})\b/g, ['sbp_']),
  vendor('planetscale_token', 'PlanetScale token',
    /\b(pscale_(?:tkn|pw|oauth)_[A-Za-z0-9_.-]{32,})\b/g, ['pscale_']),
  vendor('doppler_token', 'Doppler token',
    /\b(dp\.(?:pt|st|ct|sa|scim)\.[A-Za-z0-9]{40,})\b/g, ['dp.pt.', 'dp.st.', 'dp.ct.', 'dp.sa.']),
  vendor('notion_token', 'Notion integration token',
    /\b((?:secret_|ntn_)[A-Za-z0-9]{40,})\b/g, ['secret_', 'ntn_'], 'high'),
  vendor('figma_token', 'Figma personal access token',
    /\b(figd_[A-Za-z0-9_-]{40,})\b/g, ['figd_'], 'high'),
  vendor('linear_key', 'Linear API key',
    /\b(lin_api_[A-Za-z0-9]{40,})\b/g, ['lin_api_'], 'high'),
  vendor('atlassian_token', 'Atlassian API token',
    /\b(ATATT3[A-Za-z0-9_\-=]{180,})\b/g, ['ATATT3'], 'high'),
  vendor('dropbox_token', 'Dropbox access token',
    /\b(sl\.[A-Za-z0-9_-]{130,})\b/g, ['sl.'], 'high'),
  vendor('newrelic_key', 'New Relic API key',
    /\b(NRAK-[A-Z0-9]{27})\b/g, ['NRAK-'], 'high'),
  vendor('grafana_token', 'Grafana token',
    /\b(gl[cs]a?_[A-Za-z0-9_=-]{32,})\b/g, ['glc_', 'glsa_'], 'high'),
  vendor('sentry_token', 'Sentry auth token',
    /\b(sntrys_[A-Za-z0-9+/=]{50,}|sntryu_[0-9a-f]{64})\b/g, ['sntrys_', 'sntryu_'], 'high'),
  vendor('okta_token', 'Okta API token',
    /\b(00[A-Za-z0-9_-]{40})\b(?=[^A-Za-z0-9_-]*(?:okta|OKTA))/g, ['okta', 'OKTA'], 'critical',
    { confidence: 'likely' }),

  // ═════════════════════════════════════════════════════════ generic secrets
  {
    id: 'private_key_block',
    label: 'Private key block',
    severity: 'critical',
    confidence: 'certain',
    prefilter: ['PRIVATE KEY'],
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    enrich: (m) => ({ note: `${/OPENSSH/.test(m) ? 'An OpenSSH' : /PGP/.test(m) ? 'A PGP' : 'A'} private key, in full.` }),
  },
  {
    id: 'db_connection_string',
    label: 'Database URL with password',
    severity: 'critical',
    confidence: 'certain',
    prefilter: ['://'],
    // Only fires when credentials are actually embedded.
    pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|clickhouse|cassandra|neo4j|snowflake):\/\/[^\s:/@]+:[^\s@]+@[^\s/?#]+(?:\/[^\s?#]*)?(?:\?[^\s#]*)?/g,
    validate: (m) => !/:(?:password|pass|pwd|secret|xxx+|\*+|<[^>]*>|\$\{[^}]*\})@/i.test(m),
    enrich: (m) => ({ note: `${m.split('://')[0]} credentials, including the host.` }),
  },
  {
    id: 'jwt',
    label: 'JSON Web Token',
    severity: 'high',
    confidence: 'certain',
    prefilter: ['eyJ'],
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{0,}/g,
    validate: (m) => jwtHeader(m) !== null,
    enrich: (m) => {
      const header = jwtHeader(m);
      const payload = jwtPayload(m);
      const bits = [];
      // alg:none is a signature-bypass vulnerability, not merely a leak.
      if (header?.alg && /^none$/i.test(header.alg)) {
        bits.push('signed with alg:none — accepts any payload');
      }
      if (payload?.exp) bits.push(payload.exp * 1000 < Date.now() ? 'already expired' : 'still valid');
      for (const claim of ['email', 'preferred_username', 'name', 'sub']) {
        if (payload?.[claim]) { bits.push(`carries ${claim}`); break; }
      }
      if (payload?.iss) bits.push(`issued by ${String(payload.iss).slice(0, 40)}`);
      const severity = header?.alg && /^none$/i.test(header.alg) ? 'critical' : undefined;
      return bits.length ? { note: `Decoded: ${bits.join(', ')}.`, ...(severity && { severity }) } : {};
    },
  },
  {
    id: 'bearer_header',
    label: 'Authorization header',
    severity: 'high',
    confidence: 'likely',
    prefilter: ['uthorization'],
    pattern: /\b[Aa]uthorization\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{12,})/g,
    group: 1,
    validate: (m) => !isBenign(m, { placeholder: true }) && !isCodeIdentifier(m),
  },
  {
    id: 'high_entropy_assignment',
    label: 'Credential-shaped value',
    severity: 'medium',
    confidence: 'possible',
    // The catch-all for formats nobody has published: a secret-ish name on the
    // left of an assignment, and something genuinely random on the right.
    pattern: /(?:secret|passwd|password|pwd|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|auth[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-/+=.]{16,})["']?/gi,
    group: 1,
    validate: (m) => !isBenign(m, { placeholder: true }) && !isCodeIdentifier(m) && looksRandom(m, 3.2),
  },
  {
    id: 'unlabelled_secret',
    label: 'Unlabelled random value',
    severity: 'medium',
    confidence: 'possible',
    needs: { alnumRun: 32 },
    /**
     * The gap every keyword-anchored scanner has.
     *
     * Every other detector here fires on a prefix nobody else uses (AKIA,
     * ghp_, xoxb-) or on a credential word within reach. A token in a format
     * that did not exist when this shipped, pasted on its own line with
     * nothing around it to say what it is, matches none of them — and a
     * secret pasted without context is not less of a secret.
     *
     * The problem is that most long random-looking strings in real text are
     * supposed to be there: git SHAs, UUIDs, content hashes, digests, base64
     * images, minified code, nonces. So the bar is set by what a *secret*
     * looks like and a hash does not:
     *
     *   - all three character classes present, which excludes every hex
     *     digest, every git SHA and most base32
     *   - Shannon entropy at least 4.2, which excludes prose and identifiers
     *   - class transitions at least 0.3 per character. A random base62
     *     string changes class about 0.62 times a character; a long
     *     concatenated identifier almost never does
     *   - digits somewhere between a twelfth and three quarters of it
     *   - standing alone: not part of a path, a URL, a dotted name or a
     *     longer token
     *
     * It is `medium`, never `critical`. The honest statement is "this looks
     * like a key and nothing here says what it is", and that is a question
     * for the person, not a verdict.
     */
    //
    // `=` appears only as trailing padding, never inside the run. Allowing it
    // anywhere made `FOO_UNKNOWN_V2=<token>` match as one 55-character string
    // whose statistics are the key's diluted by the variable name — so the
    // token was reported when the name was short and missed when it was long.
    pattern: /(?<![A-Za-z0-9_\-/+.])([A-Za-z0-9_\-+/]{32,128}={0,2})(?![A-Za-z0-9_\-/+.])/g,
    group: 1,
    validate: (m, ctx) => {
      if (isBenign(m, { placeholder: true }) || isCodeIdentifier(m)) return false;
      // Hex of any length, not only digest lengths: a 48-character hex run is
      // a hash of something, not a credential.
      if (/^[0-9a-f]+$/i.test(m)) return false;
      // Subresource integrity carries its algorithm inside the token, so the
      // surrounding-words guard below never sees it.
      if (/^(?:sha(?:1|224|256|384|512)|md5)-/i.test(m)) return false;
      // An SSH *public* key is published on purpose. The wire format starts
      // with the algorithm name, base64-encoded, which is why they all begin
      // the same way.
      if (/^(?:AAAAB3NzaC1|AAAAC3NzaC1|AAAAE2VjZHNh|AAAAG25pc3Rw)/.test(m)) return false;
      // Mixing the two base64 alphabets means it is neither. It is a path:
      // /home/some_user/virt-images/packer-windows-2012-R2-standard.
      if (/[+/]/.test(m) && /[-_]/.test(m)) return false;
      // Hyphen-grouped identifiers: LVM uuids, licence keys, serial numbers.
      if (/^[A-Za-z0-9]{3,8}(?:-[A-Za-z0-9]{3,8}){3,}$/.test(m)) return false;

      if (!/[a-z]/.test(m) || !/[A-Z]/.test(m) || !/[0-9]/.test(m)) return false;
      // Only an upper bound on digits. A floor looked reasonable and was not:
      // a real forty-character base62 token carries two digits about one time
      // in fifty, and discarding those to catch nothing is a bad trade.
      if ((m.match(/[0-9]/g) || []).length / m.length > 0.75) return false;
      if (entropy(m) < 4.2) return false;
      if (classTransitions(m) < 0.3) return false;
      if (wordiness(m) >= 0.04) return false;
      // Base64 of a file or of readable text is an encoding, not a key.
      if (encodesKnownContent(m)) return false;

      // A value that already sits next to a credential word belongs to
      // high_entropy_assignment, which says something more specific about it.
      if (nearSecretWord(ctx.text, ctx.index, 48)) return false;

      const before = ctx.text.slice(Math.max(0, ctx.index - 48), ctx.index);
      if (/https?:\/\/\S*$/.test(before)) return false;
      // `h1:` is Go's module checksum prefix. Eleven go.sum files held two
      // thirds of everything this rule reported across 87,000 source files,
      // which is what a lockfile is: a page of content hashes.
      if (/(?:sha|md5|hash|digest|checksum|commit|revision|etag|nonce|integrity|sri|uuid|guid|fingerprint|\bh1)\W{0,4}$/i.test(before)) return false;
      if (/\b(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2\S*)\s*$/i.test(before)) return false;
      // The body of a PEM block is sixty-four base64 characters a line, and
      // private_key_block has already reported the whole thing. Saying it
      // again, once per line, is noise about a secret already named.
      if (insidePemBlock(ctx.text, ctx.index)) return false;

      // Finally: it has to have been *presented* as a value.
      //
      // Without this the rule fired 5,064 times on 87,000 real source files —
      // every embedded blob, every fixture, every argument to a function. A
      // secret someone pastes stands on its own line or sits on the right of
      // an assignment. A blob buried in an expression is somebody's data.
      return standsAsValue(ctx.text, ctx.index, m.length);
    },
    note: 'This looks like a key, and nothing around it says what it is. If it is one, it is still one.',
  },

  // ═══════════════════════════════════════════════════════════ India: identity
  {
    id: 'aadhaar',
    needs: { digitRun: 12 },
    label: 'Aadhaar number',
    severity: 'critical',
    confidence: 'certain',
    pattern: /\b([2-9]\d{3}[ -]?\d{4}[ -]?\d{4})\b/g,
    /**
     * Verhoeff accepts about one random twelve-digit number in ten, and this
     * rule fires at critical severity, so everything it wrongly reports stops
     * somebody mid-sentence. Scanning 87,000 real source files found 135, and
     * all of them fell into four shapes:
     *
     *   11111111-2222-3333-4444-555555555555   the middle of a UUID
     *   276.987855073372                        a coordinate's decimals
     *   arn:aws:iam::444455556666:role/example  an AWS account id, also 12
     *   202202081414.00                         a timestamp
     *
     * Four guards, in the order they are cheapest to check. The distinct-digit
     * floor is the one that does most of the work: a test fixture reaches for
     * 4444-5555-6666, and a real Aadhaar drawn from a random twelve-digit
     * space has four or fewer distinct digits about once in ten thousand.
     */
    validate: (m, ctx) => {
      const digits = m.replace(/[^0-9]/g, '');
      if (new Set(digits).size < 5) return false;

      const before = ctx.text.slice(Math.max(0, ctx.index - 64), ctx.index);
      const after = ctx.text.slice(ctx.index + m.length, ctx.index + m.length + 8);
      // Inside a UUID, or on either side of a decimal point.
      if (/[0-9a-fA-F]-$/.test(before) || /^-[0-9a-fA-F]/.test(after)) return false;
      if (/[.]$/.test(before) || /^\.\d/.test(after)) return false;
      // An AWS account number is exactly twelve digits too, and says so.
      if (/\barn:|\baws\b|account[ _-]?(?:id|number)/i.test(before)) return false;
      return aadhaar(m);
    },
    note: 'Sensitive personal data under the DPDP Act, 2023.',
  },
  {
    id: 'pan_india',
    needs: { upperRun: 5, alnumRun: 10 },
    label: 'Indian PAN',
    severity: 'high',
    confidence: 'likely',
    pattern: /\b([A-Z]{5}[0-9]{4}[A-Z])\b/g,
    validate: (m) => pan(m),
  },
  {
    id: 'gstin',
    needs: { alnumRun: 15, digitRun: 2 },
    label: 'GSTIN',
    severity: 'medium',
    confidence: 'certain',
    pattern: /\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/g,
    validate: (m) => gstin(m),
    note: 'Check character verified mod 36.',
  },
  {
    id: 'ifsc',
    needs: { upperRun: 4, alnumRun: 11 },
    label: 'IFSC code',
    severity: 'low',
    confidence: 'likely',
    pattern: /\b([A-Z]{4}0[A-Z0-9]{6})\b/g,
    validate: (m) => ifsc(m),
  },
  {
    id: 'upi_vpa',
    label: 'UPI ID',
    severity: 'medium',
    confidence: 'certain',
    prefilter: ['@'],
    pattern: /\b([a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,32})\b/g,
    validate: (m) => upiVpa(m),
  },
  {
    id: 'indian_passport',
    needs: { digitRun: 7 },
    label: 'Indian passport number',
    severity: 'high',
    confidence: 'possible',
    pattern: /\b([A-PR-WY][0-9]{7})\b/g,
    validate: (m, ctx) => indianPassport(m) && /passport/i.test(ctx.text.slice(Math.max(0, ctx.index - 40), ctx.index + 40)),
  },
  {
    id: 'voter_id',
    needs: { upperRun: 3, alnumRun: 10 },
    label: 'Voter ID (EPIC)',
    severity: 'medium',
    confidence: 'possible',
    pattern: /\b([A-Z]{3}[0-9]{7})\b/g,
    validate: (m, ctx) => voterId(m) && /(?:voter|epic|election)/i.test(ctx.text.slice(Math.max(0, ctx.index - 40), ctx.index + 40)),
  },
  {
    id: 'indian_dl',
    needs: { upperRun: 2, digitRun: 6 },
    label: 'Indian driving licence',
    severity: 'medium',
    confidence: 'likely',
    pattern: /\b([A-Z]{2}[0-9]{2}[ -]?[0-9]{4}[0-9]{7})\b/g,
    validate: (m) => indianDrivingLicence(m),
  },

  // ════════════════════════════════════════════════════ global identity
  {
    id: 'payment_card',
    needs: { digitRun: 13 },
    label: 'Payment card number',
    severity: 'critical',
    confidence: 'certain',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    // Luhn alone accepts ~1 in 10 random numbers of the right length, which is
    // how IMEIs and order numbers get reported as cards. The issuer range is
    // what makes this detector trustworthy.
    // No benign-shape guard here on purpose: the repetition guard suppressed
    // real card numbers with repeating digits, 4242424242424242 among them.
    //
    // Instead, the match must be a WHOLE number. Scanning real source found a
    // formatting test fixture — "123 456 789 123 456 789 ..." — yielding a
    // fifteen-digit window that began with 34 and passed Luhn by chance. A
    // card is bounded; a slice of a longer digit stream is not one.
    validate: (m, ctx) => {
      if (!luhn(m) || cardIssuer(m) === null) return false;
      //
      // The guard also has to treat a decimal point as a digit. Scanning
      // Django's GIS fixtures found ninety-six "cards" that were the
      // fractional part of a latitude: -0.6358599286615808 contains sixteen
      // digits that pass Luhn and start with 6, which is a Discover range.
      // \b does not help, because '.' is not a word character.
      // The guard also has to treat a decimal point as part of a number —
      // but only when it *is* one. Django's GIS fixtures produced ninety-six
      // "cards" that were the fractional part of a latitude
      // (-0.6358599286615808 holds sixteen digits that pass Luhn and start in
      // a Discover range), and \b does not help because '.' is not a word
      // character. A full stop at the end of a sentence is not a decimal
      // point, so the digit on the far side is what decides.
      const before = ctx.text.slice(Math.max(0, ctx.index - 4), ctx.index);
      const after = ctx.text.slice(ctx.index + m.length, ctx.index + m.length + 4);
      if (/\d[ -]?$/.test(before)) return false;
      if (/^[ -]?\d/.test(after)) return false;
      if (/\d\.$/.test(before)) return false;
      if (/^\.\d/.test(after)) return false;
      return true;
    },
    enrich: (m) => ({ note: `${cardIssuer(m)}, passes Luhn and a live issuer range.` }),
  },
  {
    id: 'iban',
    needs: { upperRun: 2, alnumRun: 4 },
    label: 'IBAN',
    severity: 'high',
    confidence: 'certain',
    pattern: /\b([A-Z]{2}[0-9]{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4})\b/g,
    validate: (m) => iban(m),
  },
  {
    id: 'us_ssn',
    needs: { digitRun: 9 },
    label: 'US Social Security number',
    severity: 'critical',
    confidence: 'likely',
    pattern: /\b(\d{3}-\d{2}-\d{4})\b/g,
    validate: (m) => ssn(m),
  },
  {
    id: 'canada_sin',
    needs: { digitRun: 9 },
    label: 'Canadian SIN',
    severity: 'critical',
    confidence: 'likely',
    pattern: /\b(\d{3}[ -]?\d{3}[ -]?\d{3})\b/g,
    validate: (m, ctx) => sin(m) && /(?:\bsin\b|social insurance)/i.test(ctx.text.slice(Math.max(0, ctx.index - 40), ctx.index + 20)),
  },
  {
    id: 'uk_nino',
    needs: { upperRun: 2, digitRun: 6 },
    label: 'UK National Insurance number',
    severity: 'critical',
    confidence: 'likely',
    pattern: /\b([A-CEGHJ-PR-TW-Z]{2}[ ]?[0-9]{2}[ ]?[0-9]{2}[ ]?[0-9]{2}[ ]?[A-D])\b/g,
    validate: (m) => nino(m),
  },
  {
    id: 'brazil_cpf',
    needs: { digitRun: 11 },
    label: 'Brazilian CPF',
    severity: 'critical',
    confidence: 'certain',
    pattern: /\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/g,
    validate: (m) => cpf(m),
  },
  {
    id: 'brazil_cnpj',
    needs: { digitRun: 14 },
    label: 'Brazilian CNPJ',
    severity: 'medium',
    confidence: 'certain',
    pattern: /\b(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/g,
    validate: (m) => cnpj(m),
  },
  {
    id: 'australia_abn',
    needs: { digitRun: 11 },
    label: 'Australian Business Number',
    severity: 'low',
    confidence: 'certain',
    pattern: /\b(\d{2}[ ]?\d{3}[ ]?\d{3}[ ]?\d{3})\b/g,
    validate: (m, ctx) => abn(m) && /abn/i.test(ctx.text.slice(Math.max(0, ctx.index - 30), ctx.index + 10)),
  },
  {
    id: 'australia_tfn',
    needs: { digitRun: 9 },
    label: 'Australian Tax File Number',
    severity: 'critical',
    confidence: 'likely',
    pattern: /\b(\d{3}[ ]?\d{3}[ ]?\d{3})\b/g,
    validate: (m, ctx) => tfn(m) && /(?:\btfn\b|tax file)/i.test(ctx.text.slice(Math.max(0, ctx.index - 30), ctx.index + 10)),
  },
  {
    id: 'eu_vat',
    needs: { upperRun: 2, alnumRun: 11 },
    label: 'EU VAT number',
    severity: 'low',
    confidence: 'certain',
    prefilter: ['DE', 'NL', 'IT'],
    pattern: /\b((?:DE|NL|IT)[0-9A-Z]{9,14})\b/g,
    validate: (m) => euVat(m),
  },
  {
    id: 'isin',
    needs: { upperRun: 2, alnumRun: 12 },
    label: 'ISIN (security identifier)',
    severity: 'low',
    confidence: 'certain',
    pattern: /\b([A-Z]{2}[A-Z0-9]{9}[0-9])\b/g,
    /**
     * The check digit alone is not enough: any twelve-character uppercase
     * alphanumeric run has a one-in-ten chance of passing it, and the last
     * group of an uppercase UUID is exactly twelve characters. Every one of
     * the twenty-one found in real source was of the form
     * {4724A46A-3F20-5AAA-8180-CBD31D08E478} — a Sitecore item id.
     *
     * An ISIN begins with an ISO 3166-1 alpha-2 country code (or one of the
     * reserved X-codes for supranational issues). "CB" and "DA" are not
     * countries, which settles both cases without touching a real ISIN.
     */
    validate: (m, ctx) => {
      if (!ISIN_PREFIX.has(m.slice(0, 2))) return false;
      const before = ctx.text.slice(Math.max(0, ctx.index - 2), ctx.index);
      if (/[0-9A-Fa-f]-$/.test(before)) return false;
      return isin(m);
    },
  },
  {
    id: 'imei',
    needs: { digitRun: 15 },
    label: 'IMEI',
    severity: 'medium',
    confidence: 'likely',
    pattern: /\b(\d{15})\b/g,
    validate: (m, ctx) => imei(m) && /imei/i.test(ctx.text.slice(Math.max(0, ctx.index - 30), ctx.index + 10)),
  },
  {
    id: 'email',
    label: 'Email address',
    severity: 'low',
    confidence: 'certain',
    prefilter: ['@'],
    pattern: /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    validate: (m) => !/@(?:example|test|localhost|invalid|domain|email|yourcompany|acme)\.(?:com|org|net|co)$/i.test(m),
  },
  {
    id: 'phone_india',
    needs: { digitRun: 10 },
    label: 'Indian mobile number',
    severity: 'low',
    confidence: 'likely',
    pattern: /(\+?91[ -]?)?\b([6-9]\d{4}[ -]?\d{5})\b/g,
    group: 2,
    /**
     * A bare ten-digit number is not a phone number. Scanning real source
     * found 411 matches in a single test fixture full of arbitrary integers.
     * It counts only with a country code, a separator, or a word nearby that
     * says what it is.
     */
    validate: (m, ctx) => {
      if (isBenign(m, { hex: false })) return false;
      if (/^\+?91/.test(ctx.full)) return true;
      if (/[ -]/.test(m)) return true;
      const around = ctx.text.slice(Math.max(0, ctx.index - 48), ctx.index + m.length + 24);
      return /\b(?:phone|mobile|cell|contact|call|whats ?app|tel|number|reach|sms)\b/i.test(around);
    },
  },
];

// Context signals run through the same pipeline so they inherit policy,
// overlap resolution, masking and the UI — but they carry `advisory: true`,
// which redaction honours by leaving them in place.
RULES.push(...CONTEXT_RULES);

/**
 * Names and addresses are produced by src/ner.js, not by a pattern. They are
 * registered here so they inherit categories, proofs, policy and the settings
 * UI; `synthetic: true` tells the scanner not to run them as regexes.
 */
RULES.push(
  { id: 'person_name', label: 'Person name', severity: 'medium', confidence: 'possible',
    synthetic: true, pattern: /(?!)/g,
    note: 'Personal data under GDPR and the DPDP Act when it identifies someone.' },
  { id: 'postal_address', label: 'Postal address', severity: 'high', confidence: 'likely',
    synthetic: true, pattern: /(?!)/g },
  { id: 'prompt_injection', label: 'Instructions aimed at the assistant', severity: 'critical',
    confidence: 'likely', synthetic: true, advisory: true, pattern: /(?!)/g,
    note: 'Indirect prompt injection: OWASP LLM01.' },
);

export const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/** Grouping, for the settings UI only. Kept out of the rule objects. */
export const CATEGORIES = [
  { id: 'cloud', label: 'Cloud providers', ids: ['aws_access_key_id', 'aws_secret_access_key', 'gcp_service_account', 'google_api_key', 'google_oauth_client', 'azure_storage_key', 'digitalocean_token', 'cloudflare_token'] },
  { id: 'source', label: 'Source & packages', ids: ['github_token', 'github_pat_fine_grained', 'gitlab_token', 'npm_token', 'pypi_token', 'rubygems_token', 'terraform_token', 'jfrog_token', 'sonarqube_token'] },
  { id: 'ai', label: 'AI providers', ids: ['openai_key', 'anthropic_key', 'openrouter_key', 'groq_key', 'xai_key', 'replicate_key', 'huggingface_token', 'perplexity_key', 'fireworks_key', 'langsmith_key'] },
  { id: 'payments', label: 'Payments', ids: ['stripe_live_key', 'stripe_test_key', 'square_token', 'razorpay_key', 'paypal_token'] },
  { id: 'comms', label: 'Communications', ids: ['slack_token', 'slack_webhook', 'discord_bot_token', 'telegram_bot_token', 'sendgrid_key', 'twilio_key', 'mailgun_key', 'mailchimp_key'] },
  { id: 'platform', label: 'Data & platform', ids: ['shopify_token', 'databricks_token', 'supabase_key', 'planetscale_token', 'doppler_token', 'notion_token', 'figma_token', 'linear_key', 'atlassian_token', 'dropbox_token', 'newrelic_key', 'grafana_token', 'sentry_token', 'okta_token'] },
  { id: 'generic', label: 'Generic secrets', ids: ['private_key_block', 'db_connection_string', 'jwt', 'bearer_header', 'high_entropy_assignment', 'unlabelled_secret'] },
  { id: 'india', label: 'India — identity', ids: ['aadhaar', 'pan_india', 'gstin', 'ifsc', 'upi_vpa', 'indian_passport', 'voter_id', 'indian_dl', 'phone_india'] },
  CONTEXT_CATEGORY,
  { id: 'prose', label: 'Names & addresses in prose', ids: ['person_name', 'postal_address'] },
  { id: 'injection', label: 'Prompt injection', ids: ['prompt_injection'] },
  { id: 'global', label: 'Global — identity', ids: ['payment_card', 'iban', 'us_ssn', 'canada_sin', 'uk_nino', 'brazil_cpf', 'brazil_cnpj', 'australia_abn', 'australia_tfn', 'eu_vat', 'isin', 'imei', 'email'] },
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
 * Deliberately narrower than "has a validate function". Excluding example.com
 * from the email rule is a filter, not a proof; recomputing a Verhoeff check
 * digit is. This is the honest version of the claim the project makes about
 * itself, so it is written down rather than inferred — and `bench/` measures it.
 */
export const PROOFS = {
  person_name: 'a character-n-gram classifier trained on 30,675 names from 75 locales, combined with structural context',
  postal_address: 'structural \u2014 a house number or postcode plus a street or unit component',
  prompt_injection: 'weighted signals: override imperatives, role reassignment, exfiltration requests, CSS-hidden text and invisible Unicode channels',
  aws_access_key_id: 'base32 decode recovers the AWS account number from the key itself',
  aws_secret_access_key: 'Shannon entropy \u2265 4.2, a credential word within 48 characters, and not a hex digest',
  github_token: "CRC32 checksum carried in the token's own last 6 characters",
  jwt: 'base64-decodes to a JOSE header; the payload is read for alg:none, expiry and claims',
  db_connection_string: 'credentials must be present in the URL and must not be a placeholder',
  high_entropy_assignment: 'Shannon entropy, with documentation placeholders and benign shapes excluded',
  unlabelled_secret: 'Shannon entropy ≥ 4.2, all three character classes, ≥ 0.3 class transitions per character, and not a digest, UUID, encoding or PEM body',
  payment_card: 'Luhn mod-10, plus issuer-range brand identification',
  aadhaar: 'Verhoeff check digit, plus the reserved first-digit rules',
  gstin: 'mod-36 check character and a valid state code',
  pan_india: 'structural \u2014 the holder-type character must be a real code',
  iban: 'mod-97',
  us_ssn: 'never-issued area, group and serial ranges',
  canada_sin: 'Luhn, plus a required context word',
  uk_nino: 'published prefix exclusions',
  brazil_cpf: 'two mod-11 check digits',
  brazil_cnpj: 'two mod-11 check digits with cycling weights',
  australia_abn: 'weighted mod 89',
  australia_tfn: 'weighted mod 11, plus a required context word',
  eu_vat: 'the issuing state\u2019s published check-digit algorithm',
  isin: 'Luhn over letter-expanded ordinals',
  imei: 'Luhn, plus a required context word',
  upi_vpa: 'the handle must be one a real payment service provider issues',
  ifsc: 'structural \u2014 the reserved fifth character must be zero',
  indian_dl: 'structural, with the issue year bounded to a plausible range',
};

for (const [id, proof] of Object.entries(PROOFS)) {
  const rule = RULES_BY_ID.get(id);
  if (rule) rule.proof = proof;
}

export { entropy, nearSecretWord };

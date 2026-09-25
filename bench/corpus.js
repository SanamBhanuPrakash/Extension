/**
 * The labelled corpus.
 *
 * Cases are generated from a seeded RNG rather than hard-coded, for two
 * reasons: the lengths are then guaranteed to match each detector's contract
 * instead of being miscounted by hand, and no real credential is ever
 * committed to this repository.
 *
 * Identity positives are produced by generating a random body and brute-forcing
 * the check digit until the *validator itself* accepts it. That keeps the
 * corpus honest — a sample is valid because the published algorithm says so,
 * not because the author asserted it.
 */
import { makeRng, withLuhn } from './random.js';
import {
  gstin, cpf, cnpj, sin, nino, abn, tfn, isin, imei, euVat, ifsc,
  indianDrivingLicence,
} from '../src/identifiers.js';
import { aadhaar, luhn, iban, pan, ssn, cardIssuer } from '../src/checksums.js';

/** Regenerates until the predicate holds, so a negative is genuinely negative. */
function until(make, ok, tries = 200) {
  for (let i = 0; i < tries; i++) { const v = make(); if (ok(v)) return v; }
  return make();
}

/** Appends whichever suffix character makes `validate` accept. */
function completing(body, alphabet, validate, suffixLen = 1) {
  const chars = alphabet.split('');
  if (suffixLen === 1) {
    for (const c of chars) if (validate(body + c)) return body + c;
    return null;
  }
  for (const a of chars) for (const b of chars) {
    if (validate(body + a + b)) return body + a + b;
  }
  return null;
}

const DIGITS = '0123456789';
const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** One valid sample for every credential detector. */
function vendorSamples(r) {
  return [
    ['aws_access_key_id', () => 'AKIA' + r.base32(16)],
    ['aws_access_key_id', () => 'ASIA' + r.base32(16)],
    ['gcp_service_account', () => '{"type": "service_account", "project_id": "billing-prod"}'],
    ['aws_secret_access_key', () => 'aws_secret_access_key = ' + r.alnum(20) + '/' + r.alnum(9) + '+' + r.alnum(9)],
    ['google_api_key', () => 'AIza' + r.alnum(35)],
    ['google_oauth_client', () => r.digits(12) + '-' + (r.lower(20) + r.digits(12)) + '.apps.googleusercontent.com'],
    ['azure_storage_key', () => 'AccountKey=' + r.alnum(86) + '=='],
    ['digitalocean_token', () => 'dop_v1_' + r.hex(64)],
    ['github_token', () => 'ghp_' + r.alnum(36)],
    ['github_pat_fine_grained', () => 'github_pat_' + r.alnum(22) + '_' + r.alnum(59)],
    ['gitlab_token', () => 'glpat-' + r.alnum(20)],
    ['npm_token', () => 'npm_' + r.alnum(36)],
    ['pypi_token', () => 'pypi-AgEIcHlwaS5vcmc' + r.alnum(60)],
    ['rubygems_token', () => 'rubygems_' + r.hex(48)],
    ['terraform_token', () => r.alnum(14) + '.atlasv1.' + r.alnum(60)],
    ['jfrog_token', () => 'cmVmdGtuOjAxO' + r.alnum(40)],
    ['sonarqube_token', () => 'sqp_' + r.hex(40)],
    ['openai_key', () => 'sk-proj-' + r.alnum(48)],
    ['anthropic_key', () => 'sk-ant-api03-' + r.alnum(40)],
    ['openrouter_key', () => 'sk-or-v1-' + r.hex(64)],
    ['groq_key', () => 'gsk_' + r.alnum(52)],
    ['xai_key', () => 'xai-' + r.alnum(80)],
    ['replicate_key', () => 'r8_' + r.alnum(37)],
    ['huggingface_token', () => 'hf_' + r.alnum(34)],
    ['perplexity_key', () => 'pplx-' + r.alnum(32)],
    ['fireworks_key', () => 'fw_' + r.alnum(24)],
    ['langsmith_key', () => 'lsv2_pt_' + r.hex(32) + '_' + r.hex(10)],
    ['stripe_live_key', () => 'sk_live_' + r.alnum(24)],
    ['square_token', () => 'EAAA' + r.alnum(60)],
    ['razorpay_key', () => 'rzp_live_' + r.alnum(14)],
    ['paypal_token', () => 'access_token$production$' + r.lower(16) + '$' + r.hex(32)],
    ['slack_token', () => 'xoxb-' + r.digits(12) + '-' + r.digits(12) + '-' + r.alnum(24)],
    ['slack_webhook', () => 'https://hooks.slack.com/services/T' + r.alnum(10) + '/B' + r.alnum(10) + '/' + r.alnum(24)],
    ['telegram_bot_token', () => r.digits(10) + ':AA' + r.alnum(32)],
    ['sendgrid_key', () => 'SG.' + r.alnum(22) + '.' + r.alnum(43)],
    ['twilio_key', () => 'AC' + r.hex(32)],
    ['mailgun_key', () => 'key-' + r.hex(32)],
    ['mailchimp_key', () => r.hex(32) + '-us' + r.digits(2)],
    ['shopify_token', () => 'shpat_' + r.hex(32)],
    ['databricks_token', () => 'dapi' + r.hex(32)],
    ['supabase_key', () => 'sbp_' + r.hex(40)],
    ['planetscale_token', () => 'pscale_tkn_' + r.alnum(32)],
    ['doppler_token', () => 'dp.pt.' + r.alnum(40)],
    ['notion_token', () => 'ntn_' + r.alnum(46)],
    ['figma_token', () => 'figd_' + r.alnum(40)],
    ['linear_key', () => 'lin_api_' + r.alnum(40)],
    ['atlassian_token', () => 'ATATT3' + r.alnum(185)],
    ['dropbox_token', () => 'sl.' + r.alnum(135)],
    ['newrelic_key', () => 'NRAK-' + r.upper(20) + r.digits(7)],
    ['grafana_token', () => 'glc_' + r.alnum(40)],
    ['sentry_token', () => 'sntrys_' + r.alnum(55)],
    ['private_key_block', () => '-----BEGIN RSA PRIVATE KEY-----\n' + r.alnum(64) + '\n-----END RSA PRIVATE KEY-----'],
  ];
}

/** Identity positives, each completed until its own validator accepts. */
function identitySamples(r) {
  const out = [];
  const push = (id, value) => { if (value) out.push([id, value]); };

  for (let i = 0; i < 6; i++) {
    push('payment_card', withLuhn('4' + r.digits(14)));
    push('payment_card', withLuhn('5' + String(1 + r.int(5)) + r.digits(13)));
    push('aadhaar', completing(String(2 + r.int(8)) + r.digits(10), DIGITS, aadhaar));
    push('gstin', completing(
      String(1 + r.int(9)).padStart(2, '0') + r.upper(5) + r.digits(4) + r.upper(1) + '1Z',
      B36, gstin));
    push('brazil_cpf', completing(r.digits(9), DIGITS, cpf, 2));
    push('brazil_cnpj', completing(r.digits(12), DIGITS, cnpj, 2));
    push('isin', completing('US' + r.upper(4) + r.digits(5), DIGITS, isin));
    push('iban', completing('GB' + r.digits(2) + 'WEST' + r.digits(12), '', (v) => iban(v), 0) || null);
  }
  // IBAN needs its check digits in the middle, so build it directly.
  for (let i = 0; i < 4; i++) {
    const body = 'WEST' + r.digits(14);
    const found = completing('GB', DIGITS, (p) => iban(p + body), 2);
    if (found) push('iban', found + body);
  }
  for (let i = 0; i < 4; i++) {
    push('us_ssn', (() => {
      const a = String(100 + r.int(565)).padStart(3, '0');
      const g = String(1 + r.int(98)).padStart(2, '0');
      const s = String(1 + r.int(9998)).padStart(4, '0');
      const v = `${a}-${g}-${s}`;
      return ssn(v) ? v : null;
    })());
    push('pan_india', (() => {
      const v = r.upper(3) + r.pick(['A', 'B', 'C', 'F', 'G', 'H', 'J', 'L', 'P', 'T']) + r.upper(1) + r.digits(4) + r.upper(1);
      return pan(v) ? v : null;
    })());
    push('uk_nino', (() => {
      const v = 'AB' + r.digits(6) + r.pick(['A', 'B', 'C', 'D']);
      return nino(v) ? v : null;
    })());
    push('ifsc', (() => { const v = r.upper(4) + '0' + r.alnum(6).toUpperCase(); return ifsc(v) ? v : null; })());
    push('indian_dl', (() => {
      const v = r.upper(2) + String(1 + r.int(98)).padStart(2, '0') + String(1995 + r.int(29)) + r.digits(7);
      return indianDrivingLicence(v) ? v : null;
    })());
    push('phone_india', String(6 + r.int(4)) + r.digits(9));
    push('upi_vpa', r.lower(8) + '@' + r.pick(['okhdfcbank', 'okicici', 'ybl', 'paytm', 'oksbi']));
  }
  // Context-gated identity rules carry their required word in the wrapper.
  for (let i = 0; i < 3; i++) {
    push('canada_sin', completing(r.digits(8), DIGITS, sin));
    push('australia_abn', completing(r.digits(10), DIGITS, abn));
    push('australia_tfn', completing(r.digits(8), DIGITS, tfn));
    push('imei', completing(r.digits(14), DIGITS, imei));
    push('eu_vat', completing('DE' + r.digits(8), DIGITS, euVat));
  }
  return out;
}

/** Sentences that put a credential where one really appears. */
const WRAPPERS = [
  (v) => `Here's the config: ${v}`,
  (v) => `export TOKEN=${v}`,
  (v) => `curl -H "X-Key: ${v}" https://api.internal/v1/health`,
  (v) => `it fails with ${v} but works locally`,
  (v) => `  value: "${v}"`,
  (v) => `${v}`,
];

/** Context words the gated identity rules require. */
const CONTEXT = {
  canada_sin: (v) => `employee SIN ${v} on file`,
  australia_abn: (v) => `supplier ABN ${v}`,
  australia_tfn: (v) => `TFN ${v} for payroll`,
  imei: (v) => `device IMEI ${v} reported lost`,
  indian_passport: (v) => `passport number ${v}`,
  voter_id: (v) => `voter EPIC ${v}`,
  okta_token: (v) => `okta token ${v}`,
  cloudflare_token: (v) => `${v} cloudflare`,
};

/**
 * Hard negatives: the high-entropy strings that are *supposed* to be in your
 * text. This is where published precision figures of 25–75% come from.
 */
function hardNegatives(r) {
  const cases = [];
  const add = (text, why) => cases.push({ text, expect: [], why });

  for (let i = 0; i < 12; i++) {
    add(`commit ${r.hex(40)} authored by the release bot`, 'git SHA');
    add(`sha256:${r.hex(64)}`, 'content digest');
    add(`etag: "${r.hex(32)}"`, 'md5 etag');
    add(`request id ${r.hex(8)}-${r.hex(4)}-4${r.hex(3)}-a${r.hex(3)}-${r.hex(12)}`, 'UUID');
    add(`ts=${1600000000000 + r.int(200000000000)}`, 'epoch milliseconds');
    add(`order ${until(() => r.digits(16), (v) => !luhn(v))} shipped`, 'order number failing Luhn');
    add(`invoice total reference ${until(() => r.digits(12), (v) => !aadhaar(v))}`, '12 digits failing Verhoeff');
    add(`device count ${until(() => withLuhn(r.digits(15)), (v) => !cardIssuer(v))}`, 'passes Luhn, no issuer range');
    add(`build ${r.digits(2)}.${r.digits(1)}.${r.digits(2)} released`, 'semver');
    add(`peer at 10.${r.int(255)}.${r.int(255)}.${r.int(255)}:8443`, 'IP and port');
    add(`mac ${r.hex(2)}:${r.hex(2)}:${r.hex(2)}:${r.hex(2)}:${r.hex(2)}:${r.hex(2)}`, 'MAC address');
    add(`tracking 1Z${r.alnum(16).toUpperCase()}`, 'parcel tracking');
    add(`GSTIN ${until(() => r.digits(2) + r.upper(5) + r.digits(4) + r.upper(1) + '1Z' + r.upper(1), (v) => !gstin(v))}`, 'GSTIN-shaped, bad check character');
    add(`CPF ${until(() => r.digits(11), (v) => !cpf(v))}`, 'CPF-shaped, bad check digits');
  }

  // Documentation and placeholder credentials, which every scanner trips on.
  for (const t of [
    'export API_KEY=your-api-key-here',
    'password: changeme',
    'token = "<REDACTED>"',
    'client_secret: ${CLIENT_SECRET}',
    'AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'set DATABASE_URL=postgres://user:password@localhost:5432/dev',
    'apiKey: "TODO-replace-before-launch"',
    'Authorization: Bearer <your token here>',
  ]) add(t, 'documentation placeholder');

  // Ordinary technical prose that mentions credentials without containing one.
  for (const t of [
    `TypeError: Cannot read properties of undefined (reading 'map')\n    at Object.render (/srv/app/src/pages/Dashboard.tsx:142:18)`,
    'The password reset email never arrives for users on the enterprise plan.',
    'We rotate the API key monthly and store it in the secret manager.',
    'npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree',
    'SELECT id, email FROM users WHERE created_at > now() - interval \'7 days\';',
    'Our auth token expires after 3600 seconds, then the refresh flow kicks in.',
    'kubectl get pods -n production --field-selector status.phase=Running',
  ]) add(t, 'prose about credentials, containing none');

  return cases;
}

export function buildCorpus(seed = 20260925) {
  const r = makeRng(seed);
  const cases = [];
  let n = 0;

  for (const [id, make] of vendorSamples(r)) {
    // Each credential appears in several surroundings, since context changes
    // what the surrounding rules see.
    for (const wrap of WRAPPERS.slice(0, 3)) {
      const value = make();
      const text = (CONTEXT[id] || wrap)(value);
      cases.push({ id: `pos-${n++}`, text, expect: [id], why: `${id} positive` });
    }
  }

  for (const [id, value] of identitySamples(r)) {
    const text = (CONTEXT[id] || WRAPPERS[r.int(WRAPPERS.length)])(value);
    cases.push({ id: `pos-${n++}`, text, expect: [id], why: `${id} positive` });
  }

  for (const c of hardNegatives(r)) {
    cases.push({ id: `neg-${n++}`, ...c });
  }

  return cases;
}

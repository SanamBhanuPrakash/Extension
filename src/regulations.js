/**
 * Which law this touches.
 *
 * A security engineer reads "Aadhaar number" and knows what it means. A
 * founder, a recruiter and a finance lead do not — but every one of them knows
 * what "sensitive personal data under the DPDP Act" means, because it is the
 * thing their compliance training was about.
 *
 * This maps findings to the regime that governs them. It is a translation
 * layer, not legal advice, and the wording throughout says so. Naming the
 * regime is what makes a warning actionable for the person who has to answer
 * for it — which, in most organisations, is not the person doing the pasting.
 */

const G = (article, what) => ({ regime: 'GDPR', ref: article, what });
const D = (section, what) => ({ regime: 'DPDP Act 2023', ref: section, what });

/** rule id -> the regimes that treat it as regulated data. */
export const REGIME_MAP = {
  // Identity
  email: [G('Art. 4(1)', 'personal data'), D('S. 2(t)', 'personal data')],
  phone_india: [G('Art. 4(1)', 'personal data'), D('S. 2(t)', 'personal data')],
  aadhaar: [
    D('S. 2(t) + Aadhaar Act S. 29', 'identity information; sharing is restricted by statute'),
    G('Art. 87', 'national identification number'),
  ],
  pan_india: [D('S. 2(t)', 'personal data'), { regime: 'Income Tax Act', ref: 'S. 139A', what: 'taxpayer identifier' }],
  gstin: [{ regime: 'GST Act', ref: 'S. 25', what: 'business tax registration' }],
  us_ssn: [
    { regime: 'US state breach laws', ref: 'e.g. CA Civ. Code 1798.82', what: 'notification trigger on disclosure' },
    { regime: 'GLBA', ref: 'Safeguards Rule', what: 'customer information' },
  ],
  uk_nino: [G('Art. 87', 'national identification number')],
  canada_sin: [{ regime: 'PIPEDA', ref: 'Sch. 1 4.3', what: 'sensitive identifier' }],
  brazil_cpf: [{ regime: 'LGPD', ref: 'Art. 5(I)', what: 'personal data' }],
  indian_passport: [D('S. 2(t)', 'personal data')],
  voter_id: [D('S. 2(t)', 'personal data')],
  indian_dl: [D('S. 2(t)', 'personal data')],

  person_name: [G('Art. 4(1)', 'personal data'), D('S. 2(t)', 'personal data')],
  postal_address: [G('Art. 4(1)', 'personal data'), D('S. 2(t)', 'personal data')],

  // Payment
  payment_card: [
    { regime: 'PCI DSS v4.0', ref: 'Req. 3.3', what: 'primary account number — storage and transmission are controlled' },
    G('Art. 4(1)', 'personal data'),
  ],
  iban: [G('Art. 4(1)', 'financial personal data')],
  upi_vpa: [D('S. 2(t)', 'payment identifier'), { regime: 'RBI', ref: 'Master Direction on Digital Payment Security', what: 'payment data' }],

  // Health
  health_information: [
    G('Art. 9(1)', 'special category data — processing generally prohibited without an Art. 9(2) basis'),
    { regime: 'HIPAA', ref: '45 CFR 164.502', what: 'protected health information' },
    D('S. 2(t)', 'personal data; health data attracts heightened duties'),
  ],

  // Business and market conduct
  mnpi: [
    { regime: 'SEC', ref: 'Reg FD / Rule 10b5-1', what: 'selective disclosure of material non-public information' },
    { regime: 'SEBI', ref: 'PIT Regulations 2015, Reg. 3', what: 'unpublished price sensitive information' },
    { regime: 'UK MAR', ref: 'Art. 10', what: 'unlawful disclosure of inside information' },
  ],
  legal_privilege: [{ regime: 'Legal privilege', ref: 'common law', what: 'disclosure to a third party can waive it' }],
  compensation_data: [G('Art. 4(1)', 'personal data about identifiable employees'), D('S. 2(t)', 'personal data')],
  deal_material: [{ regime: 'Contract', ref: 'NDA / confidentiality undertaking', what: 'typically restricted to named recipients' }],

  // Credentials
  aws_access_key_id: [{ regime: 'SOC 2 / ISO 27001', ref: 'A.9 access control', what: 'credential disclosure is a reportable control failure' }],
  private_key_block: [{ regime: 'SOC 2 / ISO 27001', ref: 'A.10 cryptography', what: 'key material disclosure' }],
  db_connection_string: [{ regime: 'SOC 2 / ISO 27001', ref: 'A.9 access control', what: 'credential disclosure' }],
  stripe_live_key: [{ regime: 'PCI DSS v4.0', ref: 'Req. 8', what: 'payment system credential' }],
  credential_in_prose: [{ regime: 'SOC 2 / ISO 27001', ref: 'A.9 access control', what: 'credential disclosure' }],
  security_incident: [
    { regime: 'SOC 2 / ISO 27001', ref: 'A.16 incident management', what: 'incident detail is restricted while unremediated' },
    G('Art. 33', 'if the incident involves personal data, a 72-hour notification clock may apply'),
  ],
};

/**
 * Bulk disclosure changes the regime, not just the volume. A single email
 * address is personal data; ten thousand of them, sent somewhere they should
 * not have gone, is a notifiable incident on a 72-hour clock.
 */
export const BULK_REGIMES = [
  G('Art. 33', 'a personal data breach is notifiable to the supervisory authority within 72 hours'),
  D('S. 8(6)', 'a personal data breach must be reported to the Data Protection Board and to each affected person'),
];

/** Distinct regimes across a finding set, most severe consequence first. */
export function regimesFor(findings, table = null) {
  const seen = new Map();
  const add = (entry) => {
    const key = `${entry.regime}|${entry.ref}`;
    if (!seen.has(key)) seen.set(key, entry);
  };
  for (const f of findings) for (const entry of REGIME_MAP[f.ruleId] || []) add(entry);
  if (table && table.rows >= 25) for (const entry of BULK_REGIMES) add(entry);
  return [...seen.values()];
}

/** Short names only, for a compact UI. */
export function regimeNames(findings, table = null) {
  return [...new Set(regimesFor(findings, table).map((r) => r.regime))];
}

/**
 * Context signals.
 *
 * Everything in rules.js answers "is this string a credential or an
 * identifier?" — which is the right question for an engineer and the wrong one
 * for everybody else.
 *
 * Cyberhaven's 2026 figures put 32.8% of leaks in source code and credentials,
 * and 18.2% in M&A documents and investment models. A pattern engine catches
 * the first group and is blind to the second. A CEO pasting a board deck, a
 * lawyer pasting a privileged memo, an HR lead pasting a compensation band —
 * none of them trip a single regex in rules.js, and all of them are doing
 * something their organisation would stop if it could see it.
 *
 * These signals are ADVISORY. They are never redacted: replacing the word
 * "CONFIDENTIAL" with a placeholder helps nobody, and deleting the number in
 * "ARR is £4.2M" would destroy the question being asked. They change the
 * verdict and the framing, and then the person decides. That is the correct
 * division of labour — the tool knows what the text is, the person knows
 * whether it is allowed.
 */

/** Currency figures, for the signals that only matter next to a number. */
const MONEY = /(?:[$£€₹¥]\s?[\d,.]+\s?(?:k|m|bn|b|mn|cr|crore|lakh|lakhs|million|billion)?|\b[\d,.]+\s?(?:k|m|bn|mn|cr|crore|lakh|lakhs|million|billion)\b)/i;

import { isBenign, isCodeIdentifier } from './negatives.js';

const near = (text, index, window, re) =>
  re.test(text.slice(Math.max(0, index - window), index + window));

/**
 * Advisory rules share the detector shape so they flow through the same
 * pipeline, UI and policy, but carry `advisory: true` so redaction skips them.
 */
export const CONTEXT_RULES = [
  {
    id: 'classification_marking',
    label: 'Document marked confidential',
    severity: 'high',
    confidence: 'certain',
    advisory: true,
    audience: 'everyone',
    prefilter: ['CONFIDENTIAL', 'Confidential', 'confidential', 'INTERNAL', 'Internal',
      'PROPRIETARY', 'Proprietary', 'RESTRICTED', 'Restricted', 'DO NOT'],
    // Longest alternatives first; the bare word is last and gated below.
    pattern: /\b(strictly confidential|company confidential|confidential (?:and proprietary|information)|proprietary and confidential|internal use only|internal only|for internal (?:use|distribution)|do not (?:distribute|forward|share|circulate)|commercially sensitive|restricted[- ]confidential|confidential)\b/gi,
    /**
     * A bare "confidential" is the most common marking there is, and also a
     * perfectly ordinary English word. It counts only when it reads as a
     * marking: written in capitals, or standing at the start of a line the way
     * a header does. Multi-word phrases are unambiguous and always count.
     */
    validate: (m, ctx) => {
      if (m.toLowerCase() !== 'confidential') return true;
      if (m === m.toUpperCase()) return true;
      return /(?:^|\n)[\s*_#>|-]*$/.test(ctx.text.slice(Math.max(0, ctx.index - 24), ctx.index));
    },
    note: 'This document carries a confidentiality marking. Sending it to a third-party service is usually the thing the marking exists to prevent.',
  },
  {
    id: 'legal_privilege',
    label: 'Legally privileged material',
    severity: 'critical',
    confidence: 'certain',
    advisory: true,
    audience: 'legal',
    prefilter: ['privileg', 'Privileg', 'PRIVILEG', 'without prejudice', 'Without Prejudice', 'work product'],
    pattern: /\b(attorney[- ]client privileged?|privileged and confidential|legally privileged|solicitor[- ]client privilege|attorney work[- ]product|litigation privilege|without prejudice(?: save as to costs)?|subject to contract)\b/gi,
    note: 'Privilege can be waived by disclosure to a third party. An AI provider is a third party.',
  },
  {
    id: 'deal_material',
    label: 'M&A or transaction material',
    severity: 'high',
    confidence: 'likely',
    advisory: true,
    audience: 'executive',
    prefilter: ['term sheet', 'Term Sheet', 'letter of intent', 'due diligence', 'Due Diligence',
      'data room', 'definitive agreement', 'Project ', 'cap table', 'Cap Table'],
    pattern: /\b(term sheet|letter of intent|heads of terms|due diligence (?:report|findings|checklist|request)|virtual data room|\bdata room\b|definitive agreement|share purchase agreement|merger agreement|cap(?:italisation|italization)? table|pre[- ]money valuation|post[- ]money valuation|exclusivity period)\b/gi,
    note: 'Transaction documents are 18% of all sensitive data pasted into AI tools (Cyberhaven, 2026).',
  },
  {
    id: 'mnpi',
    label: 'Possible inside information',
    severity: 'critical',
    confidence: 'likely',
    advisory: true,
    audience: 'executive',
    prefilter: ['non-public', 'nonpublic', 'non public', 'blackout', 'Blackout', 'insider', 'Insider', 'embargo', 'Embargo'],
    pattern: /\b(material non[- ]?public information|\bMNPI\b|inside information|insider (?:list|trading|information)|blackout period|closed period|pre[- ]announcement|earnings (?:release|call) draft|unannounced (?:results|acquisition|merger))\b/gi,
    note: 'Handling of inside information is regulated (SEC Reg FD, SEBI PIT Regulations, UK MAR). Disclosure to an uncontrolled third party is the risk.',
  },
  {
    id: 'unreleased_information',
    label: 'Unreleased or embargoed information',
    severity: 'medium',
    confidence: 'possible',
    advisory: true,
    audience: 'executive',
    prefilter: ['unreleased', 'Unreleased', 'unannounced', 'not yet announced', 'launch date', 'roadmap', 'Roadmap'],
    pattern: /\b(unreleased (?:product|feature|pricing|results)|not yet (?:announced|public|launched)|ahead of (?:the )?announcement|confidential roadmap|internal roadmap|pre[- ]launch pricing)\b/gi,
  },
  {
    id: 'financial_disclosure',
    label: 'Company financials',
    severity: 'high',
    confidence: 'likely',
    advisory: true,
    audience: 'finance',
    prefilter: ['ARR', 'MRR', 'EBITDA', 'runway', 'Runway', 'burn rate', 'Burn Rate', 'gross margin', 'churn'],
    pattern: /\b(ARR|MRR|EBITDA|run[- ]?rate revenue|gross margin|net margin|burn rate|cash runway|runway|churn rate|CAC|LTV|unit economics)\b/g,
    // Only a signal when an actual figure is nearby; otherwise it is a
    // vocabulary lesson, not a disclosure.
    validate: (m, ctx) => near(ctx.text, ctx.index, 90, MONEY) || near(ctx.text, ctx.index, 60, /\b\d+(?:\.\d+)?\s?%/),
    note: 'Financial metrics with figures attached. If the company is listed or in a raise, this may be non-public.',
  },
  {
    id: 'compensation_data',
    label: 'Compensation information',
    severity: 'high',
    confidence: 'likely',
    advisory: true,
    audience: 'hr',
    prefilter: ['salary', 'Salary', 'CTC', 'compensation', 'Compensation', 'base pay', 'bonus', 'Bonus', 'RSU', 'equity grant', 'severance', 'Severance'],
    pattern: /\b(salary|annual salary|base (?:pay|salary)|total compensation|\bCTC\b|bonus|equity grant|\bRSUs?\b|stock options|severance|notice pay|pay band|comp(?:ensation)? band)\b/gi,
    validate: (m, ctx) => near(ctx.text, ctx.index, 90, MONEY),
    note: 'Pay data about identifiable people is personal data under GDPR and the DPDP Act, and is restricted in most employment contracts.',
  },
  {
    id: 'health_information',
    label: 'Health information',
    severity: 'critical',
    confidence: 'likely',
    advisory: true,
    audience: 'healthcare',
    prefilter: ['diagnos', 'Diagnos', 'patient', 'Patient', 'prescri', 'Prescri', 'medical record',
      'ICD-', 'mg ', 'treatment', 'Treatment', 'symptom'],
    // `diagnosis` needs to be doing something: "Diagnosis/" is a build
    // directory in a .gitignore, not a medical record.
    pattern: /\b(diagnos(?:ed with|is of|is is|is was|tic report)|patient (?:record|history|id|name|chart)|medical (?:record|history|report)|prescri(?:bed|ption for)|ICD-1[01][ -]?[A-Z][0-9]{2}|treatment plan|clinical notes?|lab results?|blood (?:test|report)|symptoms? of)\b/gi,
    note: 'Health data is a special category under GDPR Article 9, sensitive personal data under the DPDP Act, and PHI under HIPAA. The bar for disclosure is higher than for ordinary personal data.',
  },
  {
    id: 'security_incident',
    label: 'Security incident detail',
    severity: 'high',
    confidence: 'likely',
    advisory: true,
    audience: 'security',
    prefilter: ['CVE-', 'breach', 'Breach', 'zero-day', 'zero day', 'ransom', 'Ransom', 'incident report', 'compromise'],
    pattern: /\b(CVE-\d{4}-\d{4,7}|data breach|security incident|incident report|zero[- ]day|ransomware|indicators? of compromise|\bIOCs?\b|unpatched vulnerability|active exploit)\b/gi,
    /**
     * A CVE identifier on its own is public information — every changelog
     * carries them. It is incident detail only while the issue is still open.
     */
    validate: (m, ctx) => {
      if (!/^CVE-/i.test(m)) return true;
      const around = ctx.text.slice(Math.max(0, ctx.index - 140), ctx.index + 140);
      return /\b(?:unpatched|unfixed|unresolved|not yet (?:patched|fixed|public|disclosed)|still (?:open|vulnerable)|active(?:ly)? exploit|in the wild|embargo|pre[- ]disclosure|zero[- ]day)\b/i.test(around);
    },
    note: 'Unremediated vulnerability detail is useful to an attacker and is usually under embargo until a fix ships.',
  },
  {
    id: 'credential_in_prose',
    label: 'Password written out in a sentence',
    severity: 'critical',
    confidence: 'likely',
    // NOT advisory: this one is a real secret and should be redacted.
    audience: 'everyone',
    prefilter: ['password', 'Password', 'passcode', 'login is', 'log in with', 'credentials are', 'PIN is'],
    // A copula or assignment is mandatory. Without it the bare word
    // `password` matched inside postgres://user:password@host and captured
    // the rest of the URL.
    pattern: /\b(?:pass(?:word|code)?|pwd|login|log ?in|credentials?|PIN)\s*(?:is|are|=|:)\s*["'`]?([^\s"'`,;]{6,64})["'`]?/gi,
    group: 1,
    /**
     * Rejects code as well as placeholders. Scanning 10,472 real source files
     * found this rule matching `password: urlPassword`,
     * `credentials: isCredentialsSupported` and
     * `password = utils.getSafeProp(configAuth, 'password')` — JavaScript, not
     * passwords. See isCodeIdentifier for why camelCase alone is the test and
     * a mere case change is not.
     */
    validate: (m) => !/^(?:is|the|a|an|to|for|and|reset|change|manager|policy|protected|field|less|hash|hashing|expired|incorrect|invalid|required|strength|rules?|here|above|below|attached|shared|same|new|old|your|my|our|their)$/i.test(m)
      && !/^[<{[@]/.test(m) && /[^a-z]/.test(m)
      && !isBenign(m, { placeholder: true })
      && !isCodeIdentifier(m),
    note: 'A password written into a sentence is still a password.',
  },
  {
    id: 'customer_list',
    label: 'Named customer or account list',
    severity: 'high',
    confidence: 'possible',
    advisory: true,
    audience: 'sales',
    prefilter: ['customer list', 'Customer List', 'account list', 'pipeline', 'Pipeline', 'churn risk', 'renewal'],
    pattern: /\b(customer list|client list|account list|target list|prospect list|pipeline review|churn risk|at[- ]risk accounts?|renewal forecast)\b/gi,
  },
];

/** Grouping for the settings UI. */
export const CONTEXT_CATEGORY = {
  id: 'context',
  label: 'Business & legal context',
  ids: CONTEXT_RULES.map((r) => r.id),
};

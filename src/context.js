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
     * Two phrases are ordinary English as well as markings, and both needed
     * the same gate.
     *
     * A bare "confidential" is the most common marking there is and also a
     * normal word. "Internal use only" turned out to be worse: it is how
     * every library in the world labels a private API, and fifty-three of
     * them showed up in one scan of real source — Ansible's own config file
     * says "This is for internal use only" nine times.
     *
     * Both count when they read as a *marking* rather than as a sentence:
     * written in capitals, or standing at the start of a line the way a
     * header does. The longer phrases — "strictly confidential", "do not
     * distribute", "proprietary and confidential" — are unambiguous and
     * always count.
     */
    validate: (m, ctx) => {
      const word = m.toLowerCase();
      const ambiguous = word === 'confidential' || word === 'internal use only'
        || word === 'internal only' || word === 'for internal use'
        || word === 'for internal distribution';
      if (!ambiguous) return true;
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
    /**
     * Every phrase here has to be doing medical work, not merely containing a
     * medical-sounding word. "Diagnosis/" is a build directory in a
     * .gitignore. Three of these were worse than that, and all three fired at
     * *critical* severity on ordinary technical prose:
     *
     *   "a prescribed notification"      Kubernetes, shared_informer.go
     *   "symptoms of bugs"               the Rust book
     *   "Node.js diagnostic report"      the Next.js CLI
     *
     * So "prescribed" now needs a dose or a medicine near it, "symptoms of"
     * needs to be symptoms of a condition rather than of a problem, and
     * "diagnostic report" is gone: a diagnosis is the medical event, and
     * "diagnostic" is a word every runtime uses about itself.
     */
    pattern: /\b(diagnos(?:ed with|is of|is is|is was)|patient (?:record|history|id|name|chart)|medical (?:record|history|report)|prescription for|prescribed\s+(?=[^.\n]{0,60}\b(?:mg|ml|mcg|iu|tablets?|capsules?|dose|dosage|daily|twice|bd|od|tds|course)\b)|ICD-1[01][ -]?[A-Z][0-9]{2}|treatment plan|clinical notes?|lab results?|blood (?:test|report)|symptoms? of\s+(?=[^.\n]{0,40}\b(?:covid|influenza|flu|diabetes|cancer|depression|anxiety|asthma|infection|disease|disorder|syndrome|illness|condition|the patient)\b))/gi,
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
    id: 'unannounced_transaction',
    label: 'A deal before it is public',
    severity: 'critical',
    confidence: 'likely',
    advisory: true,
    audience: 'executive',
    prefilter: ['acquir', 'Acquir', 'announcement', 'Announcement', 'embargo', 'Embargo',
      'merger', 'Merger', 'divest', 'Divest', 'takeover', 'Takeover'],
    /**
     * The example that started this: "Our company is acquiring Acme for $46M
     * and the announcement is scheduled for October 12."
     *
     * Not one credential, not one identifier, not one name of a person — and
     * the single most damaging sentence in the whole document. A pattern
     * engine that only asks "is this a secret-shaped string" cannot see it.
     * What it can see is a transaction verb, a named party, a sum of money,
     * and a date that has not happened yet.
     */
    pattern: /\b((?:acquir(?:e|es|ed|ing)|merg(?:e|es|ed|ing)\s+with|purchas(?:e|es|ed|ing)|buy(?:s|ing)?|divest(?:s|ed|ing)?|tak(?:e|es|ing)\s+over)\s+(?:[A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,3})|announcement\s+is\s+(?:scheduled|planned|set)\s+for|(?:before|ahead of|prior to)\s+the\s+announcement|embargoed until|under embargo|signing\s+(?:is|happens)\s+on)\b/g,
    /**
     * A transaction verb with a capitalised object is common English ("buy
     * Redis", "acquire GitHub" in a news article). It counts when there is
     * money attached, or a date the reader is being told not to jump.
     */
    validate: (m, ctx) => {
      const window = ctx.text.slice(Math.max(0, ctx.index - 160), ctx.index + 200);
      // Coordinated vulnerability disclosure borrows the word "embargo", and
      // axios's SECURITY.md is not a merger. A security context rules it out.
      if (/embargo/i.test(m)) {
        return !/\b(?:vulnerabilit|advisor|CVE-|disclosure|security|patch|researcher|report)/i.test(window);
      }
      if (/announcement|signing/i.test(m)) return true;
      return MONEY.test(window)
        || /\b(?:confidential|not yet public|unannounced|do not (?:share|forward)|under NDA)\b/i.test(window);
    },
    note: 'A transaction that has not been announced is inside information for everyone who knows about it. Disclosure to a third-party service is the risk the rules exist for.',
  },
  {
    id: 'negotiation_position',
    label: 'A negotiating position',
    severity: 'high',
    confidence: 'likely',
    advisory: true,
    audience: 'executive',
    prefilter: ['walk away', 'walk-away', 'BATNA', 'best and final', 'reservation price',
      'floor price', 'our floor', 'counteroffer', 'counter-offer', 'as low as', 'bottom line is'],
    /**
     * The one thing in a negotiation whose value is entirely in the other side
     * not having it. Pasting it into a chat box is not a compliance problem;
     * it is a commercial one, which is why no DLP product looks for it.
     */
    pattern: /\b(walk[- ]away (?:price|point|number)|\bBATNA\b|best and final (?:offer|price)|reservation price|(?:our|the) floor (?:is|price)|price floor of|we (?:can|could) go as low as|we(?:'| a)?re (?:prepared|willing) to (?:accept|go to|pay)|internal (?:target|ceiling|budget) (?:is|of)|counter[- ]?offer of)\b/gi,
    note: 'This is a position, not a fact. Its value depends on the other side not having it.',
  },
  {
    id: 'trade_secret',
    label: 'Proprietary method or unfiled invention',
    severity: 'high',
    confidence: 'possible',
    advisory: true,
    audience: 'everyone',
    prefilter: ['trade secret', 'Trade Secret', 'proprietary', 'Proprietary', 'invention disclosure',
      'provisional patent', 'patent application', 'not patented', 'unpatented'],
    pattern: /\b(trade secrets?|invention disclosure|provisional patent|patent application (?:number|draft|for)|(?:before|prior to) filing|unpatented|not (?:yet )?patented|proprietary (?:algorithm|model|method|process|formula|weights|dataset))\b/gi,
    note: 'Trade-secret protection depends on reasonable steps to keep it secret. Disclosure to a third party without an agreement in place can end that protection outright — unlike a patent, there is nothing to fall back on.',
  },
  {
    id: 'workforce_action',
    label: 'Unannounced workforce decision',
    severity: 'high',
    confidence: 'likely',
    advisory: true,
    audience: 'hr',
    prefilter: ['reduction in force', 'redundanc', 'Redundanc', 'layoff', 'Layoff', 'severance',
      'performance improvement plan', 'termination list', 'let go'],
    pattern: /\b(reduction in force|\bRIF(?:ed|s)?\b|layoffs?\s+(?:planned|scheduled|list|of \d+)|redundanc(?:y|ies)\s+(?:consultation|list|process)|severance (?:package|terms|offer)|performance improvement plan|termination list|exit list|being (?:let go|managed out))\b/gi,
    note: 'A decision about a named person before they have been told. In most jurisdictions the consultation process has rules about who learns first.',
  },
  {
    id: 'legal_hold',
    label: 'Live or threatened litigation',
    severity: 'high',
    confidence: 'likely',
    advisory: true,
    audience: 'legal',
    prefilter: ['litigation hold', 'legal hold', 'preservation notice', 'cease and desist',
      'subpoena', 'Subpoena', 'without prejudice', 'settlement agreement'],
    pattern: /\b(litigation hold|legal hold|preservation notice|cease and desist|subpoena(?:ed)?|without prejudice|settlement (?:agreement|discussions?|negotiations?)|statement of claim|letter before action|arbitration (?:notice|demand))\b/gi,
    /**
     * "Legal hold" is also the name of an S3 Object Lock setting, which is why
     * this fired twenty times in the AWS Terraform provider and nowhere else
     * in 87,000 files. An API flag is not a dispute.
     */
    validate: (m, ctx) => !/legal hold/i.test(m)
      || !near(ctx.text, ctx.index, 120, /\b(?:s3|object[_ ]lock|bucket|retention[_ ]mode|governance mode|compliance mode|version_?id)\b/i),
    note: 'Material connected to a live or threatened dispute. A copy in a third-party service is a copy that can be asked for in discovery.',
  },
  {
    id: 'internal_pricing',
    label: 'Internal cost or margin',
    severity: 'medium',
    confidence: 'possible',
    advisory: true,
    audience: 'executive',
    prefilter: ['rate card', 'Rate Card', 'gross margin', 'cost of goods', 'our cost', 'unit cost',
      'discount floor', 'internal pricing', 'landed cost', 'markup'],
    pattern: /\b(rate card|gross margin(?:s)? (?:of|on|is|are)|cost of goods(?: sold)?|\bCOGS\b|(?:our|unit|landed|wholesale) cost (?:is|of|per)|discount (?:floor|ceiling|authority)|internal pricing|markup (?:of|is))\b/gi,
    /** A pricing word without a number is a topic; with one it is a figure. */
    validate: (m, ctx) => near(ctx.text, ctx.index, 160, MONEY) || /%/.test(ctx.text.slice(ctx.index, ctx.index + 80)),
    note: 'What something costs you, rather than what you charge for it. A customer, a supplier or a competitor reading this changes the next negotiation.',
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

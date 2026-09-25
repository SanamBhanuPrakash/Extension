/**
 * Annotated prose for the name and address detectors.
 *
 * Hand-written rather than generated. A generator would produce the sentences
 * the detector already handles, and the point of this corpus is the sentences
 * it does not: technical prose full of capitalised product names, news copy
 * full of capitalised organisations, and addresses written the six different
 * ways people actually write them.
 *
 * `names` and `addresses` list the exact substrings that should be found.
 * A prediction counts as correct when it overlaps a gold span.
 */
export const DOCUMENTS = [
  // ── correspondence ────────────────────────────────────────────────────
  {
    id: 'email-renewal',
    text: `Hi team,

Spoke to Priya Nair yesterday about the renewal. She said the invoice went to
the wrong address — it should be Flat 3B, 14 Koregaon Park Road, Pune 411001.

I've looped in Marcus Whitfield (Director, Revenue).

Regards,
Anita Deshpande`,
    names: ['Priya Nair', 'Marcus Whitfield', 'Anita Deshpande'],
    addresses: ['Flat 3B, 14 Koregaon Park Road, Pune 411001'],
  },
  {
    id: 'email-complaint',
    text: `Dear Mr Okonkwo,

Thank you for your note. I have asked Sarah Lindqvist to look into the delay.
Our records show the package was sent to 221B Baker Street, London NW1 6XE.

Sincerely,
James Farrow`,
    names: ['Okonkwo', 'Sarah Lindqvist', 'James Farrow'],
    addresses: ['221B Baker Street, London NW1 6XE'],
  },
  {
    id: 'support-ticket',
    text: `Ticket #48217 — customer cannot log in.
Reported by Yuki Tanaka, account owner. Dr. Ferreira from the clinic called
about the same issue. Escalating to Aleksandr Petrov on the platform team.`,
    names: ['Yuki Tanaka', 'Ferreira', 'Aleksandr Petrov'],
    addresses: [],
  },
  {
    id: 'hr-note',
    text: `Performance review notes, Q3.

Rohan Mehta exceeded targets. Fatima Al-Rashid is ready for promotion.
Lars Andersen resigned on Friday; exit interview scheduled.
Home address on file: 45 Nursery Road, Singapore 118484.`,
    names: ['Rohan Mehta', 'Fatima Al-Rashid', 'Lars Andersen'],
    addresses: ['45 Nursery Road, Singapore 118484'],
  },
  {
    id: 'meeting-minutes',
    text: `Attendees: Chen Wei, Olusegun Adeyemi, Beatriz Gonçalves.
Chen Wei presented the roadmap. Olusegun Adeyemi raised the pricing question.
Action: Beatriz Gonçalves to circulate the deck by Wednesday.`,
    names: ['Chen Wei', 'Olusegun Adeyemi', 'Beatriz Gonçalves'],
    addresses: [],
  },
  {
    id: 'medical-note',
    text: `Patient: Ananya Krishnan, DOB 14/03/1988.
Diagnosed with Type 2 diabetes. Prescribed metformin 500mg twice daily.
Follow-up with Dr. Venkataraman in six weeks.
Residence: Plot 27, Sector 14, Gurugram 122001.`,
    names: ['Ananya Krishnan', 'Venkataraman'],
    addresses: ['Plot 27, Sector 14, Gurugram 122001'],
  },
  {
    id: 'legal-memo',
    text: `PRIVILEGED AND CONFIDENTIAL

Counsel for the claimant, Nkechi Obi, has served notice. Our position, per
Hiroshi Nakamura, remains unchanged. Correspondence should go to
Suite 900, 1200 Bay Street, Toronto M5R 2A5.`,
    names: ['Nkechi Obi', 'Hiroshi Nakamura'],
    addresses: ['Suite 900, 1200 Bay Street, Toronto M5R 2A5'],
  },
  {
    id: 'shipping',
    text: `Please redirect the shipment.
New delivery address: 1600 Pennsylvania Avenue NW, Washington 20500.
Contact on arrival is Ingrid Sørensen.`,
    names: ['Ingrid Sørensen'],
    addresses: ['1600 Pennsylvania Avenue NW, Washington 20500'],
  },
  {
    id: 'onboarding',
    text: `New joiner details for payroll.
Name: Thandiwe Mbeki. Start date Monday.
Address: House No 8, MG Road, Bengaluru 560001.
Buddy assigned: Wei Zhang.`,
    names: ['Thandiwe Mbeki', 'Wei Zhang'],
    addresses: ['House No 8, MG Road, Bengaluru 560001'],
  },
  {
    id: 'intro',
    text: `My name is Emeka Chukwu and I am writing about the outage.
I spoke with Kavitha Subramanian last week. She asked me to contact you.`,
    names: ['Emeka Chukwu', 'Kavitha Subramanian'],
    addresses: [],
  },

  // ── hard negatives: prose full of capitalised non-people ──────────────
  {
    id: 'neg-infra',
    text: `The Kubernetes cluster in Mumbai failed on Tuesday. Google Cloud support
said the Docker image was corrupt. We deployed React 19 on Monday and the
Sydney region recovered. Check the Terraform state and the Jenkins pipeline.`,
    names: [], addresses: [],
  },
  {
    id: 'neg-stacktrace',
    text: `TypeError: Cannot read properties of undefined (reading 'map')
    at Object.render (/srv/app/src/pages/Dashboard.tsx:142:18)
    at renderWithHooks (/srv/app/node_modules/react-dom/cjs/react-dom.js:16305:18)
    at Module._compile (node:internal/modules/cjs/loader:1105:14)`,
    names: [], addresses: [],
  },
  {
    id: 'neg-changelog',
    text: `## Unreleased
- Upgrade Postgres to 16 and Redis to 7.2
- Migrate CI from CircleCI to GitHub Actions
- Replace Moment with Temporal
- Drop Internet Explorer support`,
    names: [], addresses: [],
  },
  {
    id: 'neg-marketing',
    text: `Acme Analytics helps teams in London, Berlin and Singapore ship faster.
Trusted by Shopify, Atlassian and Figma. Available on AWS Marketplace and
Azure Marketplace from January.`,
    names: [], addresses: [],
  },
  {
    id: 'neg-finance',
    text: `Revenue in the Americas grew 12% while EMEA was flat. The Board approved
the Series B in October. Goldman Sachs advised on the transaction and
Deloitte completed the audit.`,
    names: [], addresses: [],
  },
  {
    id: 'neg-product',
    text: `The Retention Dashboard now supports Cohort Analysis and Funnel Reports.
Export to Excel and Google Sheets is available under Settings, Integrations.
Dark Mode ships next Thursday.`,
    names: [], addresses: [],
  },
  {
    id: 'neg-roads',
    text: `Traffic on the Ring Road is heavy and the Coastal Highway is closed.
Take the Main Street exit instead. The Park Avenue bridge reopens in March.`,
    names: [], addresses: [],
  },
  {
    id: 'neg-code',
    text: `const UserProfile = require('./UserProfile');
class OrderService extends BaseService {
  async findByCustomerId(id) { return this.repo.find({ customerId: id }); }
}
export default OrderService;`,
    names: [], addresses: [],
  },
  {
    id: 'neg-sql',
    text: `SELECT Customer.Name, Invoice.Total FROM Customer
JOIN Invoice ON Invoice.CustomerId = Customer.Id
WHERE Invoice.CreatedAt > NOW() - INTERVAL '30 days'
ORDER BY Invoice.Total DESC;`,
    names: [], addresses: [],
  },
  {
    id: 'neg-calendar',
    text: `Reminder: the All Hands is on Wednesday and the Retro is Friday.
Quarter End falls on December 31. Public Holiday on Monday in India and
Diwali the week after. Q4 planning starts in November.`,
    names: [], addresses: [],
  },

  // ── mixed: names present inside otherwise technical text ─────────────
  {
    id: 'mixed-oncall',
    text: `Paging on-call. The Redis cluster in Frankfurt is down.
Dmitri Volkov is investigating; Aarti Raghunathan has the runbook.
Rollback to v2.14 deployed via Jenkins.`,
    names: ['Dmitri Volkov', 'Aarti Raghunathan'],
    addresses: [],
  },
  {
    id: 'mixed-pr',
    text: `PR #882 from Sofia Almeida refactors the OrderService in TypeScript.
Reviewed by Kwame Asante. Merged to main after CI passed on GitHub Actions.`,
    names: ['Sofia Almeida', 'Kwame Asante'],
    addresses: [],
  },
  {
    id: 'mixed-incident',
    text: `Incident 2026-0417. Root cause: expired certificate on the Nginx tier.
Detected by Grafana, confirmed by Ravi Shankaran at 03:12 UTC.
Postmortem owner: Helena Vasquez.`,
    names: ['Ravi Shankaran', 'Helena Vasquez'],
    addresses: [],
  },
  {
    id: 'mixed-sales',
    text: `Pipeline review. Northwind renewed. Contoso is at risk.
Our champion at Fabrikam is Jae-won Park. Decision expected in April.
Ship to: Unit 12, 88 Collins Street, Melbourne 3000.`,
    names: ['Jae-won Park'],
    addresses: ['Unit 12, 88 Collins Street, Melbourne 3000'],
  },
  {
    id: 'mixed-signature',
    text: `Let me know if that works.

Best,
Nadia Haddad
Senior Engineer | Platform
nadia.haddad@northwind.co.in`,
    names: ['Nadia Haddad'],
    addresses: [],
  },
];

/**
 * Builds the training corpus for the person-name classifier.
 *
 * Positives: person names across every faker locale that has them.
 * Negatives: the words a name detector actually confuses — company names,
 * cities, countries, product names, months, weekdays, job titles — plus
 * ordinary vocabulary. Training against lowercase dictionary words alone
 * produces a model that thinks every capitalised token is a person.
 *
 * Not shipped. Run once; the output is a weights file.
 */
import { allFakers } from '@faker-js/faker';
import { writeFileSync } from 'node:fs';

// Any cased script, not only Latin. Cyrillic, Greek, Armenian and Georgian
// have capitals and behave exactly like Latin in the pipeline, so they belong
// in the classifier's training set rather than in a gazetteer.
const NAME_RE = /^[\p{Lu}][\p{L}'’\-]{1,23}$/u;

/** faker stores names as arrays, or as {male:[],female:[],generic:[]}. */
function flatten(node, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const v of node) if (typeof v === 'string') out.push(v);
    return;
  }
  if (typeof node === 'object') for (const v of Object.values(node)) flatten(v, out);
}

const positives = new Set();
const negatives = new Set();
const localeCount = {};

for (const [loc, faker] of Object.entries(allFakers)) {
  const defs = faker.rawDefinitions;
  if (!defs) continue;

  const names = [];
  for (const key of ['first_name', 'last_name', 'middle_name']) flatten(defs.person?.[key], names);
  let added = 0;
  for (const raw of names) {
    // Multi-word entries are split; the classifier scores single tokens.
    for (const tok of String(raw).split(/[\s.]+/)) {
      if (NAME_RE.test(tok)) { positives.add(tok); added++; }
    }
  }
  if (added) localeCount[loc] = added;

  // Hard negatives: capitalised things that are not people.
  const hard = [];
  flatten(defs.company?.name_pattern ? null : defs.company, hard);
  flatten(defs.location?.city_name, hard);
  flatten(defs.location?.city_prefix, hard);
  flatten(defs.location?.city_suffix, hard);
  flatten(defs.location?.country, hard);
  flatten(defs.location?.state, hard);
  flatten(defs.location?.street_suffix, hard);
  flatten(defs.commerce?.product_name, hard);
  flatten(defs.commerce?.department, hard);
  flatten(defs.color?.human, hard);
  flatten(defs.animal, hard);
  flatten(defs.date?.month, hard);
  flatten(defs.date?.weekday, hard);
  flatten(defs.person?.job_area, hard);
  flatten(defs.person?.job_descriptor, hard);
  flatten(defs.person?.job_type, hard);
  flatten(defs.science?.chemicalElement, hard);
  flatten(defs.music?.genre, hard);
  flatten(defs.food?.ingredient, hard);
  flatten(defs.food?.dish, hard);
  flatten(defs.vehicle?.manufacturer, hard);
  flatten(defs.vehicle?.model, hard);
  flatten(defs.word, hard);
  flatten(defs.hacker?.noun, hard);
  flatten(defs.hacker?.verb, hard);
  flatten(defs.hacker?.adjective, hard);
  flatten(defs.internet?.domain_suffix, hard);
  flatten(defs.book?.genre, hard);

  for (const raw of hard) {
    for (const tok of String(raw).split(/[\s.,/'-]+/)) {
      const cap = tok.length > 1 ? tok[0].toUpperCase() + tok.slice(1) : tok;
      if (NAME_RE.test(cap)) negatives.add(cap);
    }
  }
}

// A token that is both a name and a place ("Austin", "Paris", "Virginia") is
// genuinely ambiguous. Contradictory labels teach the model nothing, so those
// are dropped from training and left to runtime context to decide.
const ambiguous = [...positives].filter((n) => negatives.has(n));
for (const n of ambiguous) { positives.delete(n); negatives.delete(n); }

const out = {
  positives: [...positives],
  negatives: [...negatives],
  ambiguous,
};
writeFileSync('/tmp/claude-0/corpus.json', JSON.stringify(out));
const scripts = { Latin: 0, Cyrillic: 0, Greek: 0, Armenian: 0, Georgian: 0, other: 0 };
for (const n of out.positives) {
  if (/\p{Script=Cyrillic}/u.test(n)) scripts.Cyrillic++;
  else if (/\p{Script=Greek}/u.test(n)) scripts.Greek++;
  else if (/\p{Script=Armenian}/u.test(n)) scripts.Armenian++;
  else if (/\p{Script=Georgian}/u.test(n)) scripts.Georgian++;
  else if (/\p{Script=Latin}/u.test(n)) scripts.Latin++;
  else scripts.other++;
}
console.log(`scripts            : ${Object.entries(scripts).filter(([, v]) => v).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(', ')}`);
console.log(`locales with names : ${Object.keys(localeCount).length}`);
console.log(`positives          : ${out.positives.length.toLocaleString()}`);
console.log(`negatives          : ${out.negatives.length.toLocaleString()}`);
console.log(`dropped ambiguous  : ${ambiguous.length.toLocaleString()}  e.g. ${ambiguous.slice(0, 8).join(', ')}`);
console.log(`positive sample    : ${out.positives.filter((_, i) => i % 1700 === 0).slice(0, 12).join(', ')}`);
console.log(`negative sample    : ${out.negatives.filter((_, i) => i % 260 === 0).slice(0, 12).join(', ')}`);

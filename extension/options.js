import { RULES, RULES_BY_ID, CATEGORIES } from './engine/rules.js';
import { scan } from './engine/detect.js';
import { redact } from './engine/redact.js';

const DEFAULTS = { mode: 'warn', disabled: [], allow: [] };
const $ = (id) => document.getElementById(id);

const stored = await chrome.storage.sync.get('policy');
const policy = { ...DEFAULTS, ...(stored.policy || {}) };

async function save(patch) {
  Object.assign(policy, patch);
  await chrome.storage.sync.set({ policy });
  const el = $('saved');
  el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), 1200);
  runPlayground();
}

// ------------------------------------------------------------------- mode
for (const input of document.querySelectorAll('input[name=mode]')) {
  input.checked = input.value === policy.mode;
  input.onchange = () => save({ mode: input.value });
}

// -------------------------------------------------------------- detectors
const proven = RULES.filter((r) => r.proof).length;
$('ruleCount').textContent = `${RULES.length} detectors, ${proven} of which prove the match.`;

const boxes = new Map();

function renderGroups(filter = '') {
  const needle = filter.trim().toLowerCase();
  const container = $('groups');
  container.replaceChildren();
  boxes.clear();

  for (const group of CATEGORIES) {
    const rules = group.ids
      .map((id) => RULES_BY_ID.get(id))
      .filter(Boolean)
      .filter((r) => !needle || r.label.toLowerCase().includes(needle) || r.id.includes(needle));
    if (!rules.length) continue;

    const section = document.createElement('div');
    section.className = 'group';
    const h3 = document.createElement('h3');
    h3.append(document.createTextNode(group.label));
    const toggle = document.createElement('button');
    const allOn = rules.every((r) => !policy.disabled.includes(r.id));
    toggle.textContent = allOn ? 'turn off' : 'turn on';
    toggle.onclick = () => {
      const set = new Set(policy.disabled);
      for (const r of rules) allOn ? set.add(r.id) : set.delete(r.id);
      save({ disabled: [...set] }).then(() => renderGroups($('search').value));
    };
    h3.appendChild(toggle);
    section.appendChild(h3);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const rule of rules) {
      const label = document.createElement('label');
      label.className = 'det';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !policy.disabled.includes(rule.id);
      box.onchange = () => {
        const set = new Set(policy.disabled);
        box.checked ? set.delete(rule.id) : set.add(rule.id);
        save({ disabled: [...set] });
      };
      boxes.set(rule.id, box);
      const dot = document.createElement('i');
      dot.className = `dot sev-${rule.severity}`;
      dot.title = `${rule.severity} severity`;
      const name = document.createElement('span');
      name.textContent = rule.label;
      const badge = document.createElement('span');
      badge.className = rule.proof ? 'proof' : 'shape';
      badge.textContent = rule.proof ? 'proof' : 'shape';
      badge.title = rule.proof
        ? `Proved by ${rule.proof}.`
        : 'Matched on shape alone — a prefix or structure nothing else uses.';
      label.append(box, dot, name, badge);
      grid.appendChild(label);
    }
    section.appendChild(grid);
    container.appendChild(section);
  }
}
renderGroups();
$('search').oninput = (e) => renderGroups(e.target.value);
$('enableAll').onclick = () => save({ disabled: [] }).then(() => renderGroups($('search').value));

// -------------------------------------------------------------- allowlist
const allow = $('allow');
allow.value = policy.allow.join('\n');
allow.onchange = () =>
  save({ allow: allow.value.split('\n').map((s) => s.trim()).filter(Boolean) });

// -------------------------------------------------------------- playground
const EXAMPLES = [
  `Our deploy is failing, can you spot the problem?

  AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
  DATABASE_URL=postgres://app:Xq7vTm2Lp@db-prod.internal:5432/orders
  SUPPORT_EMAIL=ops@northwind.co.in

The customer's card on file is 4242 4242 4242 4242.
Order 1234567890123456 went through fine, though.`,

  `Spoke to Priya Nair yesterday about the renewal. She said the invoice went
to the wrong address \u2014 it should be Flat 3B, 14 Koregaon Park Road, Pune 411001.
Dr. Venkataraman confirmed the same.

Regards,
Anita Deshpande`,

  `PRIVILEGED AND CONFIDENTIAL \u2014 DO NOT DISTRIBUTE

Board, ahead of Thursday: ARR closed the quarter at $4.2M, up 31%. Cash runway
is 14 months at current burn. We signed the term sheet with Meridian on Tuesday;
the data room goes live Monday. Material non-public information until the 14th.`,

  ['customer_id,name,email,phone,city',
    ...Array.from({ length: 120 }, (_, i) =>
      `${9000 + i},Customer ${i},c${i}@northwind.co.in,9${String(812345670 + i)},Pune`)].join('\n'),
];
let exampleIndex = 0;

function runPlayground() {
  const text = $('sample').value;
  const out = $('out');
  out.replaceChildren();
  if (!text.trim()) {
    const p = document.createElement('div');
    p.className = 'none';
    p.textContent = 'Findings appear here as you type.';
    out.appendChild(p);
    $('counts').textContent = '';
    return;
  }

  const result = scan(text, policy);

  // Lead with the score, exactly as the in-page panel does.
  const scoreRow = document.createElement('div');
  scoreRow.className = `score band-${result.risk.band}`;
  const num = document.createElement('b');
  num.textContent = String(result.risk.score);
  const den = document.createElement('span');
  den.textContent = '/100';
  const verdict = document.createElement('em');
  verdict.textContent = result.verdict === 'clean' ? 'nothing to stop for'
    : result.verdict === 'block' ? 'would stop you' : 'would warn';
  scoreRow.append(num, den, verdict);
  out.appendChild(scoreRow);

  if (result.table) {
    const bulk = document.createElement('p');
    bulk.className = 'bulk';
    bulk.textContent = result.table.description;
    out.appendChild(bulk);
  }
  if (result.regimeNames.length) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const name of result.regimeNames.slice(0, 6)) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = name;
      chips.appendChild(chip);
    }
    out.appendChild(chips);
  }

  if (!result.groups.length) {
    const p = document.createElement('div');
    p.className = 'none';
    p.textContent = 'Nothing found.';
    out.appendChild(p);
  } else {
    const ul = document.createElement('ul');
    for (const g of result.groups) {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.className = `sev-${g.severity}`;
      b.textContent = g.label + (g.occurrences > 1 ? ` \u00d7${g.occurrences}` : '');
      const code = document.createElement('code');
      code.textContent = g.preview;
      li.append(b, code);
      ul.appendChild(li);
    }
    out.appendChild(ul);
  }
  $('counts').textContent = `${result.findings.length} found in ${text.length.toLocaleString()} characters`;
}

$('sample').oninput = runPlayground;
$('loadSample').onclick = () => {
  $('sample').value = EXAMPLES[exampleIndex % EXAMPLES.length];
  exampleIndex++;
  runPlayground();
};
$('redactBtn').onclick = () => {
  const text = $('sample').value;
  $('sample').value = redact(text).text;
  runPlayground();
};
runPlayground();

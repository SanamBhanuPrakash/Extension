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
const EXAMPLE = `Our deploy is failing, can you spot the problem?

  AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
  DATABASE_URL=postgres://app:Xq7vTm2Lp@db-prod.internal:5432/orders
  SUPPORT_EMAIL=ops@northwind.co.in

The customer's card on file is 4242 4242 4242 4242.
Order 1234567890123456 went through fine, though.`;

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
  const verdict = document.createElement('div');
  verdict.className = `verdict ${result.verdict}`;
  verdict.textContent = result.verdict === 'clean' ? 'clean'
    : result.verdict === 'block' ? 'would stop you' : 'would warn';
  out.appendChild(verdict);

  if (!result.findings.length) {
    const p = document.createElement('div');
    p.className = 'none';
    p.textContent = 'Nothing found.';
    out.appendChild(p);
  } else {
    const ul = document.createElement('ul');
    for (const f of result.findings) {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.className = `sev-${f.severity}`;
      b.textContent = f.label;
      const code = document.createElement('code');
      code.textContent = f.preview;
      li.append(b, code);
      ul.appendChild(li);
    }
    out.appendChild(ul);
  }
  $('counts').textContent = `${result.findings.length} found in ${text.length} characters`;
}

$('sample').oninput = runPlayground;
$('loadSample').onclick = () => { $('sample').value = EXAMPLE; runPlayground(); };
$('redactBtn').onclick = () => {
  const text = $('sample').value;
  $('sample').value = redact(text).text;
  runPlayground();
};
runPlayground();

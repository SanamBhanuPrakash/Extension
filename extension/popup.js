import { read, clear, breakdown, distinctSecrets, ago } from './store.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = { mode: 'warn', disabled: [], allow: [] };

/** Hosts the manifest actually injects into, so the popup can be honest. */
const WATCHED = /(?:^|\.)(?:chatgpt\.com|openai\.com|claude\.ai|gemini\.google\.com|aistudio\.google\.com|copilot\.microsoft\.com|github\.com|perplexity\.ai|deepseek\.com|mistral\.ai|grok\.com|poe\.com)$/;

async function currentHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url ? new URL(tab.url).hostname : null;
  } catch { return null; }
}

function renderBreakdown(events) {
  const rows = breakdown(events);
  if (!rows.length) return;
  $('breakdownSection').hidden = false;
  const max = rows[0].n;
  $('breakdown').replaceChildren(...rows.map((r) => {
    const el = document.createElement('div');
    el.className = 'bar';
    const label = document.createElement('b');
    label.className = `sev-${r.severity}`;
    label.textContent = r.label;
    const n = document.createElement('em');
    n.textContent = String(r.n);
    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = `${Math.round((r.n / max) * 100)}%`;
    track.appendChild(fill);
    el.append(label, n, track);
    return el;
  }));
}

function renderRecent(events) {
  const list = $('recent');
  if (!events.length) {
    $('empty').hidden = false;
    list.replaceChildren();
    return;
  }
  $('empty').hidden = true;
  list.replaceChildren(...events.slice(0, 20).map((e) => {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('b');
    label.className = `sev-${e.severity}`;
    label.textContent = e.label;
    const code = document.createElement('code');
    code.textContent = e.preview;
    row.append(label, code);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const action = document.createElement('span');
    action.className = e.action;
    action.textContent = e.action === 'redacted' ? 'redacted' : e.action === 'sent' ? 'sent as-is' : 'dismissed';
    meta.append(document.createTextNode(`${e.host} · `), action, document.createTextNode(` · ${ago(e.at)}`));
    li.append(row, meta);
    return li;
  }));
}

async function render() {
  const [state, host, stored] = await Promise.all([
    read(), currentHost(), chrome.storage.sync.get('policy'),
  ]);
  const policy = { ...DEFAULTS, ...(stored.policy || {}) };

  const watching = host && WATCHED.test(host);
  const on = policy.mode !== 'off';
  $('site').textContent = !host ? 'no page'
    : watching ? `watching ${host}`
    : `${host} — not a watched site`;
  $('dot').className = `dot${on && watching ? '' : ' off'}`;
  $('statusText').textContent = !on ? 'off' : watching ? 'on' : 'idle';

  $('nCaught').textContent = state.caught;
  $('nRedacted').textContent = state.redacted;
  $('nDistinct').textContent = distinctSecrets(state.events);

  renderBreakdown(state.events);
  renderRecent(state.events);

  const mode = $('mode');
  mode.value = policy.mode;
  mode.onchange = async () => {
    await chrome.storage.sync.set({ policy: { ...policy, mode: mode.value } });
    render();
  };
}

$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('clear').onclick = async () => { await clear(); render(); };

render();

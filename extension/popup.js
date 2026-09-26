import { read, clear, breakdown, distinctSecrets, ago } from './store.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = { mode: 'warn', disabled: [], allow: [] };

/**
 * Which sites are covered, read from the manifest rather than restated here.
 *
 * This used to be a hand-written regular expression listing twelve hostnames
 * while the manifest injected into twenty-three. A popup that reports coverage
 * from a second, staler copy of the list is worse than one that reports none:
 * it is confidently wrong, and the person has no way to tell.
 */
function builtInMatches() {
  try {
    return (chrome.runtime.getManifest().content_scripts || [])
      .flatMap((entry) => entry.matches || []);
  } catch { return []; }
}

/** Chrome match patterns are not regular expressions; this is the subset used. */
function matchesPattern(pattern, url) {
  const m = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, scheme, host, path] = m;
  if (scheme !== '*' && scheme !== url.protocol.replace(':', '')) return false;
  if (host !== '*') {
    if (host.startsWith('*.')) {
      const base = host.slice(2);
      if (url.hostname !== base && !url.hostname.endsWith(`.${base}`)) return false;
    } else if (host !== url.hostname) return false;
  }
  const re = new RegExp(`^${path.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(url.pathname + url.search);
}

async function currentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch { return null; }
}

/**
 * Coverage, stated plainly.
 *
 * The single most dangerous belief a person can form about this extension is
 * "it is installed, therefore I am protected". It runs on a fixed list of AI
 * sites and is inert everywhere else — including on whatever an organisation
 * self-hosts, which is exactly where the sensitive prompts go.
 *
 * So the popup says which of the three states this tab is in, and offers to
 * fix the third. `optional_host_permissions` has been in the manifest since
 * the first version; until now nothing asked for it, which made it a claim
 * rather than a feature.
 */
async function renderCoverage(tab, on) {
  const line = $('coverageLine');
  const add = $('watchSite');
  const remove = $('unwatchSite');
  add.hidden = true;
  remove.hidden = true;

  let url = null;
  try { url = tab?.url ? new URL(tab.url) : null; } catch { /* about:blank, chrome:// */ }

  if (!url || !/^https?:$/.test(url.protocol)) {
    line.textContent = 'This is not a web page Chhanni can watch.';
    return { host: null, watching: false };
  }

  const builtIn = builtInMatches().some((p) => matchesPattern(p, url));
  const origin = `${url.origin}/*`;
  let added = false;
  try { added = !builtIn && await chrome.permissions.contains({ origins: [origin] }); } catch { /* not supported */ }

  const host = url.hostname;
  line.replaceChildren();
  const strong = document.createElement('b');
  strong.textContent = host;
  line.append(strong);

  if (builtIn || added) {
    const state = document.createElement('span');
    state.className = on ? 'ok' : 'idle';
    state.textContent = on ? ' is watched' : ' is watched, but Chhanni is switched off';
    line.append(state, document.createTextNode(
      builtIn
        ? ` — one of ${builtInMatches().length} sites Chhanni ships with.`
        : ' — you added this one.'));
    if (added) remove.hidden = false;
  } else {
    const state = document.createElement('span');
    state.className = 'idle';
    state.textContent = ' is not watched';
    line.append(state, document.createTextNode(
      ` — Chhanni ships with ${builtInMatches().length} AI sites and is idle on everything else, including anything your organisation self-hosts.`));
    add.hidden = false;
  }

  add.onclick = () => watch(origin, tab);
  remove.onclick = () => unwatch(origin, tab);
  return { host, watching: builtIn || added };
}

const scriptId = (origin) => `chhanni-${origin.replace(/[^a-z0-9]/gi, '-')}`;

/** Ask for the origin, then register the same content script the manifest does. */
async function watch(origin, tab) {
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [origin] }); } catch { granted = false; }
  if (!granted) return;
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId(origin)] });
    if (!existing.length) {
      await chrome.scripting.registerContentScripts([{
        id: scriptId(origin),
        matches: [origin],
        js: ['content.js'],
        css: ['panel.css'],
        runAt: 'document_idle',
        allFrames: true,
        persistAcrossSessions: true,
      }]);
    }
    // The script is registered for future loads; this page needs a reload.
    if (tab?.id) await chrome.tabs.reload(tab.id);
  } catch { /* scripting unavailable: the permission alone does nothing */ }
  render();
}

async function unwatch(origin, tab) {
  try { await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin)] }); } catch { /* not registered */ }
  try { await chrome.permissions.remove({ origins: [origin] }); } catch { /* already gone */ }
  if (tab?.id) { try { await chrome.tabs.reload(tab.id); } catch { /* closed */ } }
  render();
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
  const [state, tab, stored] = await Promise.all([
    read(), currentTab(), chrome.storage.sync.get('policy'),
  ]);
  const policy = { ...DEFAULTS, ...(stored.policy || {}) };
  const on = policy.mode !== 'off';

  const { host, watching } = await renderCoverage(tab, on);
  $('site').textContent = !host ? 'no page'
    : watching ? `watching ${host}`
    : `${host} — not watched`;
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

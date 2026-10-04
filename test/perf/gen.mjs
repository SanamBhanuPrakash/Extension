/**
 * A conversation the size real ones reach, that behaves like a real one.
 *
 * Two properties matter and the first version of this file had only one.
 *
 * Size: ChatGPT keeps every turn of a thread in the DOM until it virtualises,
 * and the threads people worry about pasting into are the long technical ones
 * — code blocks, lists, tool output. 1500 turns is not a stress test, it is a
 * fortnight of one project in one thread.
 *
 * Motion: a static fixture is not a chat page. Chhanni's response scanner is
 * driven by a MutationObserver, so against static HTML it never runs and a
 * measurement of "the extension on a long conversation" measures nothing at
 * all. Real pages stream a reply token by token, and most of them keep
 * something moving in the DOM the whole time — a typing indicator, a caret,
 * a progress shimmer. Both are modelled here:
 *
 *   __stream(text, opts)   appends an assistant turn a few characters at a
 *                          time, the way a streamed reply arrives
 *   __ticker(ms)           adds and removes a node every `ms` forever, the
 *                          way an animated indicator does
 *
 * The composer is the shape Chhanni has to recognise: a textarea with
 * ChatGPT's own `#prompt-textarea` id and a Send button with an aria-label.
 * `window.__sent` records what the page would have transmitted.
 */
const LOREM = 'The migration plan depends on whether the replica lag stays under two seconds during the cutover window, which we have not yet measured on the production shard. ';
const CODE = `async function handler(req, res) {\n  const rows = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);\n  if (!rows.length) return res.status(404).end();\n  return res.json(rows[0]);\n}`;

function turn(i) {
  const user = `<div class="turn user"><div class="bubble"><p>${LOREM.repeat(2)} (question ${i})</p></div></div>`;
  const asst = `<div class="turn assistant"><div class="bubble"><p>${LOREM.repeat(4)}</p>`
    + (i % 3 === 0 ? `<pre><code>${CODE}</code></pre>` : '')
    + `<ul>${Array.from({ length: 4 }, (_, k) => `<li>point ${k} about step ${i}</li>`).join('')}</ul></div></div>`;
  return user + asst;
}

const RUNTIME = `
window.__sent = [];
document.getElementById('send').addEventListener('click', () => {
  window.__sent.push(document.getElementById('prompt-textarea').value);
});

// A streamed reply. Characters arrive in small chunks on a timer, which is
// what a token stream looks like to the DOM.
window.__stream = (text, opts) => {
  const { chunk = 6, every = 25 } = opts || {};
  const wrap = document.createElement('div');
  wrap.className = 'turn assistant streaming';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const p = document.createElement('p');
  bubble.appendChild(p);
  wrap.appendChild(bubble);
  document.body.insertBefore(wrap, document.querySelector('.app'));
  let i = 0;
  return new Promise((done) => {
    const t = setInterval(() => {
      if (i >= text.length) { clearInterval(t); wrap.classList.remove('streaming'); done(); return; }
      p.appendChild(document.createTextNode(text.slice(i, i + chunk)));
      i += chunk;
    }, every);
  });
};

// An animated indicator: one node in, one node out, forever. Every chat
// product on the list has something that does this.
let tick = null;
window.__ticker = (ms) => {
  const host = document.createElement('div');
  host.className = 'tick';
  document.body.insertBefore(host, document.querySelector('.app'));
  let on = false;
  tick = setInterval(() => {
    on = !on;
    host.textContent = on ? '\\u2022' : '';
  }, ms);
};
window.__stopTicker = () => { clearInterval(tick); tick = null; };
`;

export function conversation(n) {
  const body = Array.from({ length: n }, (_, i) => turn(i)).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>conversation ${n}</title>
<style>body{font:14px system-ui;margin:0;padding:0 0 140px}
.turn{padding:10px 20px}.user{background:#f7f7f8}.bubble{max-width:760px;margin:0 auto}
pre{background:#0d1117;color:#c9d1d9;padding:12px;overflow:auto}
.tick{height:16px;text-align:center;color:#888}
.app{position:fixed;bottom:0;left:0;right:0;padding:16px;background:#fff;border-top:1px solid #ddd}
form{display:flex;gap:8px;max-width:760px;margin:0 auto}#prompt-textarea{flex:1;min-height:56px}</style>
${body}
<div class="app"><form class="composer"><textarea id="prompt-textarea" placeholder="Send a message to the model"></textarea>
<button type="button" id="send" aria-label="Send message">Send</button></form></div>
<script>${RUNTIME}</script>`;
}

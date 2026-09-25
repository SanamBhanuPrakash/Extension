/**
 * Store listing assets.
 *
 * Chrome requires screenshots at exactly 1280x800 or 640x400, and a 440x280
 * promotional tile. Scaling a render down softens the text, so each is
 * composed at its final size in real Chromium — same harness as the UI
 * verification, same content script, same engine.
 *
 *   npm install --no-save playwright-core
 *   node scripts/store-assets.mjs
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'extension');
const out = join(here, '..', 'docs', 'store');
mkdirSync(out, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

const CHAT = (body, composer) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/fonts/inter.css"><link rel="stylesheet" href="/panel.css">
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin:0; height:100vh; background:#0d1117; color:#c9d1d9; display:flex; flex-direction:column;
         font:14px/1.62 'Inter var', ui-sans-serif, system-ui; overflow:hidden }
  .bar { height:44px; flex:none; display:flex; align-items:center; gap:9px; padding:0 18px;
         border-bottom:1px solid #1c2128; color:#7d8590; font-size:12.5px }
  .bar .dot { width:9px;height:9px;border-radius:50%;background:#2d333b }
  .thread { flex:1; overflow:hidden; padding:22px 0 }
  .wrap { width:min(680px,88%); margin:0 auto }
  .msg { display:flex; gap:12px; margin-bottom:17px }
  .av { width:26px;height:26px;border-radius:7px;flex:none;background:linear-gradient(140deg,#f2a33c,#c4283f) }
  .av.you { background:linear-gradient(140deg,#4d8df5,#9b5cf6) }
  .bubble b { display:block; font-size:12.5px; color:#8b949e; margin-bottom:3px; font-weight:590 }
  pre { background:#161b22;border:1px solid #21262d;border-radius:10px;padding:10px 12px;
        font:11.5px/1.62 ui-monospace,Menlo,monospace;color:#a5d6ff;margin:8px 0;white-space:pre-wrap }
  .composer { flex:none; width:min(680px,88%); margin:0 auto 20px; background:#161b22;
              border:1px solid #30363d; border-radius:15px; padding:12px 15px }
  textarea { width:100%; min-height:58px; background:transparent;border:0;outline:0;color:inherit;
             font:14px/1.6 'Inter var', ui-sans-serif, system-ui; resize:none }
</style></head><body>
<div class="bar"><span class="dot"></span><span>Assistant</span></div>
<div class="thread"><div class="wrap">${body}</div></div>
<div class="composer"><textarea id="c" placeholder="Message…">${composer || ''}</textarea></div>
<script src="/content.js"></script></body></html>`;

const THREAD = `
<div class="msg"><div class="av you"></div><div class="bubble"><b>You</b>
The nightly sync job started failing after we moved the worker to the new cluster.</div></div>
<div class="msg"><div class="av"></div><div class="bubble"><b>Assistant</b>
That usually points at credentials or network policy. Can you share the worker config and the error?
<pre>Error: connect ETIMEDOUT 10.42.0.17:5432
    at Socket.&lt;anonymous&gt; (/srv/sync/node_modules/pg/lib/client.js:132:11)</pre>
If the database is reachable from the old cluster but not the new one, check the security group first.</div></div>
<div class="msg"><div class="av you"></div><div class="bubble"><b>You</b>
Sure — pasting the whole env file.</div></div>`;

const server = createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u.startsWith('/scene/')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(global.__SCENE__ || CHAT(THREAD, ''));
  }
  let body;
  try { body = readFileSync(join(root, u)); } catch { res.writeHead(404); return res.end('x'); }
  res.writeHead(200, { 'content-type': TYPES[extname(u)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(8735, r));

const exe = `/opt/pw-browsers/${readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium-'))}/chrome-linux/chrome`;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

const STUB = `window.chrome={storage:{sync:{get:async()=>({policy:{mode:'warn',disabled:[],allow:[]}}),set:async()=>{}},
 local:{get:async()=>({}),set:async()=>{}},managed:{get:async()=>({})},onChanged:{addListener:()=>{}}},
 tabs:{query:async()=>[{url:'https://claude.ai/new'}]},runtime:{getURL:p=>'/'+p,openOptionsPage:()=>{}}};`;

const PAYLOADS = {
  'screenshot-1-credentials': `Deploy is failing, can you spot the problem?

  AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
  DATABASE_URL=postgres://sync_prod:Xq7vTm2Lp@db-prod.internal:5432/orders
  STRIPE_KEY=rzp_live_9xKmNpLrTvWx4Y

Customer card on file 4242 4242 4242 4242, PAN ABCPD1234E.`,
  'screenshot-2-bulk': ['customer_id,name,email,phone,city',
    ...Array.from({ length: 184 }, (_, i) =>
      `${9000 + i},Customer ${i},c${i}@northwind.co.in,9${String(812345670 + i)},Pune`)].join('\n'),
  'screenshot-3-prose': `Can you help me draft a reply to this customer?

Spoke to Priya Nair yesterday about the renewal. She said the invoice went to
the wrong address — it should be Flat 3B, 14 Koregaon Park Road, Pune 411001.
Dr. Venkataraman confirmed the same.

Regards,
Anita Deshpande`,
  'screenshot-4-board': `PRIVILEGED AND CONFIDENTIAL — DO NOT DISTRIBUTE

Board, ahead of Thursday: ARR closed the quarter at $4.2M, up 31%. Cash runway
is 14 months at current burn. We signed the term sheet with Meridian on Tuesday.
Material non-public information until the announcement on the 14th.`,
};

for (const [name, payload] of Object.entries(PAYLOADS)) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  await page.addInitScript(STUB);
  await page.goto('http://127.0.0.1:8735/scene/x.html');
  await page.waitForTimeout(900);
  await page.click('#c');
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    document.getElementById('c').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, payload);
  await page.waitForSelector('.chhanni-panel', { timeout: 6000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`  ${name}.png  1280x800`);
  await page.close();
}

// Promotional tile: 440x280, the mark and the one-line claim.
const tile = await browser.newPage({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 2 });
await tile.setContent(`<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="http://127.0.0.1:8735/fonts/inter.css"></head>
<body style="margin:0;width:440px;height:280px;display:flex;flex-direction:column;align-items:center;
 justify-content:center;gap:13px;background:#14181f;font-family:'Inter var',ui-sans-serif,system-ui;color:#eef1f6;
 background-image:radial-gradient(42% 44% at 14% 6%,rgba(242,163,60,.20),transparent 70%),
 radial-gradient(46% 46% at 88% 16%,rgba(77,141,245,.16),transparent 72%)">
<img src="http://127.0.0.1:8735/icons/icon-128.png" width="60" height="60" style="border-radius:15px">
<div style="font-size:27px;font-weight:620;letter-spacing:-.025em">Chhanni</div>
<div style="font-size:13px;color:#a2abb9;text-align:center;max-width:330px;line-height:1.5">
Catches keys, customer records and confidential material<br>before your prompt leaves the browser</div>
<div style="font-size:11px;color:#f2a33c;font-weight:510;letter-spacing:.02em">99.88% precision · no network permission</div>
</body></html>`);
await tile.waitForTimeout(700);
await tile.screenshot({ path: join(out, 'promo-tile-440x280.png') });
console.log('  promo-tile-440x280.png');

await browser.close();
server.close();

/**
 * Visual verification harness.
 *
 * Renders the popup, the settings page and the in-page panel in real Chromium,
 * and runs the paste -> redact flow end to end against a mock composer, so the
 * UI is checked rather than assumed. It also catches the class of bug that unit
 * tests cannot see: a CSS specificity mistake that silently unstyles a button.
 *
 * This is the one thing in the project with a dependency, and it is optional:
 *
 *   npm install --no-save playwright-core
 *   node scripts/render-ui.mjs          # writes PNGs to /tmp/claude-0/
 *
 * Nothing that ships imports it.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png' };
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/panel.css">
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;background:#0d1117;font:14px/1.6 ui-sans-serif,system-ui;color:#c9d1d9;
       display:flex;flex-direction:column;align-items:center;padding:28px 0 24px}
  /* Content behind the panel, so the backdrop blur has something to work on. */
  .thread{width:min(760px,92vw);flex:1}
  .msg{margin-bottom:18px;display:flex;gap:12px}
  .av{width:26px;height:26px;border-radius:7px;flex:none;background:linear-gradient(140deg,#f2a33c,#c4283f)}
  .av.you{background:linear-gradient(140deg,#4d8df5,#9b5cf6)}
  .bubble{flex:1}
  .bubble b{display:block;font-size:12.5px;color:#8b949e;margin-bottom:3px}
  pre{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:11px 13px;
      font:12px/1.65 ui-monospace,Menlo,monospace;color:#a5d6ff;overflow-x:auto;margin:9px 0}
  .composer{width:min(760px,92vw);background:#161b22;border:1px solid #30363d;border-radius:16px;padding:13px 15px}
  textarea{width:100%;min-height:74px;background:transparent;border:0;outline:0;color:inherit;
           font:14px/1.6 ui-sans-serif,system-ui;resize:none}
</style></head><body>
<div class="thread">
  <div class="msg"><div class="av you"></div><div class="bubble"><b>You</b>
    The nightly sync job started failing after we moved the worker to the new cluster.</div></div>
  <div class="msg"><div class="av"></div><div class="bubble"><b>Assistant</b>
    That usually points at credentials or network policy. Can you share the worker config and the error?
    <pre>Error: connect ETIMEDOUT 10.42.0.17:5432
    at Socket.&lt;anonymous&gt; (/srv/sync/node_modules/pg/lib/client.js:132:11)
    at Object.onceWrapper (node:events:634:26)</pre>
    If the database is reachable from the old cluster but not the new one, check the security group first.</div></div>
  <div class="msg"><div class="av you"></div><div class="bubble"><b>You</b>
    Sure, one second — pasting the whole env file.</div></div>
</div>
<div class="composer"><textarea id="c" placeholder="Message…"></textarea></div>
<script>
  // Stands in for the AI site's own upload handler. Chhanni intercepts the
  // first drop in the capture phase and re-dispatches an allowed one, so
  // whatever lands here is exactly what would have been uploaded.
  window.__ATTACHED__ = [];
  document.getElementById('c').addEventListener('drop', (e) => {
    for (const f of e.dataTransfer.files) {
      window.__ATTACHED__.push({ name: f.name, size: f.size, type: f.type });
    }
  });
</script>
<script src="/content.js"></script></body></html>`;

const fixtures = join(root, '..', 'test', 'fixtures');

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/harness.html') { res.writeHead(200, {'content-type':'text/html'}); return res.end(HARNESS); }
  // Real fixture bytes, so the attachment path is exercised with a real ZIP
  // container and a real JPEG rather than a string pretending to be one.
  if (url.startsWith('/fixtures/')) {
    let body;
    try { body = readFileSync(join(fixtures, decodeURIComponent(url.slice(10)))); }
    catch { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(body);
  }
  const p = join(root, decodeURIComponent(url));
  let body;
  try { body = readFileSync(p); } catch { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(8731, r));

const exe = `/opt/pw-browsers/${readdirSync('/opt/pw-browsers').find(d => d.startsWith('chromium-'))}/chrome-linux/chrome`;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

const now = Date.now();
const history = { caught: 47, redacted: 41, sent: 6, events: [
  { ruleId:'aws_access_key_id', label:'AWS access key ID', severity:'critical', preview:'AKI************PLE', fingerprint:'a1b2c3d4', host:'claude.ai', action:'redacted', at: now-4*60e3 },
  { ruleId:'db_connection_string', label:'Database URL with password', severity:'critical', preview:'postgr******orders', fingerprint:'b2c3d4e5', host:'claude.ai', action:'redacted', at: now-4*60e3 },
  { ruleId:'payment_card', label:'Payment card number', severity:'critical', preview:'424***********242', fingerprint:'c3d4e5f6', host:'chatgpt.com', action:'redacted', at: now-3*3600e3 },
  { ruleId:'email', label:'Email address', severity:'low', preview:'r.i**********.in', fingerprint:'d4e5f6a7', host:'chatgpt.com', action:'sent', at: now-3*3600e3 },
  { ruleId:'github_token', label:'GitHub token', severity:'critical', preview:'ghp_ab******b9xQ', fingerprint:'e5f6a7b8', host:'gemini.google.com', action:'redacted', at: now-26*3600e3 },
  { ruleId:'aws_access_key_id', label:'AWS access key ID', severity:'critical', preview:'AKI************PLE', fingerprint:'a1b2c3d4', host:'chatgpt.com', action:'redacted', at: now-50*3600e3 },
  { ruleId:'pan_india', label:'Indian PAN', severity:'high', preview:'ABC****34E', fingerprint:'f6a7b8c9', host:'claude.ai', action:'redacted', at: now-72*3600e3 },
]};

const stub = `
  window.__HISTORY__ = ${JSON.stringify(history)};
  window.__RECORDED__ = [];
  window.chrome = {
    storage: {
      sync:{ get: async()=>({policy:{mode:'warn',disabled:[],allow:[]}}), set: async()=>{} },
      local:{ get: async()=>({history:window.__HISTORY__}), set: async(v)=>{ window.__RECORDED__.push(v); } },
      onChanged:{ addListener:()=>{} },
    },
    tabs:{ query: async()=>[{url:'https://claude.ai/new'}] },
    runtime:{ getURL:(p)=>'/'+p, openOptionsPage:()=>{} },
  };`;

const BULK = ['customer_id,name,email,phone,city',
  ...Array.from({ length: 184 }, (_, i) =>
    `${9000 + i},Customer ${i},c${i}@northwind.co.in,9${String(812345670 + i)},Pune`)].join('\n');

const BOARD = `PRIVILEGED AND CONFIDENTIAL \u2014 DO NOT DISTRIBUTE

Board, ahead of Thursday: ARR closed the quarter at $4.2M, up 31%. Cash runway
is 14 months at current burn. We signed the term sheet with Meridian on Tuesday;
due diligence opens next week and the data room goes live Monday. This is
material non-public information until the announcement on the 14th.`;

const PROSE = `Hi, can you help me draft a reply to this customer?

Spoke to Priya Nair yesterday about the renewal. She said the invoice went to
the wrong address \u2014 it should be Flat 3B, 14 Koregaon Park Road, Pune 411001.
Dr. Venkataraman confirmed the same. Her PAN on file is ABCPD1234E.

I have looped in Marcus Whitfield (Director, Revenue).

Regards,
Anita Deshpande`;

const LEAK = `Deploy is failing, can you spot the problem?

  AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
  DATABASE_URL=postgres://app_prod:Xq7vTm2Lp@db-prod.internal:5432/orders
  STRIPE_KEY=${['sk', 'live', '51H8xQ2KmNpLrTvWx4YzAbCdE'].join('_')}

Customer record: r.iyer@northwind.co.in, phone 9876543210,
card 4242 4242 4242 4242, PAN ABCPD1234E.
Order 1234567890123456 went through fine.`;

async function shot(name, file, width, dark, prep) {
  const page = await browser.newPage({ viewport:{width,height:820}, colorScheme: dark?'dark':'light', deviceScaleFactor:2 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.addInitScript(stub);
  await page.goto(`http://127.0.0.1:8731/${file}`);
  await page.waitForTimeout(500);
  const extra = prep ? await prep(page) : '';
  const h = await page.evaluate(() => Math.ceil(document.body.scrollHeight));
  if (file.startsWith('harness')) {
    // Crop around the panel with margin, so the backdrop blur is visible
    // against the content it is actually sitting over.
    const box = await page.locator('.chhanni-panel').boundingBox();
    const pad = 46;
    await page.screenshot({ path: `/tmp/claude-0/${name}.png`, clip: {
      x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
      width: box.width + pad * 2, height: box.height + pad * 2,
    } });
  } else {
    await page.setViewportSize({ width, height: Math.min(h + 8, 2000) });
    await page.screenshot({ path: `/tmp/claude-0/${name}.png` });
  }
  console.log(name.padEnd(15), errs.length ? 'ERRORS: '+errs.join(' | ') : 'clean', extra);
  await page.close();
}

const firePaste = (payload = LEAK) => async (page) => {
  await page.click('#c');
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    document.getElementById('c').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, payload);
  await page.waitForSelector('.chhanni-panel', { timeout: 5000 });
  await page.waitForTimeout(400);
  return `panel shown, composer="${await page.inputValue('#c').then((v) => v.slice(0, 20))}"`;
};

/**
 * Drops real files on the composer.
 *
 * Fetched over the harness server and turned into File objects in the page, so
 * the content script sees the same bytes a browser would hand it from the
 * user's disk — a genuine ZIP container, a genuine JPEG with an EXIF block.
 */
const fireDrop = (names) => async (page) => {
  await page.evaluate(async (names) => {
    const dt = new DataTransfer();
    for (const name of names) {
      const res = await fetch('/fixtures/' + name);
      const buf = await res.arrayBuffer();
      dt.items.add(new File([buf], name, { type: '' }));
    }
    document.getElementById('c').dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, names);
  await page.waitForSelector('.chhanni-panel', { timeout: 8000 });
  await page.waitForTimeout(400);
  return `panel shown for ${names.join(', ')}`;
};

await shot('popup-light', 'popup.html', 360, false);
await shot('popup-dark', 'popup.html', 360, true);
await shot('panel-dark', 'harness.html', 900, true, firePaste());
await shot('panel-light', 'harness.html', 900, false, firePaste());
await shot('panel-bulk', 'harness.html', 900, true, firePaste(BULK));
await shot('panel-board', 'harness.html', 900, true, firePaste(BOARD));
await shot('panel-prose', 'harness.html', 900, true, firePaste(PROSE));
await shot('panel-docx', 'harness.html', 900, true, fireDrop(['contract.docx']));
await shot('panel-image', 'harness.html', 900, true, fireDrop(['photo.jpg']));
await shot('panel-sheet', 'harness.html', 900, true, fireDrop(['employees.xlsx', 'screenshot.png']));
await shot('options-dark', 'options.html', 800, true, async (p) => { await p.click('#loadSample'); await p.waitForTimeout(300); });
await shot('options-light', 'options.html', 800, false, async (p) => { await p.click('#loadSample'); await p.waitForTimeout(300); });

// End-to-end: does "Redact and continue" actually clean the composer?
const page = await browser.newPage({ viewport:{width:900,height:820} });
await page.addInitScript(stub);
await page.goto('http://127.0.0.1:8731/harness.html');
// The content script dynamic-imports eleven engine modules plus the font.
await page.waitForTimeout(900);
await firePaste()(page);
await page.waitForSelector('.chhanni-primary', { timeout: 8000 });
await page.click('.chhanni-primary');
await page.waitForTimeout(300);
const final = await page.inputValue('#c');
const { scan } = await import('../src/detect.js');
console.log('\n--- end-to-end redaction ---');
console.log(final);
console.log('\nverdict after redaction:', scan(final).verdict);
console.log('recorded to storage:', JSON.stringify(await page.evaluate(() => window.__RECORDED__.length)) + ' write(s)');

// End-to-end, attachments: a DOCX and a photograph go in, and what the site
// receives is the redacted text and an image with its EXIF gone.
const page2 = await browser.newPage({ viewport: { width: 900, height: 820 } });
const errs2 = [];
page2.on('pageerror', (e) => errs2.push(e.message));
await page2.addInitScript(stub);
await page2.goto('http://127.0.0.1:8731/harness.html');
await page2.waitForTimeout(900);
await fireDrop(['contract.docx', 'photo.jpg'])(page2);
await page2.click('.chhanni-primary');
await page2.waitForTimeout(400);
const attached = await page2.evaluate(() => window.__ATTACHED__);
console.log('\n--- end-to-end attachments ---');
console.log('handed to the page:', JSON.stringify(attached, null, 2));
if (errs2.length) console.log('page errors:', errs2.join(' | '));

await browser.close();
server.close();

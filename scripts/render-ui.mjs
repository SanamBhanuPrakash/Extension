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
import { extname, join } from 'node:path';

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png' };
const root = join(process.cwd(), 'extension');
const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/panel.css">
<style>
  body{margin:0;height:100vh;background:#0e1117;font:14px ui-sans-serif,system-ui;color:#c9d1d9;
       display:flex;align-items:flex-end;justify-content:center;padding:0 0 26px}
  .composer{width:min(720px,90vw);background:#161b22;border:1px solid #30363d;border-radius:14px;padding:12px 14px}
  textarea{width:100%;min-height:82px;background:transparent;border:0;outline:0;color:inherit;
           font:14px ui-sans-serif,system-ui;resize:none}
</style></head><body>
<div class="composer"><textarea id="c" placeholder="Message…"></textarea></div>
<script src="/content.js"></script></body></html>`;

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/harness.html') { res.writeHead(200, {'content-type':'text/html'}); return res.end(HARNESS); }
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
    // Tight crop on the panel itself; the mock page around it is scaffolding.
    await page.locator('.chhanni-panel').screenshot({ path: `/tmp/claude-0/${name}.png` });
  } else {
    await page.setViewportSize({ width, height: Math.min(h + 8, 2000) });
    await page.screenshot({ path: `/tmp/claude-0/${name}.png` });
  }
  console.log(name.padEnd(15), errs.length ? 'ERRORS: '+errs.join(' | ') : 'clean', extra);
  await page.close();
}

const firePaste = async (page) => {
  await page.click('#c');
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    document.getElementById('c').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, LEAK);
  await page.waitForSelector('.chhanni-panel', { timeout: 3000 });
  await page.waitForTimeout(350);
  return `panel shown, composer="${await page.inputValue('#c')}"`;
};

await shot('panel-dark', 'harness.html', 900, true, firePaste);
await shot('panel-light', 'harness.html', 900, false, firePaste);
await shot('options-dark', 'options.html', 780, true, async (p) => { await p.click('#loadSample'); await p.waitForTimeout(300); });

// End-to-end: does "Redact and continue" actually clean the composer?
const page = await browser.newPage({ viewport:{width:900,height:820} });
await page.addInitScript(stub);
await page.goto('http://127.0.0.1:8731/harness.html');
await page.waitForTimeout(400);
await firePaste(page);
await page.click('.chhanni-primary');
await page.waitForTimeout(300);
const final = await page.inputValue('#c');
const { scan } = await import('./src/detect.js');
console.log('\n--- end-to-end redaction ---');
console.log(final);
console.log('\nverdict after redaction:', scan(final).verdict);
console.log('recorded to storage:', JSON.stringify(await page.evaluate(() => window.__RECORDED__.length)) + ' write(s)');
await browser.close();
server.close();

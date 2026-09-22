// The layer below the browser. A TLS handshake and HTTP/2 preface are
// fingerprintable before a single byte of JavaScript runs, so this asks which
// of them automation actually changes.
import { launchChrome } from './lib/chrome.js';
import { CHROME, CHROME_ARGS } from './lib/paths.js';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const { chromium } = await import('playwright-core');
const URL_ = 'https://tls.peet.ws/api/all';

const pull = (o) => ({
  ja3: o.tls?.ja3_hash ?? null,
  ja4: o.tls?.ja4 ?? null,
  peetprint: o.tls?.peetprint_hash ?? null,
  http2: o.http2?.akamai_fingerprint_hash ?? null,
  httpVersion: o.http_version ?? null,
  ua: (o.user_agent || '').slice(-40),
});
const rows = [];

async function viaBrowser(label, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-'));
  const proc = spawn(CHROME, [...args, '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: ['ignore','pipe','pipe'] });
  const ws = await new Promise((r, j) => { let b=''; const to=setTimeout(()=>j(new Error('no cdp')),20000);
    proc.stderr.on('data',(d)=>{b+=d; const m=b.match(/ws:\/\/[^\s]+/); if(m){clearTimeout(to);r(m[0]);}}); });
  const browser = await chromium.connectOverCDP(ws);
  const ctx = browser.contexts()[0]; const pg = ctx.pages()[0] || await ctx.newPage();
  await pg.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const json = JSON.parse(await pg.evaluate(() => document.body.innerText));
  rows.push({ client: label, ...pull(json) });
  await browser.close(); try { proc.kill('SIGKILL'); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}

// 1. Chrome headless, driven by Playwright over CDP
await viaBrowser('Chrome headless + Playwright', CHROME_ARGS);
// 2. the same binary headful, same driver
await viaBrowser('Chrome headful + Playwright', CHROME_ARGS.filter((a) => a !== '--headless=new'));
// 3. Lightpanda, a non-Chromium engine speaking CDP
{
  const port = 9701;
  const lp = spawn('/tmp/gl/lp/bin/lightpanda', ['serve','--host','127.0.0.1','--port',String(port)], { stdio:['ignore','pipe','pipe'] });
  await new Promise((r) => setTimeout(r, 2500));
  try {
    const puppeteer = (await import('puppeteer-core')).default;
    const b = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}/`, protocolTimeout: 60000 });
    const pg = await b.newPage();
    await pg.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const json = JSON.parse(await pg.evaluate(() => document.body.innerText));
    rows.push({ client: 'Lightpanda', ...pull(json) });
    await b.disconnect();
  } catch (e) { rows.push({ client: 'Lightpanda', error: e.message.split('\n')[0].slice(0,50) }); }
  try { lp.kill('SIGKILL'); } catch {}
}
// 4. curl, for contrast
try {
  const j = JSON.parse(execSync(`curl -s --max-time 30 ${URL_}`, { encoding: 'utf8' }));
  rows.push({ client: 'curl', ...pull(j) });
} catch (e) { rows.push({ client: 'curl', error: 'failed' }); }

console.table(rows);
console.log(JSON.stringify({
  distinctJa3: new Set(rows.filter(r=>r.ja3).map(r=>r.ja3)).size,
  distinctJa4: new Set(rows.filter(r=>r.ja4).map(r=>r.ja4)).size,
  distinctHttp2: new Set(rows.filter(r=>r.http2).map(r=>r.http2)).size,
}));
process.exit(0);

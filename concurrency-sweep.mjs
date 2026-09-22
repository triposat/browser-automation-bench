// Every browser-automation benchmark reports n=1 and then talks about scale.
// This sweeps concurrency and reports the MARGINAL cost of each added unit,
// for the two architectures people actually choose between.
import { browserFootprint, selfRssMb, t } from './lib/measure.js';
import { serveFixture } from './lib/serve.js';
import { launchChrome } from './lib/chrome.js';
import { execSync } from 'node:child_process';
const { chromium } = await import('playwright-core');

const LEVELS = [1, 2, 4, 8, 16];
const site = await serveFixture();
const EXTRACT = () => [...document.querySelectorAll('article.product_pod')].map((el) => ({
  title: el.querySelector('h3 a')?.getAttribute('title') ?? null,
  price: el.querySelector('.price_color')?.textContent?.trim() ?? null }));

const cpuOf = async (wsUrl) => {
  const { WebSocket } = await import('ws');
  try {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    const r = await new Promise((res) => {
      ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id === 1) res(m); });
      ws.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' }), { binary: false });
      setTimeout(() => res(null), 4000);
    });
    ws.close();
    return r && r.result ? +r.result.processInfo.reduce((a, x) => a + x.cpuTime, 0).toFixed(2) : null;
  } catch { return null; }
};

// ---- A: N contexts inside ONE browser
async function contextsInOneBrowser(n) {
  const c = await launchChrome();
  const browser = await chromium.connectOverCDP(c.wsUrl);
  const ctxs = [browser.contexts()[0]];
  for (let i = 1; i < n; i++) ctxs.push(await browser.newContext());
  const t0 = t();
  await Promise.all(ctxs.map(async (ctx) => {
    const pg = ctx.pages()[0] || await ctx.newPage();
    await pg.goto(site.url, { waitUntil: 'domcontentloaded' });
    const rows = await pg.evaluate(EXTRACT);
    if (rows.length !== 20) throw new Error('bad extraction');
  }));
  const wallMs = t() - t0;
  await new Promise((r) => setTimeout(r, 1500));
  const mem = browserFootprint(c.profileDir);
  const cpu = await cpuOf(c.wsUrl);
  const out = { mode: 'contexts', n, browserMb: mem.footprintMb, procs: mem.procs, cpuSeconds: cpu, wallMs, clientRssMb: selfRssMb() };
  await browser.close(); c.kill();
  return out;
}

// ---- B: N separate browsers
async function separateBrowsers(n) {
  const chromes = []; const browsers = [];
  for (let i = 0; i < n; i++) {
    const c = await launchChrome();
    chromes.push(c);
    browsers.push(await chromium.connectOverCDP(c.wsUrl));
  }
  const t0 = t();
  await Promise.all(browsers.map(async (b) => {
    const ctx = b.contexts()[0];
    const pg = ctx.pages()[0] || await ctx.newPage();
    await pg.goto(site.url, { waitUntil: 'domcontentloaded' });
    const rows = await pg.evaluate(EXTRACT);
    if (rows.length !== 20) throw new Error('bad extraction');
  }));
  const wallMs = t() - t0;
  await new Promise((r) => setTimeout(r, 1500));
  let mb = 0, procs = 0, cpu = 0;
  for (const c of chromes) {
    const m = browserFootprint(c.profileDir);
    mb += m.footprintMb; procs += m.procs;
    const x = await cpuOf(c.wsUrl); if (x) cpu += x;
  }
  const out = { mode: 'browsers', n, browserMb: +mb.toFixed(1), procs, cpuSeconds: +cpu.toFixed(2), wallMs, clientRssMb: selfRssMb() };
  for (const b of browsers) { try { await b.close(); } catch {} }
  for (const c of chromes) c.kill();
  return out;
}

const results = [];
for (const n of LEVELS) {
  for (const fn of [contextsInOneBrowser, separateBrowsers]) {
    try { const r = await fn(n); results.push(r); console.error(`${r.mode} n=${n} -> ${r.browserMb} MB, ${r.procs} procs, ${r.cpuSeconds}s, ${r.wallMs}ms`); }
    catch (e) { results.push({ mode: fn.name, n, error: e.message.slice(0, 80) }); console.error(`FAIL ${fn.name} n=${n}: ${e.message.slice(0,60)}`); }
    await new Promise((r) => setTimeout(r, 1200));
  }
}
await site.close();
console.log(JSON.stringify(results));
process.exit(0);

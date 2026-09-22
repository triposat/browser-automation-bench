// Every number in the guide comes from an 11 KB page. This re-runs the same
// comparison at three page weights to see which deltas survive real weight.
import { serveHeavy } from './fixture.mjs';
import { browserFootprint, selfRssMb, t } from '../lib/measure.js';
import { startCdpProxy } from '../lib/wsproxy.js';
import { launchChrome } from '../lib/chrome.js';
import { WebSocket } from 'ws';

const TIERS = [
  { name: 'light   (the guide\'s fixture)', cards: 20, ballastKb: 0, storeRows: 0 },
  { name: 'medium  (~a docs SPA)', cards: 200, ballastKb: 700, storeRows: 20000 },
  { name: 'heavy   (~a real app)', cards: 600, ballastKb: 3000, storeRows: 80000 },
];
const EXTRACT = () => [...document.querySelectorAll('article.product_pod')].map((el) => ({
  title: el.querySelector('h3 a')?.getAttribute('title') ?? null,
  price: el.querySelector('.price_color')?.textContent?.trim() ?? null }));

const cpuOf = async (wsUrl) => {
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

const results = [];
for (const tier of TIERS) {
  const site = await serveHeavy(tier);

  // ---- Playwright
  {
    const { chromium } = await import('playwright-core');
    const c = await launchChrome(); const px = await startCdpProxy(c.wsUrl, 0);
    const b = await chromium.connectOverCDP(`ws://127.0.0.1:${px.port}${new URL(c.wsUrl).pathname}`);
    const ctx = b.contexts()[0]; const pg = ctx.pages()[0] || await ctx.newPage();
    await pg.goto(site.url, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    const page = await pg.evaluate(() => ({
      domNodes: document.getElementsByTagName('*').length,
      heapMb: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null }));
    let m = t(); let u = px.stats.toBrowser;
    const loc = pg.locator('article.product_pod'); const n = Math.min(await loc.count(), 20);
    for (let i = 0; i < n; i++) { const el = loc.nth(i); await el.locator('h3 a').getAttribute('title'); await el.locator('.price_color').textContent(); }
    const walk = { ms: t() - m, msgs: px.stats.toBrowser - u };
    m = t(); u = px.stats.toBrowser;
    const rows = await pg.evaluate(EXTRACT);
    const single = { ms: t() - m, msgs: px.stats.toBrowser - u };
    await new Promise((r) => setTimeout(r, 1200));
    const mem = browserFootprint(c.profileDir);
    results.push({ tier: tier.name, client: 'Playwright', ...page, rawScriptKb: site.rawScriptKb,
      browserMb: mem.footprintMb, procs: mem.procs, cpu: await cpuOf(c.wsUrl),
      walkMs: walk.ms, walkMsgs: walk.msgs, evalMs: single.ms, evalMsgs: single.msgs,
      records: rows.length, clientRssMb: selfRssMb() });
    await b.close(); c.kill(); await px.close();
  }
  // ---- Puppeteer
  {
    const puppeteer = (await import('puppeteer-core')).default;
    const c = await launchChrome(); const px = await startCdpProxy(c.wsUrl, 0);
    const b = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${px.port}${new URL(c.wsUrl).pathname}`, protocolTimeout: 300000 });
    const pg = (await b.pages())[0] || await b.newPage();
    await pg.goto(site.url, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => window.__ready === true, { timeout: 30000 });
    let m = t(); let u = px.stats.toBrowser;
    const hs = (await pg.$$('article.product_pod')).slice(0, 20);
    for (const h of hs) { await (await h.$('h3 a')).evaluate((e) => e.getAttribute('title')); await (await h.$('.price_color')).evaluate((e) => e.textContent); }
    const walk = { ms: t() - m, msgs: px.stats.toBrowser - u };
    m = t(); u = px.stats.toBrowser;
    const rows = await pg.evaluate(EXTRACT);
    const single = { ms: t() - m, msgs: px.stats.toBrowser - u };
    await new Promise((r) => setTimeout(r, 1200));
    const mem = browserFootprint(c.profileDir);
    results.push({ tier: tier.name, client: 'Puppeteer', rawScriptKb: site.rawScriptKb,
      browserMb: mem.footprintMb, procs: mem.procs, cpu: await cpuOf(c.wsUrl),
      walkMs: walk.ms, walkMsgs: walk.msgs, evalMs: single.ms, evalMsgs: single.msgs,
      records: rows.length, clientRssMb: selfRssMb() });
    await b.disconnect(); c.kill(); await px.close();
  }
  await site.close();
  console.error(`tier done: ${tier.name}`);
}
console.log(JSON.stringify(results));
process.exit(0);

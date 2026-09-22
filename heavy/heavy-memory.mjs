// The guide's central claim is that Chromium costs the same whichever client
// drives it. That was measured on an 11 KB page. Re-test it at real weight.
import { serveHeavy } from './fixture.mjs';
import { browserFootprint } from '../lib/measure.js';
import { launchChrome } from '../lib/chrome.js';
import { WebSocket } from 'ws';
const REPEATS = 3;
const cpuOf = async (wsUrl) => {
  try {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    const r = await new Promise((res) => {
      ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id === 1) res(m); });
      ws.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' }), { binary: false });
      setTimeout(() => res(null), 4000); });
    ws.close();
    return r && r.result ? +r.result.processInfo.reduce((a, x) => a + x.cpuTime, 0).toFixed(2) : null;
  } catch { return null; }
};
const site = await serveHeavy({ cards: 600, ballastKb: 3000, storeRows: 80000 });
const out = { Playwright: [], Puppeteer: [] };
for (let i = 0; i < REPEATS; i++) {
  {
    const { chromium } = await import('playwright-core');
    const c = await launchChrome();
    const b = await chromium.connectOverCDP(c.wsUrl);
    const pg = b.contexts()[0].pages()[0] || await b.contexts()[0].newPage();
    await pg.goto(site.url, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));
    const m = browserFootprint(c.profileDir);
    out.Playwright.push({ mb: m.footprintMb, procs: m.procs, cpu: await cpuOf(c.wsUrl) });
    await b.close(); c.kill();
  }
  {
    const puppeteer = (await import('puppeteer-core')).default;
    const c = await launchChrome();
    const b = await puppeteer.connect({ browserWSEndpoint: c.wsUrl, protocolTimeout: 300000 });
    const pg = (await b.pages())[0] || await b.newPage();
    await pg.goto(site.url, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => window.__ready === true, { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));
    const m = browserFootprint(c.profileDir);
    out.Puppeteer.push({ mb: m.footprintMb, procs: m.procs, cpu: await cpuOf(c.wsUrl) });
    await b.disconnect(); c.kill();
  }
}
await site.close();
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
for (const k of Object.keys(out)) {
  const mb = out[k].map((x) => x.mb), cpu = out[k].map((x) => x.cpu);
  console.log(`${k.padEnd(11)} browser ${med(mb)} MB (${Math.min(...mb)}-${Math.max(...mb)})  cpu ${med(cpu)} s  procs ${out[k][0].procs}`);
}
process.exit(0);

// After 200 iterations the browser tree dropped 169 MB following a forced client
// GC plus a 1.5 s pause. Those are two different causes. Test them separately.
import { serveLeakFixture } from './fixture.mjs';
import { browserFootprint, selfRssMb } from '../lib/measure.js';
import { launchChrome } from '../lib/chrome.js';
const { chromium } = await import('playwright-core');
const ARM = process.argv.find((a) => a.startsWith('--arm='))?.split('=')[1];
const EXTRACT = () => [...document.querySelectorAll('article.product_pod')].map((el) => ({
  title: el.querySelector('h3 a')?.getAttribute('title') ?? null,
  price: el.querySelector('.price_color')?.textContent?.trim() ?? null }));

const site = await serveLeakFixture();
const chrome = await launchChrome();
const browser = await chromium.connectOverCDP(chrome.wsUrl);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] || await ctx.newPage();
for (let i = 1; i <= 200; i++) {
  await page.goto(site.url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(EXTRACT);
}
const before = { browserMb: browserFootprint(chrome.profileDir).footprintMb, clientRssMb: selfRssMb() };

if (ARM === 'idle-only') {
  await new Promise((r) => setTimeout(r, 1500));
} else if (ARM === 'gc-only') {
  if (global.gc) { global.gc(); global.gc(); global.gc(); }
} else if (ARM === 'gc-plus-idle') {
  if (global.gc) { global.gc(); global.gc(); }
  await new Promise((r) => setTimeout(r, 1500));
  if (global.gc) global.gc();
} else if (ARM === 'browser-gc') {
  // ask the browser to collect, rather than the client
  const s = await ctx.newCDPSession(page);
  await s.send('HeapProfiler.collectGarbage');
  await s.detach().catch(() => {});
}
const after = { browserMb: browserFootprint(chrome.profileDir).footprintMb, clientRssMb: selfRssMb() };
console.log(JSON.stringify({ arm: ARM, before, after,
  browserDeltaMb: +(after.browserMb - before.browserMb).toFixed(1),
  clientDeltaMb: +(after.clientRssMb - before.clientRssMb).toFixed(1) }));
await browser.close(); chrome.kill(); await site.close();
process.exit(0);

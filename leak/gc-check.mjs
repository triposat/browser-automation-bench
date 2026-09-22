// Client RSS grew in every mode. That is only a leak if it survives a forced GC.
// Run with --expose-gc so the distinction is measurable rather than assumed.
import { serveLeakFixture } from './fixture.mjs';
import { browserFootprint, selfRssMb } from '../lib/measure.js';
import { launchChrome } from '../lib/chrome.js';
const { chromium } = await import('playwright-core');
const N = Number(process.env.ITER || 200);
const EXTRACT = () => [...document.querySelectorAll('article.product_pod')].map((el) => ({
  title: el.querySelector('h3 a')?.getAttribute('title') ?? null,
  price: el.querySelector('.price_color')?.textContent?.trim() ?? null }));

const site = await serveLeakFixture();
const chrome = await launchChrome();
const browser = await chromium.connectOverCDP(chrome.wsUrl);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] || await ctx.newPage();

const heapMb = () => +(process.memoryUsage().heapUsed / 1048576).toFixed(1);
const ext = () => +(process.memoryUsage().external / 1048576).toFixed(1);
const rows = [];
const sample = (iter, label) => rows.push({ iter, label, rssMb: selfRssMb(), heapUsedMb: heapMb(), externalMb: ext(),
  browserMb: browserFootprint(chrome.profileDir).footprintMb });

sample(0, 'start');
for (let i = 1; i <= N; i++) {
  await page.goto(site.url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(EXTRACT);
  if (i % 50 === 0) sample(i, 'running');
}
sample(N, 'before gc');
if (global.gc) { global.gc(); global.gc(); await new Promise((r) => setTimeout(r, 1500)); global.gc(); }
sample(N, 'after forced gc');

console.log(JSON.stringify({ gcAvailable: !!global.gc, rows }, null, 1));
await browser.close(); chrome.kill(); await site.close();
process.exit(0);

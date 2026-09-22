// Four ways to loop the same extraction, tracked over hundreds of iterations.
// "Memory leaks" is folklore in every comparison article; this measures it.
import { serveLeakFixture } from './fixture.mjs';
import { browserFootprint, selfRssMb } from '../lib/measure.js';
import { launchChrome } from '../lib/chrome.js';
const { chromium } = await import('playwright-core');

const N = Number(process.env.ITER || 200);
const EVERY = Number(process.env.SAMPLE || 25);
const MODE = process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1];

const EXTRACT = () => [...document.querySelectorAll('article.product_pod')].map((el) => ({
  title: el.querySelector('h3 a')?.getAttribute('title') ?? null,
  price: el.querySelector('.price_color')?.textContent?.trim() ?? null }));

const site = await serveLeakFixture();
const chrome = await launchChrome();
const browser = await chromium.connectOverCDP(chrome.wsUrl);
const rootCtx = browser.contexts()[0];

// JS heap comes from the browser's own accounting, which separates
// "the page leaked" from "the browser process grew".
async function jsHeapMb(page) {
  try {
    const s = await rootCtx.newCDPSession(page);
    await s.send('Performance.enable');
    const { metrics } = await s.send('Performance.getMetrics');
    const h = metrics.find((m) => m.name === 'JSHeapUsedSize');
    await s.detach().catch(() => {});
    return h ? +(h.value / 1048576).toFixed(1) : null;
  } catch { return null; }
}

const samples = [];
let persistentPage = null;
let heapProbePage = null;

async function iterate(i) {
  if (MODE === 'reuse-page') {
    if (!persistentPage) persistentPage = rootCtx.pages()[0] || await rootCtx.newPage();
    await persistentPage.goto(site.url, { waitUntil: 'domcontentloaded' });
    const rows = await persistentPage.evaluate(EXTRACT);
    heapProbePage = persistentPage;
    return rows.length;
  }
  if (MODE === 'new-page-closed') {
    const pg = await rootCtx.newPage();
    await pg.goto(site.url, { waitUntil: 'domcontentloaded' });
    const rows = await pg.evaluate(EXTRACT);
    heapProbePage = null;
    await pg.close();
    return rows.length;
  }
  if (MODE === 'new-context-closed') {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await pg.goto(site.url, { waitUntil: 'domcontentloaded' });
    const rows = await pg.evaluate(EXTRACT);
    heapProbePage = null;
    await ctx.close();
    return rows.length;
  }
  if (MODE === 'new-context-leaked') {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await pg.goto(site.url, { waitUntil: 'domcontentloaded' });
    const rows = await pg.evaluate(EXTRACT);
    heapProbePage = pg;
    return rows.length;   // deliberately never closed
  }
  throw new Error('unknown mode');
}

let badExtractions = 0;
for (let i = 1; i <= N; i++) {
  let n = 0;
  try { n = await iterate(i); } catch (e) { badExtractions++; }
  if (n !== 20) badExtractions++;
  if (i % EVERY === 0 || i === 1) {
    const mem = browserFootprint(chrome.profileDir);
    samples.push({ iter: i, browserMb: mem.footprintMb, procs: mem.procs,
      clientRssMb: selfRssMb(),
      jsHeapMb: heapProbePage ? await jsHeapMb(heapProbePage) : null });
    process.stderr.write(`  ${MODE} ${i}/${N}  ${mem.footprintMb} MB  ${mem.procs} procs\r`);
    // stop before the box starts swapping, and say so rather than reporting a crash
    if (mem.footprintMb > 6000) { samples.push({ abortedAt: i, reason: 'browser tree passed 6 GB' }); break; }
  }
}
process.stderr.write('\n');
console.log(JSON.stringify({ mode: MODE, iterations: N, badExtractions, samples }));
try { await browser.close(); } catch {}
chrome.kill(); await site.close();
process.exit(0);

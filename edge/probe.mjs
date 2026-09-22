// The article tells readers to collapse a locator walk into one in-page
// evaluation. This measures where that advice stops being true.
import { serveEdgeCase } from './fixture.mjs';
import { launchChrome } from '../lib/chrome.js';
const { chromium } = await import('playwright-core');

const site = await serveEdgeCase();
const c = await launchChrome();
const browser = await chromium.connectOverCDP(c.wsUrl);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(site.url, { waitUntil: 'domcontentloaded' });

const byTag = (rows) => rows.reduce((a, t) => { const k = String(t).split('-')[0]; a[k] = (a[k] || 0) + 1; return a; }, {});

// 1. the naive single evaluation, immediately after domcontentloaded
const naive = await page.evaluate(() =>
  [...document.querySelectorAll('.item')].map((el) => el.dataset.title));

// 2. same evaluation, after waiting for the deferred render
await page.waitForTimeout(1200);
const afterWait = await page.evaluate(() =>
  [...document.querySelectorAll('.item')].map((el) => el.dataset.title));

// 3. after the interaction the page requires
await page.click('#load-more');
await page.waitForSelector('#gated .item');
const afterClick = await page.evaluate(() =>
  [...document.querySelectorAll('.item')].map((el) => el.dataset.title));

// 4. an evaluation that also walks open shadow roots
const withOpenShadow = await page.evaluate(() => {
  const out = [];
  const walk = (root) => {
    root.querySelectorAll('.item').forEach((el) => out.push(el.dataset.title));
    root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  walk(document);
  return out;
});

// 5. what a closed shadow root exposes
const closedProbe = await page.evaluate(() => {
  const h = document.getElementById('closed-host');
  return { shadowRootIsNull: h.shadowRoot === null, childElementCount: h.childElementCount };
});

// 6. frames: what the framework reaches that one evaluation cannot
const frameCounts = [];
for (const f of page.frames()) {
  try { frameCounts.push({ url: f.url().slice(0, 34), items: await f.evaluate(() => document.querySelectorAll('.item').length) }); }
  catch (e) { frameCounts.push({ url: f.url().slice(0, 34), error: e.message.split('\n')[0].slice(0, 44) }); }
}
const allFrames = frameCounts.reduce((a, f) => a + (f.items || 0), 0);

console.log(JSON.stringify({
  totalRecordsOnPage: site.totalRecords,
  naiveEvaluate: { found: naive.length, byBucket: byTag(naive) },
  afterWaiting: { found: afterWait.length },
  afterClicking: { found: afterClick.length },
  plusOpenShadowWalk: { found: withOpenShadow.length, byBucket: byTag(withOpenShadow) },
  closedShadowRoot: closedProbe,
  frames: frameCounts,
  reachableAcrossAllFrames: allFrames,
}, null, 1));

await browser.close(); c.kill(); site.close();
process.exit(0);

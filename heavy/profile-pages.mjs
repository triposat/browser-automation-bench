// Before picking a heavy target, measure what heavy means: transfer bytes,
// script bytes, request count, DOM nodes, and whether a repeatable list exists.
import { launchChrome } from './lib/chrome.js';
const { chromium } = await import('playwright-core');

const TARGETS = [
  ['books.toscrape.com (the article\'s current target)', 'https://books.toscrape.com/', 'article.product_pod'],
  ['react.dev', 'https://react.dev/', 'a'],
  ['angular.dev', 'https://angular.dev/', 'a'],
  ['developer.mozilla.org', 'https://developer.mozilla.org/en-US/docs/Web/API', 'a'],
  ['vuejs.org', 'https://vuejs.org/', 'a'],
];

const c = await launchChrome();
const browser = await chromium.connectOverCDP(c.wsUrl);
const rows = [];
for (const [label, url, sel] of TARGETS) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let transfer = 0, scriptBytes = 0, reqs = 0;
  page.on('response', async (r) => {
    reqs++;
    try {
      const len = Number(r.headers()['content-length'] || 0);
      transfer += len;
      if ((r.headers()['content-type'] || '').includes('javascript')) scriptBytes += len;
    } catch {}
  });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    const dom = await page.evaluate(() => ({
      nodes: document.getElementsByTagName('*').length,
      htmlChars: document.documentElement.outerHTML.length,
      heapMb: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    }));
    rows.push({ label, requests: reqs, transferKb: +(transfer / 1024).toFixed(0), scriptKb: +(scriptBytes / 1024).toFixed(0),
      domNodes: dom.nodes, htmlKb: +(dom.htmlChars / 1024).toFixed(0), jsHeapMb: dom.heapMb });
  } catch (e) { rows.push({ label, error: e.message.split('\n')[0].slice(0, 60) }); }
  await ctx.close();
}
console.table(rows);
await browser.close(); c.kill();
process.exit(0);

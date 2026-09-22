// Page script cannot open a closed shadow root. Can the protocol?
import { serveEdgeCase } from './fixture.mjs';
import { launchChrome } from '../lib/chrome.js';
const { chromium } = await import('playwright-core');
const site = await serveEdgeCase();
const c = await launchChrome();
const browser = await chromium.connectOverCDP(c.wsUrl);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(site.url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);

const out = {};
// 1. page script
out.pageScript = await page.evaluate(() => ({
  shadowRoot: document.getElementById('closed-host').shadowRoot === null ? 'null' : 'accessible',
  itemsVisible: document.querySelectorAll('#closed-host .item').length,
}));
// 2. Playwright's own selector engine, which pierces open shadow DOM
try {
  out.playwrightLocator = { count: await page.locator('#closed-host .item').count() };
} catch (e) { out.playwrightLocator = { error: e.message.split('\n')[0].slice(0, 60) }; }
// 3. CDP DOM domain with pierce
const s = await ctx.newCDPSession(page);
const { root } = await s.send('DOM.getDocument', { depth: -1, pierce: true });
let found = 0; const titles = [];
const walk = (n) => {
  if (n.attributes) {
    for (let i = 0; i < n.attributes.length; i += 2) {
      if (n.attributes[i] === 'data-title' && n.attributes[i + 1].startsWith('Item closedshadow')) { found++; titles.push(n.attributes[i + 1]); }
    }
  }
  (n.children || []).forEach(walk);
  (n.shadowRoots || []).forEach(walk);
  (n.contentDocument ? [n.contentDocument] : []).forEach(walk);
};
walk(root);
out.cdpDomPierce = { closedShadowItemsFound: found, sample: titles.slice(0, 2) };
console.log(JSON.stringify(out, null, 1));
await browser.close(); c.kill(); site.close();
process.exit(0);

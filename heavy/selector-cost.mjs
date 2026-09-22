// Puppeteer's walk message count scaled with page size even though the walk
// reads a fixed 20 cards. Split the selector call from the iteration to see why.
import { serveHeavy } from './fixture.mjs';
import { startCdpProxy } from '../lib/wsproxy.js';
import { launchChrome } from '../lib/chrome.js';
import { t } from '../lib/measure.js';

const TIERS = [{ cards: 20 }, { cards: 200 }, { cards: 600 }];
const rows = [];
for (const cfg of TIERS) {
  const site = await serveHeavy({ ...cfg, ballastKb: 0, storeRows: 0 });

  { // Puppeteer: $$ returns a handle per match
    const puppeteer = (await import('puppeteer-core')).default;
    const c = await launchChrome(); const px = await startCdpProxy(c.wsUrl, 0);
    const b = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${px.port}${new URL(c.wsUrl).pathname}`, protocolTimeout: 300000 });
    const pg = (await b.pages())[0] || await b.newPage();
    await pg.goto(site.url, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => window.__ready === true, { timeout: 30000 });
    let u = px.stats.toBrowser; let m = t();
    const hs = await pg.$$('article.product_pod');
    const selectOnly = { msgs: px.stats.toBrowser - u, ms: t() - m, handles: hs.length };
    u = px.stats.toBrowser; m = t();
    for (const h of hs.slice(0, 20)) {
      await (await h.$('h3 a')).evaluate((e) => e.getAttribute('title'));
      await (await h.$('.price_color')).evaluate((e) => e.textContent);
    }
    const read20 = { msgs: px.stats.toBrowser - u, ms: t() - m };
    rows.push({ cards: cfg.cards, client: 'Puppeteer $$', selectMsgs: selectOnly.msgs, handles: selectOnly.handles, read20Msgs: read20.msgs });
    await b.disconnect(); c.kill(); await px.close();
  }
  { // Playwright: locator is lazy until acted on
    const { chromium } = await import('playwright-core');
    const c = await launchChrome(); const px = await startCdpProxy(c.wsUrl, 0);
    const b = await chromium.connectOverCDP(`ws://127.0.0.1:${px.port}${new URL(c.wsUrl).pathname}`);
    const ctx = b.contexts()[0]; const pg = ctx.pages()[0] || await ctx.newPage();
    await pg.goto(site.url, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    let u = px.stats.toBrowser;
    const loc = pg.locator('article.product_pod');
    const count = await loc.count();
    const selectOnly = { msgs: px.stats.toBrowser - u, handles: count };
    u = px.stats.toBrowser;
    for (let i = 0; i < 20; i++) { const el = loc.nth(i); await el.locator('h3 a').getAttribute('title'); await el.locator('.price_color').textContent(); }
    const read20 = { msgs: px.stats.toBrowser - u };
    rows.push({ cards: cfg.cards, client: 'Playwright locator', selectMsgs: selectOnly.msgs, handles: selectOnly.handles, read20Msgs: read20.msgs });
    await b.close(); c.kill(); await px.close();
  }
  await site.close();
}
console.table(rows);
process.exit(0);

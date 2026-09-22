// From reading patchright's source notes: avoiding Runtime.enable is "the biggest
// patch" it makes, because a page can detect that CDP domain being enabled. The
// guide counts CDP messages but never asks which of them are themselves a tell.
// This reads the method tally straight off the counting proxy.
import { launchChrome } from './lib/chrome.js';
import { startCdpProxy } from './lib/wsproxy.js';

const out = {};
const run = async (name, fn) => {
  const c = await launchChrome();
  const px = await startCdpProxy(c.wsUrl, 0);
  try { await fn(`ws://127.0.0.1:${px.port}${new URL(c.wsUrl).pathname}`); } catch (e) { out[name] = { error: String(e.message).slice(0, 70) }; }
  const m = px.stats.methods;
  out[name] ??= {
    totalCommands: px.stats.toBrowser,
    runtimeEnable: m.get('Runtime.enable') ?? 0,
    enables: [...m.entries()].filter(([k]) => k.endsWith('.enable')).map(([k, v]) => `${k}${v > 1 ? ' x' + v : ''}`),
  };
  await px.close(); c.kill?.();
};

await run('playwright', async (url) => {
  const { chromium } = await import('playwright-core');
  const b = await chromium.connectOverCDP(url);
  const ctx = b.contexts()[0]; const p = ctx.pages()[0] || await ctx.newPage();
  await p.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => document.title); await b.close();
});
await run('puppeteer', async (url) => {
  const pup = (await import('puppeteer-core')).default;
  const b = await pup.connect({ browserWSEndpoint: url });
  const p = await b.newPage();
  await p.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => document.title); await b.close();
});
console.log(JSON.stringify(out, null, 1));

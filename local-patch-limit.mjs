// The guide shows patchright's launch-time patch vanishing when you connect to a
// browser you started yourself. That is a fact about patchright, not about the
// JS layer, and leaving it there implies local patching cannot work at all.
//
// This measures where the local ceiling actually sits: a CDP script hook applied
// to a browser this process did NOT launch, then the surfaces below JavaScript.
import puppeteer from 'puppeteer-core';
import { launchChrome } from './lib/chrome.js';

const read = (page) => page.evaluate(() => ({
  webdriver: navigator.webdriver,
  chrome: typeof window.chrome,
  cores: navigator.hardwareConcurrency,
}));

const c = await launchChrome();                       // started here, not by any stealth tool
const browser = await puppeteer.connect({ browserWSEndpoint: c.wsUrl, protocolTimeout: 60000 });
const out = {};

const bare = await browser.newPage();
await bare.goto('https://example.com', { waitUntil: 'domcontentloaded' });
out.connectedUnpatched = await read(bare);
await bare.close();

// The CDP-level hook: installed on a connection, not at launch.
const patched = await browser.newPage();
await patched.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  window.chrome = { runtime: {} };
});
await patched.goto('https://example.com', { waitUntil: 'domcontentloaded' });
out.connectedPatched = await read(patched);
await patched.close();
await browser.close(); c.kill?.();

console.log(JSON.stringify(out, null, 1));

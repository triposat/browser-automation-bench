// Contexts are 1.75x cheaper than separate browsers. What does that buy the
// site looking at you? Compare what two contexts expose against two browsers.
import { launchChrome } from './lib/chrome.js';
const { chromium } = await import('playwright-core');

const FP = `(() => {
  const c = document.createElement('canvas'); c.width=200; c.height=50;
  const x = c.getContext('2d');
  x.textBaseline='top'; x.font='14px Arial'; x.fillStyle='#f60'; x.fillRect(0,0,100,20);
  x.fillStyle='#069'; x.fillText('fingerprint-probe',2,15);
  const canvas = c.toDataURL();
  let webgl = 'none';
  try { const g=document.createElement('canvas').getContext('webgl');
    const d=g.getExtension('WEBGL_debug_renderer_info');
    webgl = d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'no-ext'; } catch {}
  return {
    ua: navigator.userAgent,
    platform: navigator.platform,
    hw: navigator.hardwareConcurrency,
    mem: navigator.deviceMemory ?? null,
    lang: navigator.languages.join(','),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: screen.width + 'x' + screen.height + 'x' + screen.colorDepth,
    canvasHash: canvas.slice(-48),
    webgl,
  };
})()`;

const hash = (o) => JSON.stringify(o);
const results = {};

// Two contexts inside one browser
{
  const c = await launchChrome();
  const b = await chromium.connectOverCDP(c.wsUrl);
  const a = b.contexts()[0];
  const d = await b.newContext();
  const pa = a.pages()[0] || await a.newPage();
  const pd = await d.newPage();
  await pa.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await pd.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  const f1 = await pa.evaluate(FP), f2 = await pd.evaluate(FP);
  const diff = Object.keys(f1).filter((k) => hash(f1[k]) !== hash(f2[k]));
  results.twoContextsOneBrowser = { identicalFields: Object.keys(f1).length - diff.length, totalFields: Object.keys(f1).length, differingFields: diff, sample: { ua: f1.ua.slice(-38), canvasHash: f1.canvasHash, hw: f1.hw, screen: f1.screen } };
  // storage isolation, which is what contexts DO buy
  await pa.evaluate(() => localStorage.setItem('probe', 'ctx-a'));
  results.storageIsolation = { contextBSeesContextAValue: await pd.evaluate(() => localStorage.getItem('probe')) };
  await b.close(); c.kill();
}

// Two separate browsers, default config
{
  const c1 = await launchChrome(); const c2 = await launchChrome();
  const b1 = await chromium.connectOverCDP(c1.wsUrl); const b2 = await chromium.connectOverCDP(c2.wsUrl);
  const p1 = b1.contexts()[0].pages()[0] || await b1.contexts()[0].newPage();
  const p2 = b2.contexts()[0].pages()[0] || await b2.contexts()[0].newPage();
  await p1.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await p2.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  const f1 = await p1.evaluate(FP), f2 = await p2.evaluate(FP);
  const diff = Object.keys(f1).filter((k) => hash(f1[k]) !== hash(f2[k]));
  results.twoSeparateBrowsers = { identicalFields: Object.keys(f1).length - diff.length, totalFields: Object.keys(f1).length, differingFields: diff };
  await b1.close(); await b2.close(); c1.kill(); c2.kill();
}

console.log(JSON.stringify(results, null, 1));
process.exit(0);

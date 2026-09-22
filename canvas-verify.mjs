// The claim is strong, so verify it byte-for-byte across three separate browsers
// with three different user-data-dirs, plus two contexts inside one.
import { launchChrome } from './lib/chrome.js';
import crypto from 'node:crypto';
const { chromium } = await import('playwright-core');
const FP = `(() => {
  const c=document.createElement('canvas'); c.width=280; c.height=60;
  const x=c.getContext('2d');
  x.textBaseline='alphabetic'; x.font='16px "Arial"'; x.fillStyle='#f60';
  x.fillRect(10,10,120,30); x.fillStyle='rgba(0,102,153,0.7)';
  x.fillText('Cwm fjordbank glyphs vext quiz \\u{1F600}',12,40);
  return { canvas: c.toDataURL(), ua: navigator.userAgent, hw: navigator.hardwareConcurrency,
           dm: navigator.deviceMemory ?? null, plat: navigator.platform };
})()`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const rows = [];
const chromes = [];
for (let i = 0; i < 3; i++) {
  const c = await launchChrome(); chromes.push(c);
  const b = await chromium.connectOverCDP(c.wsUrl);
  const p = b.contexts()[0].pages()[0] || await b.contexts()[0].newPage();
  await p.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  const f = await p.evaluate(FP);
  rows.push({ what: `browser ${i + 1} (own user-data-dir)`, canvasSha: sha(f.canvas), hw: f.hw, dm: f.dm, plat: f.plat });
  if (i === 0) {
    const ctx2 = await b.newContext(); const p2 = await ctx2.newPage();
    await p2.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    const f2 = await p2.evaluate(FP);
    rows.push({ what: 'browser 1, second context', canvasSha: sha(f2.canvas), hw: f2.hw, dm: f2.dm, plat: f2.plat });
  }
  await b.close();
}
for (const c of chromes) c.kill();
console.table(rows);
const uniq = new Set(rows.map((r) => r.canvasSha));
console.log(JSON.stringify({ distinctCanvasHashes: uniq.size, outOf: rows.length,
  verdict: uniq.size === 1 ? 'every browser and context produced the SAME canvas hash' : 'hashes differ' }));
process.exit(0);

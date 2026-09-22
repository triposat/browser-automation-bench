// Publishing "Lightpanda under-renders angular.dev" needs the same page measured
// both ways in one session, repeated, not a single sample against a stored number.
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { launchChrome } from './lib/chrome.js';

const LP = process.env.LIGHTPANDA_PATH || '/tmp/gl/lp/bin/lightpanda';
const TARGETS = [['react.dev','https://react.dev/'], ['angular.dev','https://angular.dev/'], ['vuejs.org','https://vuejs.org/']];
const count = async (page, url) => {
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  return page.evaluate(() => ({ nodes: document.querySelectorAll('*').length, links: document.querySelectorAll('a').length }));
};

const out = {};
for (const [name, url] of TARGETS) out[name] = { lightpanda: [], chrome: [] };

for (let i = 0; i < 3; i++) {
  for (const [name, url] of TARGETS) {
    const port = 9700 + Math.floor(Math.random() * 300);
    const lp = spawn(LP, ['serve','--host','127.0.0.1','--port',String(port)], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const b = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}`, protocolTimeout: 60000 });
      out[name].lightpanda.push(await count(await b.newPage(), url)); await b.close();
    } catch (e) { out[name].lightpanda.push({ error: String(e.message).slice(0,60) }); }
    lp.kill();
  }
}
const c = await launchChrome();
const b = await puppeteer.connect({ browserWSEndpoint: c.wsUrl, protocolTimeout: 60000 });
for (let i = 0; i < 3; i++) {
  for (const [name, url] of TARGETS) {
    const p = await b.newPage();
    try { out[name].chrome.push(await count(p, url)); } catch (e) { out[name].chrome.push({ error: String(e.message).slice(0,60) }); }
    await p.close();
  }
}
await b.close(); c.kill?.();
const med = (a) => { const s=a.filter(Number.isFinite).sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
for (const [k,v] of Object.entries(out)) {
  const ln = med(v.lightpanda.map(r=>r.nodes)), cn = med(v.chrome.map(r=>r.nodes));
  console.log(`${k.padEnd(12)} chrome ${String(cn).padStart(5)} nodes   lightpanda ${String(ln).padStart(5)}   ratio ${(ln/cn).toFixed(2)}`);
}

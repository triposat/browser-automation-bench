#!/usr/bin/env node
/**
 * browser-automation-bench
 *
 * Drives one pinned Chrome build from Playwright, Puppeteer, Selenium Classic and
 * Selenium BiDi, and reports what each costs: client memory, browser memory,
 * process count, and protocol round trips for an identical extraction task.
 *
 * Two things this measures that most comparisons do not:
 *   1. Browser memory as macOS phys_footprint / Linux PSS, not a sum of RSS.
 *      Summing RSS over a Chromium tree counts the shared binary image once per
 *      process and roughly doubles the answer.
 *   2. Protocol messages on the wire, via a counting proxy between client and
 *      browser, rather than inferred from the API surface.
 *
 *   npm i playwright-core puppeteer-core selenium-webdriver ws
 *   npx @puppeteer/browsers install chrome@stable chromedriver@stable --path ./.browsers
 *   node bench.mjs
 *
 * Set RTT=60 to inject 60 ms of round-trip latency and model a remote browser.
 */
import { execFileSync, execSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const RTT = Number(process.env.RTT || 0);
const REPEATS = Number(process.env.REPEATS || 3);
const t = () => Number(process.hrtime.bigint() / 1000000n);
const g = (p) => fs.globSync(p)[0];
const CHROME = process.env.CHROME_PATH || g('./.browsers/chrome/*/chrome-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing') || g('./.browsers/chrome/*/chrome-*/chrome');
const CHROMEDRIVER = process.env.CHROMEDRIVER_PATH || g('./.browsers/chromedriver/*/chromedriver-*/chromedriver');
const ARGS = ['--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-sync', '--disable-features=Translate,MediaRouter', '--headless=new'];

/* ---------- memory ---------- */
// phys_footprint on macOS, PSS on Linux. Both exclude the shared binary image.
function privateMb(pid) {
  try {
    if (process.platform === 'darwin') {
      const o = execFileSync('/usr/bin/footprint', ['-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = o.match(/phys_footprint:\s*([\d.]+)\s*([KMGB])/);
      if (!m) return 0;
      const v = parseFloat(m[1]);
      return m[2] === 'G' ? v * 1024 : m[2] === 'K' ? v / 1024 : m[2] === 'B' ? v / 1048576 : v;
    }
    const pss = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+) kB/m);
    return pss ? +pss[1] / 1024 : 0;
  } catch { return 0; }
}
function browserMemory(profileDir) {
  const rows = execSync('ps -eo pid=,command=', { encoding: 'utf8' }).trim().split('\n')
    .map((l) => { const m = l.trim().match(/^(\d+)\s+(.*)$/); return m ? { pid: +m[1], cmd: m[2] } : null; })
    .filter(Boolean).filter((r) => r.cmd.includes(profileDir) && !/\bps\b|footprint/.test(r.cmd));
  return { procs: rows.length, privateMb: +rows.reduce((a, r) => a + privateMb(r.pid), 0).toFixed(1) };
}
const clientRssMb = () => +(process.memoryUsage().rss / 1048576).toFixed(1);

// Chrome accounts for its own processes. SystemInfo lives on the browser-level
// session, not a page session, and it is the only portable CPU source here.
async function browserCpuSeconds(wsUrl) {
  try {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    const r = await new Promise((res) => {
      ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id === 1) res(m); });
      ws.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' }), { binary: false });
      setTimeout(() => res(null), 4000);
    });
    ws.close();
    if (!r || r.error) return null;
    return +r.result.processInfo.reduce((a, x) => a + x.cpuTime, 0).toFixed(2);
  } catch { return null; }
}

// Sum CPU time across every process belonging to one profile directory.
// chromedriver re-parents its browser, so this is how the Selenium arms get counted.
function treeCpuSeconds(profileDir) {
  try {
    const rows = execSync('ps -eo pid=,time=,command=', { encoding: 'utf8' }).trim().split('\n')
      .filter((l) => l.includes(profileDir) && !/\bps\b|footprint/.test(l));
    let total = 0;
    for (const l of rows) {
      const m = l.trim().match(/^\d+\s+(\S+)\s/);
      if (!m) continue;
      const p = m[1].split(':').map(Number);
      total += p.length === 3 ? p[0]*3600 + p[1]*60 + p[2] : p[0]*60 + p[1];
    }
    return +total.toFixed(2);
  } catch { return null; }
}

// Lightpanda is one process and speaks only part of CDP, so its CPU comes from ps.
function pidCpuSeconds(pid) {
  try {
    const t = execSync(`ps -p ${pid} -o time=`, { encoding: 'utf8' }).trim();
    const p = t.split(':').map(Number);
    return +(p.length === 3 ? p[0]*3600 + p[1]*60 + p[2] : p[0]*60 + p[1]).toFixed(2);
  } catch { return null; }
}

/* ---------- fixture ---------- */
// A 20-card listing shaped like a real catalogue page, served locally so the
// framework comparison is not polluted by network variance.
async function serveFixture() {
  const cards = Array.from({ length: 20 }, (_, i) => `<article class="product_pod">
    <h3><a href="/b/${i}" title="Product Title Number ${i}">Product Title Number ${i}</a></h3>
    <div class="product_price"><p class="price_color">£${(10 + i * 1.37).toFixed(2)}</p>
    <p class="instock availability">In stock</p></div></article>`).join('');
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Catalogue</title></head><body><ol class="row">${cards}</ol></body></html>`;
  const s = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(html); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}/`, close: () => new Promise((r) => s.close(r)) };
}

/* ---------- counting proxies ---------- */
async function cdpProxy(upstream, delayMs) {
  const half = delayMs / 2;
  const later = (fn) => (half > 0 ? setTimeout(fn, half) : fn());
  const stats = { up: 0, down: 0, bytesUp: 0, bytesDown: 0, methods: new Map() };
  const server = http.createServer(); const wss = new WebSocketServer({ server });
  const target = new URL(upstream);
  wss.on('connection', (client, req) => {
    const to = new WebSocket(`ws://${target.host}${req.url}`, { perMessageDeflate: false, maxPayload: 5e8 });
    const q = [];
    // CDP frames are text. Relaying the raw Buffer sends a binary frame and Chrome closes the socket.
    to.on('open', () => { q.forEach((m) => to.send(m, { binary: false })); q.length = 0; });
    client.on('message', (d) => {
      stats.up++; stats.bytesUp += d.length;
      try { const j = JSON.parse(d.toString()); if (j.method) stats.methods.set(j.method, (stats.methods.get(j.method) || 0) + 1); } catch {}
      const s = d.toString();
      later(() => { if (to.readyState === 1) to.send(s, { binary: false }); else q.push(s); });
    });
    to.on('message', (d) => { stats.down++; stats.bytesDown += d.length; const s = d.toString(); later(() => { if (client.readyState === 1) client.send(s, { binary: false }); }); });
    const bye = () => { try { to.close(); } catch {} try { client.close(); } catch {} };
    client.on('close', bye); to.on('close', bye); client.on('error', bye); to.on('error', bye);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, stats, close: () => new Promise((r) => { wss.close(); server.close(r); }) };
}
async function httpProxy(origin, delayMs) {
  const half = delayMs / 2;
  const later = (fn) => (half > 0 ? setTimeout(fn, half) : fn());
  const stats = { requests: 0, bytesUp: 0, bytesDown: 0, byRoute: new Map() };
  const u = new URL(origin);
  const server = http.createServer((req, res) => {
    stats.requests++;
    const route = `${req.method} ${req.url.replace(/\/session\/[0-9a-f]{20,}/i, '/session/{id}').replace(/\/element\/[^/]+/gi, '/element/{id}')}`;
    stats.byRoute.set(route, (stats.byRoute.get(route) || 0) + 1);
    const chunks = [];
    req.on('data', (c) => { chunks.push(c); stats.bytesUp += c.length; });
    req.on('end', () => later(() => {
      const p = http.request({ host: u.hostname, port: u.port, path: req.url, method: req.method, headers: { ...req.headers, host: u.host } }, (pr) => {
        const down = [];
        pr.on('data', (c) => { stats.bytesDown += c.length; down.push(c); });
        pr.on('end', () => later(() => { res.writeHead(pr.statusCode, pr.headers); res.end(Buffer.concat(down)); }));
      });
      p.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
      if (chunks.length) p.write(Buffer.concat(chunks));
      p.end();
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, stats, close: () => new Promise((r) => server.close(r)) };
}
async function launchChrome() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  const proc = spawn(CHROME, [...ARGS, '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let b = ''; const to = setTimeout(() => rej(new Error('no CDP endpoint')), 20000);
    proc.stderr.on('data', (d) => { b += d; const m = b.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(to); res(m[0]); } });
  });
  return { proc, profileDir, wsUrl, kill: () => { try { proc.kill('SIGKILL'); } catch {} try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch {} } };
}

/* ---------- the workload, four ways ---------- */
const EXTRACT = () => [...document.querySelectorAll('article.product_pod')].map((el) => ({
  title: el.querySelector('h3 a')?.getAttribute('title') ?? null,
  price: el.querySelector('.price_color')?.textContent?.trim() ?? null }));

async function runPlaywright(site) {
  const base = clientRssMb();
  const { chromium } = await import('playwright-core');
  const importCost = +(clientRssMb() - base).toFixed(1);
  const c = await launchChrome(); const px = await cdpProxy(c.wsUrl, RTT);
  const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${px.port}${new URL(c.wsUrl).pathname}`);
  const ctx = browser.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(site.url, { waitUntil: 'domcontentloaded' });
  let m = t(); let u = px.stats.up;
  const loc = page.locator('article.product_pod'); const n = await loc.count();
  for (let i = 0; i < n; i++) { const el = loc.nth(i); await el.locator('h3 a').getAttribute('title'); await el.locator('.price_color').textContent(); }
  const walk = { ms: t() - m, msgs: px.stats.up - u };
  m = t(); u = px.stats.up;
  const rows = await page.evaluate(EXTRACT);
  const single = { ms: t() - m, msgs: px.stats.up - u };
  await new Promise((r) => setTimeout(r, 1200));
  const mem = browserMemory(c.profileDir);
  const out = { tool: 'Playwright', protocol: 'CDP', cpuSeconds: await browserCpuSeconds(c.wsUrl), importCost, clientRssMb: clientRssMb(), ...mem, walk, single, items: rows.length, kbUp: +(px.stats.bytesUp / 1024).toFixed(1) };
  await browser.close(); c.kill(); await px.close();
  return out;
}

async function runPuppeteer(site) {
  const base = clientRssMb();
  const puppeteer = (await import('puppeteer-core')).default;
  const importCost = +(clientRssMb() - base).toFixed(1);
  const c = await launchChrome(); const px = await cdpProxy(c.wsUrl, RTT);
  const browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${px.port}${new URL(c.wsUrl).pathname}`, protocolTimeout: 300000 });
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.goto(site.url, { waitUntil: 'domcontentloaded' });
  let m = t(); let u = px.stats.up;
  for (const h of await page.$$('article.product_pod')) {
    await (await h.$('h3 a')).evaluate((e) => e.getAttribute('title'));
    await (await h.$('.price_color')).evaluate((e) => e.textContent);
  }
  const walk = { ms: t() - m, msgs: px.stats.up - u };
  m = t(); u = px.stats.up;
  const rows = await page.evaluate(EXTRACT);
  const single = { ms: t() - m, msgs: px.stats.up - u };
  await new Promise((r) => setTimeout(r, 1200));
  const mem = browserMemory(c.profileDir);
  const out = { tool: 'Puppeteer', protocol: 'CDP', cpuSeconds: await browserCpuSeconds(c.wsUrl), importCost, clientRssMb: clientRssMb(), ...mem, walk, single, items: rows.length, kbUp: +(px.stats.bytesUp / 1024).toFixed(1) };
  await browser.disconnect(); c.kill(); await px.close();
  return out;
}

async function runSeleniumClassic(site) {
  const base = clientRssMb();
  const { Builder, By } = await import('selenium-webdriver');
  const chromeMod = await import('selenium-webdriver/chrome.js');
  const importCost = +(clientRssMb() - base).toFixed(1);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-sel-'));
  const port = 9515 + Math.floor(Math.random() * 400);
  const cd = spawn(CHROMEDRIVER, [`--port=${port}`, '--silent'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1200));
  const px = await httpProxy(`http://127.0.0.1:${port}`, RTT);
  const opts = new chromeMod.Options();
  opts.setChromeBinaryPath(CHROME);
  for (const a of [...ARGS, `--user-data-dir=${profileDir}`]) opts.addArguments(a);
  const driver = await new Builder().forBrowser('chrome').usingServer(`http://127.0.0.1:${px.port}`).setChromeOptions(opts).build();
  await driver.get(site.url);
  let m = t(); let u = px.stats.requests;
  for (const el of await driver.findElements(By.css('article.product_pod'))) {
    await (await el.findElement(By.css('h3 a'))).getAttribute('title');
    await (await el.findElement(By.css('.price_color'))).getText();
  }
  const walk = { ms: t() - m, msgs: px.stats.requests - u };
  m = t(); u = px.stats.requests;
  const rows = await driver.executeScript(EXTRACT);
  const single = { ms: t() - m, msgs: px.stats.requests - u };
  await new Promise((r) => setTimeout(r, 1200));
  const mem = browserMemory(profileDir);
  const out = { tool: 'Selenium', protocol: 'WebDriver Classic', cpuSeconds: treeCpuSeconds(profileDir), importCost, clientRssMb: clientRssMb(), ...mem, walk, single, items: rows.length, kbUp: +(px.stats.bytesUp / 1024).toFixed(1), topRoutes: [...px.stats.byRoute.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4) };
  await driver.quit(); try { cd.kill('SIGKILL'); } catch {}
  await px.close(); try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  return out;
}

async function runSeleniumBidi(site) {
  const { Builder } = await import('selenium-webdriver');
  const chromeMod = await import('selenium-webdriver/chrome.js');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-bidi-'));
  const port = 9915 + Math.floor(Math.random() * 300);
  const cd = spawn(CHROMEDRIVER, [`--port=${port}`, '--silent'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1200));
  const opts = new chromeMod.Options();
  opts.setChromeBinaryPath(CHROME);
  for (const a of [...ARGS, `--user-data-dir=${profileDir}`]) opts.addArguments(a);
  opts.enableBidi();
  const driver = await new Builder().forBrowser('chrome').usingServer(`http://127.0.0.1:${port}`).setChromeOptions(opts).build();
  const socketUrl = (await driver.getCapabilities()).get('webSocketUrl');
  const ws = new WebSocket(socketUrl, { perMessageDeflate: false, maxPayload: 5e8 });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  let id = 0; const pending = new Map(); const st = { up: 0, bytesUp: 0 };
  // Delay BOTH legs. Delaying only the outbound send charges this arm half the
  // round trip that the proxied arms pay, which flatters it by roughly 2x.
  const later = (fn) => (RTT > 0 ? setTimeout(fn, RTT / 2) : fn());
  ws.on('message', (d) => {
    const j = JSON.parse(d.toString());
    if (j.type === 'event') return;
    later(() => { const p = pending.get(j.id); if (p) { pending.delete(j.id); p(j); } });
  });
  const send = (method, params = {}) => new Promise((res) => {
    const msg = JSON.stringify({ id: ++id, method, params });
    st.up++; st.bytesUp += Buffer.byteLength(msg); pending.set(id, res);
    later(() => ws.send(msg, { binary: false }));
  });
  const ctxId = (await send('browsingContext.getTree', {})).result.contexts[0].context;
  await send('browsingContext.navigate', { context: ctxId, url: site.url, wait: 'complete' });
  let m = t(); let u = st.up;
  const nodes = (await send('browsingContext.locateNodes', { context: ctxId, locator: { type: 'css', value: 'article.product_pod' }, maxNodeCount: 50 })).result.nodes;
  for (const n of nodes) {
    await send('script.callFunction', { functionDeclaration: 'function(){return this.querySelector("h3 a").getAttribute("title");}', target: { context: ctxId }, this: { handle: n.handle }, awaitPromise: false });
    await send('script.callFunction', { functionDeclaration: 'function(){return this.querySelector(".price_color").textContent.trim();}', target: { context: ctxId }, this: { handle: n.handle }, awaitPromise: false });
  }
  const walk = { ms: t() - m, msgs: st.up - u };
  m = t(); u = st.up;
  const ev = await send('script.evaluate', { expression: `(${EXTRACT.toString()})()`, target: { context: ctxId }, awaitPromise: false, resultOwnership: 'root' });
  const single = { ms: t() - m, msgs: st.up - u };
  await new Promise((r) => setTimeout(r, 1200));
  const mem = browserMemory(profileDir);
  const out = { tool: 'Selenium', protocol: 'WebDriver BiDi', cpuSeconds: treeCpuSeconds(profileDir), importCost: null, clientRssMb: clientRssMb(), ...mem, walk, single, items: nodes.length, kbUp: +(st.bytesUp / 1024).toFixed(1) };
  ws.close(); await driver.quit(); try { cd.kill('SIGKILL'); } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  return out;
}

async function runLightpanda(site) {
  const LP = process.env.LIGHTPANDA_PATH || '/tmp/gl/lp/bin/lightpanda';
  if (!fs.existsSync(LP)) return null;
  const base = clientRssMb();
  const puppeteer = (await import('puppeteer-core')).default;
  const importCost = +(clientRssMb() - base).toFixed(1);
  const port = 9400 + Math.floor(Math.random() * 400);
  const proc = spawn(LP, ['serve', '--host', '127.0.0.1', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((r) => setTimeout(r, 2500));
  const px = await cdpProxy(`ws://127.0.0.1:${port}/`, RTT);
  const browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${px.port}/`, protocolTimeout: 300000 });
  const page = await browser.newPage();
  await page.goto(site.url, { waitUntil: 'domcontentloaded' });
  let m = t(); let u = px.stats.up;
  for (const h of await page.$$('article.product_pod')) {
    await (await h.$('h3 a')).evaluate((e) => e.getAttribute('title'));
    await (await h.$('.price_color')).evaluate((e) => e.textContent);
  }
  const walk = { ms: t() - m, msgs: px.stats.up - u };
  m = t(); u = px.stats.up;
  const rows = await page.evaluate(EXTRACT);
  const single = { ms: t() - m, msgs: px.stats.up - u };
  await new Promise((r) => setTimeout(r, 1000));
  const out = { tool: 'Lightpanda', protocol: 'CDP (partial)', importCost, clientRssMb: clientRssMb(),
    procs: 1, privateMb: +privateMb(proc.pid).toFixed(1), cpuSeconds: pidCpuSeconds(proc.pid),
    walk, single, items: rows.length, kbUp: +(px.stats.bytesUp / 1024).toFixed(1) };
  try { await browser.disconnect(); } catch {}
  try { proc.kill('SIGKILL'); } catch {}
  await px.close();
  return out;
}

/* ---------- dispatch ---------- */
// Each tool runs in its own process. Importing all four into one process makes
// every client-memory reading cumulative, which silently reports the wrong
// number for every tool after the first.
const TOOLS = { playwright: runPlaywright, puppeteer: runPuppeteer, 'selenium-classic': runSeleniumClassic, 'selenium-bidi': runSeleniumBidi, lightpanda: runLightpanda };
const LABELS = { playwright: 'Playwright', puppeteer: 'Puppeteer', 'selenium-classic': 'Selenium', 'selenium-bidi': 'raw client', lightpanda: 'Lightpanda' };

const childTool = process.argv.find((a) => a.startsWith('--tool='))?.split('=')[1];
if (childTool) {
  const site = await serveFixture();
  const out = await TOOLS[childTool](site);
  await site.close();
  console.log(JSON.stringify(out));
  process.exit(0);
}

const med = (xs) => { const s = xs.filter((v) => typeof v === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pad = (s, n) => String(s ?? '-').padEnd(n);
const rpad = (s, n) => String(s ?? '-').padStart(n);

const results = [];
for (const key of Object.keys(TOOLS)) {
  const runs = [];
  for (let i = 0; i < REPEATS; i++) {
    const raw = execFileSync(process.execPath, [process.argv[1], `--tool=${key}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1e8, env: process.env });
    const parsed = JSON.parse(raw.trim().split('\n').pop() || 'null');
    if (!parsed) break;
    runs.push(parsed);
    process.stderr.write(`  ${LABELS[key]} ${runs[0].protocol} ${i + 1}/${REPEATS}\r`);
  }
  if (!runs.length) { process.stderr.write(`  ${LABELS[key]} skipped (not installed)\n`); continue; }
  process.stderr.write(`  ${LABELS[key]} ${runs[0].protocol} done                    \n`);
  results.push({ label: LABELS[key], protocol: runs[0].protocol,
    importCost: med(runs.map((r) => r.importCost)), clientRssMb: med(runs.map((r) => r.clientRssMb)),
    privateMb: med(runs.map((r) => r.privateMb)), procs: runs[0].procs,
    cpuSeconds: med(runs.map((r) => r.cpuSeconds)),
    walkMs: med(runs.map((r) => r.walk.ms)), walkMsgs: med(runs.map((r) => r.walk.msgs)),
    singleMs: med(runs.map((r) => r.single.ms)), singleMsgs: med(runs.map((r) => r.single.msgs)),
    kbUp: med(runs.map((r) => r.kbUp)), items: runs[0].items });
}

const chromeVersion = execFileSync(CHROME, ['--version'], { encoding: 'utf8' }).trim();
console.log(`\nbrowser-automation-bench   ${chromeVersion}   node ${process.version}   rtt=${RTT}ms   repeats=${REPEATS}`);
console.log(`${os.platform()}/${os.arch()}  ${os.cpus().length} cpus  ${Math.round(os.totalmem() / 1073741824)} GB   browser memory metric: ${process.platform === 'darwin' ? 'phys_footprint' : 'PSS'}\n`);
console.log(pad('TOOL', 11) + pad('PROTOCOL', 17) + rpad('IMPORT', 8) + rpad('CLIENT', 10) + rpad('BROWSER', 9) + rpad('PROCS', 6) + rpad('CPU', 8) + rpad('WALK', 9) + rpad('MSGS', 6) + rpad('EVAL', 7) + rpad('ITEMS', 7));
console.log('-'.repeat(104));
for (const r of results) {
  console.log(pad(r.label, 11) + pad(r.protocol, 17) + rpad(r.importCost === null ? '-' : r.importCost + ' MB', 8) + rpad(r.clientRssMb + ' MB', 10) +
    rpad(r.privateMb + ' MB', 9) + rpad(r.procs, 6) + rpad(r.cpuSeconds === null ? '-' : r.cpuSeconds + ' s', 8) + rpad(r.walkMs + ' ms', 9) + rpad(r.walkMsgs, 6) + rpad(r.singleMs + ' ms', 7) + rpad(r.items, 7));
}
console.log(`\nIMPORT   client RSS added by loading the library, before any browser exists`);
console.log(`CLIENT   client RSS with one browser connected and the page extracted`);
console.log(`BROWSER  ${process.platform === 'darwin' ? 'phys_footprint' : 'PSS'} summed across the browser process tree, shared binary image excluded`);
console.log(`CPU      seconds of CPU the browser tree consumed, from its own accounting`);
console.log(`WALK     20 cards read one locator at a time, and the protocol messages it cost`);
console.log(`EVAL     the same 20 cards read in a single in-page evaluation\n`);
fs.writeFileSync('bench-results.json', JSON.stringify({ chrome: chromeVersion, node: process.version, rtt: RTT, repeats: REPEATS, results }, null, 2));
process.exit(0);

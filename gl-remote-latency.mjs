// The guide quotes four remote-latency figures: a median CDP round trip to the
// endpoint, a locator walk run remotely, the same read collapsed into one
// evaluation, and a cold connect. None of them had a probe behind them, so this
// is that probe. Every number below is a median of REPEATS runs, reported with
// its min and max, because a single sample of a network measurement says very
// little. The walk mirrors bench.mjs: 20 cards, two fields each, 40 reads.
//
//   GL_TOKEN=... node gl-remote-latency.mjs
//
import { chromium } from 'playwright-core';

const T = process.env.GL_TOKEN;
if (!T) { console.error('set GL_TOKEN'); process.exit(1); }
const API = 'https://api.gologin.com';
const H = { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' };
const REPEATS = Number(process.env.REPEATS ?? 5);
const RTT_SAMPLES = 11;
const TARGET = 'https://books.toscrape.com/';

const req = async (p, o = {}) => {
  const r = await fetch(`${API}${p}`, { headers: H, ...o });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};
const ms = (t0) => Number((performance.now() - t0).toFixed(1));
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const band = (a) => `${Math.min(...a).toFixed(0)}-${Math.max(...a).toFixed(0)}`;

const runOnce = async (profile) => {
  const url = `wss://cloudbrowser.gologin.com/connect?token=${T}&profile=${profile}`;

  const t0 = performance.now();
  const browser = await chromium.connectOverCDP(url, { timeout: 180_000 });
  const connectMs = ms(t0);

  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();

  // Median CDP round trip: Browser.getVersion is a no-op the browser answers
  // directly, so the number is transit plus dispatch, not page work.
  const cdp = await ctx.newCDPSession(page);
  const rtts = [];
  for (let i = 0; i < RTT_SAMPLES; i++) { const t = performance.now(); await cdp.send('Browser.getVersion'); rtts.push(ms(t)); }

  const tNav = performance.now();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  const navMs = ms(tNav);

  // Walk: one locator read per field, the shape bench.mjs measures locally.
  const cards = page.locator('article.product_pod');
  const n = await cards.count();
  const tWalk = performance.now();
  const walked = [];
  for (let i = 0; i < n; i++) {
    const c = cards.nth(i);
    walked.push({
      title: await c.locator('h3 a').getAttribute('title'),
      price: (await c.locator('.price_color').textContent())?.trim() ?? null,
    });
  }
  const walkMs = ms(tWalk);

  // Collapsed: the same 40 reads in one evaluation.
  const tEval = performance.now();
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('article.product_pod')].map((el) => ({
      title: el.querySelector('h3 a')?.getAttribute('title') ?? null,
      price: el.querySelector('.price_color')?.textContent?.trim() ?? null,
    })));
  const evalMs = ms(tEval);

  await browser.close();
  return { connectMs, rttMedian: median(rtts), navMs, walkMs, evalMs, items: walked.length, evalItems: rows.length };
};

let id;
try {
  const created = await req('/browser/quick', { method: 'POST', body: JSON.stringify({ os: 'win', osSpec: 'win11', name: 'remote-latency' }) });
  id = created?.id;
  if (!id) throw new Error('profile create failed: ' + JSON.stringify(created).slice(0, 160));
  console.log(`profile ${id.slice(0, 8)}  target ${TARGET}  repeats ${REPEATS}\n`);

  const runs = [];
  for (let i = 0; i < REPEATS; i++) {
    try {
      const r = await runOnce(id);
      runs.push(r);
      console.log(`run ${i + 1}: connect ${r.connectMs} ms, rtt ${r.rttMedian} ms, nav ${r.navMs} ms, walk ${r.walkMs} ms, eval ${r.evalMs} ms, items ${r.items}/${r.evalItems}`);
    } catch (e) {
      console.log(`run ${i + 1}: FAILED ${String(e.message).slice(0, 120)}`);
    }
  }

  const ok = runs.filter((r) => r.items === 20 && r.evalItems === 20);
  if (!ok.length) { console.log('\nno complete runs'); process.exit(1); }

  const col = (k) => ok.map((r) => r[k]);
  console.log(`\n${ok.length} complete runs of ${REPEATS}\n`);
  console.log('METRIC                       MEDIAN      MIN-MAX');
  console.log('------------------------------------------------');
  const row = (label, k) => console.log(`${label.padEnd(28)} ${String(Math.round(median(col(k)))).padStart(6)} ms  ${band(col(k)).padStart(11)}`);
  row('CDP round trip', 'rttMedian');
  row('connect', 'connectMs');
  row('navigate (domcontentloaded)', 'navMs');
  row('walk, 40 locator reads', 'walkMs');
  row('same read, one evaluation', 'evalMs');

  const first = runs[0], rest = ok.filter((r) => r !== runs[0]);
  if (first?.connectMs && rest.length) {
    console.log(`\nfirst connect ${Math.round(first.connectMs)} ms against a median ${Math.round(median(rest.map((r) => r.connectMs)))} ms for the ${rest.length} after it`);
  }
  const w = median(col('walkMs')), e = median(col('evalMs'));
  console.log(`collapsing the walk: ${Math.round(w)} ms to ${Math.round(e)} ms, a factor of ${(w / e).toFixed(0)}`);
} finally {
  if (id) { await req(`/browser/${id}`, { method: 'DELETE' }); console.log('cleaned up profile'); }
}

// What an open cloud session costs the client, and how the account ceiling
// refuses one more. This opens sessions until the ceiling refuses one, samples
// client RSS after each, then asks for one more over both a plain GET and a
// WebSocket upgrade, because the two paths refuse with different status codes.
//
//   GL_TOKEN=... node gl-session-cost.mjs
//
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';

const T = process.env.GL_TOKEN;
if (!T) { console.error('set GL_TOKEN'); process.exit(1); }
const API = 'https://api.gologin.com';
const H = { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' };
const MAX = Number(process.env.MAX_SESSIONS ?? 6);

const req = async (p, o = {}) => {
  const r = await fetch(`${API}${p}`, { headers: H, ...o });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};
const wss = (p) => `wss://cloudbrowser.gologin.com/connect?token=${T}&profile=${p}`;
const mb = (n) => Number((n / 1048576).toFixed(1));

// RSS settles noticeably after a GC, so take it the same way every time.
const rss = async () => {
  if (global.gc) global.gc();
  await new Promise((r) => setTimeout(r, 400));
  return process.memoryUsage().rss;
};

// Path A: plain GET of the same URL over https.
const getPath = async (p) => {
  const r = await fetch(wss(p).replace('wss:', 'https:'));
  return { status: r.status, reason: (r.headers.get('X-Error-Reason') || '').slice(0, 70) || null };
};

// Path B: a real WebSocket upgrade. `ws` surfaces the rejected handshake as
// 'unexpected-response', which carries the HTTP status the server sent.
const wsPath = (p) => new Promise((resolve) => {
  const sock = new WebSocket(wss(p), { perMessageDeflate: false, handshakeTimeout: 45000 });
  const done = (v) => { try { sock.terminate(); } catch {} resolve(v); };
  sock.on('unexpected-response', (_req, res) => done({
    status: res.statusCode,
    reason: (res.headers['x-error-reason'] || '').slice(0, 70) || null,
  }));
  sock.on('open', () => done({ status: 101, reason: null, note: 'upgrade accepted' }));
  sock.on('error', (e) => done({ status: 'error', reason: String(e.message).slice(0, 70) }));
  setTimeout(() => done({ status: 'timeout', reason: null }), 50000);
});

const ids = [];
const held = [];
try {
  for (let i = 0; i < MAX; i++) {
    const c = await req('/browser/quick', { method: 'POST', body: JSON.stringify({ os: 'win', osSpec: 'win11', name: `cost-${i}` }) });
    if (c?.id) ids.push(c.id);
  }
  if (ids.length < 2) throw new Error('could not create profiles: ' + JSON.stringify(ids));

  const base = await rss();
  console.log(`baseline client RSS ${mb(base)} MB, node ${process.version}\n`);
  console.log('SESSIONS  CLIENT RSS   DELTA     local browser procs');
  console.log('-----------------------------------------------------');

  let refusedAt = null;
  for (const id of ids) {
    let browser;
    try {
      browser = await chromium.connectOverCDP(wss(id), { timeout: 120_000 });
    } catch (e) {
      refusedAt = held.length + 1;
      console.log(`\nsession ${refusedAt} refused by connectOverCDP: ${String(e.message).split('\n')[0].slice(0, 80)}`);
      break;
    }
    const ctx = browser.contexts()[0] ?? await browser.newContext();
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    held.push({ browser, id });
    const now = await rss();
    console.log(`   ${String(held.length).padStart(2)}     ${String(mb(now)).padStart(7)} MB  ${String(mb(now - base)).padStart(6)} MB   0`);
  }

  console.log(`\nsessions held: ${held.length}${refusedAt ? `, refused at ${refusedAt}` : ', ceiling not reached'}`);

  // Ask for one more over both paths, against a profile that is not in use.
  const spare = ids[held.length] ?? ids[ids.length - 1];
  console.log('\nrefusal on one more session, same URL, two paths:');
  const g = await getPath(spare);
  const w = await wsPath(spare);
  console.log(`  plain GET          status ${g.status}   X-Error-Reason: ${g.reason ?? '(none)'}`);
  console.log(`  WebSocket upgrade  status ${w.status}   X-Error-Reason: ${w.reason ?? '(none)'}${w.note ? '  ' + w.note : ''}`);
  console.log(`\n  same code on both paths: ${String(g.status) === String(w.status)}`);
} finally {
  for (const h of held) { try { await h.browser.close(); } catch {} }
  for (const id of ids) await req(`/browser/${id}`, { method: 'DELETE' });
  console.log(`\ncleaned up ${ids.length} profiles`);
}

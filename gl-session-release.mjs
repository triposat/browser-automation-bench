// Isolate it properly: fill the parallel-session ceiling, release exactly one
// session by client close alone, then see whether a new one can start.
const TOKEN = process.env.GL_TOKEN;
// Bring your own profiles with GL_PROFILES=id1,id2,..., or leave it unset and the
// probe creates default profiles through the API and deletes them when it ends,
// including when it fails part-way.
const API = 'https://api.gologin.com';
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
if (!TOKEN) { console.error('set GL_TOKEN'); process.exit(1); }
const created = [];
const provision = async (n, tag) => {
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${API}/browser/quick`, { method: 'POST', headers: AUTH,
      body: JSON.stringify({ os: 'win', osSpec: 'win11', name: `${tag}-${i}` }) }).then((x) => x.json()).catch(() => null);
    if (r?.id) created.push(r.id);
  }
  return created;
};
const cleanup = async () => { for (const id of created) await fetch(`${API}/browser/${id}`, { method: 'DELETE', headers: AUTH }).catch(() => {}); };
// The ceiling is a plan setting, so this needs one more profile than your plan allows
// parallel sessions. Six covers the plan tested; raise MAX_SESSIONS for a larger one.
const P = (process.env.GL_PROFILES || '').split(',').filter(Boolean);
if (!P.length) P.push(...await provision(Number(process.env.MAX_SESSIONS ?? 6), 'release'));
const { chromium } = await import('playwright-core');
const url = (p) => `wss://cloudbrowser.gologin.com/connect?token=${TOKEN}&profile=${p}`;
const preflight = async (p) => {
  const r = await fetch(url(p).replace('wss:', 'https:'));
  return { status: r.status, reason: (r.headers.get('X-Error-Reason') || '').slice(0, 60) };
};
const open = async (p) => {
  const b = await chromium.connectOverCDP(url(p), { timeout: 120000 });
  const c = b.contexts()[0] || await b.newContext();
  const pg = c.pages()[0] || await c.newPage();
  await pg.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  return b;
};

const out = {};
const held = [];
try {
// 1. fill to the ceiling
for (const p of P) {
  const pre = await preflight(p);
  if (pre.status !== 200) { out.ceilingReachedAt = held.length; out.refusal = pre; break; }
  try { held.push({ b: await open(p), p }); } catch (e) { out.ceilingReachedAt = held.length; out.refusal = { status: 'ws', reason: e.message.split('\n')[0].slice(0, 60) }; break; }
}
out.sessionsHeld = held.length;
if (!out.ceilingReachedAt) out.note = 'ran out of profiles before hitting the ceiling';

// 2. release ONE by client close alone, no DELETE
const victim = held.pop();
await victim.b.close();
out.closedWithoutDelete = victim.p.slice(-6);

// 3. can a new session start now?
for (const wait of [0, 5, 20]) {
  if (wait) await new Promise((r) => setTimeout(r, wait * 1000));
  out[`slotAfter${wait}s`] = await preflight(victim.p);
}
// 4. then DELETE and retry, for the contrast
await fetch(`https://api.gologin.com/browser/${victim.p}/web`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
await new Promise((r) => setTimeout(r, 2000));
out.slotAfterExplicitDelete = await preflight(victim.p);

for (const h of held) { try { await h.b.close(); } catch {} 
  await fetch(`https://api.gologin.com/browser/${h.p}/web`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } }); }
console.log(JSON.stringify(out, null, 1));
} finally { await cleanup(); }
process.exit(0);

// The guide proves separate local browsers share one identity. This runs the
// identical probe against separate remote profiles, so the recommendation is
// measured rather than asserted.
import crypto from 'node:crypto';
const { chromium } = await import('playwright-core');
const TOKEN = process.env.GL_TOKEN;
const PROFILES = process.env.GL_PROFILES.split(',');

const FP = `(() => {
  const c=document.createElement('canvas'); c.width=280; c.height=60;
  const x=c.getContext('2d');
  x.textBaseline='alphabetic'; x.font='16px "Arial"'; x.fillStyle='#f60';
  x.fillRect(10,10,120,30); x.fillStyle='rgba(0,102,153,0.7)';
  x.fillText('Cwm fjordbank glyphs vext quiz \\u{1F600}',12,40);
  let webgl='none', vendor='none';
  try { const g=document.createElement('canvas').getContext('webgl');
    const d=g.getExtension('WEBGL_debug_renderer_info');
    webgl = d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'no-ext';
    vendor = d ? g.getParameter(d.UNMASKED_VENDOR_WEBGL) : 'no-ext'; } catch {}
  return { canvas:c.toDataURL(), ua:navigator.userAgent, hw:navigator.hardwareConcurrency,
           dm:navigator.deviceMemory ?? null, plat:navigator.platform,
           screen: screen.width+'x'+screen.height+'x'+screen.colorDepth,
           tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
           langs: navigator.languages.join(','), webgl, vendor,
           webdriver: navigator.webdriver };
})()`;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

const rows = [];
for (const p of PROFILES) {
  const url = `wss://cloudbrowser.gologin.com/connect?token=${TOKEN}&profile=${p}`;
  const pre = await fetch(url.replace('wss:', 'https:'));
  if (pre.status !== 200) { rows.push({ profile: p.slice(-6), error: pre.headers.get('X-Error-Reason')?.slice(0, 50) }); continue; }
  try {
    const b = await chromium.connectOverCDP(url, { timeout: 120000 });
    const ctx = b.contexts()[0] || await b.newContext();
    const pg = ctx.pages()[0] || await ctx.newPage();
    await pg.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const f = await pg.evaluate(FP);
    let ip = null;
    try { await pg.goto('https://ipinfo.io/json', { waitUntil: 'domcontentloaded', timeout: 45000 });
      ip = JSON.parse(await pg.evaluate(() => document.body.innerText)).ip; } catch {}
    rows.push({ profile: p.slice(-6), canvasSha: sha(f.canvas), hw: f.hw, dm: f.dm,
      screen: f.screen, tz: f.tz, webgl: String(f.webgl).slice(0, 26), webdriver: f.webdriver, ip });
    await b.close();
  } catch (e) { rows.push({ profile: p.slice(-6), error: e.message.split('\n')[0].slice(0, 50) }); }
  await fetch(`https://api.gologin.com/browser/${p}/web`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
  await new Promise((r) => setTimeout(r, 2500));
}
console.table(rows);
const hashes = new Set(rows.filter((r) => r.canvasSha).map((r) => r.canvasSha));
console.log(JSON.stringify({ profilesProbed: rows.filter((r) => r.canvasSha).length,
  distinctCanvasHashes: hashes.size,
  distinctHw: new Set(rows.filter((r)=>r.hw).map((r)=>r.hw)).size,
  distinctIps: new Set(rows.filter((r)=>r.ip).map((r)=>r.ip)).size }));
process.exit(0);

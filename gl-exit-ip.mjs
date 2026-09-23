// The guide says three API-created profiles "varied their exit IP". That is a
// measured claim and worth re-checking: these profiles have no proxy attached,
// so any variation comes from the cloud infrastructure itself, not a purchase.
import { WebSocket } from 'ws';
const T = process.env.GL_TOKEN, API = 'https://api.gologin.com';
const H = { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' };
const req = async (p, o = {}) => { const r = await fetch(`${API}${p}`, { headers: H, ...o }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

const readIp = async (profile) => {
  const ws = new WebSocket(`wss://cloudbrowser.gologin.com/connect?token=${T}&profile=${profile}`, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  let id = 0; const pend = new Map();
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); const q = pend.get(m.id); if (q) { pend.delete(m.id); m.error ? q.rej(new Error(m.error.message)) : q.res(m.result); } });
  const send = (method, params = {}, sid) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }), { binary: false }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, 45000); });
  const { targetId } = await send('Target.createTarget', { url: 'https://ipinfo.io/json' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await new Promise((r) => setTimeout(r, 4000));
  const { result } = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sessionId);
  await send('Target.closeTarget', { targetId }).catch(() => {});
  ws.close();
  try { const j = JSON.parse(result.value); return { ip: j.ip, country: j.country, org: (j.org || '').slice(0, 34) }; } catch { return { raw: String(result.value).slice(0, 60) }; }
};

const ids = [];
try {
  for (let i = 0; i < 3; i++) { const c = await req('/browser/quick', { method: 'POST', body: JSON.stringify({ os: 'win', osSpec: 'win11', name: `ip-${i}` }) }); if (c?.id) ids.push(c.id); }
  const rows = [];
  for (const id of ids) { try { rows.push({ profile: id.slice(0, 6), ...(await readIp(id)) }); } catch (e) { rows.push({ profile: id.slice(0, 6), error: String(e.message).slice(0, 40) }); } }
  console.table(rows);
  const ips = rows.map((r) => r.ip).filter(Boolean);
  console.log(`distinct exit IPs across ${ips.length} profiles: ${new Set(ips).size}`);
} finally { for (const id of ids) await req(`/browser/${id}`, { method: 'DELETE' }); console.log('cleaned up', ids.length); }

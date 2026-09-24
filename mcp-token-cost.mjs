import { encode } from 'gpt-tokenizer';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CHROME } from './lib/paths.js';
if (!CHROME) { console.error('Chrome not found: run the @puppeteer/browsers install from the README'); process.exit(1); }
const chrome = spawn(CHROME, ['--headless=new','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${path.join(os.tmpdir(), `tk-${Date.now()}`)}`,'about:blank'], { stdio:['ignore','pipe','pipe'] });
const wsUrl = await new Promise((r) => { let b=''; chrome.stderr.on('data', (d)=>{ b+=d; const m=b.match(/ws:\/\/[^\s]+/); if(m) r(m[0]); }); });
const mcp = spawn('npx', ['@playwright/mcp','--cdp-endpoint', wsUrl,'--headless'], { stdio:['pipe','pipe','pipe'] });
let buf=''; const waiters=new Map();
mcp.stdout.on('data',(d)=>{ buf+=d.toString(); let i; while((i=buf.indexOf('\n'))>=0){ const l=buf.slice(0,i).trim(); buf=buf.slice(i+1); if(!l) continue; try{const m=JSON.parse(l); if(m.id&&waiters.has(m.id)){waiters.get(m.id)(m);waiters.delete(m.id);} }catch{} } });
let id=0;
const rpc=(method,params)=>new Promise((res,rej)=>{ const my=++id; waiters.set(my,res); mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id:my,method,params})+'\n'); setTimeout(()=>rej(new Error('timeout '+method)),60000); });
await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'tk',version:'1'}});
mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
const call=async(n,a)=>{ const r=await rpc('tools/call',{name:n,arguments:a}); return (r.result?.content||[]).map(c=>c.text||'').join(''); };
const EX={'books.toscrape.com':"() => [...document.querySelectorAll('article.product_pod')].map(el=>({title:el.querySelector('h3 a').getAttribute('title'),price:el.querySelector('.price_color').textContent.trim()}))",
          'news.ycombinator.com':"() => [...document.querySelectorAll('.athing .titleline > a')].map(a=>({title:a.textContent,url:a.href}))"};
for (const url of ['https://books.toscrape.com/','https://news.ycombinator.com/']) {
  await call('browser_navigate',{url});
  const snap = await call('browser_snapshot',{});
  const ev = await call('browser_evaluate',{ function: EX[new URL(url).hostname] });
  const st = encode(snap).length, et = encode(ev).length;
  const recs = (ev.match(/"title"/g)||[]).length;
  console.log(JSON.stringify({ url, snapshotChars: snap.length, snapshotTokens: st, evalChars: ev.length, evalTokens: et, records: recs, ratio: +(st/et).toFixed(1) }));
}
try{mcp.kill('SIGKILL');}catch{} try{chrome.kill('SIGKILL');}catch{} process.exit(0);

// JA3 differed headless vs headful. That is only a headless tell if JA3 is
// stable across repeats of the same config. Chrome sends GREASE values that
// JA3 does not normalise and JA4 does, so test repeats before concluding.
import { CHROME, CHROME_ARGS } from './lib/paths.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const { chromium } = await import('playwright-core');
const URL_ = 'https://tls.peet.ws/api/all';

async function sample(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ja3-'));
  const proc = spawn(CHROME, [...args, '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio:['ignore','pipe','pipe'] });
  const ws = await new Promise((r,j)=>{let b='';const to=setTimeout(()=>j(new Error('no cdp')),20000);
    proc.stderr.on('data',(d)=>{b+=d;const m=b.match(/ws:\/\/[^\s]+/);if(m){clearTimeout(to);r(m[0]);}});});
  const browser = await chromium.connectOverCDP(ws);
  const ctx = browser.contexts()[0]; const pg = ctx.pages()[0] || await ctx.newPage();
  await pg.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const j = JSON.parse(await pg.evaluate(() => document.body.innerText));
  await browser.close(); try { proc.kill('SIGKILL'); } catch {}
  try { fs.rmSync(dir, { recursive:true, force:true, maxRetries:3 }); } catch {}
  return { ja3: j.tls?.ja3_hash, ja4: j.tls?.ja4, http2: j.http2?.akamai_fingerprint_hash };
}

const headless = [], headful = [];
for (let i = 0; i < 3; i++) {
  headless.push(await sample(CHROME_ARGS));
  headful.push(await sample(CHROME_ARGS.filter((a) => a !== '--headless=new')));
}
const uniq = (a, k) => new Set(a.map((x) => x[k])).size;
console.log(JSON.stringify({
  headless: { ja3: headless.map(x=>x.ja3.slice(0,10)), distinctJa3: uniq(headless,'ja3'), distinctJa4: uniq(headless,'ja4'), distinctHttp2: uniq(headless,'http2') },
  headful:  { ja3: headful.map(x=>x.ja3.slice(0,10)),  distinctJa3: uniq(headful,'ja3'),  distinctJa4: uniq(headful,'ja4'),  distinctHttp2: uniq(headful,'http2') },
  ja4MatchesAcrossModes: headless[0].ja4 === headful[0].ja4,
  http2MatchesAcrossModes: headless[0].http2 === headful[0].http2,
  ja3DistinctOverall: new Set([...headless, ...headful].map(x=>x.ja3)).size,
}, null, 1));
process.exit(0);

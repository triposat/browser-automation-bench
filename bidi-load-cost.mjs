// The matrix printed "-" for the BiDi row's load cost, because the arm was never
// instrumented for it. Every other row reports RSS added by importing its client
// before a browser exists, so this measures the BiDi arm the same way.
//
// Two numbers matter and they are not the same:
//   raw    what a hand-rolled BiDi client costs: the ws package alone
//   armed  what bench.mjs's BiDi arm actually loads, because it uses
//          selenium-webdriver to spawn chromedriver and negotiate webSocketUrl
//          before it takes over the socket by hand
//
// Each sample runs in a fresh process, since a second import is free.
import { execFileSync } from 'node:child_process';

const rss = "const r=()=>+(process.memoryUsage().rss/1048576).toFixed(1);";
const MODES = {
  raw:   `${rss}const b=r();await import('ws');console.log(+(r()-b).toFixed(1));`,
  armed: `${rss}const b=r();await import('selenium-webdriver');await import('selenium-webdriver/chrome.js');await import('ws');console.log(+(r()-b).toFixed(1));`,
};
const med = (a) => { const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
const N = +(process.env.REPEATS || 5);

const out = {};
for (const [name, src] of Object.entries(MODES)) {
  const runs = [];
  for (let i = 0; i < N; i++) {
    runs.push(+execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' }).trim());
  }
  out[name] = { runs, medianMb: med(runs) };
}
console.log(JSON.stringify(out, null, 1));

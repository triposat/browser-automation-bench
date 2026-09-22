import { execSync, execFileSync } from 'node:child_process';

const toMb = (val, unit) => (unit === 'G' ? val * 1024 : unit === 'K' ? val / 1024 : unit === 'B' ? val / 1048576 : val);

// macOS phys_footprint is what Activity Monitor calls "Memory": private dirty
// plus compressed, with the shared binary image excluded. Summing `ps` RSS over
// a Chromium tree counts that shared image once per process and roughly doubles
// the answer, which is why per-context figures in circulation run high.
export function physFootprintMb(pid) {
  try {
    const o = execFileSync('/usr/bin/footprint', ['-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = o.match(/phys_footprint:\s*([\d.]+)\s*([KMGB])/);
    return m ? toMb(parseFloat(m[1]), m[2]) : 0;
  } catch { return 0; }
}

export function psRows(filter) {
  return execSync('ps -eo pid=,ppid=,rss=,command=', { encoding: 'utf8' })
    .trim().split('\n')
    .map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return m ? { pid: +m[1], ppid: +m[2], rssKb: +m[3], cmd: m[4] } : null; })
    .filter(Boolean).filter(filter);
}

// Every Chromium process belonging to one profile directory, whoever spawned it.
// chromedriver re-parents its browser, so a descendant walk alone misses processes.
export function browserFootprint(profileDir) {
  const rows = psRows((r) => r.cmd.includes(profileDir) && !/\bps\b|footprint/.test(r.cmd));
  const footprintMb = rows.reduce((a, r) => a + physFootprintMb(r.pid), 0);
  const psRssMb = rows.reduce((a, r) => a + r.rssKb, 0) / 1024;
  return { procs: rows.length, footprintMb: +footprintMb.toFixed(1), psRssSumMb: +psRssMb.toFixed(1), pids: rows.map((r) => r.pid) };
}

export const selfRssMb = () => +(process.memoryUsage().rss / 1048576).toFixed(1);
export const selfFootprintMb = () => +physFootprintMb(process.pid).toFixed(1);
export const t = () => Number(process.hrtime.bigint() / 1000000n);

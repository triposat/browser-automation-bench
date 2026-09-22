import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { CHROME, CHROME_ARGS } from './paths.js';

export async function launchChrome({ extraArgs = [], headful = false } = {}) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-prof-'));
  const proc = spawn(CHROME, [...CHROME_ARGS.filter((a) => !(headful && a === '--headless=new')), ...extraArgs, '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = ''; const to = setTimeout(() => rej(new Error('no CDP endpoint')), 20000);
    proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(to); res(m[0]); } });
  });
  return { proc, profileDir, wsUrl, kill: () => { try { proc.kill('SIGKILL'); } catch {} try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch {} } };
}

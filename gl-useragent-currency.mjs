// The guide says fresh profiles carry a Chrome 151 User-Agent while the
// benchmark drives 153. That is a detection surface, so it needs a probe
// rather than a one-off check: a profile advertising a browser version two
// majors behind the real fleet is a mismatch anyone can read.
//
// Compares the User-Agent on newly created profiles against the Chrome this
// harness actually launches, and cleans up after itself.
import { execFileSync } from 'node:child_process';
import { CHROME } from './lib/paths.js';

const T = process.env.GL_TOKEN;
if (!T) { console.error('set GL_TOKEN'); process.exit(1); }
const API = 'https://api.gologin.com';
const H = { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' };
const req = async (p, o = {}) => {
  const r = await fetch(`${API}${p}`, { headers: H, ...o });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};
// UA strings read 'Chrome/153.0...' while --version reads 'Chrome for Testing 153.0...'
const major = (s) => (String(s).match(/Chrome(?:\/| for Testing )(\d+)/) || [])[1];

const localFull = execFileSync(CHROME, ['--version'], { encoding: 'utf8' }).trim();
const localMajor = major(localFull);

const ids = [];
try {
  for (let i = 0; i < 3; i++) {
    const c = await req('/browser/quick', { method: 'POST', body: JSON.stringify({ os: 'win', osSpec: 'win11', name: `ua-${i}` }) });
    if (c?.id) ids.push(c.id);
  }
  const rows = [];
  for (const id of ids) {
    const p = await req(`/browser/${id}`);
    const ua = p?.navigator?.userAgent ?? '';
    rows.push({ profile: id.slice(0, 6), advertises: major(ua), ua: ua.slice(-42) });
  }
  console.table(rows);
  const majors = [...new Set(rows.map((r) => r.advertises))];
  console.log(`local Chrome        : ${localFull}  (major ${localMajor})`);
  console.log(`profiles advertise  : ${majors.join(', ')}`);
  const behind = majors.every((m) => +m < +localMajor);
  console.log(behind
    ? `\nEvery profile is ${majors.map((m) => +localMajor - +m).join('/')} major(s) behind the browser this harness drives.`
    : `\nProfiles are level with or ahead of the local build.`);
  console.log('PATCH /browser/update_ua_to_new_browser_v moves them forward. See');
  console.log('https://gologin.com/docs/api-reference/profile/get-latest-useragent');
} finally {
  for (const id of ids) await req(`/browser/${id}`, { method: 'DELETE' });
  console.log(`\ncleaned up ${ids.length}`);
}

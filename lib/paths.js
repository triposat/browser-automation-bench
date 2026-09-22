import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const g = (p) => globSync(p)[0];
// Local .browsers first, as the README instructs. The /tmp fallback is the old
// build location and is kept only so an existing checkout keeps working.
const first = (...pats) => { for (const p of pats) { const h = g(p); if (h) return h; } return undefined; };
export const CHROME = first(
  fileURLToPath(new URL('../.browsers/chrome/mac_arm-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', import.meta.url)),
  '/tmp/gl/bench/.browsers/chrome/mac_arm-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
export const CHROMEDRIVER = first(
  fileURLToPath(new URL('../.browsers/chromedriver/mac_arm-*/chromedriver-mac-arm64/chromedriver', import.meta.url)),
  '/tmp/gl/bench/.browsers/chromedriver/mac_arm-*/chromedriver-mac-arm64/chromedriver');
export const CHROME_ARGS = [
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-sync', '--disable-features=Translate,MediaRouter', '--headless=new',
];

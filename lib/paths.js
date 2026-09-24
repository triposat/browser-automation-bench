import { globSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One resolver for every binary the harness drives. Each lookup honours an
// environment override first, then the repo's own ./.browsers directory.
//
// @puppeteer/browsers installs to .browsers/<browser>/<platform>-<build>/<exec>.
// The platform names and executable paths below are read from its
// browser-data/chrome.js, chromedriver.js and types.js, not guessed.
//
// Supported: macOS (arm64, x64) and Linux (x64, arm64), because those are the
// platforms bench.mjs can measure memory on (phys_footprint and PSS). There is
// no Windows memory path, so Windows is not resolved here rather than resolved
// into a run that cannot report its main column. Only macOS arm64 has been
// executed; the others follow the same source and have not been run.

const ROOT = fileURLToPath(new URL('../.browsers/', import.meta.url)).split(path.sep).join('/');

const PLATFORM = {
  'darwin-arm64': 'mac_arm', 'darwin-x64': 'mac',
  'linux-x64': 'linux', 'linux-arm64': 'linux_arm',
}[`${process.platform}-${process.arch}`];

const MAC_FOLDER = { mac_arm: 'mac-arm64', mac: 'mac-x64' }[PLATFORM];

const CHROME_EXEC = MAC_FOLDER
  ? `chrome-${MAC_FOLDER}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  : 'chrome-linux64/chrome';
const DRIVER_EXEC = MAC_FOLDER ? `chromedriver-${MAC_FOLDER}/chromedriver` : 'chromedriver-linux64/chromedriver';

const installed = (browser, exec) =>
  PLATFORM ? globSync(`${ROOT}${browser}/${PLATFORM}-*/${exec}`)[0] : undefined;

export const CHROME = process.env.CHROME_PATH || installed('chrome', CHROME_EXEC);
export const CHROMEDRIVER = process.env.CHROMEDRIVER_PATH || installed('chromedriver', DRIVER_EXEC);

// Lightpanda has no pinned release (its installer ships nightly), so it is
// looked for where the guide's two install routes put it: ./.browsers, then
// the installer's own default of ~/.local/bin. Undefined means "skip the row".
export const LIGHTPANDA = [
  process.env.LIGHTPANDA_PATH,
  `${ROOT}lightpanda/lightpanda`,
  path.join(os.homedir(), '.local', 'bin', 'lightpanda'),
].find((p) => p && existsSync(p));

export const CHROME_ARGS = [
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-sync', '--disable-features=Translate,MediaRouter', '--headless=new',
];

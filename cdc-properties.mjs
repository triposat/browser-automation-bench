// The guide states chromedriver injects seven cdc_ properties onto window while
// Playwright and Puppeteer leave zero, and that the string is stable across
// versions. None of that had a script behind it. This measures both halves:
// the window properties a chromedriver-driven session carries, and the same
// count under a plain CDP connect.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { CHROME, CHROMEDRIVER } from './lib/paths.js';
import { launchChrome } from './lib/chrome.js';

const COUNT = `Object.getOwnPropertyNames(window).filter((k) => k.startsWith('cdc_'))`;

// --- arm 1: Selenium over chromedriver ---
const port = 9800 + Math.floor(Math.random() * 300);
const cd = spawn(CHROMEDRIVER, [`--port=${port}`, '--silent'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1400));
let viaDriver = { error: 'not run' };
try {
  const { Builder } = await import('selenium-webdriver');
  const chrome = await import('selenium-webdriver/chrome.js');
  const dir = fs.mkdtempSync('./.run/cdc-');
  const o = new chrome.Options();
  o.setChromeBinaryPath(CHROME);
  for (const a of ['--headless=new', '--no-first-run', `--user-data-dir=${dir}`]) o.addArguments(a);
  const driver = await new Builder().forBrowser('chrome').usingServer(`http://127.0.0.1:${port}`).setChromeOptions(o).build();
  await driver.get('https://example.com');
  viaDriver = { keys: await driver.executeScript(`return ${COUNT}`) };
  await driver.quit();
  fs.rmSync(dir, { recursive: true, force: true });
} catch (e) { viaDriver = { error: String(e.message).slice(0, 70) }; }
cd.kill();

// --- arm 2: a plain CDP connect, no chromedriver in the path ---
const c = await launchChrome();
const pup = (await import('puppeteer-core')).default;
const b = await pup.connect({ browserWSEndpoint: c.wsUrl, protocolTimeout: 60000 });
const page = (await b.pages())[0] || await b.newPage();
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
const viaCdp = await page.evaluate(COUNT);
await b.close(); c.kill?.();

console.log('via chromedriver :', viaDriver.error ?? `${viaDriver.keys.length} properties`);
if (viaDriver.keys) viaDriver.keys.forEach((k) => console.log('   ', k));
console.log('via plain CDP    :', viaCdp.length, 'properties');

// Implemented from creepjs/src/headless/index.ts, read directly rather than from
// any description of it. These are its likeHeadless/headless checks verbatim,
// run against headful Chrome, headless Chrome, and a GoLogin cloud profile.
//
// The two that matter most for this guide are noTaskbar and webDriverIsOn:
//   noTaskbar     screen.height === availHeight, i.e. a desktop with no dock
//   webDriverIsOn true when webdriver is set OR when it is undefined on a Blink
//                 build new enough to have it, so deleting the property is a tell
import { WebSocket } from 'ws';
import { launchChrome } from './lib/chrome.js';
const CHECKS = `(async () => {
  const IS_BLINK = !!window.chrome || /Chrome|Chromium/.test(navigator.userAgent);
  const mimeTypes = Object.keys({ ...navigator.mimeTypes });
  let gl = null;
  try { const c = document.createElement('canvas').getContext('webgl');
        const d = c && c.getExtension('WEBGL_debug_renderer_info');
        gl = d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : null; } catch {}
  return {
    _renderer: gl, _screen: screen.width + 'x' + screen.height,
    _avail: screen.availWidth + 'x' + screen.availHeight,
    _webdriver: String(navigator.webdriver), _platform: navigator.platform,
    likeHeadless: {
      noChrome: IS_BLINK && !('chrome' in window),
      noPlugins: IS_BLINK && navigator.plugins.length === 0,
      noMimeTypes: IS_BLINK && mimeTypes.length === 0,
      notificationIsDenied: IS_BLINK && 'Notification' in window && Notification.permission === 'denied',
      prefersLightColor: matchMedia('(prefers-color-scheme: light)').matches,
      uaDataIsBlank: 'userAgentData' in navigator && navigator.userAgentData?.platform === '',
      pdfIsDisabled: 'pdfViewerEnabled' in navigator && navigator.pdfViewerEnabled === false,
      noTaskbar: screen.height === screen.availHeight && screen.width === screen.availWidth,
      hasVvpScreenRes: (innerWidth === screen.width && outerHeight === screen.height) ||
        ('visualViewport' in window && visualViewport.width === screen.width && visualViewport.height === screen.height),
      hasSwiftShader: /SwiftShader/.test(gl || ''),
      noWebShare: IS_BLINK && CSS.supports('accent-color: initial') && (!('share' in navigator) || !('canShare' in navigator)),
    },
    headless: {
      webDriverIsOn: (CSS.supports('border-end-end-radius: initial') && navigator.webdriver === undefined) || !!navigator.webdriver,
      hasHeadlessUA: /HeadlessChrome/.test(navigator.userAgent) || /HeadlessChrome/.test(navigator.appVersion),
    },
  };
})()`;

const rate = (o) => { const k = Object.keys(o); return `${Math.round(k.filter((x) => o[x]).length / k.length * 100)}%`; };
const report = (name, r) => {
  if (r.error) return console.log(`\n${name}: ${r.error}`);
  const hit = (o) => Object.keys(o).filter((k) => o[k]);
  console.log(`\n${name}`);
  console.log(`  screen ${r._screen}  avail ${r._avail}  webdriver ${r._webdriver}  platform ${r._platform}`);
  console.log(`  renderer ${String(r._renderer).slice(0, 46)}`);
  console.log(`  likeHeadless ${rate(r.likeHeadless)}  ->  ${hit(r.likeHeadless).join(', ') || 'none'}`);
  console.log(`  headless     ${rate(r.headless)}  ->  ${hit(r.headless).join(', ') || 'none'}`);
};

// Connect to a PAGE target's own debugger URL rather than the browser endpoint,
// so there is no session multiplexing and no client library in the path. The
// fingerprint being read is the browser's, not one a client has touched.
const viaCdp = async (browserWsUrl) => {
  const port = new URL(browserWsUrl).port;
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?https://example.com`, { method: 'PUT' })).json();
  const ws = new WebSocket(created.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 5e8 });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  let id = 0; const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); const q = pending.get(m.id); if (q) { pending.delete(m.id); m.error ? q.rej(new Error(m.error.message)) : q.res(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 15000);
  });
  await send('Runtime.enable'); // evaluation needs the domain, which is exactly the tell
  await new Promise((r) => setTimeout(r, 2500));
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: CHECKS, awaitPromise: true, returnByValue: true });
  ws.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`).catch(() => {});
  if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description || '').slice(0, 100));
  return result.value;
};

for (const [name, opt] of [['headful', { headful: true }], ['headless', {}]]) {
  const c = await launchChrome(opt);
  try { report(`local Chrome ${name}`, await viaCdp(c.wsUrl)); }
  catch (e) { console.log(name, "FAIL", e.stack.split(String.fromCharCode(10)).slice(0,3).join(" | ")); }
  c.kill?.();
}

// A cloud browser has no local /json endpoint, so the remote arm attaches to a
// page target over the browser-level socket instead.
const viaRemoteCdp = async (wsUrl) => {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 5e8 });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  let id = 0; const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); const q = pending.get(m.id); if (q) { pending.delete(m.id); m.error ? q.rej(new Error(m.error.message)) : q.res(m.result); } });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }), { binary: false });
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 45000);
  });
  const { targetId } = await send('Target.createTarget', { url: 'https://example.com' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await new Promise((r) => setTimeout(r, 4000));
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: CHECKS, awaitPromise: true, returnByValue: true }, sessionId);
  await send('Target.closeTarget', { targetId }).catch(() => {});
  ws.close();
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result.value;
};

if (process.env.GL_TOKEN && process.env.GL_PROFILE) {
  const url = `https://cloudbrowser.gologin.com/connect?token=${process.env.GL_TOKEN}&profile=${process.env.GL_PROFILE}`;
  try { report('GoLogin cloud profile', await viaRemoteCdp(url.replace('https://', 'wss://'))); }
  catch (e) { report('GoLogin cloud profile', { error: String(e.message).slice(0, 80) }); }
}

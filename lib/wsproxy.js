import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

// Transparent CDP proxy. Sits between the automation client and the browser's
// own DevTools socket and counts every frame in both directions, so protocol
// chatter is measured on the wire instead of inferred from the API surface.
export async function startCdpProxy(upstreamWsUrl, delayMs = 0) {
  const half = delayMs / 2;
  const later = (fn) => (half > 0 ? setTimeout(fn, half) : fn());
  const stats = { toBrowser: 0, toClient: 0, bytesToBrowser: 0, bytesToClient: 0, methods: new Map(), events: new Map() };
  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', (client, req) => {
    const target = new URL(upstreamWsUrl);
    // Preserve the per-target path Playwright/Puppeteer asks for.
    const up = new WebSocket(`ws://${target.host}${req.url}`, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    const q = [];
    // CDP frames are text. Relaying the Buffer as-is sends a binary frame and
    // Chrome closes the socket, so every hop is converted back to a string.
    up.on('open', () => { for (const m of q) up.send(m, { binary: false }); q.length = 0; });
    client.on('message', (data) => {
      stats.toBrowser++; stats.bytesToBrowser += data.length;
      try {
        const m = JSON.parse(data.toString());
        if (m.method) stats.methods.set(m.method, (stats.methods.get(m.method) || 0) + 1);
      } catch {}
      const text = data.toString();
      later(() => { if (up.readyState === WebSocket.OPEN) up.send(text, { binary: false }); else q.push(text); });
    });
    up.on('message', (data) => {
      stats.toClient++; stats.bytesToClient += data.length;
      try {
        const m = JSON.parse(data.toString());
        if (m.method) stats.events.set(m.method, (stats.events.get(m.method) || 0) + 1);
      } catch {}
      const txt = data.toString();
      later(() => { if (client.readyState === WebSocket.OPEN) client.send(txt, { binary: false }); });
    });
    const bye = () => { try { up.close(); } catch {} try { client.close(); } catch {} };
    client.on('close', bye); up.on('close', bye);
    client.on('error', bye); up.on('error', bye);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, stats, url: (path) => `ws://127.0.0.1:${port}${path}`, close: () => new Promise((r) => { wss.close(); server.close(r); }) };
}

// Counting proxy for WebDriver Classic, which is request/response over HTTP.
// Each command is a full round trip, so requests are the unit that matters.
export async function startHttpProxy(upstreamOrigin, delayMs = 0) {
  const half = delayMs / 2;
  const later = (fn) => (half > 0 ? setTimeout(fn, half) : fn());
  const stats = { requests: 0, bytesUp: 0, bytesDown: 0, byRoute: new Map() };
  const server = http.createServer((req, res) => {
    stats.requests++;
    const route = `${req.method} ${req.url.replace(/\/session\/[0-9a-f]{20,}/i, '/session/{id}').replace(/\/element\/[^/]+/gi, '/element/{id}')}`;
    stats.byRoute.set(route, (stats.byRoute.get(route) || 0) + 1);
    const chunks = [];
    req.on('data', (c) => { chunks.push(c); stats.bytesUp += c.length; });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(upstreamOrigin);
      later(() => {
        const p = http.request({ host: u.hostname, port: u.port, path: req.url, method: req.method, headers: { ...req.headers, host: u.host } }, (pr) => {
          const chunksDown = [];
          pr.on('data', (c) => { stats.bytesDown += c.length; chunksDown.push(c); });
          pr.on('end', () => later(() => { res.writeHead(pr.statusCode, pr.headers); res.end(Buffer.concat(chunksDown)); }));
        });
        p.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
        if (body.length) p.write(body);
        p.end();
      });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, stats, close: () => new Promise((r) => server.close(r)) };
}

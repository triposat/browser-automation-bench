import http from 'node:http';
import zlib from 'node:zlib';

// A client-rendered app whose weight is a dial. Cards come from JSON at runtime,
// components hold state and listeners, and a ballast module is parsed and executed
// so the JS heap is real rather than a string sitting in the DOM.
export async function serveHeavy({ cards = 20, ballastKb = 0, storeRows = 0 } = {}) {
  const data = Array.from({ length: cards }, (_, i) => ({
    id: i, title: `Product Title Number ${i}`, price: (10 + i * 1.37).toFixed(2),
    stock: i % 7, rating: (i % 5) + 1, sku: `SKU-${String(i).padStart(6, '0')}`,
  }));

  // executable ballast: real functions and closures, not dead weight
  const fnCount = Math.max(0, Math.round(ballastKb * 1024 / 190));
  const ballast = Array.from({ length: fnCount }, (_, i) =>
    `export const f${i} = (a, b) => { const s = "pad${i}".repeat(3); return (a ?? ${i}) + (b ?? ${i}) + s.length; };`
  ).join('\n') + `\nexport const all = [${Array.from({ length: fnCount }, (_, i) => `f${i}`).join(',')}];\n`;

  const app = `
import { all } from './ballast.js';
window.__ballastFns = all.length;
// a client-side store, the way a real app holds its data
const store = { rows: [], index: new Map() };
for (let i = 0; i < ${storeRows}; i++) {
  const r = { id: i, k: 'row-' + i, v: { a: i, b: 'x'.repeat(40), c: [i, i+1, i+2] } };
  store.rows.push(r); store.index.set(r.k, r);
}
window.__store = store;
const root = document.getElementById('app');
const DATA = ${JSON.stringify(data)};
// render components client-side, each with state and listeners
const frag = document.createDocumentFragment();
for (const d of DATA) {
  const el = document.createElement('article');
  el.className = 'product_pod';
  el.innerHTML = '<h3><a href="/p/' + d.id + '" title="' + d.title + '">' + d.title + '</a></h3>' +
    '<p class="price_color">£' + d.price + '</p>' +
    '<p class="instock availability">' + (d.stock ? 'In stock' : 'Out') + '</p>' +
    '<button class="add" data-id="' + d.id + '">Add</button>';
  const state = { hovered: false, qty: 0 };
  el.querySelector('.add').addEventListener('click', () => { state.qty++; el.dataset.qty = state.qty; });
  el.addEventListener('mouseenter', () => { state.hovered = true; });
  frag.appendChild(el);
}
root.appendChild(frag);
// a render loop, the way a live app keeps working
setInterval(() => { root.dataset.tick = String(Date.now() % 997); }, 100);
window.__ready = true;
`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Catalogue</title></head>
<body><div id="app"></div><script type="module" src="./app.js"></script></body></html>`;

  const send = (res, body, type) => {
    const gz = zlib.gzipSync(body);
    res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip', 'content-length': gz.length, 'cache-control': 'no-store' });
    res.end(gz);
  };
  const server = http.createServer((q, r) => {
    if (q.url.startsWith('/app.js')) return send(r, app, 'text/javascript');
    if (q.url.startsWith('/ballast.js')) return send(r, ballast, 'text/javascript');
    send(r, html, 'text/html; charset=utf-8');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, cards,
    rawScriptKb: +((Buffer.byteLength(app) + Buffer.byteLength(ballast)) / 1024).toFixed(0),
    close: () => new Promise((r) => server.close(r)) };
}

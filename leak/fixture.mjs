import http from 'node:http';

// A page with the things that actually leak: event listeners, a timer, closures
// holding DOM references, and images. An 11 KB static page proves nothing here.
export async function serveLeakFixture() {
  const cards = Array.from({ length: 20 }, (_, i) => `
    <article class="product_pod" data-id="${i}">
      <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="p${i}">
      <h3><a href="/p/${i}" title="Product Title Number ${i}">Product ${i}</a></h3>
      <p class="price_color">£${(10 + i * 1.37).toFixed(2)}</p>
      <button class="add" data-id="${i}">Add</button>
    </article>`).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Catalogue</title></head><body>
<div id="app">${cards}</div>
<script>
  // listeners that hold DOM references in closures
  const seen = [];
  document.querySelectorAll('.add').forEach((b) => {
    const card = b.closest('.product_pod');
    b.addEventListener('click', () => { seen.push(card); });
    b.addEventListener('mouseenter', () => { card.dataset.hovered = '1'; });
  });
  // a timer that keeps mutating the DOM
  window.__t = setInterval(() => {
    const n = document.querySelector('.price_color');
    if (n) n.dataset.tick = String(Date.now() % 1000);
  }, 50);
  // a detached-node generator, which is the classic real leak
  window.__detached = [];
  for (let i = 0; i < 200; i++) {
    const d = document.createElement('div');
    d.innerHTML = '<span>' + i + '</span>';
    window.__detached.push(d);
  }
</script></body></html>`;
  const server = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    r.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, bytes: Buffer.byteLength(html),
           close: () => new Promise((r) => server.close(r)) };
}

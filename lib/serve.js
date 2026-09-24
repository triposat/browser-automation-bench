import http from 'node:http';

// The same 20-card listing bench.mjs serves, generated here rather than read
// from disk, so it cannot depend on a file outside the repo.
//
// Keep this markup identical to the fixture in bench.mjs. The guide compares
// numbers from both scripts, and that comparison only holds if the page does.
export async function serveFixture() {
  const cards = Array.from({ length: 20 }, (_, i) => `<article class="product_pod">
    <h3><a href="/b/${i}" title="Product Title Number ${i}">Product Title Number ${i}</a></h3>
    <div class="product_price"><p class="price_color">£${(10 + i * 1.37).toFixed(2)}</p>
    <p class="instock availability">In stock</p></div></article>`).join('');
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Catalogue</title></head><body><ol class="row">${cards}</ol></body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

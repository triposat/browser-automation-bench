import http from 'node:http';

// A catalogue page with 35 records that arrive seven different ways. Each way is
// something a real page actually does, not a contrivance.
export async function serveEdgeCase() {
  const item = (cls, i, tag) => `<div class="${cls}" data-title="Item ${tag}-${i}" data-price="${(9 + i).toFixed(2)}">Item ${tag}-${i}</div>`;
  const five = (cls, tag) => Array.from({ length: 5 }, (_, i) => item(cls, i, tag)).join('');

  // second origin, for the cross-origin iframe
  const other = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<!DOCTYPE html><html><body>${five('item', 'xorigin')}</body></html>`);
  });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const otherPort = other.address().port;

  const main = http.createServer((q, r) => {
    if (q.url === '/same-origin-frame') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end(`<!DOCTYPE html><html><body>${five('item', 'sameframe')}</body></html>`);
    }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Edge cases</title></head><body>
<section id="immediate">${five('item', 'immediate')}</section>
<section id="deferred"></section>
<button id="load-more">Load more</button>
<section id="gated"></section>
<div id="open-host"></div>
<div id="closed-host"></div>
<iframe id="same" src="/same-origin-frame" width="300" height="120"></iframe>
<iframe id="cross" src="http://localhost:${otherPort}/" width="300" height="120"></iframe>
<script>
  // renders 800 ms after load, the way a client-rendered list does
  setTimeout(() => { document.getElementById('deferred').innerHTML = \`${five('item', 'deferred')}\`; }, 800);
  // renders only on click, the way a Load more control does
  document.getElementById('load-more').addEventListener('click', () => {
    document.getElementById('gated').innerHTML = \`${five('item', 'gated')}\`;
  });
  document.getElementById('open-host').attachShadow({ mode: 'open' }).innerHTML = \`${five('item', 'openshadow')}\`;
  document.getElementById('closed-host').attachShadow({ mode: 'closed' }).innerHTML = \`${five('item', 'closedshadow')}\`;
</script></body></html>`);
  });
  await new Promise((r) => main.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${main.address().port}/`,
    totalRecords: 35,
    close: () => { main.close(); other.close(); },
  };
}

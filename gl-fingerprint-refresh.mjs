// Found by reading the SDK source, not the docs: src/gologin-api.js exposes
// refreshProfilesFingerprint(), which PATCHes /browser/fingerprints. The guide
// currently tells readers to hand-patch canvas.mode on each profile. If this
// endpoint re-rolls the fingerprint properly, the hand-patch advice is inferior
// to the path the vendor actually built.
//
// Three profiles, read before, PATCH, read after. Cleans up after itself.
const TOKEN = process.env.GL_TOKEN;
const API = 'https://api.gologin.com';
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const req = async (path, opts = {}) => {
  const r = await fetch(`${API}${path}`, { headers: H, ...opts });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
};

// the fields a page can actually observe, pulled out of the profile config
const shape = (p) => ({
  canvas: p?.canvas?.mode, canvasNoise: p?.canvas?.noise,
  webGL: p?.webGL?.mode, webGLNoise: p?.webGL?.noise,
  renderer: p?.webGLMetadata?.renderer?.slice(0, 40),
  vendor: p?.webGLMetadata?.vendor?.slice(0, 28),
  cores: p?.navigator?.hardwareConcurrency, mem: p?.navigator?.deviceMemory,
  res: p?.navigator?.resolution, ua: p?.navigator?.userAgent?.slice(-38),
});

const ids = [];
try {
  for (let i = 0; i < 3; i++) {
    const c = await req('/browser/quick', {
      method: 'POST',
      body: JSON.stringify({ os: 'win', osSpec: 'win11', name: `src-probe-${i}` }),
    });
    if (c.body?.id) ids.push(c.body.id);
  }
  console.log('created', ids.length, 'profiles');

  const before = {};
  for (const id of ids) before[id] = shape((await req(`/browser/${id}`)).body);

  const patch = await req('/browser/fingerprints', {
    method: 'PATCH', body: JSON.stringify({ browsersIds: ids }),
  });
  console.log('PATCH /browser/fingerprints ->', patch.status);

  const after = {};
  for (const id of ids) after[id] = shape((await req(`/browser/${id}`)).body);

  for (const id of ids) {
    const changed = Object.keys(before[id]).filter((k) => before[id][k] !== after[id][k]);
    console.log(`\n${id.slice(0, 8)}  changed: ${changed.join(', ') || 'NOTHING'}`);
    console.log('  before', JSON.stringify(before[id]));
    console.log('  after ', JSON.stringify(after[id]));
  }
  const uniq = (o, k) => new Set(Object.values(o).map((v) => v[k])).size;
  console.log(`\ndistinct across the 3 profiles  before -> after`);
  for (const k of ['canvas', 'canvasNoise', 'renderer', 'cores', 'res'])
    console.log(`  ${k.padEnd(12)} ${uniq(before, k)} -> ${uniq(after, k)}`);
} finally {
  for (const id of ids) await req(`/browser/${id}`, { method: 'DELETE' });
  console.log('\ncleaned up', ids.length, 'profiles');
}

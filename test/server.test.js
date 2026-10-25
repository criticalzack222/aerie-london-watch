const test = require('node:test');
const assert = require('node:assert');

test('server serves the shell, health, and clean errors', async t => {
  const server = require('../server/server');
  await new Promise(r => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(base + '/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Aerie London Watch/);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);

  const bad = await fetch(base + '/api/cameras/..%2F..%2Fsecret/image');
  assert.equal(bad.status, 400);

  const trav = await fetch(base + '/..%2F..%2Fserver%2Fserver.js');
  assert.ok([403, 200].includes(trav.status));
  assert.doesNotMatch(await trav.text(), /createServer/);

  const hist = await fetch(base + '/api/cameras/00001.01251/history');
  assert.equal(hist.status, 200);
  assert.deepEqual((await hist.json()).frames, []);
  const gone = await fetch(base + '/api/cameras/00001.01251/frames/1700000000000');
  assert.equal(gone.status, 404);
  assert.equal((await fetch(base + '/api/cameras/bad/history')).status, 400);

  const post = await fetch(base + '/api/health', { method: 'POST' });
  assert.equal(post.status, 405);
});

const test = require('node:test');
const assert = require('node:assert');
const { roadOf, bearingOf, normaliseCameras, normaliseDisruptions, isCamId, makeLimiter, makeCache } = require('../server/lib');

const place = (o = {}) => ({
  id: 'JamCams_00001.01251', commonName: ' A40 Westway/Wood Lane ', lat: 51.5165, lon: -0.2263,
  additionalProperties: [
    { key: 'available', value: 'true' },
    { key: 'imageUrl', value: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.01251.jpg' },
    { key: 'videoUrl', value: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.01251.mp4' },
    { key: 'view', value: 'Westbound' }
  ], ...o
});

test('roadOf finds A and M roads', () => {
  assert.equal(roadOf('A40 Westway/Wood Lane'), 'A40');
  assert.equal(roadOf('Blackwall Tunnel A102'), 'A102');
  assert.equal(roadOf('M4 J1'), 'M4');
  assert.equal(roadOf('Euston Rd/Gower St'), null);
});

test('bearingOf reads compass words', () => {
  assert.equal(bearingOf('Westbound'), 270);
  assert.equal(bearingOf('looking north east'), 45);
  assert.equal(bearingOf('N/A'), null);
  assert.equal(bearingOf(null), null);
});

test('normaliseCameras shapes and filters', () => {
  const out = normaliseCameras([place(), place({ lat: null }), place({ additionalProperties: [] })]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    id: '00001.01251', name: 'A40 Westway/Wood Lane', lat: 51.5165, lon: -0.2263,
    img: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.01251.jpg',
    vid: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.01251.mp4',
    view: 'Westbound', bearing: 270, road: 'A40', available: true
  });
  assert.throws(() => normaliseCameras({}));
});

test('normaliseDisruptions parses string points and skips bad ones', () => {
  const out = normaliseDisruptions([
    { id: 'TIMS-1', point: '[-0.1,51.5]', severity: 'Serious', category: 'Works', location: ' Strand ', comments: 'Lane   closed' },
    { id: 'TIMS-2', point: 'not json' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].location, 'Strand');
  assert.equal(out[0].summary, 'Lane closed');
});

test('isCamId rejects path tricks', () => {
  assert.ok(isCamId('00001.01251'));
  assert.ok(!isCamId('../etc/passwd'));
  assert.ok(!isCamId('00001.01251.jpg'));
});

test('limiter blocks after capacity', () => {
  const allow = makeLimiter({ capacity: 2, refillPerSec: 0 });
  assert.ok(allow('a', 0)); assert.ok(allow('a', 0)); assert.ok(!allow('a', 0)); assert.ok(allow('b', 0));
});

test('cache dedupes in-flight loads and serves stale on error', async () => {
  const cache = makeCache();
  let calls = 0;
  const loader = async () => { calls++; return calls; };
  const [a, b] = await Promise.all([cache.get('k', 0, loader), cache.get('k', 0, loader)]);
  assert.equal(calls, 1); assert.equal(a.value, 1); assert.equal(b.value, 1);
  const s = await cache.get('k', 0, async () => { throw new Error('down'); });
  assert.equal(s.value, 1); assert.equal(s.stale, true);
});

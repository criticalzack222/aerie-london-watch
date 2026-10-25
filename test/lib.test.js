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

const { makeRecorder, normaliseLines, normaliseWeather } = require('../server/lib');

test('recorder keeps distinct frames, caps memory, forgets idle cameras', () => {
  const r = makeRecorder({ maxCams: 2, maxFrames: 3, watchMs: 1000 });
  r.watch('a', 0);
  assert.ok(r.add('a', { t: 1, hash: 'x', buf: Buffer.alloc(10) }));
  assert.ok(!r.add('a', { t: 2, hash: 'x', buf: Buffer.alloc(10) }), 'same picture is skipped');
  for (let i = 3; i < 8; i++) r.add('a', { t: i, hash: 'h' + i, buf: Buffer.alloc(10) });
  assert.deepEqual(r.list('a').map(f => f.t), [5, 6, 7]);
  assert.equal(r.get('a', 6).hash, 'h6');
  assert.ok(!r.add('nope', { t: 1, hash: 'z' }), 'unwatched cameras are not recorded');
  r.watch('b', 10); r.watch('c', 20);            // over maxCams: 'a' (oldest) goes
  assert.deepEqual(r.due(30).sort(), ['b', 'c']);
  assert.deepEqual(r.due(5000), []);             // idle past watchMs
});

test('normaliseLines sorts worst first', () => {
  const out = normaliseLines([
    { id: 'victoria', name: 'Victoria', modeName: 'tube', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] },
    { id: 'central', name: 'Central', modeName: 'tube', lineStatuses: [{ statusSeverity: 6, statusSeverityDescription: 'Severe Delays', reason: 'Signal  failure' }] }
  ]);
  assert.equal(out[0].id, 'central');
  assert.equal(out[0].reason, 'Signal failure');
  assert.equal(out[1].status, 'Good Service');
});

test('normaliseWeather maps codes', () => {
  const w = normaliseWeather({ current: { temperature_2m: 11.6, weather_code: 61, wind_speed_10m: 14.2, precipitation: 0.3, is_day: 0 }, daily: { sunset: ['2026-10-25T16:45'] } });
  assert.deepEqual([w.tempC, w.summary, w.windKmh, w.isDay, w.sunset], [12, 'Light rain', 14, false, '2026-10-25T16:45']);
});

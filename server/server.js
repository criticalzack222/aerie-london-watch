'use strict';
/**
 * Aerie London Watch — API + static web server.
 * Zero dependencies, Node 18+ (uses global fetch).
 *
 *   GET /api/health                  liveness + cache stats
 *   GET /api/cameras                 all TfL JamCams, normalised, cached 3 min
 *   GET /api/cameras/:id/image       camera still, proxied + cached 45 s
 *   GET /api/disruptions             live TfL road disruptions, cached 2 min
 *   GET /api/geocode?q=...           London-bounded place search (Nominatim), cached 24 h, 1 req/s upstream
 *   everything else                  static files from ../public
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { LONDON_BBOX, normaliseCameras, normaliseDisruptions, isCamId, makeLimiter, makeCache } = require('./lib');

const PORT = +process.env.PORT || 8080;
const TFL_KEY = process.env.TFL_APP_KEY || '';          // optional: raises TfL rate limits
const CONTACT = process.env.CONTACT_EMAIL || 'admin@example.com'; // Nominatim asks for a contact
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const UA = `AerieLondonWatch/1.0 (+${CONTACT})`;

const cache = makeCache({ max: 600 });
const apiLimit = makeLimiter({ capacity: 120, refillPerSec: 2 });   // 120 burst, ~120/min per IP
const geoLimit = makeLimiter({ capacity: 10, refillPerSec: 0.2 });  // 10 burst, 12/min per IP

const tfl = p => `https://api.tfl.gov.uk${p}${TFL_KEY ? (p.includes('?') ? '&' : '?') + 'app_key=' + encodeURIComponent(TFL_KEY) : ''}`;

async function upstream(url, { as = 'json', timeout = 10000 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw Object.assign(new Error(`Upstream ${res.status}`), { status: res.status });
  return as === 'json' ? res.json() : { type: res.headers.get('content-type') || 'image/jpeg', buf: Buffer.from(await res.arrayBuffer()) };
}

// Nominatim's usage policy allows at most 1 request per second from one app: serialise calls.
let geoChain = Promise.resolve();
function nominatim(q) {
  const run = geoChain.then(async () => {
    const b = LONDON_BBOX;
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&bounded=1&viewbox=${b.west},${b.north},${b.east},${b.south}&q=${encodeURIComponent(q)}`;
    try { return await upstream(url); }
    finally { await new Promise(r => setTimeout(r, 1000)); }
  });
  geoChain = run.catch(() => {});
  return run;
}

/* ---------- response helpers ---------- */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.amazonaws.com https://server.arcgisonline.com https://*.basemaps.cartocdn.com",
    "media-src 'self' https://*.amazonaws.com",
    "connect-src 'self' https://api.tfl.gov.uk https://nominatim.openstreetmap.org https://tiles.openfreemap.org https://server.arcgisonline.com https://*.basemaps.cartocdn.com",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'"
  ].join('; ')
};

function send(req, res, status, body, headers = {}) {
  const h = { ...SECURITY_HEADERS, ...headers };
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  if (!h['Content-Type']) h['Content-Type'] = 'application/json; charset=utf-8';
  const compressible = /json|text|javascript|svg|xml/.test(h['Content-Type']) && buf.length > 1024;
  if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding';
  }
  h['Content-Length'] = buf.length;
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : buf);
}
const fail = (req, res, status, message) => send(req, res, status, { error: message }, { 'Cache-Control': 'no-store' });

/* ---------- API routes ---------- */
async function api(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!apiLimit(ip)) return fail(req, res, 429, 'Too many requests. Slow down and try again in a minute.');

  const p = url.pathname;

  if (p === '/api/health') {
    return send(req, res, 200, { ok: true, uptime: Math.round(process.uptime()), cached: cache.size() }, { 'Cache-Control': 'no-store' });
  }

  if (p === '/api/cameras') {
    const { value, stale } = await cache.get('cams', 180e3, async () => normaliseCameras(await upstream(tfl('/Place/Type/JamCam'))));
    return send(req, res, 200, { updated: new Date().toISOString(), stale, count: value.length, cameras: value },
      { 'Cache-Control': 'public, max-age=60' });
  }

  const m = /^\/api\/cameras\/([^/]+)\/image$/.exec(p);
  if (m) {
    const id = m[1];
    if (!isCamId(id)) return fail(req, res, 400, 'Camera id should look like 00001.01251.');
    const { value } = await cache.get('img:' + id, 45e3, () => upstream(`https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${id}.jpg`, { as: 'bin' }));
    return send(req, res, 200, value.buf, { 'Content-Type': value.type, 'Cache-Control': 'public, max-age=30' });
  }

  if (p === '/api/disruptions') {
    const { value, stale } = await cache.get('disr', 120e3, async () => normaliseDisruptions(await upstream(tfl('/Road/all/Disruption'), { timeout: 15000 })));
    return send(req, res, 200, { updated: new Date().toISOString(), stale, disruptions: value }, { 'Cache-Control': 'public, max-age=60' });
  }

  if (p === '/api/geocode') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
    if (q.length < 2) return fail(req, res, 400, 'Type at least two characters to search.');
    if (!geoLimit(ip)) return fail(req, res, 429, 'Place search is busy. Wait a few seconds and try again.');
    const { value } = await cache.get('geo:' + q.toLowerCase(), 864e5, async () =>
      (await nominatim(q)).map(r => ({ label: r.display_name.split(',').slice(0, 3).join(','), lat: +r.lat, lon: +r.lon, kind: r.type })));
    return send(req, res, 200, { results: value }, { 'Cache-Control': 'public, max-age=3600' });
  }

  return fail(req, res, 404, 'No such API route.');
}

/* ---------- static files ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return fail(req, res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) {
      // single-page app: unknown paths fall back to the shell
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) =>
        e2 ? fail(req, res, 404, 'Not found') : send(req, res, 200, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }));
    }
    const ext = path.extname(file);
    const cacheCtl = ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600';
    send(req, res, 200, buf, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheCtl });
  });
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(req, res, 405, 'Only GET is supported.');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    console.error(new Date().toISOString(), req.url, err.message);
    if (!res.headersSent) fail(req, res, 502, 'TfL did not respond. Cameras will reappear when it is back.');
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Aerie London Watch on http://localhost:${PORT}`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = server;

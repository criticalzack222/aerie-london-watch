'use strict';
// Pure helpers shared by the server and its tests. No I/O here.

const LONDON_BBOX = { west: -0.56, south: 51.27, east: 0.34, north: 51.70 };

const prop = (place, key) =>
  (place.additionalProperties || []).find(a => a.key === key)?.value;

/** Pull a road label out of a TfL camera name, e.g. "A40 Westway/Wood Lane" -> "A40". */
function roadOf(name) {
  const m = /\b(A\d{1,4}[A-Z]?|M\d{1,3})\b/.exec(name || '');
  return m ? m[1] : null;
}

/** Turn a free-text view ("Northbound", "looking S/E") into a bearing in degrees, or null. */
function bearingOf(view) {
  if (!view) return null;
  const v = String(view).toLowerCase().trim();
  if (/^(n\/?a|none|unknown)$/.test(v)) return null;
  const table = [
    [/north[- ]?east|\bn\/?e\b|\bne\b/, 45], [/south[- ]?east|\bs\/?e\b|\bse\b/, 135],
    [/south[- ]?west|\bs\/?w\b|\bsw\b/, 225], [/north[- ]?west|\bn\/?w\b|\bnw\b/, 315],
    [/north|\bn\b|\bnb\b/, 0], [/east|\be\b|\beb\b/, 90], [/south|\bs\b|\bsb\b/, 180], [/west|\bw\b|\bwb\b/, 270]
  ];
  for (const [re, deg] of table) if (re.test(v)) return deg;
  return null;
}

/** Normalise the TfL JamCam payload into the compact shape the frontend uses. */
function normaliseCameras(places) {
  if (!Array.isArray(places)) throw new Error('Unexpected TfL camera payload');
  return places
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && prop(p, 'imageUrl'))
    .map(p => {
      const name = String(p.commonName || '').trim();
      const view = prop(p, 'view') || null;
      return {
        id: String(p.id).replace(/^JamCams_/, ''),
        name,
        lat: +p.lat.toFixed(6),
        lon: +p.lon.toFixed(6),
        img: prop(p, 'imageUrl'),
        vid: prop(p, 'videoUrl') || null,
        view,
        bearing: bearingOf(view),
        road: roadOf(name),
        available: prop(p, 'available') !== 'false'
      };
    });
}

/** Normalise TfL road disruptions; drops anything without a usable point. */
function normaliseDisruptions(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const d of items) {
    let pt = null;
    try { pt = typeof d.point === 'string' ? JSON.parse(d.point) : d.point; } catch { /* ignore */ }
    if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    out.push({
      id: d.id,
      lon: pt[0], lat: pt[1],
      severity: d.severity || 'Unknown',
      category: d.category || '',
      location: (d.location || '').trim(),
      summary: String(d.comments || d.currentUpdate || '').replace(/\s+/g, ' ').trim().slice(0, 280),
      updated: d.lastModifiedTime || d.startDateTime || null
    });
  }
  return out;
}

/** Validate a camera id from a URL ("00001.01251"). */
const isCamId = id => /^\d{5}\.\d{5}$/.test(id);

/** Simple token bucket per key. */
function makeLimiter({ capacity, refillPerSec }) {
  const buckets = new Map();
  return function allow(key, now = Date.now()) {
    let b = buckets.get(key);
    if (!b) { b = { tokens: capacity, at: now }; buckets.set(key, b); }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
    b.at = now;
    if (buckets.size > 5000) buckets.clear(); // crude memory cap
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

/** TTL cache with in-flight de-duplication and serve-stale-on-error. */
function makeCache({ max = 500 } = {}) {
  const store = new Map();     // key -> { value, expires }
  const inflight = new Map();  // key -> Promise
  return {
    async get(key, ttlMs, loader) {
      const hit = store.get(key);
      const now = Date.now();
      if (hit && hit.expires > now) return { value: hit.value, stale: false };
      if (inflight.has(key)) return inflight.get(key);
      const p = (async () => {
        try {
          const value = await loader();
          store.delete(key);
          store.set(key, { value, expires: Date.now() + ttlMs });
          if (store.size > max) store.delete(store.keys().next().value);
          return { value, stale: false };
        } catch (err) {
          if (hit) return { value: hit.value, stale: true };
          throw err;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    },
    size: () => store.size
  };
}

module.exports = { LONDON_BBOX, roadOf, bearingOf, normaliseCameras, normaliseDisruptions, isCamId, makeLimiter, makeCache };

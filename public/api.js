// Data layer. Uses the Aerie backend when it is running; falls back to calling TfL
// and Nominatim directly, so the site also works on a plain static host.

const TFL = 'https://api.tfl.gov.uk';
let mode = null; // 'server' | 'direct'

async function getJSON(url, timeout = 12000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export async function detect() {
  if (mode) return mode;
  try {
    const h = await getJSON('api/health', 2500);
    mode = h && h.ok ? 'server' : 'direct';
  } catch { mode = 'direct'; }
  return mode;
}
export const getMode = () => mode;

/* --- same normalisers as server/lib.js, kept small for the static fallback --- */
const prop = (p, k) => (p.additionalProperties || []).find(a => a.key === k)?.value;
const roadOf = n => (/\b(A\d{1,4}[A-Z]?|M\d{1,3})\b/.exec(n || '') || [])[1] || null;
function bearingOf(view) {
  if (!view) return null;
  const v = String(view).toLowerCase().trim();
  if (/^(n\/?a|none|unknown)$/.test(v)) return null;
  const t = [[/north[- ]?east|\bne\b/, 45], [/south[- ]?east|\bse\b/, 135], [/south[- ]?west|\bsw\b/, 225], [/north[- ]?west|\bnw\b/, 315],
    [/north|\bnb\b/, 0], [/east|\beb\b/, 90], [/south|\bsb\b/, 180], [/west|\bwb\b/, 270]];
  for (const [re, d] of t) if (re.test(v)) return d;
  return null;
}

export async function getCameras() {
  if ((await detect()) === 'server') return (await getJSON('api/cameras')).cameras;
  const raw = await getJSON(`${TFL}/Place/Type/JamCam`, 20000);
  return raw.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && prop(p, 'imageUrl')).map(p => {
    const name = String(p.commonName || '').trim(), view = prop(p, 'view') || null;
    return { id: String(p.id).replace(/^JamCams_/, ''), name, lat: p.lat, lon: p.lon, img: prop(p, 'imageUrl'),
      vid: prop(p, 'videoUrl') || null, view, bearing: bearingOf(view), road: roadOf(name), available: prop(p, 'available') !== 'false' };
  });
}

export async function getDisruptions() {
  if ((await detect()) === 'server') return (await getJSON('api/disruptions', 20000)).disruptions;
  const raw = await getJSON(`${TFL}/Road/all/Disruption`, 25000);
  const out = [];
  for (const d of raw) {
    let pt; try { pt = typeof d.point === 'string' ? JSON.parse(d.point) : d.point; } catch {}
    if (!Array.isArray(pt)) continue;
    out.push({ id: d.id, lon: pt[0], lat: pt[1], severity: d.severity || 'Unknown', category: d.category || '',
      location: (d.location || '').trim(), summary: String(d.comments || '').replace(/\s+/g, ' ').trim().slice(0, 280), updated: d.lastModifiedTime || null });
  }
  return out;
}

/** Image URL for a camera; cache-busted per minute so stills refresh. */
export function imageUrl(cam) {
  const t = Math.floor(Date.now() / 60000);
  return mode === 'server' ? `api/cameras/${cam.id}/image?t=${t}` : `${cam.img}?t=${t}`;
}

export async function geocode(q) {
  if ((await detect()) === 'server') return (await getJSON(`api/geocode?q=${encodeURIComponent(q)}`)).results;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&bounded=1&viewbox=-0.56,51.70,0.34,51.27&q=${encodeURIComponent(q)}`;
  return (await getJSON(url)).map(r => ({ label: r.display_name.split(',').slice(0, 3).join(','), lat: +r.lat, lon: +r.lon, kind: r.type }));
}

/* --- city status --- */
export async function getNetwork() {
  if ((await detect()) === 'server') return (await getJSON('api/network', 20000)).lines;
  const raw = await getJSON(`${TFL}/Line/Mode/tube,elizabeth-line,dlr,overground/Status`, 20000);
  return raw.map(l => {
    const s = (l.lineStatuses || []).slice().sort((a, b) => a.statusSeverity - b.statusSeverity)[0] || {};
    return { id: l.id, name: l.name, mode: l.modeName, status: s.statusSeverityDescription || 'Unknown',
      severity: Number.isFinite(s.statusSeverity) ? s.statusSeverity : 10, reason: String(s.reason || '').replace(/\s+/g, ' ').trim() };
  }).sort((a, b) => a.severity - b.severity || a.name.localeCompare(b.name));
}

const WMO = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle',
  55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Showers', 81: 'Showers',
  82: 'Heavy showers', 95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm' };
export async function getWeather() {
  if ((await detect()) === 'server') return getJSON('api/weather');
  const w = await getJSON('https://api.open-meteo.com/v1/forecast?latitude=51.5074&longitude=-0.1278&current=temperature_2m,weather_code,wind_speed_10m,precipitation,is_day&daily=sunrise,sunset&forecast_days=1&timezone=Europe%2FLondon');
  const c = w.current || {};
  return { tempC: Math.round(c.temperature_2m), windKmh: Math.round(c.wind_speed_10m), rainMm: c.precipitation, code: c.weather_code,
    summary: WMO[c.weather_code] || 'Unknown', isDay: c.is_day === 1, sunrise: w.daily?.sunrise?.[0], sunset: w.daily?.sunset?.[0] };
}

/* --- rewind (needs the Aerie server, which records stills) --- */
export const rewindAvailable = () => mode === 'server';
export async function getHistory(id) {
  if (mode !== 'server') return [];
  return (await getJSON(`api/cameras/${id}/history`)).frames;
}
export const frameUrl = (id, t) => `api/cameras/${id}/frames/${t}`;

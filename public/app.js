import { detect, getMode, getCameras, getDisruptions, imageUrl, geocode } from './api.js';

/* ================= helpers ================= */
const $ = id => document.getElementById(id);
const LONDON = { center: [-0.1225, 51.5045], zoom: 13.2, pitch: 52, bearing: -18 };
const store = {
  get(k, d) { try { const v = localStorage.getItem('aerie:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('aerie:' + k, JSON.stringify(v)); } catch {} }
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (d = new Date()) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Europe/London' }).format(d);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const dur = ms => (reduceMotion ? 0 : ms);
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); }
function setStatus(state, text) { $('netDot').className = 'dot ' + state; $('netTxt').textContent = text; }
function haversine(a, b) {
  const R = 6371e3, r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const distLabel = m => (m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km');
const dms = (v, p, n) => { const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d - m / 60) * 3600).toFixed(1); return `${d}°${String(m).padStart(2, '0')}′${s.padStart(4, '0')}″${v >= 0 ? p : n}`; };

/* ================= state ================= */
let map, cams = [], byId = new Map(), disruptions = [];
let selected = null, clip = false, roadFilter = null, styleKind = store.get('style', 'sat');
let show3d = store.get('3d', true), showDisr = store.get('disr', true);
let pins = store.get('pins', []);
let patrol = null, visited = [];

/* ================= boot ================= */
setInterval(() => ($('clkLon').textContent = fmtTime()), 1000);

/* ================= map styles ================= */
const OFM = 'https://tiles.openfreemap.org/planet';
const FONT = ['Noto Sans Regular'];

function styleFor(kind) {
  const sources = { ofm: { type: 'vector', url: OFM, attribution: '© OpenStreetMap contributors · OpenFreeMap' } };
  const layers = [];
  if (kind === 'sat') {
    sources.sat = { type: 'raster', tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] };
    layers.push({ id: 'base', type: 'raster', source: 'sat', paint: { 'raster-saturation': -0.15, 'raster-contrast': 0.08 } });
  } else if (kind === 'night') {
    sources.dark = { type: 'raster', tileSize: 256, maxzoom: 20, attribution: '© CARTO',
      tiles: ['a', 'b', 'c', 'd'].map(s => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png`) };
    layers.push({ id: 'base', type: 'raster', source: 'dark' });
  } else {
    // "Blueprint" vector map drawn from OpenStreetMap data
    layers.push(
      { id: 'bg', type: 'background', paint: { 'background-color': '#0a1824' } },
      { id: 'park', type: 'fill', source: 'ofm', 'source-layer': 'park', paint: { 'fill-color': '#0f2a26' } },
      { id: 'landcover', type: 'fill', source: 'ofm', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['grass', 'wood']]], paint: { 'fill-color': '#0f2a26' } },
      { id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': '#06243a' } },
      { id: 'rail', type: 'line', source: 'ofm', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'rail'], paint: { 'line-color': '#2a4458', 'line-width': 1, 'line-dasharray': [3, 2] } },
      { id: 'road-minor', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 13,
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary']]], paint: { 'line-color': '#1d3546', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 18, 6] } },
      { id: 'road-major', type: 'line', source: 'ofm', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary']]], paint: { 'line-color': '#35607a', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 18, 12] } }
    );
  }
  const labelInk = kind === 'sat' ? '#ffffff' : '#c4d3de';
  layers.push(
    { id: 'bld3d', type: 'fill-extrusion', source: 'ofm', 'source-layer': 'building', minzoom: 13,
      layout: { visibility: show3d ? 'visible' : 'none' },
      paint: {
        'fill-extrusion-color': kind === 'sat' ? '#c9d6df' : kind === 'night' ? '#1b2a36' : '#173246',
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, ['coalesce', ['get', 'render_height'], 8]],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': kind === 'sat' ? 0.38 : 0.85
      } },
    { id: 'road-names', type: 'symbol', source: 'ofm', 'source-layer': 'transportation_name', minzoom: 14.5,
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11, 'text-letter-spacing': 0.05 },
      paint: { 'text-color': labelInk, 'text-halo-color': 'rgba(0,0,0,.85)', 'text-halo-width': 1.4 } },
    { id: 'places', type: 'symbol', source: 'ofm', 'source-layer': 'place', maxzoom: 15,
      filter: ['in', ['get', 'class'], ['literal', ['suburb', 'neighbourhood', 'quarter', 'town']]],
      layout: { 'text-field': ['upcase', ['get', 'name']], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 13], 'text-letter-spacing': 0.18 },
      paint: { 'text-color': labelInk, 'text-halo-color': 'rgba(0,0,0,.8)', 'text-halo-width': 1.5, 'text-opacity': 0.9 } }
  );
  return { version: 8, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', sources, layers };
}

/* ================= map ================= */
function initMap() {
  const saved = store.get('view', null);
  map = new maplibregl.Map({
    container: 'map', style: styleFor(styleKind), attributionControl: { compact: true },
    center: saved?.center || LONDON.center, zoom: saved?.zoom ?? LONDON.zoom,
    pitch: show3d ? (saved?.pitch ?? LONDON.pitch) : 0, bearing: saved?.bearing ?? LONDON.bearing,
    maxPitch: 80, minZoom: 9, maxBounds: [[-0.9, 51.15], [0.65, 51.85]], // Greater London and a margin
    dragRotate: true, touchPitch: true
  });
  map.on('style.load', addOverlays);
  map.once('load', () => {
    $('boot').classList.add('done');
    loadCameras(); loadDisruptions();
    setInterval(loadCameras, 10 * 60e3);
    setInterval(loadDisruptions, 5 * 60e3);
  });
  map.on('move', () => requestAnimationFrame(readout));
  map.on('moveend', () => {
    const c = map.getCenter();
    store.set('view', { center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() });
    renderNear(); readout();
  });
  ['mousedown', 'touchstart', 'wheel'].forEach(ev => map.getCanvas().addEventListener(ev, () => patrol && stopPatrol('Patrol stopped'), { passive: true }));
  map.on('error', e => { if (e?.error?.status === 403 || /style/i.test(e?.error?.message || '')) console.warn(e.error); });

  $('zin').onclick = () => map.zoomIn();
  $('zout').onclick = () => map.zoomOut();
  $('north').onclick = () => map.easeTo({ bearing: 0, duration: dur(600) });
  $('home').onclick = () => map.flyTo({ ...LONDON, pitch: show3d ? LONDON.pitch : 0, duration: dur(1600) });
  $('locate').onclick = () => {
    if (!navigator.geolocation) return toast('Location is not available in this browser.');
    navigator.geolocation.getCurrentPosition(
      p => {
        const ll = [p.coords.longitude, p.coords.latitude];
        if (haversine(ll, LONDON.center) > 45e3) return toast('You look to be outside London, so the view stays here.');
        map.flyTo({ center: ll, zoom: 16.5, duration: dur(1600) });
      },
      () => toast('Location was refused. Allow it in your browser settings to use this.'),
      { enableHighAccuracy: true, timeout: 9000 }
    );
  };
}

function addOverlays() {
  map.addSource('cams', { type: 'geojson', data: camGeo(), cluster: true, clusterRadius: 42, clusterMaxZoom: 14 });
  map.addSource('cones', { type: 'geojson', data: coneGeo() });
  map.addSource('sel', { type: 'geojson', data: selGeo() });
  map.addSource('disr', { type: 'geojson', data: disrGeo() });

  map.addLayer({ id: 'cones', type: 'fill', source: 'cones', minzoom: 15, paint: { 'fill-color': '#4fd1e8', 'fill-opacity': 0.16 } });
  map.addLayer({ id: 'disr', type: 'circle', source: 'disr', layout: { visibility: showDisr ? 'visible' : 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 9],
      'circle-color': ['match', ['get', 'severity'], ['Serious', 'Severe'], '#ff5a5f', 'Moderate', '#ff8a3d', '#ffd166'],
      'circle-opacity': 0.85, 'circle-stroke-color': '#070b0f', 'circle-stroke-width': 1.5, 'circle-blur': 0.1
    } });
  map.addLayer({ id: 'clusters', type: 'circle', source: 'cams', filter: ['has', 'point_count'],
    paint: {
      'circle-color': 'rgba(13,20,27,.92)', 'circle-stroke-color': '#ffb020', 'circle-stroke-width': 1.5,
      'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 40, 23, 120, 28]
    } });
  map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'cams', filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': FONT, 'text-size': 12, 'text-allow-overlap': true },
    paint: { 'text-color': '#ffb020' } });
  map.addLayer({ id: 'cams', type: 'circle', source: 'cams', filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 5, 15, 7, 18, 10],
      'circle-color': ['case', ['get', 'available'], '#ffb020', '#7f93a3'],
      'circle-stroke-color': '#070b0f', 'circle-stroke-width': 2
    } });
  map.addLayer({ id: 'sel', type: 'circle', source: 'sel',
    paint: { 'circle-radius': 16, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#4fd1e8', 'circle-stroke-width': 2.5 } });

  map.on('click', 'clusters', async e => {
    const f = e.features[0];
    try {
      const z = await map.getSource('cams').getClusterExpansionZoom(f.properties.cluster_id);
      map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(z + 0.3, 17), duration: dur(700) });
    } catch { map.easeTo({ center: f.geometry.coordinates, zoom: map.getZoom() + 2 }); }
  });
  map.on('click', 'cams', e => { const c = byId.get(e.features[0].properties.id); if (c) selectCam(c, { fly: true }); });
  map.on('click', 'disr', e => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ offset: 10, maxWidth: '260px' }).setLngLat(e.features[0].geometry.coordinates)
      .setHTML(`<div class="pop"><span class="sev">${esc(p.severity).toUpperCase()} · ${esc(p.category)}</span><b>${esc(p.location)}</b>${esc(p.summary)}</div>`).addTo(map);
  });
  const hoverTip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
  for (const id of ['cams', 'clusters', 'disr']) {
    map.on('mouseenter', id, e => {
      map.getCanvas().style.cursor = 'pointer';
      if (id === 'cams') hoverTip.setLngLat(e.features[0].geometry.coordinates).setHTML(`<div class="pop"><b>${esc(e.features[0].properties.name)}</b></div>`).addTo(map);
    });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; hoverTip.remove(); });
  }
}

const setData = (id, data) => map?.getSource(id)?.setData(data);
const visibleCams = () => (roadFilter ? cams.filter(c => c.road === roadFilter) : cams);
const camGeo = () => ({ type: 'FeatureCollection', features: visibleCams().map(c => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] }, properties: { id: c.id, name: c.name, available: c.available } })) });
const selGeo = () => ({ type: 'FeatureCollection', features: selected ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [selected.lon, selected.lat] }, properties: {} }] : [] });
const disrGeo = () => ({ type: 'FeatureCollection', features: disruptions.map(d => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [d.lon, d.lat] }, properties: d })) });
function coneGeo() {
  // a 60° wedge, ~90 m long, pointing where the camera looks (only when TfL says which way)
  const feats = [];
  for (const c of visibleCams()) {
    if (c.bearing == null) continue;
    const pts = [[c.lon, c.lat]], len = 90, k = 1 / 111320;
    for (let a = c.bearing - 30; a <= c.bearing + 30; a += 10) {
      const r = a * Math.PI / 180;
      pts.push([c.lon + Math.sin(r) * len * k / Math.cos(c.lat * Math.PI / 180), c.lat + Math.cos(r) * len * k]);
    }
    pts.push([c.lon, c.lat]);
    feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} });
  }
  return { type: 'FeatureCollection', features: feats };
}

/* ================= data ================= */
async function loadCameras() {
  try {
    const list = await getCameras();
    cams = list; byId = new Map(list.map(c => [c.id, c]));
    setData('cams', camGeo()); setData('cones', coneGeo());
    const off = cams.filter(c => !c.available).length;
    setStatus('live', `${cams.length} CAMERAS${off ? ` · ${off} OFFLINE` : ''}${getMode() === 'server' ? '' : ' · DIRECT'}`);
    renderRoads(); renderNear(); renderWall(); readout();
    const fromHash = /cam=(\d{5}\.\d{5})/.exec(location.hash)?.[1];
    const first = fromHash || (!selected && store.get('selected', null));
    if (first && byId.has(first)) selectCam(byId.get(first), { fly: !!fromHash });
  } catch (err) {
    setStatus('err', 'CAMERAS UNAVAILABLE · RETRYING');
    toast(err.message || 'Could not reach TfL. Retrying in 20 seconds.');
    setTimeout(loadCameras, 20e3);
  }
}

async function loadDisruptions() {
  try {
    disruptions = await getDisruptions();
    setData('disr', disrGeo());
    renderAlerts();
  } catch { /* alerts are secondary; keep the last good set */ }
}

/* ================= selection & feed ================= */
function selectCam(c, { fly = false, street = false } = {}) {
  selected = c; clip = false;
  store.set('selected', c.id);
  history.replaceState(null, '', '#cam=' + c.id);
  visited = [c.id, ...visited.filter(v => v !== c.id)].slice(0, 40);
  setData('sel', selGeo());
  if (fly || street) {
    map.flyTo({
      center: [c.lon, c.lat],
      zoom: street ? 18.6 : Math.max(map.getZoom(), 16.8),
      pitch: show3d ? (street ? 74 : Math.max(map.getPitch(), 55)) : 0,
      bearing: street && c.bearing != null ? c.bearing : map.getBearing(),
      duration: dur(street ? 2200 : 1400), essential: true
    });
  }
  renderFeed();
  $('camInfo').hidden = false;
  $('camName').textContent = c.name;
  const nearestAlert = disruptions.map(d => ({ d, m: haversine([c.lon, c.lat], [d.lon, d.lat]) })).sort((a, b) => a.m - b.m)[0];
  $('camMeta').innerHTML =
    `<dt>ID</dt><dd>${esc(c.id)}</dd>` +
    (c.road ? `<dt>ROAD</dt><dd>${esc(c.road)}</dd>` : '') +
    (c.view ? `<dt>FACING</dt><dd>${esc(c.view)}</dd>` : '') +
    `<dt>POS</dt><dd>${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</dd>` +
    `<dt>STATE</dt><dd style="color:var(--${c.available ? 'ok' : 'bad'})">${c.available ? 'ONLINE' : 'REPORTED OFFLINE'}</dd>` +
    (nearestAlert && nearestAlert.m < 600 ? `<dt>ALERT</dt><dd style="color:var(--warn)">${esc(nearestAlert.d.severity)} · ${distLabel(nearestAlert.m)} away</dd>` : '');
  $('svLink').href = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${c.lat},${c.lon}`;
  $('clipBtn').hidden = !c.vid;
  $('clipBtn').textContent = 'PLAY CLIP';
  $('pinBtn').textContent = pins.includes(c.id) ? 'UNPIN' : 'PIN TO WALL';
  openTab('feed');
  $('paneFeed').scrollTop = 0; // keep the live picture in view after picking from the list
  document.getElementById('app').classList.remove('sheet-min');
}

function renderFeed() {
  const c = selected, f = $('feed');
  if (!c) return;
  f.classList.add('loading');
  f.innerHTML = (clip && c.vid
    ? `<video src="${esc(c.vid)}" autoplay muted loop playsinline></video>`
    : `<img src="${esc(imageUrl(c))}" alt="Live view from ${esc(c.name)}">`) +
    `<div class="tag"><span class="dot live"></span>${clip ? 'RECENT CLIP' : 'LIVE STILL'}</div><div class="ts">${fmtTime()}</div>`;
  const el = f.querySelector('img,video');
  el.addEventListener(clip ? 'loadeddata' : 'load', () => f.classList.remove('loading'), { once: true });
  el.addEventListener('error', () => {
    f.classList.remove('loading');
    f.innerHTML = `<div class="empty">This camera isn't sending pictures right now.<br>Try one from the nearest list.</div>`;
  }, { once: true });
  if (!clip) f.querySelector('img').onclick = () => openViewer(c);
}
setInterval(() => { if (selected && !clip && !document.hidden) renderFeed(); }, 60e3);

$('clipBtn').onclick = () => { clip = !clip; $('clipBtn').textContent = clip ? 'SHOW STILL' : 'PLAY CLIP'; renderFeed(); };
$('bigBtn').onclick = () => selected && openViewer(selected);
$('streetBtn').onclick = () => selected && selectCam(selected, { street: true });
$('pinBtn').onclick = () => selected && togglePin(selected.id);
$('shareBtn').onclick = async () => {
  const url = location.href.split('#')[0] + '#cam=' + selected.id;
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
};

function nearest(from, n = 6, exclude = []) {
  return visibleCams().filter(c => !exclude.includes(c.id))
    .map(c => ({ c, m: haversine(from, [c.lon, c.lat]) })).sort((a, b) => a.m - b.m).slice(0, n);
}
function renderNear() {
  if (!cams.length || !map) return;
  const ctr = map.getCenter();
  $('near').innerHTML = nearest([ctr.lng, ctr.lat]).map(({ c, m }) =>
    `<li><button data-id="${c.id}"><span>${esc(c.name)}</span><small>${distLabel(m)}</small></button></li>`).join('');
}
$('near').onclick = e => { const b = e.target.closest('button'); if (b) selectCam(byId.get(b.dataset.id), { fly: true }); };

/* ================= road filter ================= */
function renderRoads() {
  const counts = {};
  cams.forEach(c => c.road && (counts[c.road] = (counts[c.road] || 0) + 1));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 14);
  $('roads').innerHTML = `<button data-road="" aria-pressed="${!roadFilter}">ALL ROADS</button>` +
    top.map(([r, n]) => `<button data-road="${r}" aria-pressed="${roadFilter === r}">${r} · ${n}</button>`).join('');
}
$('roads').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  roadFilter = b.dataset.road || null;
  setData('cams', camGeo()); setData('cones', coneGeo()); renderRoads(); renderNear();
  if (roadFilter) {
    const list = visibleCams(), bb = new maplibregl.LngLatBounds();
    list.forEach(c => bb.extend([c.lon, c.lat]));
    map.fitBounds(bb, { padding: 70, maxZoom: 15, duration: dur(1200) });
    toast(`Showing ${list.length} cameras on the ${roadFilter}`);
  }
};

/* ================= readout ================= */
function readout() {
  if (!map) return;
  const c = map.getCenter(), z = map.getZoom();
  $('rLat').textContent = dms(c.lat, 'N', 'S');
  $('rLon').textContent = dms(c.lng, 'E', 'W');
  const mpp = 156543.03 * Math.cos(c.lat * Math.PI / 180) / 2 ** z;
  const alt = mpp * map.getCanvas().clientHeight * Math.cos(map.getPitch() * Math.PI / 180) * 0.9;
  $('rAlt').textContent = alt > 1000 ? (alt / 1000).toFixed(1) + ' km' : Math.max(20, Math.round(alt)) + ' m';
  const hdg = (map.getBearing() + 360) % 360;
  $('rHdg').textContent = String(Math.round(hdg)).padStart(3, '0') + '°';
  $('compass').style.transform = `rotate(${-map.getBearing()}deg)`;
  if (cams.length) { const b = map.getBounds(); $('rCams').textContent = visibleCams().filter(k => b.contains([k.lon, k.lat])).length + ' cams'; }
}

/* ================= wall ================= */
function togglePin(id) {
  if (pins.includes(id)) pins = pins.filter(p => p !== id);
  else { if (pins.length >= 9) return toast('The wall holds 9 cameras. Unpin one first.'); pins.push(id); toast('Pinned to the wall'); }
  store.set('pins', pins);
  if (selected) $('pinBtn').textContent = pins.includes(selected.id) ? 'UNPIN' : 'PIN TO WALL';
  renderWall();
}
function renderWall() {
  const list = pins.map(id => byId.get(id)).filter(Boolean);
  $('wallCount').textContent = list.length;
  $('wallHint').hidden = list.length > 0;
  $('wall').innerHTML = list.map(c => `<div class="tile">
      <img src="${esc(imageUrl(c))}" alt="${esc(c.name)}" data-view="${c.id}" loading="lazy">
      <button class="goto" data-goto="${c.id}" aria-label="Show ${esc(c.name)} on the map">MAP</button>
      <button class="x" data-unpin="${c.id}" aria-label="Unpin ${esc(c.name)}">✕</button>
      <div class="cap">${esc(c.name)}</div></div>`).join('');
}
$('wall').onclick = e => {
  const t = e.target.closest('[data-unpin],[data-goto],[data-view]'); if (!t) return;
  if (t.dataset.unpin) togglePin(t.dataset.unpin);
  else if (t.dataset.goto) selectCam(byId.get(t.dataset.goto), { fly: true });
  else openViewer(byId.get(t.dataset.view));
};
setInterval(() => { if (!document.hidden && pins.length) renderWall(); }, 60e3);

/* ================= alerts ================= */
const SEV_RANK = { Severe: 0, Serious: 1, Moderate: 2, Minimal: 3 };
function renderAlerts() {
  const list = [...disruptions].sort((a, b) => (SEV_RANK[a.severity] ?? 4) - (SEV_RANK[b.severity] ?? 4)).slice(0, 80);
  $('alertCount').textContent = disruptions.length;
  $('alerts').innerHTML = list.length ? list.map(d => `<li><button data-lon="${d.lon}" data-lat="${d.lat}">
      <span class="sev ${esc(d.severity)}">${esc(d.severity).toUpperCase()} · ${esc(d.category)}</span>
      <b>${esc(d.location || 'Unnamed location')}</b><span>${esc(d.summary)}</span></button></li>`).join('')
    : '<li class="hint" style="padding:10px 0">No road disruptions reported right now.</li>';
}
$('alerts').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  const ll = [+b.dataset.lon, +b.dataset.lat];
  map.flyTo({ center: ll, zoom: 16.5, duration: dur(1400) });
  const near = nearest(ll, 1)[0];
  if (near && near.m < 800) setTimeout(() => selectCam(near.c), dur(1400));
};

/* ================= patrol ================= */
function startPatrol() {
  const b = map.getBounds();
  let pool = visibleCams().filter(c => c.available && b.contains([c.lon, c.lat]));
  if (pool.length < 2) pool = nearest([map.getCenter().lng, map.getCenter().lat], 12).map(x => x.c).filter(c => c.available);
  if (!pool.length) return toast('No cameras to patrol here.');
  // order as a nearest-neighbour route so the flight path doesn't zig-zag
  const route = [pool.shift()];
  while (pool.length) {
    const last = route[route.length - 1];
    pool.sort((a, z) => haversine([last.lon, last.lat], [a.lon, a.lat]) - haversine([last.lon, last.lat], [z.lon, z.lat]));
    route.push(pool.shift());
  }
  let i = 0;
  const step = () => {
    const c = route[i++ % route.length];
    selectCam(c);
    map.flyTo({ center: [c.lon, c.lat], zoom: 17.4, pitch: show3d ? 64 : 0, bearing: (map.getBearing() + 40) % 360, duration: dur(3200), essential: true });
  };
  patrol = setInterval(step, 9000); step();
  $('btnPatrol').setAttribute('aria-pressed', true);
  toast(`Patrolling ${route.length} cameras · touch the map to stop`);
}
function stopPatrol(msg) {
  clearInterval(patrol); patrol = null;
  $('btnPatrol').setAttribute('aria-pressed', false);
  if (msg) toast(msg);
}
$('btnPatrol').onclick = () => (patrol ? stopPatrol('Patrol stopped') : startPatrol());

/* ================= toolbar ================= */
document.querySelectorAll('[data-style]').forEach(b => {
  b.setAttribute('aria-pressed', b.dataset.style === styleKind);
  b.onclick = () => setStyleKind(b.dataset.style);
});
function setStyleKind(kind) {
  if (kind === styleKind || !map) return;
  styleKind = kind; store.set('style', kind);
  document.querySelectorAll('[data-style]').forEach(x => x.setAttribute('aria-pressed', x.dataset.style === kind));
  map.setStyle(styleFor(kind), { diff: false }); // overlays are re-added on style.load
}
function set3d(on) {
  show3d = on; store.set('3d', on);
  $('btn3d').setAttribute('aria-pressed', on);
  if (map.getLayer('bld3d')) map.setLayoutProperty('bld3d', 'visibility', on ? 'visible' : 'none');
  map.easeTo({ pitch: on ? 58 : 0, duration: dur(900) });
}
function setDisr(on) {
  showDisr = on; store.set('disr', on);
  $('btnDisr').setAttribute('aria-pressed', on);
  if (map.getLayer('disr')) map.setLayoutProperty('disr', 'visibility', on ? 'visible' : 'none');
}
$('btn3d').setAttribute('aria-pressed', show3d);
$('btnDisr').setAttribute('aria-pressed', showDisr);
$('btn3d').onclick = () => set3d(!show3d);
$('btnDisr').onclick = () => setDisr(!showDisr);

function setSplit(on) {
  const app = $('app'); on = on ?? !app.classList.contains('split');
  app.classList.toggle('split', on);
  $('btnSplit').setAttribute('aria-pressed', on);
  if (on) openTab('wall');
  setTimeout(() => map?.resize(), 80);
}
$('btnSplit').onclick = () => setSplit();
$('grab').onclick = () => { $('app').classList.toggle('sheet-min'); setTimeout(() => map?.resize(), 80); };

function openTab(t) {
  for (const [tab, pane] of [['tabFeed', 'paneFeed'], ['tabWall', 'paneWall'], ['tabAlerts', 'paneAlerts']]) {
    const on = pane.toLowerCase().endsWith(t);
    $(tab).setAttribute('aria-selected', on); $(pane).hidden = !on;
  }
}
$('tabFeed').onclick = () => openTab('feed');
$('tabWall').onclick = () => openTab('wall');
$('tabAlerts').onclick = () => openTab('alerts');

/* ================= viewer ================= */
let viewing = null;
function openViewer(c) {
  if (!c) return;
  viewing = c;
  $('viewerImg').src = imageUrl(c); $('viewerImg').alt = c.name; $('viewerCap').textContent = c.name;
  $('viewer').hidden = false; $('viewerClose').focus();
}
const closeViewer = () => { $('viewer').hidden = true; viewing = null; };
function viewerStep(dir) {
  if (!viewing) return;
  if (dir < 0) { const prev = visited.find(id => id !== viewing.id && byId.has(id)); if (prev) openViewer(byId.get(prev)); return; }
  const nxt = nearest([viewing.lon, viewing.lat], 1, [viewing.id, ...visited.slice(0, 8)])[0];
  if (nxt) { visited.unshift(nxt.c.id); selectCam(nxt.c, { fly: true }); openViewer(nxt.c); }
}
$('viewerClose').onclick = closeViewer;
$('viewerNext').onclick = () => viewerStep(1);
$('viewerPrev').onclick = () => viewerStep(-1);
$('viewer').onclick = e => { if (e.target.id === 'viewer') closeViewer(); };

/* ================= search ================= */
const q = $('q'), res = $('results');
let items = [], active = -1, geoTimer, geoAbortTag = 0;
function showResults(list, msg = '') {
  items = list; active = -1;
  res.innerHTML = list.map((it, i) => `<button role="option" data-i="${i}"><span>${esc(it.label)}</span><small>${it.cam ? 'CAMERA' : 'PLACE'}</small></button>`).join('') +
    (msg ? `<div class="msg">${esc(msg)}</div>` : '');
  res.classList.toggle('open', list.length > 0 || !!msg);
}
function choose(it) {
  res.classList.remove('open'); q.blur();
  if (it.cam) selectCam(it.cam, { fly: true });
  else map.flyTo({ center: [it.lon, it.lat], zoom: 17, pitch: show3d ? 60 : 0, duration: dur(1800) });
}
q.addEventListener('input', () => {
  const v = q.value.trim(), lv = v.toLowerCase();
  clearTimeout(geoTimer);
  if (v.length < 2) return showResults([]);
  const camHits = cams.filter(c => c.name.toLowerCase().includes(lv) || c.road?.toLowerCase() === lv).slice(0, 6).map(c => ({ label: c.name, cam: c }));
  showResults(camHits, 'Searching places…');
  const tag = ++geoAbortTag;
  geoTimer = setTimeout(async () => {
    try {
      const places = await geocode(v);
      if (tag !== geoAbortTag) return;
      showResults([...camHits, ...places], camHits.length + places.length ? '' : 'Nothing found in London for that.');
    } catch (err) { if (tag === geoAbortTag) showResults(camHits, err.message); }
  }, 500);
});
q.addEventListener('keydown', e => {
  const btns = res.querySelectorAll('button');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); if (!btns.length) return;
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
    btns.forEach((b, i) => b.classList.toggle('active', i === active));
  } else if (e.key === 'Enter') { e.preventDefault(); const it = items[Math.max(active, 0)]; if (it) choose(it); }
  else if (e.key === 'Escape') { res.classList.remove('open'); q.blur(); }
});
res.onclick = e => { const b = e.target.closest('button'); if (b) choose(items[+b.dataset.i]); };
document.addEventListener('click', e => { if (!e.target.closest('.search')) res.classList.remove('open'); });

/* ================= keyboard ================= */
document.addEventListener('keydown', e => {
  if (e.target.matches('input') || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  const act = {
    '/': () => q.focus(), escape: () => (viewing ? closeViewer() : patrol && stopPatrol('Patrol stopped')),
    n: () => { const from = selected ? [selected.lon, selected.lat] : [map.getCenter().lng, map.getCenter().lat]; const x = nearest(from, 1, visited.slice(0, 10))[0]; if (x) selectCam(x.c, { fly: true }); },
    a: () => $('btnPatrol').click(), w: () => setSplit(), b: () => set3d(!show3d), r: () => setDisr(!showDisr),
    h: () => $('home').click(), s: () => setStyleKind('sat'), d: () => setStyleKind('night'), m: () => setStyleKind('map'),
    arrowright: () => viewing && viewerStep(1), arrowleft: () => viewing && viewerStep(-1)
  }[k];
  if (act) { e.preventDefault(); act(); }
});

window.addEventListener('hashchange', () => {
  const id = /cam=(\d{5}\.\d{5})/.exec(location.hash)?.[1];
  if (id && byId.has(id) && selected?.id !== id) selectCam(byId.get(id), { fly: true });
});

/* ================= offline shell ================= */
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
detect();

/* ================= start (last, so every const above exists) ================= */
if (!window.maplibregl) {
  $('bootTxt').textContent = 'The map engine could not load. Check your connection and reload the page.';
} else if (!(() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } })()) {
  $('bootTxt').textContent = 'This browser cannot draw 3D maps (WebGL is off). Try Safari, Chrome or Firefox.';
} else {
  initMap();
}

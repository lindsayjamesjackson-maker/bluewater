import createTidePredictor from './vendor/tide-predictor.js';

/* ------------------------------------------------------------------ *
 * Bluewater - SST / chlorophyll / breaks for offshore fishing
 * ------------------------------------------------------------------ */

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const DOMAINS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0';
const CMAP = 'https://gibs.earthdata.nasa.gov/colormaps/v1.3';
const TILE_CACHE = 'bw-tiles-v1';

const LAYERS = {
  sst: {
    id: 'GHRSST_L4_MUR_Sea_Surface_Temperature',
    tms: 'GoogleMapsCompatible_Level7', maxNative: 7,
    cmap: 'GHRSST_Sea_Surface_Temperature',
    name: 'SST', full: 'Sea surface temperature', unit: '°C',
    fmt: v => v.toFixed(1) + '°',
    // break finder works in raw degrees
    grad: v => v, gUnit: '°C/km', gRange: [0.02, 0.60], gDefault: 0.12
  },
  chl: {
    id: 'VIIRS_NOAA21_Chlorophyll_a',
    tms: 'GoogleMapsCompatible_Level7', maxNative: 7,
    cmap: 'VIIRS_Chlorophyll',
    name: 'Chl-a', full: 'Chlorophyll-a', unit: 'mg/m³',
    fmt: v => v < 1 ? v.toFixed(3) : v.toFixed(2),
    // chlorophyll spans decades - measure the break on a log scale
    grad: v => Math.log10(Math.max(v, 1e-3)), gUnit: 'dex/km', gRange: [0.02, 0.50], gDefault: 0.10
  },
  sstA: {
    id: 'GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies',
    tms: 'GoogleMapsCompatible_Level7', maxNative: 7,
    cmap: 'GHRSST_Sea_Surface_Temperature_Anomalies',
    name: 'Anomaly', full: 'SST anomaly vs average', unit: '°C',
    fmt: v => (v > 0 ? '+' : '') + v.toFixed(1) + '°',
    grad: v => v, gUnit: '°C/km', gRange: [0.02, 0.60], gDefault: 0.12
  }
};

const HOME = { lat: -18.05, lon: 122.0, zoom: 8 };

/* ---------------------------- small utils --------------------------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem('bw.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bw.' + k, JSON.stringify(v)); } catch {} }
};
let toastT;
function toast(msg, ms = 2400) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
function dayLabel(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d), today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - dt) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return dt.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
}
function dm(v, pos, neg) {
  const h = v < 0 ? neg : pos, a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
  return d + '°' + m.toFixed(3) + "' " + h;
}
const fmtPos = (lat, lon) => dm(lat, 'N', 'S') + '  ' + dm(lon, 'E', 'W');
function haversine(a, b, c, d) {
  const R = 6371000, p = Math.PI / 180;
  const dl = (c - a) * p, dg = (d - b) * p;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function bearing(a, b, c, d) {
  const p = Math.PI / 180, y = Math.sin((d - b) * p) * Math.cos(c * p);
  const x = Math.cos(a * p) * Math.sin(c * p) - Math.sin(a * p) * Math.cos(c * p) * Math.cos((d - b) * p);
  return (Math.atan2(y, x) / p + 360) % 360;
}
const compass = deg => ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(deg / 22.5) % 16];
const nm = m => (m / 1852);

/* --------------------------- colour maps ---------------------------- */
const cmaps = {};              // name -> { lut: Map(rgbInt -> value), stops:[{v,rgb}] }
async function loadColorMap(name) {
  if (cmaps[name]) return cmaps[name];
  const cached = store.get('cmap.' + name, null);
  let entries = cached;
  if (!entries) {
    const xml = await (await fetch(CMAP + '/' + name + '.xml')).text();
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const cm = [...doc.querySelectorAll('ColorMap')].find(c => c.getAttribute('units'));
    if (!cm) throw new Error('no colormap');
    entries = [...cm.querySelectorAll('ColorMapEntry')].map(e => {
      const m = (e.getAttribute('value') || '').match(/([\[(])\s*(\S+?)\s*,\s*(\S+?)\s*([\])])/);
      if (!m) return null;
      const lo = m[2] === '-INF' ? null : parseFloat(m[2]);
      const hi = m[3] === '+INF' ? null : parseFloat(m[3]);
      const v = lo === null ? hi : hi === null ? lo : (lo + hi) / 2;
      return [e.getAttribute('rgb'), v];
    }).filter(Boolean);
    store.set('cmap.' + name, entries);
  }
  const lut = new Map(), stops = [];
  for (const [rgb, v] of entries) {
    const [r, g, b] = rgb.split(',').map(Number);
    lut.set((r << 16) | (g << 8) | b, v);
    stops.push({ v, rgb: 'rgb(' + rgb + ')' });
  }
  stops.sort((a, b) => a.v - b.v);
  return (cmaps[name] = { lut, stops });
}

/* ------------------------------ map --------------------------------- */
const saved = store.get('view', null);
const home = store.get('home', HOME);
const map = L.map('map', {
  zoomControl: false, attributionControl: true, worldCopyJump: true,
  center: saved ? [saved.lat, saved.lon] : [home.lat, home.lon],
  zoom: saved ? saved.zoom : home.zoom, minZoom: 3, maxZoom: 13,
  tap: false, zoomSnap: 0.5, wheelPxPerZoomLevel: 90
});
map.attributionControl.setPrefix('');

const esriAttr = 'Esri, GEBCO, NOAA';
const bathy = L.tileLayer(
  'https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 13, maxNativeZoom: 13, attribution: esriAttr, crossOrigin: true }).addTo(map);
const labels = L.tileLayer(
  'https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 13, maxNativeZoom: 13, pane: 'shadowPane', crossOrigin: true }).addTo(map);
const gebco = L.tileLayer.wms('https://wms.gebco.net/mapserv', {
  layers: 'GEBCO_LATEST', format: 'image/png', transparent: false, version: '1.3.0',
  attribution: 'GEBCO', opacity: 0.85
});

map.createPane('data'); map.getPane('data').style.zIndex = 350;
map.createPane('breaks'); map.getPane('breaks').style.zIndex = 400;
map.getPane('breaks').style.pointerEvents = 'none';

/* ------------------------ data (imagery) layer ---------------------- */
const state = {
  layer: store.get('layer', 'sst'),
  date: null,
  dates: [],
  latest: {},
  opacity: store.get('opacity', 80),
  breaks: store.get('breaks', false),
  thresh: store.get('thresh', 30),
  spd: store.get('spd', 'kn'),
  gps: null
};

let dataLayer = null;
function dataUrl(key, date) {
  const L_ = LAYERS[key];
  return GIBS + '/' + L_.id + '/default/' + date + '/' + L_.tms + '/{z}/{y}/{x}.png';
}
function buildDataLayer() {
  if (dataLayer) map.removeLayer(dataLayer);
  const L_ = LAYERS[state.layer];
  dataLayer = L.tileLayer(dataUrl(state.layer, state.date), {
    pane: 'data', maxZoom: 13, maxNativeZoom: L_.maxNative, minZoom: 3,
    opacity: state.opacity / 100, crossOrigin: 'anonymous',
    attribution: 'NASA GIBS'
  }).addTo(map);
}

/* --------------------- decoded tile cache + breaks ------------------- */
const decoded = new Map();     // key -> Promise<{vals:Float32Array, grad:Float32Array}>
function decodeKey(key, date, z, x, y) { return key + '|' + date + '|' + z + '/' + x + '/' + y; }

function loadImg(src) {
  return new Promise((res, rej) => {
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => res(im); im.onerror = () => rej(new Error('tile'));
    im.src = src;
  });
}

/** Decode one native-resolution data tile to values + gradient magnitude (per km). */
function getDecoded(key, date, z, x, y) {
  const k = decodeKey(key, date, z, x, y);
  if (decoded.has(k)) return decoded.get(k);
  const p = (async () => {
    const L_ = LAYERS[key];
    const cm = await loadColorMap(L_.cmap);
    const url = GIBS + '/' + L_.id + '/default/' + date + '/' + L_.tms + '/' + z + '/' + y + '/' + x + '.png';
    const im = await loadImg(url);
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = false;
    g.drawImage(im, 0, 0, 256, 256);
    const d = g.getImageData(0, 0, 256, 256).data;
    const vals = new Float32Array(65536).fill(NaN);
    for (let i = 0, p2 = 0; i < 65536; i++, p2 += 4) {
      if (d[p2 + 3] < 200) continue;
      const v = cm.lut.get((d[p2] << 16) | (d[p2 + 1] << 8) | d[p2 + 2]);
      if (v !== undefined) vals[i] = v;
    }
    // metres per pixel at the tile centre
    const nTiles = Math.pow(2, z);
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / nTiles)));
    const mpp = 156543.03392 * Math.cos(latRad) / nTiles;
    const kmpp = mpp / 1000;
    const tf = L_.grad;
    const grad = new Float32Array(65536).fill(NaN);
    for (let yy = 1; yy < 255; yy++) {
      for (let xx = 1; xx < 255; xx++) {
        const i = yy * 256 + xx;
        const a = vals[i - 257], b = vals[i - 256], c2 = vals[i - 255];
        const e = vals[i - 1], f = vals[i + 1];
        const h = vals[i + 255], j = vals[i + 256], l = vals[i + 257];
        if (isNaN(a) || isNaN(b) || isNaN(c2) || isNaN(e) || isNaN(f) || isNaN(h) || isNaN(j) || isNaN(l)) continue;
        const gx = (tf(c2) + 2 * tf(f) + tf(l)) - (tf(a) + 2 * tf(e) + tf(h));
        const gy = (tf(h) + 2 * tf(j) + tf(l)) - (tf(a) + 2 * tf(b) + tf(c2));
        grad[i] = Math.hypot(gx, gy) / (8 * kmpp);
      }
    }
    return { vals, grad };
  })().catch(() => null);
  decoded.set(k, p);
  if (decoded.size > 220) decoded.delete(decoded.keys().next().value);
  return p;
}

/** Break-finder overlay: canvas tiles painted from the decoded gradient field. */
const BreakLayer = L.GridLayer.extend({
  createTile(coords, done) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const key = state.layer, L_ = LAYERS[key];
    const nz = Math.min(coords.z, L_.maxNative);
    const shift = coords.z - nz;
    const px = coords.x >> shift, py = coords.y >> shift;
    getDecoded(key, state.date, nz, px, py).then(tile => {
      if (!tile) { done(null, c); return; }
      const g = c.getContext('2d');
      const img = g.createImageData(256, 256);
      const o = img.data;
      const sub = Math.pow(2, shift);                   // how many child tiles per native tile
      const ox = (coords.x - (px << shift)) * 256 / sub;
      const oy = (coords.y - (py << shift)) * 256 / sub;
      const lo = LAYERS[key].gRange[0], hi = LAYERS[key].gRange[1];
      const t = lo + (hi - lo) * Math.pow(state.thresh / 100, 1.6);
      for (let yy = 0; yy < 256; yy++) {
        const sy = Math.min(255, Math.floor(oy + yy / sub));
        for (let xx = 0; xx < 256; xx++) {
          const sx = Math.min(255, Math.floor(ox + xx / sub));
          const v = tile.grad[sy * 256 + sx];
          if (isNaN(v) || v < t) continue;
          const s = Math.min(1, (v - t) / (t * 1.6));    // 0..1 strength above threshold
          const i = (yy * 256 + xx) * 4;
          o[i] = 255;
          o[i + 1] = Math.round(238 - 150 * s);
          o[i + 2] = Math.round(90 - 90 * s);
          o[i + 3] = Math.round(70 + 185 * s);
        }
      }
      g.putImageData(img, 0, 0);
      done(null, c);
    });
    return c;
  }
});
let breakLayer = null;
function refreshBreaks() {
  if (breakLayer) { map.removeLayer(breakLayer); breakLayer = null; }
  if (!state.breaks) return;
  breakLayer = new BreakLayer({ pane: 'breaks', maxZoom: 13, minZoom: 5, opacity: 1 });
  breakLayer.addTo(map);
}

/* ---------------------- point sampling for readout ------------------ */
async function sampleAt(key, lat, lon) {
  const L_ = LAYERS[key], z = L_.maxNative, n = Math.pow(2, z);
  const xf = (lon + 180) / 360 * n;
  const r = lat * Math.PI / 180;
  const yf = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  const x = Math.floor(xf), y = Math.floor(yf);
  if (y < 0 || y >= n) return null;
  const tile = await getDecoded(key, state.date, z, ((x % n) + n) % n, y);
  if (!tile) return null;
  const px = Math.min(255, Math.floor((xf - x) * 256));
  const py = Math.min(255, Math.floor((yf - y) * 256));
  const i = py * 256 + px;
  return { value: tile.vals[i], grad: tile.grad[i] };
}

/* --------------------------- date handling -------------------------- */
async function latestDate(key) {
  const L_ = LAYERS[key];
  const end = new Date(), start = new Date(Date.now() - 30 * 86400000);
  try {
    const u = DOMAINS + '/' + L_.id + '/default/' + L_.tms + '/-180,-85,180,85/' + iso(start) + '--' + iso(end) + '.xml';
    const xml = await (await fetch(u)).text();
    const m = [...xml.matchAll(/<Domain>([^<]+)<\/Domain>/g)].pop();
    if (m) {
      const parts = m[1].split(',').pop().split('/');
      return parts.length > 1 ? parts[1] : parts[0];
    }
  } catch {}
  return store.get('latest.' + key, iso(new Date(Date.now() - 2 * 86400000)));
}
function buildDates(latest) {
  const [y, m, d] = latest.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  const out = [];
  for (let i = 20; i >= 0; i--) out.push(iso(new Date(base.getTime() - i * 86400000)));
  return out;
}
async function initDates() {
  const l = await latestDate(state.layer);
  store.set('latest.' + state.layer, l);
  state.latest[state.layer] = l;
  state.dates = buildDates(l);
  state.date = state.dates[state.dates.length - 1];
  $('#dateSlider').max = state.dates.length - 1;
  $('#dateSlider').value = state.dates.length - 1;
  paintDate();
}
function paintDate() {
  $('#dateLabel').textContent = dayLabel(state.date);
  $('#dateSub').textContent = state.date + '  ·  ' + LAYERS[state.layer].full;
}

/* ------------------------------ legend ------------------------------ */
async function paintLegend() {
  const L_ = LAYERS[state.layer];
  let cm;
  try { cm = await loadColorMap(L_.cmap); } catch { $('#legend').classList.add('hidden'); return; }
  const stops = cm.stops.filter(s => isFinite(s.v));
  if (!stops.length) return;
  const lo = stops[0].v, hi = stops[stops.length - 1].v;
  const grad = stops.filter((_, i) => i % 4 === 0 || i === stops.length - 1)
    .map(s => s.rgb + ' ' + (((s.v - lo) / (hi - lo)) * 100).toFixed(1) + '%').join(',');
  $('#legend').classList.remove('hidden');
  $('#legend').innerHTML =
    '<div class="lg-title">' + L_.full + '</div>' +
    '<div class="lg-bar" style="background:linear-gradient(90deg,' + grad + ')"></div>' +
    '<div class="lg-ends"><span>' + L_.fmt(lo) + '</span><span>' + L_.unit + '</span><span>' + L_.fmt(hi) + '</span></div>';
}

/* ------------------------------- GPS -------------------------------- */
let boatMarker = null, accCircle = null, following = false, watchId = null;
const boatIcon = h => L.divIcon({
  className: '', iconSize: [26, 26],
  html: '<svg class="boat" viewBox="0 0 26 26"><circle cx="13" cy="13" r="7" fill="#31c2f0" stroke="#04121e" stroke-width="2.5"/>' +
    (h == null ? '' : '<g class="hd" style="transform:rotate(' + h + 'deg)"><path d="M13 1.5 L16.4 7.2 L9.6 7.2 Z" fill="#31c2f0" stroke="#04121e" stroke-width="1.6"/></g>') +
    '</svg>'
});
function startGps() {
  if (!('geolocation' in navigator)) { toast('This browser has no GPS access.'); return; }
  if (watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(p => {
    const { latitude: lat, longitude: lon, accuracy, heading } = p.coords;
    state.gps = { lat, lon, accuracy, heading, t: p.timestamp };
    if (!boatMarker) {
      boatMarker = L.marker([lat, lon], { icon: boatIcon(heading), zIndexOffset: 900, interactive: false }).addTo(map);
      accCircle = L.circle([lat, lon], { radius: accuracy, color: '#31c2f0', weight: 1, opacity: .5, fillOpacity: .07, interactive: false }).addTo(map);
    } else {
      boatMarker.setLatLng([lat, lon]); boatMarker.setIcon(boatIcon(heading));
      accCircle.setLatLng([lat, lon]); accCircle.setRadius(accuracy);
    }
    if (following) map.panTo([lat, lon], { animate: true });
    updateFrom();
  }, err => {
    toast(err.code === 1 ? 'Location is off for this site. Turn it on in Settings.' : 'No GPS fix yet.');
    $('#btnLocate').classList.remove('on'); following = false;
  }, { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 });
}

/* ------------------------------ readout ----------------------------- */
let tapMarker = null, tapPt = null;
const tapIcon = L.divIcon({
  className: '', iconSize: [26, 26],
  html: '<svg class="tapmk" viewBox="0 0 26 26"><circle cx="13" cy="13" r="9" fill="none" stroke="#ff8a3d" stroke-width="2.5"/><circle cx="13" cy="13" r="2" fill="#ff8a3d"/></svg>'
});
function updateFrom() {
  if (!tapPt || !state.gps) { $('#roFrom').textContent = '—'; return; }
  const d = haversine(state.gps.lat, state.gps.lon, tapPt.lat, tapPt.lng);
  const b = bearing(state.gps.lat, state.gps.lon, tapPt.lat, tapPt.lng);
  $('#roFrom').textContent = nm(d).toFixed(1) + ' nm ' + compass(b);
}
async function showReadout(latlng) {
  tapPt = latlng;
  if (!tapMarker) tapMarker = L.marker(latlng, { icon: tapIcon, zIndexOffset: 800 }).addTo(map);
  else tapMarker.setLatLng(latlng);
  $('#readout').classList.remove('hidden');
  $('#roPos').textContent = fmtPos(latlng.lat, latlng.lng);
  $('#roSst').textContent = '…'; $('#roChl').textContent = '…'; $('#roGrad').textContent = '…';
  updateFrom();
  const [s, c] = await Promise.all([sampleAt('sst', latlng.lat, latlng.lng), sampleAt('chl', latlng.lat, latlng.lng)]);
  const cur = state.layer === 'chl' ? c : s;
  $('#roSst').textContent = (s && !isNaN(s.value)) ? LAYERS.sst.fmt(s.value) + 'C' : 'cloud';
  $('#roChl').textContent = (c && !isNaN(c.value)) ? LAYERS.chl.fmt(c.value) : 'cloud';
  const gk = state.layer === 'chl' ? 'chl' : 'sst';
  $('#roGrad').textContent = (cur && !isNaN(cur.grad))
    ? cur.grad.toFixed(gk === 'chl' ? 2 : 2) + ' ' + LAYERS[gk].gUnit : '—';
  loadConditions(latlng.lat, latlng.lng);
  loadTide(latlng.lat, latlng.lng);
}

/* ---------------------------- conditions ---------------------------- */
const condCache = new Map();
async function fetchJson(url, ttlMin) {
  const k = 'j.' + url;
  const c = store.get(k, null);
  if (c && Date.now() - c.t < ttlMin * 60000) return c.d;
  try {
    const d = await (await fetch(url)).json();
    store.set(k, { t: Date.now(), d });
    return d;
  } catch (e) {
    if (c) return c.d;
    throw e;
  }
}
function nearestHour(times) {
  const now = Date.now();
  let best = 0, bd = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(new Date(times[i]).getTime() - now);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
function card(k, v, s, warn) {
  return '<div class="card' + (warn ? ' warn' : '') + '"><div class="k">' + k + '</div><div class="v">' + v + '</div>' +
    (s ? '<div class="s">' + s + '</div>' : '') + '</div>';
}
async function loadConditions(lat, lon) {
  $('#condWhere').textContent = 'For ' + fmtPos(lat, lon);
  const la = lat.toFixed(2), lo = lon.toFixed(2);
  const wUrl = 'https://api.open-meteo.com/v1/forecast?latitude=' + la + '&longitude=' + lo +
    '&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m&daily=sunrise,sunset' +
    '&timezone=Australia%2FPerth&forecast_days=2&wind_speed_unit=' + (state.spd === 'kn' ? 'kn' : 'kmh');
  const mUrl = 'https://marine-api.open-meteo.com/v1/marine?latitude=' + la + '&longitude=' + lo +
    '&hourly=wave_height,wave_period,swell_wave_height,swell_wave_period,swell_wave_direction,' +
    'sea_surface_temperature,ocean_current_velocity,ocean_current_direction' +
    '&timezone=Australia%2FPerth&forecast_days=2';
  try {
    const [w, m] = await Promise.all([fetchJson(wUrl, 45), fetchJson(mUrl, 45)]);
    const i = nearestHour(w.hourly.time);
    const j = nearestHour(m.hourly.time);
    const u = state.spd === 'kn' ? 'kn' : 'km/h';
    const ws = w.hourly.wind_speed_10m[i], wg = w.hourly.wind_gusts_10m[i], wd = w.hourly.wind_direction_10m[i];
    const sw = m.hourly.swell_wave_height[j], sp = m.hourly.swell_wave_period[j], sd = m.hourly.swell_wave_direction[j];
    const wh = m.hourly.wave_height[j];
    const cv = m.hourly.ocean_current_velocity[j], cd = m.hourly.ocean_current_direction[j];
    const rough = ws != null && (state.spd === 'kn' ? ws >= 18 : ws >= 33);
    const sr = (w.daily.sunrise[0] || '').slice(11, 16), ss = (w.daily.sunset[0] || '').slice(11, 16);
    $('#condCards').innerHTML =
      card('Wind', ws == null ? '—' : Math.round(ws) + ' ' + u, wd == null ? '' : compass(wd) + ' · gust ' + Math.round(wg), rough) +
      card('Sea', wh == null ? '—' : wh.toFixed(1) + ' m', 'combined') +
      card('Swell', sw == null ? '—' : sw.toFixed(1) + ' m', (sp ? Math.round(sp) + ' s ' : '') + (sd != null ? compass(sd) : '')) +
      card('Current', cv == null ? '—' : (cv / 1.852).toFixed(1) + ' kn', cd == null ? '' : 'setting ' + compass(cd)) +
      card('Light', sr + ' – ' + ss, 'sunrise – sunset');
    $('#condHint').textContent = rough
      ? 'Model wind is up around ' + Math.round(ws) + ' ' + u + '. Check the BOM coastal waters forecast before you commit.'
      : 'Forecast model output, updated hourly. Always cross-check the BOM coastal waters forecast.';
  } catch {
    $('#condCards').innerHTML = '<div class="empty">No forecast right now. It will fill in when you have signal.</div>';
    $('#condHint').textContent = '';
  }
}

/* ------------------------------- tide ------------------------------- */
let tideStations = null;
async function getStations() {
  if (tideStations) return tideStations;
  tideStations = await (await fetch('data/au-tide-stations.json')).json();
  return tideStations;
}
function nearestStation(list, lat, lon) {
  let best = null, bd = Infinity;
  for (const s of list) {
    const d = haversine(lat, lon, s.la, s.lo);
    if (d < bd) { bd = d; best = s; }
  }
  return { s: best, d: bd };
}
let tideCache = null;
async function loadTide(lat, lon) {
  let list;
  try { list = await getStations(); } catch { $('#tideWhere').textContent = 'Tide data unavailable.'; return; }
  const { s, d } = nearestStation(list, lat, lon);
  if (!s) return;
  const off = s.off != null ? s.off : 0;
  const cons = s.c.map(c => ({ name: c[0], amplitude: c[1], phase: c[2] }));
  const p = createTidePredictor(cons, { phaseKey: 'phase' });
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 86400000);
  const ext = p.getExtremesPrediction({ start, end, timeFidelity: 60 })
    .map(e => ({ t: new Date(e.time), h: e.level + off, high: !!e.high }));
  const tl = p.getTimelinePrediction({ start: new Date(Date.now() - 6 * 3600000), end: new Date(Date.now() + 18 * 3600000), timeFidelity: 900 })
    .map(e => ({ t: new Date(e.time), h: e.level + off }));
  tideCache = { s, ext, tl, off };
  const km = (d / 1000).toFixed(0);
  $('#tideWhere').textContent = s.n + (s.r ? ', ' + s.r : '') + ' · ' + km + ' km from the mark';
  const now = Date.now();
  const upcoming = ext.filter(e => e.t.getTime() > now - 3600000).slice(0, 6);
  $('#tideList').innerHTML = upcoming.map(e =>
    '<div class="t ' + (e.high ? 'hi' : 'lo') + '"><div class="lab">' + (e.high ? 'High' : 'Low') + '</div>' +
    '<div class="tm">' + pad(e.t.getHours()) + ':' + pad(e.t.getMinutes()) + '</div>' +
    '<div class="h">' + e.h.toFixed(2) + ' m</div></div>').join('') ||
    '<div class="empty">No tide extremes in range.</div>';
  drawTide(tl, ext);
}
function drawTide(tl, ext) {
  const c = $('#tideChart');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 320, h = 150;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  if (!tl.length) return;
  const hs = tl.map(p => p.h);
  const lo = Math.min(...hs) - 0.4, hi = Math.max(...hs) + 0.4;
  const t0 = tl[0].t.getTime(), t1 = tl[tl.length - 1].t.getTime();
  const X = t => 6 + (t - t0) / (t1 - t0) * (w - 12);
  const Y = v => h - 22 - (v - lo) / (hi - lo) * (h - 40);
  // grid
  g.strokeStyle = '#1e3f56'; g.lineWidth = 1; g.font = '10px -apple-system,sans-serif'; g.fillStyle = '#8fb0c4';
  for (let k = 0; k <= 4; k++) {
    const v = lo + (hi - lo) * k / 4, y = Y(v);
    g.beginPath(); g.moveTo(6, y); g.lineTo(w - 6, y); g.stroke();
    g.fillText(v.toFixed(1), 8, y - 3);
  }
  // curve
  g.beginPath();
  tl.forEach((p, i) => { const x = X(p.t.getTime()), y = Y(p.h); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.lineTo(X(t1), h - 22); g.lineTo(X(t0), h - 22); g.closePath();
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, 'rgba(49,194,240,.42)'); grd.addColorStop(1, 'rgba(49,194,240,0)');
  g.fillStyle = grd; g.fill();
  g.beginPath();
  tl.forEach((p, i) => { const x = X(p.t.getTime()), y = Y(p.h); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.strokeStyle = '#31c2f0'; g.lineWidth = 2; g.stroke();
  // now line
  const nx = X(Date.now());
  g.strokeStyle = '#ff8a3d'; g.lineWidth = 1.5; g.setLineDash([3, 3]);
  g.beginPath(); g.moveTo(nx, 6); g.lineTo(nx, h - 22); g.stroke(); g.setLineDash([]);
  // hour ticks
  g.fillStyle = '#8fb0c4';
  for (let t = t0; t <= t1; t += 6 * 3600000) {
    const d = new Date(t); const x = X(t);
    g.fillText(pad(d.getHours()) + ':00', Math.min(w - 34, Math.max(4, x - 14)), h - 7);
  }
}

/* ------------------------------ marks ------------------------------- */
let marks = store.get('marks', []);
let markLayer = L.layerGroup().addTo(map);
const markIcon = L.divIcon({
  className: '', iconSize: [22, 22],
  html: '<svg class="mk" viewBox="0 0 22 22"><circle cx="11" cy="11" r="7" fill="#4fd08a" stroke="#04121e" stroke-width="2.2"/></svg>'
});
function renderMarks() {
  markLayer.clearLayers();
  marks.forEach(m => L.marker([m.lat, m.lon], { icon: markIcon })
    .bindTooltip(m.name, { direction: 'top', offset: [0, -10] }).addTo(markLayer));
  $('#marksList').innerHTML = marks.length ? marks.map((m, i) =>
    '<div class="mark" data-i="' + i + '"><div class="mi"><div class="mn">' + m.name + '</div>' +
    '<div class="mc">' + fmtPos(m.lat, m.lon) + (m.sst != null ? ' · ' + m.sst.toFixed(1) + '°C' : '') + '</div></div>' +
    '<button class="mx" data-del="' + i + '">&times;</button></div>').join('')
    : '<div class="empty">Tap the map, then Save mark. Marks export as GPX for the plotter.</div>';
  store.set('marks', marks);
}
function gpx() {
  const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Bluewater" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    marks.map(m => '  <wpt lat="' + m.lat.toFixed(6) + '" lon="' + m.lon.toFixed(6) + '">\n' +
      '    <name>' + esc(m.name) + '</name>\n' +
      '    <desc>' + esc((m.sst != null ? 'SST ' + m.sst.toFixed(1) + 'C ' : '') + (m.chl != null ? 'Chl ' + m.chl.toFixed(3) : '') + ' ' + (m.date || '')) + '</desc>\n' +
      '    <sym>Fishing Hot Spot</sym>\n  </wpt>').join('\n') + '\n</gpx>';
}

/* ---------------------------- offline save -------------------------- */
function tileRange(bounds, z) {
  const n = Math.pow(2, z);
  const toX = lon => Math.floor((lon + 180) / 360 * n);
  const toY = lat => {
    const r = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  };
  return {
    x0: toX(bounds.getWest()), x1: toX(bounds.getEast()),
    y0: toY(bounds.getNorth()), y1: toY(bounds.getSouth()), n
  };
}
function planUrls(bounds, maxZ, dates) {
  const urls = new Set();
  for (let z = 6; z <= maxZ; z++) {
    const r = tileRange(bounds, z);
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) {
        const xx = ((x % r.n) + r.n) % r.n;
        urls.add('https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/' + z + '/' + y + '/' + xx);
        urls.add('https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/' + z + '/' + y + '/' + xx);
      }
    }
  }
  for (const key of ['sst', 'chl']) {
    const L_ = LAYERS[key];
    const r = tileRange(bounds, L_.maxNative);
    for (const dte of dates) {
      for (let x = r.x0; x <= r.x1; x++) {
        for (let y = r.y0; y <= r.y1; y++) {
          const xx = ((x % r.n) + r.n) % r.n;
          urls.add(GIBS + '/' + L_.id + '/default/' + dte + '/' + L_.tms + '/' + L_.maxNative + '/' + y + '/' + xx + '.png');
        }
      }
    }
  }
  return [...urls];
}
function dlDates() {
  if (!$('#dlAllDates').checked) return [state.date];
  const i = state.dates.indexOf(state.date);
  return state.dates.slice(Math.max(0, i - 4), i + 1);
}
function updateEstimate() {
  const z = +$('#dlZoom').value;
  $('#dlVal').textContent = ['coarse', 'good', 'fine', 'finest'][z - 9];
  const urls = planUrls(map.getBounds(), z, dlDates());
  const mb = (urls.length * 22 / 1024).toFixed(0);
  $('#dlEstimate').textContent = urls.length.toLocaleString() + ' tiles, roughly ' + mb + ' MB. Covers what is on screen now.';
}
async function doDownload() {
  const urls = planUrls(map.getBounds(), +$('#dlZoom').value, dlDates());
  const cache = await caches.open(TILE_CACHE);
  $('#dlProg').classList.remove('hidden');
  let done = 0, failed = 0;
  const step = () => {
    const pc = Math.round(done / urls.length * 100);
    $('#dlBar').style.width = pc + '%';
    $('#dlText').textContent = pc + '%  ·  ' + done.toLocaleString() + ' of ' + urls.length.toLocaleString();
  };
  step();
  const queue = urls.slice();
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      try {
        const res = await fetch(u, { mode: 'cors', cache: 'no-cache' });
        // the service worker hands back a blank placeholder when it cannot reach the
        // network - storing that would poison the offline map with empty tiles
        if (res.ok && !res.headers.get('X-BW-Placeholder')) await cache.put(u, res.clone());
        else failed++;
      } catch { failed++; }
      done++;
      if (done % 6 === 0 || done === urls.length) step();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  // conditions + tide data for offline
  try { if (tapPt) await loadConditions(tapPt.lat, tapPt.lng); } catch {}
  try { await getStations(); } catch {}
  $('#dlProg').classList.add('hidden');
  toast(failed ? 'Saved, ' + failed + ' tiles missing (cloud gaps are normal).' : 'Area saved. It will work with no signal.', 3600);
  showCacheInfo();
}
async function showCacheInfo() {
  try {
    const c = await caches.open(TILE_CACHE);
    const n = (await c.keys()).length;
    let extra = '';
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      if (e.usage) extra = ' · ' + (e.usage / 1048576).toFixed(0) + ' MB used';
    }
    $('#cacheInfo').textContent = n.toLocaleString() + ' tiles stored' + extra;
  } catch { $('#cacheInfo').textContent = 'Storage not available.'; }
}

/* -------------------------------- UI -------------------------------- */
function openDrawer(id) { $('#' + id).classList.remove('hidden'); }
function closeDrawer(id) { $('#' + id).classList.add('hidden'); }

$$('[data-close]').forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.close;
  if (t === 'readout') { $('#readout').classList.add('hidden'); if (tapMarker) { map.removeLayer(tapMarker); tapMarker = null; } tapPt = null; }
  else closeDrawer(t);
}));
$$('.drawer').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.classList.add('hidden'); }));

// layer options
$('#layerOpts').innerHTML = Object.entries(LAYERS).map(([k, v]) =>
  '<label class="sw" data-k="' + k + '"><input type="radio" name="lyr" value="' + k + '"' + (k === state.layer ? ' checked' : '') + '>' +
  '<span>' + v.full + '<span class="meta">' + (k === 'sst' ? 'Daily blended analysis, best all-round' :
    k === 'chl' ? 'Green water, bait and colour changes' : 'How far off the seasonal average today sits') + '</span></span></label>').join('');
function markSel() {
  $$('#layerOpts .sw').forEach(l => l.classList.toggle('sel', l.dataset.k === state.layer));
  $('#layerName').textContent = LAYERS[state.layer].name;
}
markSel();
$('#layerOpts').addEventListener('change', async e => {
  if (e.target.name !== 'lyr') return;
  state.layer = e.target.value; store.set('layer', state.layer);
  markSel();
  const l = await latestDate(state.layer);
  state.latest[state.layer] = l; store.set('latest.' + state.layer, l);
  state.dates = buildDates(l);
  const idx = Math.min(state.dates.length - 1, +$('#dateSlider').value);
  $('#dateSlider').max = state.dates.length - 1;
  state.date = state.dates[idx];
  paintDate(); buildDataLayer(); refreshBreaks(); paintLegend();
  updateThreshLabel();
});

$('#btnLayers').addEventListener('click', () => openDrawer('drawer'));
$('#btnDate').addEventListener('click', () => openDrawer('drawer'));
$('#btnMenu').addEventListener('click', () => openDrawer('menu'));
$('#btnOffline').addEventListener('click', () => { openDrawer('offline'); updateEstimate(); showCacheInfo(); });

$('#opacity').value = state.opacity;
$('#opVal').textContent = state.opacity + '%';
$('#opacity').addEventListener('input', e => {
  state.opacity = +e.target.value; store.set('opacity', state.opacity);
  $('#opVal').textContent = state.opacity + '%';
  if (dataLayer) dataLayer.setOpacity(state.opacity / 100);
});

function updateThreshLabel() {
  const L_ = LAYERS[state.layer];
  const t = L_.gRange[0] + (L_.gRange[1] - L_.gRange[0]) * Math.pow(state.thresh / 100, 1.6);
  $('#thVal').textContent = t.toFixed(2) + ' ' + L_.gUnit;
}
$('#thresh').value = state.thresh;
updateThreshLabel();
$('#thresh').addEventListener('input', e => {
  state.thresh = +e.target.value; store.set('thresh', state.thresh);
  updateThreshLabel();
});
$('#thresh').addEventListener('change', () => { if (state.breaks) refreshBreaks(); });

$('#breakOn').checked = state.breaks;
function setBreaks(on) {
  state.breaks = on; store.set('breaks', on);
  $('#breakOn').checked = on;
  $('#btnBreak').classList.toggle('on', on);
  refreshBreaks();
}
$('#breakOn').addEventListener('change', e => setBreaks(e.target.checked));
$('#btnBreak').addEventListener('click', () => setBreaks(!state.breaks));

$('#bathyOn').addEventListener('change', e => e.target.checked ? bathy.addTo(map) : map.removeLayer(bathy));
$('#labelsOn').addEventListener('change', e => e.target.checked ? labels.addTo(map) : map.removeLayer(labels));
$('#gebcoOn').addEventListener('change', e => e.target.checked ? gebco.addTo(map) : map.removeLayer(gebco));

$('#dateSlider').addEventListener('input', e => {
  state.date = state.dates[+e.target.value];
  paintDate();
});
$('#dateSlider').addEventListener('change', () => { buildDataLayer(); refreshBreaks(); });
$('#btnLatest').addEventListener('click', () => {
  $('#dateSlider').value = state.dates.length - 1;
  state.date = state.dates[state.dates.length - 1];
  paintDate(); buildDataLayer(); refreshBreaks();
});

$('#btnLocate').addEventListener('click', () => {
  following = !following;
  $('#btnLocate').classList.toggle('on', following);
  startGps();
  if (following && state.gps) map.setView([state.gps.lat, state.gps.lon], Math.max(map.getZoom(), 10));
});

$('#roSave').addEventListener('click', async () => {
  if (!tapPt) return;
  const [s, c] = await Promise.all([sampleAt('sst', tapPt.lat, tapPt.lng), sampleAt('chl', tapPt.lat, tapPt.lng)]);
  const name = 'Mark ' + (marks.length + 1);
  marks.push({
    name, lat: tapPt.lat, lon: tapPt.lng, date: state.date,
    sst: s && !isNaN(s.value) ? s.value : null,
    chl: c && !isNaN(c.value) ? c.value : null
  });
  renderMarks(); toast('Saved ' + name);
});
$('#roGo').addEventListener('click', async () => {
  if (!tapPt) return;
  const txt = tapPt.lat.toFixed(5) + ', ' + tapPt.lng.toFixed(5);
  try { await navigator.clipboard.writeText(txt); toast('Copied ' + txt); }
  catch { toast(txt, 4000); }
});

$('#marksList').addEventListener('click', e => {
  const del = e.target.dataset.del;
  if (del !== undefined) { marks.splice(+del, 1); renderMarks(); return; }
  const row = e.target.closest('.mark');
  if (row) { const m = marks[+row.dataset.i]; map.setView([m.lat, m.lon], Math.max(map.getZoom(), 10)); sheet.close(); }
});
$('#btnClearMarks').addEventListener('click', () => { if (marks.length && confirm('Delete all marks?')) { marks = []; renderMarks(); } });
$('#btnExportGpx').addEventListener('click', () => {
  if (!marks.length) { toast('No marks to export yet.'); return; }
  const b = new Blob([gpx()], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = 'bluewater-marks.gpx';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

$('#dlZoom').addEventListener('input', updateEstimate);
$('#dlAllDates').addEventListener('change', updateEstimate);
$('#btnDownload').addEventListener('click', doDownload);
$('#btnClearCache').addEventListener('click', async () => {
  await caches.delete(TILE_CACHE); toast('Stored maps cleared.'); showCacheInfo();
});

$$('input[name=spd]').forEach(r => {
  r.checked = r.value === state.spd;
  r.addEventListener('change', () => {
    state.spd = r.value; store.set('spd', state.spd);
    if (tapPt) loadConditions(tapPt.lat, tapPt.lng); else loadConditions(map.getCenter().lat, map.getCenter().lng);
  });
});
$('#btnSetHome').addEventListener('click', () => {
  const c = map.getCenter();
  store.set('home', { lat: c.lat, lon: c.lng, zoom: map.getZoom() });
  toast('Home port set.');
});
$('#btnGoHome').addEventListener('click', () => {
  const h = store.get('home', HOME); map.setView([h.lat, h.lon], h.zoom); closeDrawer('menu');
});

/* bottom sheet drag */
const sheet = (() => {
  const el = $('#sheet'), handle = $('#sheetHandle');
  let sy = 0, open = false, dragging = false;
  const setOpen = o => { open = o; el.classList.toggle('open', o); };
  handle.addEventListener('click', () => setOpen(!open));
  handle.addEventListener('touchstart', e => { sy = e.touches[0].clientY; dragging = true; }, { passive: true });
  handle.addEventListener('touchmove', e => {
    if (!dragging) return;
    const dy = e.touches[0].clientY - sy;
    if (Math.abs(dy) > 34) { setOpen(dy < 0); dragging = false; }
  }, { passive: true });
  handle.addEventListener('touchend', () => { dragging = false; });
  return { open: () => setOpen(true), close: () => setOpen(false) };
})();
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.remove('active'));
  $$('.tabpane').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $('#tab-' + t.dataset.tab).classList.add('active');
  if (t.dataset.tab === 'tide' && tideCache) drawTide(tideCache.tl, tideCache.ext);
}));

/* map events */
map.on('click', e => showReadout(e.latlng));
map.on('moveend', () => {
  const c = map.getCenter();
  store.set('view', { lat: c.lat, lon: c.lng, zoom: map.getZoom() });
  if (!tapPt) { loadConditions(c.lat, c.lng); loadTide(c.lat, c.lng); }
});
map.on('dragstart', () => { if (following) { following = false; $('#btnLocate').classList.remove('on'); } });
window.addEventListener('resize', () => { if (tideCache) drawTide(tideCache.tl, tideCache.ext); });
window.addEventListener('online', () => toast('Back online.'));
window.addEventListener('offline', () => toast('Offline. Using saved maps.', 3200));

/* --------------------------------- go ------------------------------- */
(async function boot() {
  renderMarks();
  $('#btnBreak').classList.toggle('on', state.breaks);
  await initDates();
  buildDataLayer();
  paintLegend();
  refreshBreaks();
  const c = map.getCenter();
  loadConditions(c.lat, c.lng);
  loadTide(c.lat, c.lng);
  startGps();
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch {}
  }
})();

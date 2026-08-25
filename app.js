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
    grad: v => v, gUnit: '°C/km'
  },
  chl: {
    id: 'VIIRS_NOAA21_Chlorophyll_a',
    tms: 'GoogleMapsCompatible_Level7', maxNative: 7,
    cmap: 'VIIRS_Chlorophyll',
    name: 'Chl-a', full: 'Chlorophyll-a', unit: 'mg/m³',
    fmt: v => v < 1 ? v.toFixed(3) : v.toFixed(2),
    // chlorophyll spans decades - measure the break on a log scale
    grad: v => Math.log10(Math.max(v, 1e-3)), gUnit: 'dex/km'
  },
  sstA: {
    id: 'GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies',
    tms: 'GoogleMapsCompatible_Level7', maxNative: 7,
    cmap: 'GHRSST_Sea_Surface_Temperature_Anomalies',
    name: 'Anomaly', full: 'SST anomaly vs average', unit: '°C',
    fmt: v => (v > 0 ? '+' : '') + v.toFixed(1) + '°',
    grad: v => v, gUnit: '°C/km'
  }
};

const HOME = { lat: -18.05, lon: 122.0, zoom: 8 };

// Broome fish aggregating devices.
// Positions supplied by the user from the current official listing, where all
// four were showing "In Position". Each decimal pair was checked against the
// degrees-decimal-minutes on the same record and they agree exactly.
// These replaced an older published set that was out by 4 to 30 km.
// FADs are moored, not fixed: they break away, get retrieved and get moved, so
// this is still a starting point rather than gospel.
const FADS = {
  source: 'current official listing, all showing In Position',
  vintage: 'checked 24 Aug 2026',
  check: 'https://www.dpird.wa.gov.au/individuals/recreational-fishing/recreational-fishing-initiatives/fish-aggregating-devices/',
  list: [
    { name: 'Broome 37', lat: -17.90615, lon: 121.759917 },
    { name: 'Broome 38', lat: -17.94880, lon: 121.573667 },
    { name: 'Broome 39', lat: -17.82880, lon: 121.859300 },
    { name: 'Broome 40', lat: -17.90655, lon: 121.859333 }
  ]
};

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
const seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  maxZoom: 13, maxNativeZoom: 13, opacity: 0.95,
  attribution: 'OpenSeaMap', pane: 'shadowPane'
});
const gebco = L.tileLayer.wms('https://wms.gebco.net/mapserv', {
  layers: 'GEBCO_LATEST', format: 'image/png', transparent: false, version: '1.3.0',
  attribution: 'GEBCO', opacity: 0.85
});

map.createPane('data'); map.getPane('data').style.zIndex = 350;
map.createPane('breaks'); map.getPane('breaks').style.zIndex = 400;
map.getPane('breaks').style.pointerEvents = 'none';
map.createPane('cur'); map.getPane('cur').style.zIndex = 430;
map.getPane('cur').style.pointerEvents = 'none';
/* the wind/current arrows get their own pane, always above the tile pane
   (200) - unlike the colour field, which drops below it in wind/current
   view so the land can sit on top, the arrows need to stay fully readable
   even over the dimmed land, so they don't get muted along with it */
map.createPane('arrows'); map.getPane('arrows').style.zIndex = 390;
map.getPane('arrows').style.pointerEvents = 'none';

/* A real coastline, not just the basemap's own linework - cropped from
   Natural Earth's 1:10m coastline (public domain, see data/COASTLINE-
   DATA-LICENSE.txt) to the Kimberley/Pilbara coast and simplified down to
   a small local file, same pattern as the tide station data. Drawn in
   shadowPane alongside the reference layer above, so like that layer it
   is never dimmed or painted over - the one place on screen you can always
   tell land from water, wind/current view especially, where the basemap's
   own land fill is turned right down. A dark casing under a pale line
   keeps it readable over both bright water colours and pale land alike. */
(async function loadCoastline() {
  try {
    const runs = await (await fetch('data/wa-coastline.json')).json();
    const opts = { pane: 'shadowPane', interactive: false, lineJoin: 'round', lineCap: 'round' };
    L.polyline(runs, Object.assign({}, opts, { color: '#04141f', weight: 3.2, opacity: 0.55 })).addTo(map);
    L.polyline(runs, Object.assign({}, opts, { color: '#eaf6ff', weight: 1.3, opacity: 0.95 })).addTo(map);
  } catch { /* offline before the first save, or the file hasn't cached yet - the reference layer still shows through */ }
})();

/* ------------------------ data (imagery) layer ---------------------- */
const state = {
  layer: store.get('layer', 'sst'),
  date: null,
  dates: [],
  latest: {},
  opacity: store.get('opacity', 80),
  breaks: store.get('breaks', false),
  coverage: store.get('coverage', 8),
  breakT: null,
  spd: store.get('spd', 'kn'),
  mapView: store.get('mapView', 'sat'),      // 'sat' | 'wind' | 'current' - full map view, mutually exclusive
  showArrows: store.get('showArrows', true),
  seamarks: store.get('seamarks', false),
  fads: store.get('fads', true),
  gps: null,
  tlIdx: null,   // hour-of-day (0-23) selected on the timeline; null = "not computed yet"
  tlDay: 0,      // days from today the timeline is showing (0 = today)
  tlPage: store.get('tlPage', 'wind'),  // which graph the timeline shows: 'wind' | 'current'
  windMetric: store.get('windMetric', 'wind'),  // on the wind page, which line is graphed: 'wind' | 'gust'
  tideDay: 0     // days from today the Tide tab is showing
};
/* hourly wind + current + sea state for one calendar day at the focus point,
   sliced from Open-Meteo's hourly arrays for state.tlDay - drives the
   bottom timeline scrubber, the Conditions cards, and the wind/current
   map arrow layers so they can all show a forecast hour, not just now. */
let tlData = null;   // the sliced single day currently shown
let tlFull = null;   // the raw multi-day fetch {w, m} tlData is sliced from
const TL_DAY_MIN = -3, TL_DAY_MAX = 10;
function fmtClock(iso) {
  const d = new Date(iso);
  let h = d.getHours();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return h + ap;
}
function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function addDays(base, n) {
  const d = new Date(base); d.setDate(d.getDate() + n); return d;
}
function dayLabelFor(n) {
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return addDays(new Date(), n).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
}
/* the exact Open-Meteo hourly timestamp the timeline is currently reading -
   used to pick the matching hour out of any other Open-Meteo response
   (grid points for the arrow layers), since they share the same tz/hour grid */
function tlTargetTime() {
  return (tlData && tlData.times && tlData.times[state.tlIdx]) ? tlData.times[state.tlIdx] : null;
}

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
      const t = state.breakT;
      if (!(t > 0)) { done(null, c); return; }
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

/* The break threshold used to be a fixed number of degrees per kilometre, which
   was a guess - and a bad one. Real MUR SST gradients offshore are around
   0.01-0.05 degC/km and an anomaly field is smoother still, so a 0.10 default
   painted nothing at all and the whole feature looked broken.
   Now the threshold comes from the data on screen: pool the gradients of the
   tiles in view and take a percentile, so the slider means "highlight the
   strongest N% of the water I can see". That holds up across layers, seasons
   and regions without any magic constants. */
async function computeBreakThreshold() {
  const key = state.layer, z = LAYERS[key].maxNative;
  const b = map.getBounds(), n = Math.pow(2, z);
  const toX = lon => Math.floor((lon + 180) / 360 * n);
  const toY = lat => {
    const r = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  };
  const x0 = toX(b.getWest()), x1 = toX(b.getEast());
  const y0 = toY(b.getNorth()), y1 = toY(b.getSouth());
  const want = [];
  for (let x = x0; x <= x1 && want.length < 16; x++)
    for (let y = y0; y <= y1 && want.length < 16; y++)
      want.push([((x % n) + n) % n, Math.max(0, Math.min(n - 1, y))]);
  const tiles = await Promise.all(want.map(([x, y]) => getDecoded(key, state.date, z, x, y)));
  const samples = [];
  for (const t of tiles) {
    if (!t) continue;
    for (let i = 0; i < 65536; i += 5) {
      const v = t.grad[i];
      if (!isNaN(v)) samples.push(v);          // flat water counts too - the
    }                                          // slider means "% of what I can see"
  }
  if (samples.length < 200) return null;
  samples.sort((a, b2) => a - b2);
  const pick = arr => arr[Math.max(0, Math.min(arr.length - 1,
    Math.floor(arr.length * (1 - state.coverage / 100))))];
  let t = pick(samples);
  if (!(t > 0)) {
    // Mostly featureless water, so the percentile lands on zero. Fall back to the
    // same percentile of only the pixels that are changing at all, so a single
    // sharp edge in an otherwise flat field still gets found.
    const pos = samples.filter(v => v > 0);
    if (pos.length < 50) return null;
    t = pick(pos);
  }
  return t > 0 ? t : null;
}

let breakSeq = 0;
async function refreshBreaks(announce) {
  if (breakLayer) { map.removeLayer(breakLayer); breakLayer = null; }
  if (!state.breaks) { paintBreakHint(); return; }
  const seq = ++breakSeq;
  $('#btnBreak').classList.add('busy');
  const t = await computeBreakThreshold();
  if (seq !== breakSeq) return;
  $('#btnBreak').classList.remove('busy');
  state.breakT = t;
  paintBreakHint();
  if (!t) {
    if (announce) toast('No usable data here on ' + dayLabel(state.date) + ' — cloud, or off the edge of the pass. Try winding the date back.', 4200);
    return;
  }
  breakLayer = new BreakLayer({ pane: 'breaks', maxZoom: 13, minZoom: 5, opacity: 1 });
  if (state.mapView === 'sat') breakLayer.addTo(map);
}
function paintBreakHint() {
  const el = $('#thVal');
  if (!el) return;
  el.textContent = state.coverage + '%' +
    (state.breaks && state.breakT
      ? '  ·  ≥' + state.breakT.toFixed(3) + ' ' + LAYERS[state.layer].gUnit : '');
}
let breakMoveT;
function breaksOnMove() {
  if (!state.breaks) return;
  clearTimeout(breakMoveT);
  breakMoveT = setTimeout(() => refreshBreaks(false), 700);
}

/* ------------------------------- FADs ------------------------------- */
const fadIcon = L.divIcon({
  className: '', iconSize: [30, 30],
  html: '<svg class="fad" viewBox="0 0 30 30">' +
    '<circle cx="15" cy="15" r="10" fill="none" stroke="#ffd24a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/>' +
    '<circle cx="15" cy="15" r="3.4" fill="#ffd24a" stroke="#04121e" stroke-width="1.4"/></svg>'
});
const fadLayer = L.layerGroup();
FADS.list.forEach(f => {
  // Tapping a FAD should answer "what is the water doing there", so it opens the
  // normal readout rather than a name-only popup.
  L.marker([f.lat, f.lon], { icon: fadIcon, zIndexOffset: 700 })
    .on('click', () => showReadout(L.latLng(f.lat, f.lon), f))
    .addTo(fadLayer);
});
function setFads(on) {
  state.fads = on; store.set('fads', on);
  const el = document.getElementById('fadOn'); if (el) el.checked = on;
  on ? fadLayer.addTo(map) : map.removeLayer(fadLayer);
}

/* ------------------- wind / current field + arrows ------------------- */
/* Wind and Current are full map "pages", mutually exclusive with the
   satellite layer (SST/Chl/Anom) - same one-tap pattern, driven by
   state.mapView. Each renders as a smooth coloured field (a small NxN
   sample-grid canvas, scaled up with smoothing - the same trick behind
   Windy/GIBS-style continuous colour from a coarse grid) plus a sparse,
   neutral set of direction arrows on top. Colour now carries magnitude,
   so the arrows don't need to - which also sidesteps the old per-arrow
   colour buckets that broke when the display unit was km/h. */
const FIELD_N = 10;
const WIND_STOPS = [
  { v: 0, rgb: [46, 74, 102] },
  { v: 5, rgb: [53, 130, 165] },
  { v: 10, rgb: [69, 179, 168] },
  { v: 15, rgb: [130, 199, 100] },
  { v: 20, rgb: [230, 205, 70] },
  { v: 28, rgb: [255, 150, 60] },
  { v: 38, rgb: [255, 80, 80] }
];
const CURRENT_STOPS = [
  { v: 0, rgb: [30, 60, 92] },
  { v: 0.3, rgb: [45, 116, 150] },
  { v: 0.6, rgb: [68, 168, 176] },
  { v: 1.0, rgb: [120, 198, 120] },
  { v: 1.6, rgb: [230, 205, 70] },
  { v: 2.5, rgb: [255, 120, 70] }
];
function lerpColor(stops, v) {
  if (v <= stops[0].v) return stops[0].rgb;
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i].v) {
      const a = stops[i - 1], b = stops[i], f = (v - a.v) / (b.v - a.v);
      return [0, 1, 2].map(k => Math.round(a.rgb[k] + (b.rgb[k] - a.rgb[k]) * f));
    }
  }
  return stops[stops.length - 1].rgb;
}
/* N x N sample points across the current view, row-major north-to-south,
   west-to-east - matches how the small field canvas gets painted. */
function fieldGrid(N, b) {
  const pts = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      pts.push({
        lat: b.getNorth() - (b.getNorth() - b.getSouth()) * (i + 0.5) / N,
        lon: b.getWest() + (b.getEast() - b.getWest()) * (j + 0.5) / N
      });
    }
  }
  return pts;
}
/* Builds the small NxN colour-field canvas for one fetched grid - cached
   per fetch (see _load below) and reused every animation frame, so a frame
   redraw is just one drawImage() plus the arrow loop, not a full rebuild. */
function buildFieldImage(N, grid, kind) {
  if (!grid) return null;
  const stops = kind === 'wind' ? WIND_STOPS : CURRENT_STOPS;
  const small = document.createElement('canvas'); small.width = N; small.height = N;
  const sg = small.getContext('2d');
  const img = sg.createImageData(N, N);
  for (let idx = 0; idx < N * N; idx++) {
    const p = grid[idx], o = idx * 4;
    if (!p) { img.data[o + 3] = 0; continue; }
    const [r, gg, b] = lerpColor(stops, p.kn);
    img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 200;
  }
  sg.putImageData(img, 0, 0);
  return small;
}
/* Direction is shown as flowing particles - short marks that actually
   travel across the screen, in the true direction, at a speed that scales
   with the local wind/current strength - rather than a static arrow with
   a cosmetic animated dash (which read as "flashing" in place, not moving).
   Each particle lives in screen space, one per PARTICLE_N, and looks up
   its local vector from whichever field grid-cell it's currently sitting
   over - the same NxN grid the colour field is built from, so a particle
   drawn over a fast orange patch visibly outruns one over a slow blue
   patch. A particle respawns at a random point once it drifts off-screen
   or reaches the end of its randomised lifespan, fading in over its first
   few frames so respawns don't pop. */
const PARTICLE_N = 160;
function initParticles(n, size) {
  const arr = [];
  for (let k = 0; k < n; k++) {
    const x = Math.random() * size.x, y = Math.random() * size.y;
    arr.push({ x, y, px: x, py: y, age: Math.floor(Math.random() * 90), life: 70 + Math.random() * 80, lastAngle: null });
  }
  return arr;
}
/* One animation frame. The field goes on its own canvas, sat in the 'cur'
   pane, which in wind/current view sits BELOW the basemap tile pane so the
   land can render on top of it (dimmed, not painted over - see setMapView).
   The particles go on a second canvas in the 'arrows' pane instead, which
   stays above the tile pane always, so they read clearly over the dimmed
   land rather than getting muted along with the field underneath it. */
function drawFieldFrame(fieldCanvas, arrowCanvas, m, dpr, grid, fieldImg, N, kind, particles) {
  dpr = dpr || 1;
  const size = m.getSize();
  const fg = fieldCanvas.getContext('2d');
  fg.setTransform(dpr, 0, 0, dpr, 0, 0);
  fg.clearRect(0, 0, size.x, size.y);
  const ag = arrowCanvas.getContext('2d');
  ag.setTransform(dpr, 0, 0, dpr, 0, 0);
  ag.clearRect(0, 0, size.x, size.y);
  if (!grid || !fieldImg) return;
  fg.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in fg) fg.imageSmoothingQuality = 'high';
  fg.drawImage(fieldImg, 0, 0, N, N, 0, 0, size.x, size.y);
  if (!state.showArrows || !particles) return;
  ag.lineCap = 'round';
  // speed is anchored to the real value in knots, not a fraction of some
  // per-kind maximum - a fraction-of-max scale made a 2 kn current look as
  // brisk as the strongest current on the map, when it should barely drift.
  // The same px-per-knot applies to wind and current alike, so a 2 kn current
  // reads as a slow crawl and a 20 kn wind reads as a proper flow.
  const PX_PER_KNOT = 0.3;
  for (const pt of particles) {
    const j = Math.max(0, Math.min(N - 1, Math.floor(pt.x / size.x * N)));
    const i = Math.max(0, Math.min(N - 1, Math.floor(pt.y / size.y * N)));
    const cell = grid[i * N + j];
    pt.age++;
    if (!cell || pt.age > pt.life || pt.x < -5 || pt.x > size.x + 5 || pt.y < -5 || pt.y > size.y + 5) {
      // respawn at a fresh random point - collapse the trail to zero length
      // here so the next frame doesn't draw a streak clear across the screen
      pt.x = Math.random() * size.x; pt.y = Math.random() * size.y;
      pt.px = pt.x; pt.py = pt.y;
      pt.age = 0; pt.life = 70 + Math.random() * 80;
      pt.lastAngle = null;
      continue;
    }
    // wind_direction_10m is where the wind is FROM; ocean_current_direction is where it's heading
    const a = ((kind === 'wind' ? cell.dir + 180 : cell.dir) - 90) * Math.PI / 180;
    // where two grid cells disagree sharply on direction (a convergence or
    // shear line), nearest-cell lookup makes a particle crossing that
    // boundary flip direction every frame instead of flowing through it -
    // read as "sitting there and shaking". Catch a big frame-to-frame swing
    // and fade the particle out early instead of letting it vibrate in place.
    if (pt.lastAngle != null) {
      let da = Math.abs(a - pt.lastAngle) % (Math.PI * 2);
      if (da > Math.PI) da = Math.PI * 2 - da;
      if (da > Math.PI / 2 && pt.life - pt.age > 9) pt.life = pt.age + 9;
    }
    pt.lastAngle = a;
    const speedPx = Math.min(8.5, 0.1 + cell.kn * PX_PER_KNOT); // screen px this particle advances per tick
    pt.px = pt.x; pt.py = pt.y;
    pt.x += Math.cos(a) * speedPx;
    pt.y += Math.sin(a) * speedPx;
    // fade in over the first few frames after a spawn, fade out over the
    // last few before it dies (whether from natural expiry or the early
    // shear cutoff above) so nothing pops in or vanishes abruptly
    const fadeIn = Math.min(1, pt.age / 8);
    const fadeOut = Math.min(1, (pt.life - pt.age) / 9);
    const alpha = 0.9 * Math.min(fadeIn, fadeOut);
    if (alpha <= 0.02) continue;
    const hl = 3.4, ha = 0.5;
    const hx1 = pt.x - hl * Math.cos(a - ha), hy1 = pt.y - hl * Math.sin(a - ha);
    const hx2 = pt.x - hl * Math.cos(a + ha), hy2 = pt.y - hl * Math.sin(a + ha);
    // a dark halo drawn first so the white mark still reads against pale
    // water and land alike, not just the colour field
    ag.strokeStyle = 'rgba(4,18,30,' + (alpha * 0.65) + ')'; ag.lineWidth = 2.6;
    ag.beginPath(); ag.moveTo(pt.px, pt.py); ag.lineTo(pt.x, pt.y); ag.stroke();
    ag.fillStyle = 'rgba(4,18,30,' + (alpha * 0.65) + ')';
    ag.beginPath(); ag.moveTo(pt.x, pt.y); ag.lineTo(hx1, hy1); ag.lineTo(hx2, hy2); ag.closePath(); ag.fill();
    ag.strokeStyle = 'rgba(255,255,255,' + alpha + ')'; ag.lineWidth = 1.5;
    ag.beginPath(); ag.moveTo(pt.px, pt.py); ag.lineTo(pt.x, pt.y); ag.stroke();
    ag.fillStyle = 'rgba(255,255,255,' + alpha + ')';
    ag.beginPath(); ag.moveTo(pt.x, pt.y); ag.lineTo(hx1, hy1); ag.lineTo(hx2, hy2); ag.closePath(); ag.fill();
  }
}
/* Shared behaviour for the two field layers - fetch/redraw stays per-class
   (different API, different unit handling) but the canvas lifecycle and the
   animation loop are identical, so they're mixed in via Object.assign
   rather than duplicated. Redrawing is decoupled from fetching: _load()
   only refreshes this._grid/_fieldImg, and a throttled requestAnimationFrame
   loop repaints from whatever's cached every ~18fps, which is what drives
   the flowing arrows even when the data itself hasn't changed. */
const FieldLayerBase = {
  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', this._cls);
    this._canvas.style.position = 'absolute';
    map.getPane('cur').appendChild(this._canvas);
    // the arrows live on a separate canvas, in the 'arrows' pane above the
    // basemap tiles, so they stay crisp even where the field beneath them
    // is dimmed under the land (see setMapView / the 'arrows' pane above)
    this._arrowCanvas = L.DomUtil.create('canvas', this._cls + '-arrows');
    this._arrowCanvas.style.position = 'absolute';
    map.getPane('arrows').appendChild(this._arrowCanvas);
    map.on('moveend zoomend resize', this._reset, this);
    this._particles = null;
    this._reset();
    this._animTick();
  },
  onRemove(map) {
    map.off('moveend zoomend resize', this._reset, this);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    L.DomUtil.remove(this._canvas);
    L.DomUtil.remove(this._arrowCanvas);
    this._grid = null; this._fieldImg = null;
  },
  _reset() {
    const m = this._map, size = m.getSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pt = m.containerPointToLayerPoint([0, 0]);
    [this._canvas, this._arrowCanvas].forEach(cv => {
      L.DomUtil.setPosition(cv, pt);
      cv.width = size.x * dpr; cv.height = size.y * dpr;
      cv.style.width = size.x + 'px';
      cv.style.height = size.y + 'px';
    });
    this._dpr = dpr;
    // particles live in screen-space, seeded once and left to keep flowing -
    // a pan/zoom just repositions the pane as a whole (Leaflet's own CSS
    // transform), so there's no need to reseed on every _reset() call
    if (!this._particles) this._particles = initParticles(PARTICLE_N, size);
    this._load();
  },
  _animTick(t) {
    if (t == null || !this._lastT || t - this._lastT > 55) {
      this._lastT = t;
      drawFieldFrame(this._canvas, this._arrowCanvas, this._map, this._dpr, this._grid, this._fieldImg, FIELD_N, this._kind, this._particles);
    }
    this._raf = requestAnimationFrame(ts => this._animTick(ts));
  },
  refresh() { this._load(); }
};
/* Grid-sampled surface current, rendered as a coloured field. This is the
   broad-scale model current, not the tidal stream - see the note in the drawer. */
const CurrentLayer = L.Layer.extend(Object.assign({}, FieldLayerBase, {
  _cls: 'bw-cur', _kind: 'current',
  async _load() {
    const N = FIELD_N;
    const pts = fieldGrid(N, this._map.getBounds());
    const target = tlTargetTime();
    const key = pts.map(p => p.lat.toFixed(2) + ',' + p.lon.toFixed(2)).join('|') + '@' + target;
    if (!target) { this._grid = null; this._fieldImg = null; return; }
    if (key === this._key && this._grid) return;
    this._key = key;
    try {
      const grid = new Array(N * N).fill(null);
      for (let k = 0; k < pts.length; k += 25) {
        const chunk = pts.slice(k, k + 25);
        const url = 'https://marine-api.open-meteo.com/v1/marine?latitude=' +
          chunk.map(p => p.lat.toFixed(3)).join(',') + '&longitude=' +
          chunk.map(p => p.lon.toFixed(3)).join(',') +
          '&hourly=ocean_current_velocity,ocean_current_direction' +
          '&timezone=Australia%2FPerth&past_days=' + Math.max(0, -TL_DAY_MIN) + '&forecast_days=' + (TL_DAY_MAX + 1);
        const raw = await fetchJson(url, 60, false);
        const arr = Array.isArray(raw) ? raw : [raw];
        arr.forEach((r, i) => {
          if (!r || !r.hourly) return;
          const h = r.hourly.time.indexOf(target);
          if (h < 0) return;
          const v = r.hourly.ocean_current_velocity[h];
          const d = r.hourly.ocean_current_direction[h];
          if (v == null || d == null) return;
          grid[k + i] = { lat: chunk[i].lat, lon: chunk[i].lon, kn: v / 1.852, dir: d };
        });
      }
      this._grid = grid;
      this._fieldImg = buildFieldImage(N, grid, 'current');
    } catch {
      this._grid = null; this._fieldImg = null;
    }
  }
}));
let currentLayer = null;

/* Same grid-and-field approach, sampling forecast wind speed/direction.
   Always fetched in true knots regardless of the display unit, so the
   field colour stays correct however Settings has units set. Both wind
   and gust speed come back in the one fetch, so switching the Wind/Gusts
   selector just re-picks which value each grid cell uses (see
   _buildFromRaw) rather than re-fetching - the map field and the timeline
   graph then always agree on which one is showing. */
const WindLayer = L.Layer.extend(Object.assign({}, FieldLayerBase, {
  _cls: 'bw-wind', _kind: 'wind',
  async _load() {
    const N = FIELD_N;
    const pts = fieldGrid(N, this._map.getBounds());
    const target = tlTargetTime();
    const key = pts.map(p => p.lat.toFixed(2) + ',' + p.lon.toFixed(2)).join('|') + '@' + target;
    if (!target) { this._grid = null; this._fieldImg = null; return; }
    if (key !== this._key || !this._raw) {
      this._key = key;
      try {
        const raw = new Array(N * N).fill(null);
        for (let k = 0; k < pts.length; k += 25) {
          const chunk = pts.slice(k, k + 25);
          const url = 'https://api.open-meteo.com/v1/forecast?latitude=' +
            chunk.map(p => p.lat.toFixed(3)).join(',') + '&longitude=' +
            chunk.map(p => p.lon.toFixed(3)).join(',') +
            '&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m' +
            '&timezone=Australia%2FPerth&past_days=' + Math.max(0, -TL_DAY_MIN) + '&forecast_days=' + (TL_DAY_MAX + 1) +
            '&wind_speed_unit=kn';
          const res = await fetchJson(url, 60, false);
          const arr = Array.isArray(res) ? res : [res];
          arr.forEach((r, i) => {
            if (!r || !r.hourly) return;
            const h = r.hourly.time.indexOf(target);
            if (h < 0) return;
            const v = r.hourly.wind_speed_10m[h];
            const g = r.hourly.wind_gusts_10m ? r.hourly.wind_gusts_10m[h] : null;
            const d = r.hourly.wind_direction_10m[h];
            if (v == null || d == null) return;
            raw[k + i] = { lat: chunk[i].lat, lon: chunk[i].lon, wind: v, gust: g != null ? g : v, dir: d };
          });
        }
        this._raw = raw;
      } catch {
        this._raw = null;
      }
    }
    this._buildFromRaw();
  },
  _buildFromRaw() {
    const N = FIELD_N;
    if (!this._raw) { this._grid = null; this._fieldImg = null; return; }
    const metric = state.windMetric === 'gust' ? 'gust' : 'wind';
    const grid = this._raw.map(c => c ? { lat: c.lat, lon: c.lon, kn: c[metric], dir: c.dir } : null);
    this._grid = grid;
    this._fieldImg = buildFieldImage(N, grid, 'wind');
  }
}));
let windLayer = null;

/* The colour-scale key is removed for every layer - satellite and field
   alike. Left as a no-op (rather than pulled out at every call site) so
   nothing else needs to change; #legend itself is gone from the page. */
function paintFieldLegend() {}

function paintWcSeg() {
  $$('#wcSeg button').forEach(b => b.classList.toggle('on', b.dataset.wc === state.mapView));
  const row = $('#windMetricRow'); if (row) row.classList.toggle('hidden', state.mapView !== 'wind');
}
/* the Wind/Gusts toggle only matters on the wind page - it picks which
   single line the timeline graphs, colour-coded (see renderTimelineGraph) */
function paintWindMetricSeg() {
  $$('#windMetricSeg button').forEach(b => b.classList.toggle('on', b.dataset.wm === state.windMetric));
}
function updateTlTitle() {
  const el = $('#tlTitle'); if (el) el.textContent = state.tlPage === 'current' ? 'Current' : 'Wind';
}
/* The single switch between the satellite layer and a full-page wind/current
   field - mutually exclusive, one tap, same pattern as SST/Chl/Anom. Leaving
   'sat' hides the imagery + break-finder panes (without discarding them);
   coming back re-shows them rather than refetching. On the field views the
   land basemap is pulled above the coloured field (dropping the field pane
   below the tile pane) and dimmed rather than fully opaque, so the coast is
   readable without blotting out the water the field is actually showing. */
function setMapView(view) {
  state.mapView = view; store.set('mapView', view);
  paintWcSeg();
  markSel();
  if (view === 'sat') {
    if (windLayer) { map.removeLayer(windLayer); windLayer = null; }
    if (currentLayer) { map.removeLayer(currentLayer); currentLayer = null; }
    map.getPane('cur').style.zIndex = 430;
    bathy.setOpacity(1);
    if (dataLayer && !map.hasLayer(dataLayer)) dataLayer.addTo(map);
    if (breakLayer && !map.hasLayer(breakLayer)) breakLayer.addTo(map);
  } else {
    if (dataLayer && map.hasLayer(dataLayer)) map.removeLayer(dataLayer);
    if (breakLayer && map.hasLayer(breakLayer)) map.removeLayer(breakLayer);
    map.getPane('cur').style.zIndex = 150;   // below the tile pane (200) - land renders on top
    // the land fill itself goes very light here so the field colour is the
    // thing that reads - the coastline stays marked regardless, because the
    // reference layer (roads, rivers, place names) sits in its own pane
    // above everything and is never dimmed, so it doubles as the coastline
    // outline without needing a separate vector layer of our own
    bathy.setOpacity(0.22);
    if (view === 'wind') {
      if (currentLayer) { map.removeLayer(currentLayer); currentLayer = null; }
      if (!windLayer) { windLayer = new WindLayer(); windLayer.addTo(map); }
    } else {
      if (windLayer) { map.removeLayer(windLayer); windLayer = null; }
      if (!currentLayer) { currentLayer = new CurrentLayer(); currentLayer.addTo(map); }
    }
  }
}
/* Tapping Wind/Current up top picks which forecast the timeline graph
   shows AND switches the map to that full field view. */
function setTlPage(page) {
  state.tlPage = page; store.set('tlPage', page);
  setMapView(page);
  updateTlTitle();
  renderTimelineGraph();
  updateTlValue();
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
  const end = new Date(Date.now() + 86400000), start = new Date(Date.now() - 30 * 86400000);
  try {
    // A modest bbox around the region rather than the whole globe - GIBS answers
    // it faster and it is the only water we care about being current for.
    const u = DOMAINS + '/' + L_.id + '/default/' + L_.tms + '/108,-40,156,-8/' +
      iso(start) + '--' + iso(end) + '.xml';
    const xml = await (await fetch(u, { cache: 'no-store' })).text();
    const m = [...xml.matchAll(/<Domain>([^<]+)<\/Domain>/g)].pop();
    if (m) {
      const parts = m[1].split(',').pop().split('/');
      const d = parts.length > 1 ? parts[1] : parts[0];
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        store.set('latest.' + key, d);
        store.set('checked.' + key, Date.now());
        return d;
      }
    }
  } catch {}
  return store.get('latest.' + key, iso(new Date(Date.now() - 2 * 86400000)));
}

/* How far behind real time this layer is, and what to expect next. */
function daysBehind(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const then = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((today - then) / 86400000);
}
function paintFreshness() {
  const el = $('#freshness');
  if (!el) return;
  const key = state.layer, L_ = LAYERS[key];
  const latest = state.latest[key];
  if (!latest) { el.textContent = 'Checking what NASA has published…'; return; }
  const behind = daysBehind(latest);
  const typical = key === 'chl' ? 'one to two days' : 'about a day';
  const cls = behind <= (key === 'chl' ? 2 : 1) ? 'ok' : 'old';
  const ageTxt = behind <= 0 ? 'today' : behind === 1 ? '1 day behind' : behind + ' days behind';
  const [yy, mm, dd] = latest.split('-').map(Number);
  const next = new Date(yy, mm - 1, dd + 1);
  const nextName = next.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' });
  const checked = store.get('checked.' + key, 0);
  const ago = checked ? Math.round((Date.now() - checked) / 60000) : null;
  el.innerHTML =
    'Newest image NASA has published: <b>' + dayLabel(latest) + '</b>' +
    '<span class="age ' + cls + '">' + ageTxt + '</span><br>' +
    L_.full + ' normally runs ' + typical + ' behind, so <b>' + nextName + '</b> should appear ' +
    (key === 'chl' ? 'over the next day or two' : 'within about a day') + '.' +
    (ago !== null ? '<br>Last checked ' + (ago < 1 ? 'just now' : ago + ' min ago') + '.' : '') +
    (behind > 3 ? '<br><b>Running late.</b> Heavy cloud or a processing hold at NASA will do this. Wind the date back to find the last clear pass.' : '');
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
  paintFreshness();
  const seen = store.get('seenLatest.' + state.layer, null);
  if (seen && seen !== l) toast('New ' + LAYERS[state.layer].name + ' imagery: ' + dayLabel(l), 3600);
  store.set('seenLatest.' + state.layer, l);
}
function paintDate() {
  $('#dateLabel').textContent = dayLabel(state.date);
  if (typeof syncDayNav === 'function') syncDayNav();
  $('#dateSub').textContent = state.date + '  ·  ' + LAYERS[state.layer].full;
}

/* ------------------------------ legend ------------------------------ */
/* The colour-scale key is removed for every layer, satellite included - see
   the matching paintFieldLegend() no-op above. Left in place as a no-op
   rather than pulled out at every call site. */
function paintLegend() {}

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
async function showReadout(latlng, place) {
  tapPt = latlng;
  const t = $('#roTitle');
  if (place) { t.hidden = false; t.textContent = place.name; }
  else { t.hidden = true; t.textContent = ''; }
  const noteEl = $('#roNote');
  if (noteEl) noteEl.remove();
  if (place) {
    const n = document.createElement('div');
    n.className = 'ro-note'; n.id = 'roNote';
    n.textContent = 'Position from the ' + FADS.source + ', ' + FADS.vintage +
      '. FADs get moved, retrieved and break their moorings \u2014 confirm before you plan around one.';
    $('#readout').appendChild(n);
  }
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
const memCache = new Map();
/* persist:false keeps a response in memory only - the current-arrow grid changes
   with every pan, and writing each one to localStorage would fill the quota and
   start silently breaking everything else stored there. */
async function fetchJson(url, ttlMin, persist = true) {
  const k = 'j.' + url;
  const c = persist ? store.get(k, null) : memCache.get(k);
  if (c && Date.now() - c.t < ttlMin * 60000) return c.d;
  try {
    const d = await (await fetch(url)).json();
    const rec = { t: Date.now(), d };
    persist ? store.set(k, rec) : memCache.set(k, rec);
    if (!persist && memCache.size > 40) memCache.delete(memCache.keys().next().value);
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
  state.tlLat = lat; state.tlLon = lon;
  await refreshTimeline();
}
async function refreshTimeline() {
  const lat = state.tlLat, lon = state.tlLon;
  if (lat == null) return;
  const la = lat.toFixed(2), lo = lon.toFixed(2);
  const past = Math.max(0, -TL_DAY_MIN), fwd = TL_DAY_MAX + 1;
  const wUrl = 'https://api.open-meteo.com/v1/forecast?latitude=' + la + '&longitude=' + lo +
    '&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m&daily=sunrise,sunset' +
    '&timezone=Australia%2FPerth&past_days=' + past + '&forecast_days=' + fwd +
    '&wind_speed_unit=' + (state.spd === 'kn' ? 'kn' : 'kmh');
  const mUrl = 'https://marine-api.open-meteo.com/v1/marine?latitude=' + la + '&longitude=' + lo +
    '&hourly=wave_height,wave_period,swell_wave_height,swell_wave_period,swell_wave_direction,' +
    'sea_surface_temperature,ocean_current_velocity,ocean_current_direction' +
    '&timezone=Australia%2FPerth&past_days=' + past + '&forecast_days=' + fwd;
  try {
    const [w, m] = await Promise.all([fetchJson(wUrl, 45), fetchJson(mUrl, 45)]);
    tlFull = { w, m };
    sliceTimelineDay();
  } catch {
    tlFull = null; tlData = null;
    $('#condWhere').textContent = 'For ' + fmtPos(lat, lon);
    $('#condCards').innerHTML = '<div class="empty">No forecast right now. It will fill in when you have signal.</div>';
    $('#condHint').textContent = '';
    renderTimelineGraph();
    syncTlDayNav();
  }
}
function sliceTimelineDay() {
  if (!tlFull) return;
  const { w, m } = tlFull;
  const target = localDateStr(addDays(new Date(), state.tlDay));
  const idxs = []; w.hourly.time.forEach((t, i) => { if (t.slice(0, 10) === target) idxs.push(i); });
  if (!idxs.length) {
    tlData = null; renderTimelineGraph(); syncTlDayNav();
    if (currentLayer) currentLayer.refresh();
    if (windLayer) windLayer.refresh();
    return;
  }
  const i0 = idxs[0], n = idxs.length;
  const mIdxs = []; m.hourly.time.forEach((t, i) => { if (t.slice(0, 10) === target) mIdxs.push(i); });
  const j0 = mIdxs.length ? mIdxs[0] : i0;
  tlData = {
    lat: state.tlLat, lon: state.tlLon,
    times: w.hourly.time.slice(i0, i0 + n),
    wind: w.hourly.wind_speed_10m.slice(i0, i0 + n),
    gust: w.hourly.wind_gusts_10m.slice(i0, i0 + n),
    wdir: w.hourly.wind_direction_10m.slice(i0, i0 + n),
    wave: m.hourly.wave_height.slice(j0, j0 + n),
    swell: m.hourly.swell_wave_height.slice(j0, j0 + n),
    swellP: m.hourly.swell_wave_period.slice(j0, j0 + n),
    swellDir: m.hourly.swell_wave_direction.slice(j0, j0 + n),
    cur: m.hourly.ocean_current_velocity.slice(j0, j0 + n),
    cdir: m.hourly.ocean_current_direction.slice(j0, j0 + n),
    sunrise: w.daily.sunrise, sunset: w.daily.sunset
  };
  const slider = $('#tlSlider');
  if (state.tlIdx == null || state.tlIdx > n - 1) {
    state.tlIdx = state.tlDay === 0 ? nearestHour(tlData.times) : Math.floor(n / 2);
  }
  if (slider) { slider.max = n - 1; slider.value = state.tlIdx; }
  renderCondAt(state.tlIdx);
  renderTimelineGraph();
  syncTlDayNav();
  // the map can already be showing the wind/current field before this first
  // resolves (e.g. the app reopens straight into the wind view, since that
  // was the last thing shown) - whichever layer is live retries its own
  // fetch now that there's a valid hour to fetch data for. Cheap no-op via
  // the key check in _load() if it already has this exact data.
  if (currentLayer) currentLayer.refresh();
  if (windLayer) windLayer.refresh();
}
function stepTlDay(delta) {
  const nd = Math.max(TL_DAY_MIN, Math.min(TL_DAY_MAX, state.tlDay + delta));
  if (nd === state.tlDay) return;
  state.tlDay = nd; state.tlIdx = null;
  sliceTimelineDay(); // also refreshes currentLayer/windLayer itself
}
function syncTlDayNav() {
  const label = $('#tlDayLabel'); if (label) label.textContent = dayLabelFor(state.tlDay);
  const prev = $('#tlPrevDay'); if (prev) prev.disabled = state.tlDay <= TL_DAY_MIN;
  const next = $('#tlNextDay'); if (next) next.disabled = state.tlDay >= TL_DAY_MAX;
}
function renderCondAt(idx) {
  if (!tlData || !tlData.times.length) return;
  idx = Math.max(0, Math.min(tlData.times.length - 1, idx));
  const u = state.spd === 'kn' ? 'kn' : 'km/h';
  const ws = tlData.wind[idx], wg = tlData.gust[idx], wd = tlData.wdir[idx];
  const sw = tlData.swell[idx], sp = tlData.swellP[idx], sd = tlData.swellDir[idx];
  const wh = tlData.wave[idx];
  const cv = tlData.cur[idx], cd = tlData.cdir[idx];
  const rough = ws != null && (state.spd === 'kn' ? ws >= 18 : ws >= 33);
  const sr = (tlData.sunrise[0] || '').slice(11, 16), ss = (tlData.sunset[0] || '').slice(11, 16);
  const isNow = state.tlDay === 0 && idx === nearestHour(tlData.times);
  const when = (isNow ? 'now' : dayLabelFor(state.tlDay) + ' ' + fmtClock(tlData.times[idx]));
  $('#condWhere').textContent = 'For ' + fmtPos(tlData.lat, tlData.lon) + (isNow ? '' : ' · ' + when + ' forecast');
  $('#condCards').innerHTML =
    card('Wind', ws == null ? '—' : Math.round(ws) + ' ' + u, wd == null ? '' : compass(wd) + ' · gust ' + Math.round(wg), rough) +
    card('Sea', wh == null ? '—' : wh.toFixed(1) + ' m', 'combined') +
    card('Swell', sw == null ? '—' : sw.toFixed(1) + ' m', (sp ? Math.round(sp) + ' s ' : '') + (sd != null ? compass(sd) : '')) +
    card('Current', cv == null ? '—' : (cv / 1.852).toFixed(1) + ' kn', cd == null ? '' : 'setting ' + compass(cd)) +
    card('Light', sr + ' – ' + ss, 'sunrise – sunset');
  $('#condHint').textContent = rough
    ? (isNow ? 'Model wind is up around ' : 'Model wind is forecast up around ') + Math.round(ws) + ' ' + u + '. Check the BOM coastal waters forecast before you commit.'
    : 'Forecast model output, updated hourly. Always cross-check the BOM coastal waters forecast.';
  updateTlTimeLabel();
  updateTlValue();
}

/* ------------------------------ timeline ----------------------------- */
/* A Windy-style scrubber. Wind page: speed and gusts as two overlaid
   filled lines on the same axis. Current page: a single speed line.
   Dragging moves state.tlIdx (hour of the selected day) which drives the
   Conditions cards, the value line under the graph, and - after a short
   pause - the wind and current map arrow layers. Day arrows page through
   state.tlDay (past_days/forecast_days fetched up front, sliced per day). */
function renderTimelineGraph() {
  const cv = $('#tlGraph');
  if (!cv) return;
  const rect = cv.getBoundingClientRect();
  const w = Math.max(200, rect.width || cv.parentElement.clientWidth || 320), h = 46;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px';
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const nowMark = $('#tlNowMark');
  if (!tlData || !tlData.times.length) { positionPlayhead(); if (nowMark) nowMark.classList.add('hidden'); return; }
  const n = tlData.times.length;
  const bw = w / n;
  const baseY = h - 12;
  // night shading using sunrise/sunset for the day either side
  const bands = [];
  for (let d = 0; d < tlData.sunrise.length; d++) {
    const sr = tlData.sunrise[d], ss = tlData.sunset[d];
    if (sr) bands.push({ t: new Date(sr).getTime(), on: false });
    if (ss) bands.push({ t: new Date(ss).getTime(), on: true });
  }
  bands.sort((a, b) => a.t - b.t);
  tlData.times.forEach((t, i) => {
    const tt = new Date(t).getTime();
    let night = true;
    for (const b of bands) { if (tt >= b.t) night = b.on; }
    if (night) { g.fillStyle = 'rgba(0,0,0,.16)'; g.fillRect(i * bw, 0, bw + 0.5, h); }
  });
  const X = i => i * bw + bw / 2;
  /* Reference gridlines at round numbers (5/10/15kn and so on, picked to
     suit whatever range is on screen) with a small value key down the left
     edge and a unit label in the corner - so the strength of the day reads
     as an actual number, not just a colour, the same way Windy's scrubber
     does. Drawn before the coloured area so the fill still shows through
     it at low alpha, and the lines read clearly above the fill line. */
  const niceStep = maxV => {
    const target = maxV / 4;
    const steps = [1, 2, 5, 10, 15, 20, 25, 50, 100];
    for (const s of steps) if (target <= s) return s;
    return Math.ceil(target / 50) * 50;
  };
  const drawRefLines = (maxV, unit) => {
    const step = niceStep(maxV);
    const marks = [];
    for (let v = step; v < maxV; v += step) marks.push(v);
    g.font = '8px -apple-system,sans-serif'; g.textAlign = 'left';
    marks.forEach((v, idx) => {
      const y = baseY - (v / maxV) * (baseY - 4);
      g.strokeStyle = 'rgba(143,176,196,.22)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      g.fillStyle = 'rgba(214,228,238,.8)';
      // the unit only needs to appear once - fold it into the top line's
      // label rather than a separate corner key, which crowded it when the
      // top gridline landed near the very top of the graph
      const label = idx === marks.length - 1 ? v + ' ' + unit : String(v);
      g.fillText(label, 3, Math.max(9, y - 2));
    });
  };
  /* Windy-style colour coding: each hour's fill/stroke colour comes from
     its own knot value read against the same scale the map field uses
     (WIND_STOPS/CURRENT_STOPS - see buildFieldImage above), blended into
     a horizontal gradient across the hours rather than one flat colour,
     so a calm morning reads blue and a stiff sea-breeze reads green/
     orange, matching the field on the map. */
  const gradientArea = (vals, kts, maxV, stops, fillA, strokeA) => {
    const fillGrad = g.createLinearGradient(0, 0, w, 0);
    const strokeGrad = g.createLinearGradient(0, 0, w, 0);
    vals.forEach((v, i) => {
      const [r, gg, b] = lerpColor(stops, kts[i]);
      const frac = n > 1 ? i / (n - 1) : 0;
      fillGrad.addColorStop(frac, 'rgba(' + r + ',' + gg + ',' + b + ',' + fillA + ')');
      strokeGrad.addColorStop(frac, 'rgba(' + r + ',' + gg + ',' + b + ',' + strokeA + ')');
    });
    g.beginPath();
    vals.forEach((v, i) => { const x = X(i), y = baseY - (Math.max(0, v || 0) / maxV) * (baseY - 4); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.lineTo(X(n - 1), baseY); g.lineTo(X(0), baseY); g.closePath();
    g.fillStyle = fillGrad; g.fill();
    g.beginPath();
    vals.forEach((v, i) => { const x = X(i), y = baseY - (Math.max(0, v || 0) / maxV) * (baseY - 4); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.strokeStyle = strokeGrad; g.lineWidth = 1.8; g.stroke();
  };
  // the wind page graphs one line at a time now - Wind or Gusts, picked by
  // #windMetricSeg - rather than two overlaid fills, so the colour-coding
  // reads cleanly instead of blending two translucent layers together
  if (state.tlPage === 'current') {
    const cur = tlData.cur.map(v => v == null ? 0 : v / 1.852);
    const maxV = Math.max(1, ...cur) * 1.15;
    drawRefLines(maxV, 'kn');
    gradientArea(cur, cur, maxV, CURRENT_STOPS, 0.42, 0.95);
  } else {
    const toKn = v => state.spd === 'kn' ? v : v / 1.852;
    const metric = state.windMetric === 'gust' ? 'gust' : 'wind';
    const vals = tlData[metric].map(v => v == null ? 0 : v);
    const kts = vals.map(toKn);
    const maxV = Math.max(state.spd === 'kn' ? 10 : 18, ...vals) * 1.15;
    drawRefLines(maxV, state.spd === 'kn' ? 'kn' : 'km/h');
    gradientArea(vals, kts, maxV, WIND_STOPS, 0.42, 0.95);
  }
  // hour ticks
  g.fillStyle = 'rgba(143,176,196,.85)'; g.font = '9px -apple-system,sans-serif'; g.textAlign = 'center';
  [0, 6, 12, 18].forEach(hr => {
    const i = tlData.times.findIndex(t => new Date(t).getHours() === hr);
    if (i < 0) return;
    const label = hr === 0 ? '12am' : hr === 12 ? '12pm' : hr < 12 ? hr + 'am' : (hr - 12) + 'pm';
    const tx = Math.min(w - 14, Math.max(14, X(i)));
    g.fillText(label, tx, h - 1);
  });
  g.textAlign = 'left';
  // "now" reference tick, separate from the draggable playhead
  if (nowMark) {
    const nowI = state.tlDay === 0 ? nearestHour(tlData.times) : -1;
    if (nowI >= 0) { nowMark.style.left = (((nowI + 0.5) / n) * 100) + '%'; nowMark.classList.remove('hidden'); }
    else nowMark.classList.add('hidden');
  }
  positionPlayhead();
}
function positionPlayhead() {
  const head = $('#tlHead'); if (!head) return;
  const n = tlData && tlData.times.length ? tlData.times.length : 24;
  const frac = (state.tlIdx + 0.5) / n;
  head.style.left = (frac * 100) + '%';
}
function updateTlTimeLabel() {
  const tEl = $('#tlTime'); if (!tEl || !tlData) return;
  tEl.textContent = fmtClock(tlData.times[state.tlIdx]);
}
function updateTlValue() {
  const el = $('#tlValue'); if (!el) return;
  if (!tlData) { el.textContent = '—'; return; }
  const idx = state.tlIdx;
  if (state.tlPage === 'current') {
    const cv = tlData.cur[idx], cd = tlData.cdir[idx];
    el.textContent = cv == null ? '—' : (cv / 1.852).toFixed(1) + ' kn' + (cd != null ? ' · setting ' + compass(cd) : '');
  } else {
    const u = state.spd === 'kn' ? 'kn' : 'km/h';
    const ws = tlData.wind[idx], wg = tlData.gust[idx], wd = tlData.wdir[idx];
    el.textContent = ws == null ? '—' : Math.round(ws) + ' ' + u + (wd != null ? ' ' + compass(wd) : '') + ' · gusts ' + Math.round(wg) + ' ' + u;
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
let tideMap = null;  // {t0,t1,w,h,X,Y} from the last draw, for the drag-to-read handler
async function loadTide(lat, lon) {
  state.tideLat = lat; state.tideLon = lon;
  let list;
  try { list = await getStations(); } catch { $('#tideWhere').textContent = 'Tide data unavailable.'; return; }
  const { s, d } = nearestStation(list, lat, lon);
  if (!s) return;
  const off = s.off != null ? s.off : 0;
  const cons = s.c.map(c => ({ name: c[0], amplitude: c[1], phase: c[2] }));
  const p = createTidePredictor(cons, { phaseKey: 'phase' });
  const dayStart = addDays(new Date(), state.tideDay); dayStart.setHours(0, 0, 0, 0);
  const extStart = new Date(dayStart.getTime() - 6 * 3600000);
  const extEnd = new Date(dayStart.getTime() + 30 * 3600000);
  const ext = p.getExtremesPrediction({ start: extStart, end: extEnd, timeFidelity: 60 })
    .map(e => ({ t: new Date(e.time), h: e.level + off, high: !!e.high }));
  const winStart = state.tideDay === 0 ? new Date(Date.now() - 6 * 3600000) : new Date(dayStart.getTime() - 3 * 3600000);
  const winEnd = state.tideDay === 0 ? new Date(Date.now() + 18 * 3600000) : new Date(dayStart.getTime() + 27 * 3600000);
  const tl = p.getTimelinePrediction({ start: winStart, end: winEnd, timeFidelity: 900 })
    .map(e => ({ t: new Date(e.time), h: e.level + off }));
  tideCache = { s, ext, tl, off };
  const km = (d / 1000).toFixed(0);
  $('#tideWhere').textContent = s.n + (s.r ? ', ' + s.r : '') + ' · ' + km + ' km from the mark';
  const dayEnd = dayStart.getTime() + 86400000;
  const upcoming = state.tideDay === 0
    ? ext.filter(e => e.t.getTime() > Date.now() - 3600000).slice(0, 6)
    : ext.filter(e => e.t.getTime() >= dayStart.getTime() && e.t.getTime() < dayEnd);
  $('#tideList').innerHTML = upcoming.map(e =>
    '<div class="t ' + (e.high ? 'hi' : 'lo') + '"><div class="lab">' + (e.high ? 'High' : 'Low') + '</div>' +
    '<div class="tm">' + pad(e.t.getHours()) + ':' + pad(e.t.getMinutes()) + '</div>' +
    '<div class="h">' + e.h.toFixed(2) + ' m</div></div>').join('') ||
    '<div class="empty">No tide extremes in range.</div>';
  drawTide(tl, ext);
  syncTideDayNav();
}
function stepTideDay(delta) {
  state.tideDay += delta;
  hideTideReadout();
  if (state.tideLat != null) loadTide(state.tideLat, state.tideLon);
}
function syncTideDayNav() {
  const label = $('#tideDayLabel'); if (label) label.textContent = dayLabelFor(state.tideDay);
}
function drawTide(tl, ext, markX) {
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
  tideMap = { t0, t1, w, h, X, Y };
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
  // now line - only meaningful when looking at today
  if (state.tideDay === 0) {
    const nx = X(Date.now());
    g.strokeStyle = '#ff8a3d'; g.lineWidth = 1.5; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(nx, 6); g.lineTo(nx, h - 22); g.stroke(); g.setLineDash([]);
  }
  // hour ticks
  g.fillStyle = '#8fb0c4';
  for (let t = t0; t <= t1; t += 6 * 3600000) {
    const d = new Date(t); const x = X(t);
    g.fillText(pad(d.getHours()) + ':00', Math.min(w - 34, Math.max(4, x - 14)), h - 7);
  }
  // drag-to-read marker
  if (markX != null) {
    const frac = Math.min(1, Math.max(0, (markX - 6) / (w - 12)));
    const t = t0 + frac * (t1 - t0);
    const hgt = tideHeightAt(tl, t);
    if (hgt != null) {
      const x = X(t), y = Y(hgt);
      g.strokeStyle = '#fff'; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(x, 6); g.lineTo(x, h - 22); g.stroke();
      g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
      g.strokeStyle = '#31c2f0'; g.lineWidth = 2; g.stroke();
    }
  }
}
function tideHeightAt(tl, t) {
  if (!tl || !tl.length) return null;
  if (t <= tl[0].t.getTime()) return tl[0].h;
  if (t >= tl[tl.length - 1].t.getTime()) return tl[tl.length - 1].h;
  for (let i = 0; i < tl.length - 1; i++) {
    const a = tl[i].t.getTime(), b = tl[i + 1].t.getTime();
    if (t >= a && t <= b) {
      const f = (t - a) / (b - a);
      return tl[i].h + (tl[i + 1].h - tl[i].h) * f;
    }
  }
  return null;
}
function hideTideReadout() {
  const el = $('#tideReadout'); if (el) el.classList.add('hidden');
}
function tideReadAt(clientX) {
  if (!tideMap || !tideCache) return;
  const rect = $('#tideChart').getBoundingClientRect();
  const px = clientX - rect.left;
  const frac = Math.min(1, Math.max(0, (px - 6) / (tideMap.w - 12)));
  const t = tideMap.t0 + frac * (tideMap.t1 - tideMap.t0);
  const hgt = tideHeightAt(tideCache.tl, t);
  drawTide(tideCache.tl, tideCache.ext, px);
  const el = $('#tideReadout'); if (!el || hgt == null) return;
  const d = new Date(t);
  el.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' · ' + hgt.toFixed(2) + ' m';
  el.style.left = Math.min(rect.width - 8, Math.max(8, px)) + 'px';
  el.classList.remove('hidden');
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

// map-type shortcuts
function markSel() {
  $$('#layerSeg button').forEach(b => b.classList.toggle('on', state.mapView === 'sat' && b.dataset.layer === state.layer));
}
markSel();
$('#layerSeg').addEventListener('click', async e => {
  const b = e.target.closest('button[data-layer]');
  if (!b) return;
  const same = b.dataset.layer === state.layer;
  if (!same) { state.layer = b.dataset.layer; store.set('layer', state.layer); }
  markSel();
  setMapView('sat');
  if (same) return;
  const l = await latestDate(state.layer);
  state.latest[state.layer] = l; store.set('latest.' + state.layer, l);
  state.dates = buildDates(l);
  const idx = Math.min(state.dates.length - 1, +$('#dateSlider').value);
  $('#dateSlider').max = state.dates.length - 1;
  state.date = state.dates[idx];
  paintDate(); buildDataLayer(); refreshBreaks(true); paintLegend();
  paintFreshness();
  paintBreakHint();
  const seen = store.get('seenLatest.' + state.layer, null);
  if (seen && seen !== l) toast('New ' + LAYERS[state.layer].name + ' imagery: ' + dayLabel(l), 3200);
  store.set('seenLatest.' + state.layer, l);
});

$('#btnDate').addEventListener('click', () => openDrawer('menu'));

/* Day stepper on the map, so you can walk back through the passes without
   opening settings. Newest available is the ceiling - there is nothing after it. */
function stepDay(delta) {
  const i = state.dates.indexOf(state.date);
  const j = Math.max(0, Math.min(state.dates.length - 1, (i < 0 ? state.dates.length - 1 : i) + delta));
  if (j === i) return;
  state.date = state.dates[j];
  $('#dateSlider').value = j;
  paintDate(); paintFreshness(); buildDataLayer(); refreshBreaks(true);
  syncDayNav();
}
function syncDayNav() {
  const i = state.dates.indexOf(state.date);
  const prev = $('#btnPrevDay'), next = $('#btnNextDay');
  if (!prev || !next) return;
  prev.disabled = i <= 0;
  next.disabled = i < 0 || i >= state.dates.length - 1;
}
$('#btnPrevDay').addEventListener('click', () => stepDay(-1));
$('#btnNextDay').addEventListener('click', () => stepDay(1));
$('#btnMenu').addEventListener('click', () => openDrawer('menu'));
$('#btnOffline').addEventListener('click', () => { openDrawer('offline'); updateEstimate(); showCacheInfo(); });

$('#opacity').value = state.opacity;
$('#opVal').textContent = state.opacity + '%';
$('#opacity').addEventListener('input', e => {
  state.opacity = +e.target.value; store.set('opacity', state.opacity);
  $('#opVal').textContent = state.opacity + '%';
  if (dataLayer) dataLayer.setOpacity(state.opacity / 100);
});

$('#thresh').value = state.coverage;
paintBreakHint();
$('#thresh').addEventListener('input', e => {
  state.coverage = +e.target.value; store.set('coverage', state.coverage);
  paintBreakHint();
});
$('#thresh').addEventListener('change', () => { if (state.breaks) refreshBreaks(true); });

$('#breakOn').checked = state.breaks;
function setBreaks(on) {
  state.breaks = on; store.set('breaks', on);
  $('#breakOn').checked = on;
  $('#btnBreak').classList.toggle('on', on);
  refreshBreaks(true);
}
$('#breakOn').addEventListener('change', e => setBreaks(e.target.checked));
$('#btnBreak').addEventListener('click', () => setBreaks(!state.breaks));

$('#arrowsOn').checked = state.showArrows;
$('#arrowsOn').addEventListener('change', e => {
  state.showArrows = e.target.checked; store.set('showArrows', state.showArrows);
  if (windLayer) windLayer._draw();
  if (currentLayer) currentLayer._draw();
});

/* wind / current page selector, up in the top bar - picks which forecast
   the timeline graph shows AND switches the map to that full field view. */
$$('#wcSeg button').forEach(b => b.addEventListener('click', () => setTlPage(b.dataset.wc)));
$$('#windMetricSeg button').forEach(b => b.addEventListener('click', () => {
  if (state.windMetric === b.dataset.wm) return;
  state.windMetric = b.dataset.wm; store.set('windMetric', state.windMetric);
  paintWindMetricSeg();
  renderTimelineGraph();
  // the map field itself needs to switch too, not just the timeline graph -
  // WindLayer keeps both wind and gust values cached from the last fetch, so
  // this just re-picks which one colours the field rather than refetching
  if (windLayer) windLayer.refresh();
}));

/* timeline scrubber - cheap redraw on every drag tick, layer refetch debounced */
let tlDebounce = null;
const tlSliderEl = $('#tlSlider');
if (tlSliderEl) {
  tlSliderEl.addEventListener('input', e => {
    state.tlIdx = +e.target.value;
    renderCondAt(state.tlIdx);
    positionPlayhead();
    clearTimeout(tlDebounce);
    tlDebounce = setTimeout(() => {
      if (currentLayer) currentLayer.refresh();
      if (windLayer) windLayer.refresh();
    }, 450);
  });
}
const tlNowBtn = $('#tlNow');
if (tlNowBtn) {
  tlNowBtn.addEventListener('click', () => {
    state.tlDay = 0; state.tlIdx = null;
    sliceTimelineDay();
    if (currentLayer) currentLayer.refresh();
    if (windLayer) windLayer.refresh();
  });
}
const tlPrevBtn = $('#tlPrevDay'), tlNextBtn = $('#tlNextDay');
if (tlPrevBtn) tlPrevBtn.addEventListener('click', () => stepTlDay(-1));
if (tlNextBtn) tlNextBtn.addEventListener('click', () => stepTlDay(1));
const tlToggleBtn = $('#tlToggle');
if (tlToggleBtn) {
  tlToggleBtn.addEventListener('click', () => {
    const collapsed = $('#timeline').classList.toggle('collapsed');
    store.set('tlCollapsed', collapsed);
    if (!collapsed) renderTimelineGraph();
  });
  if (store.get('tlCollapsed', false)) $('#timeline').classList.add('collapsed');
}
window.addEventListener('resize', () => renderTimelineGraph());
$('#seamarkOn').checked = state.seamarks;
$('#seamarkOn').addEventListener('change', e => {
  state.seamarks = e.target.checked; store.set('seamarks', state.seamarks);
  state.seamarks ? seamarks.addTo(map) : map.removeLayer(seamarks);
});
$('#fadOn').checked = state.fads;
$('#fadOn').addEventListener('change', e => setFads(e.target.checked));
$('#fadHint').innerHTML = FADS.list.length + ' FADs off Broome \u2014 ' + FADS.source +
  ', ' + FADS.vintage + '. They are moored, not fixed: they break free, get pulled and get moved. ' +
  '<a href="' + FADS.check + '" target="_blank" rel="noopener">Check the live listing</a> before you plan a trip around one.';

$('#btnCheckNew').addEventListener('click', async () => {
  $('#btnCheckNew').textContent = 'Checking…';
  const before = state.latest[state.layer];
  const l = await latestDate(state.layer);
  state.latest[state.layer] = l;
  state.dates = buildDates(l);
  $('#dateSlider').max = state.dates.length - 1;
  $('#dateSlider').value = state.dates.length - 1;
  state.date = state.dates[state.dates.length - 1];
  paintDate(); paintFreshness(); buildDataLayer(); refreshBreaks(true);
  $('#btnCheckNew').textContent = 'Check for new imagery';
  toast(l === before ? 'Still ' + dayLabel(l) + ' \u2014 nothing newer yet.' : 'Updated to ' + dayLabel(l), 3200);
});

$('#bathyOn').addEventListener('change', e => e.target.checked ? bathy.addTo(map) : map.removeLayer(bathy));
$('#labelsOn').addEventListener('change', e => e.target.checked ? labels.addTo(map) : map.removeLayer(labels));
$('#gebcoOn').addEventListener('change', e => e.target.checked ? gebco.addTo(map) : map.removeLayer(gebco));

$('#dateSlider').addEventListener('input', e => {
  state.date = state.dates[+e.target.value];
  paintDate();
});
$('#dateSlider').addEventListener('change', () => { buildDataLayer(); refreshBreaks(true); });
$('#btnLatest').addEventListener('click', () => {
  $('#dateSlider').value = state.dates.length - 1;
  state.date = state.dates[state.dates.length - 1];
  paintDate(); buildDataLayer(); refreshBreaks(true);
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
  const titleEl = $('#roTitle');
  const name = (titleEl && !titleEl.hidden && titleEl.textContent)
    ? titleEl.textContent : 'Mark ' + (marks.length + 1);
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
    if (state.mapView === 'wind') paintFieldLegend('wind');
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
  const el = $('#sheet'), btn = $('#sheetToggle'), label = $('#grabLabel');
  let sy = 0, open = false, dragging = false;
  const setOpen = o => {
    open = o;
    el.classList.toggle('open', o);
    document.body.classList.toggle('sheet-open', o);
    btn.setAttribute('aria-expanded', o ? 'true' : 'false');
    btn.setAttribute('aria-label', o ? 'Close panel' : 'Open panel');
    label.textContent = o ? 'Close' : 'Conditions, tide & marks';
  };
  btn.addEventListener('click', () => setOpen(!open));
  // dragging still works, but the chevron is the obvious way in
  btn.addEventListener('touchstart', e => { sy = e.touches[0].clientY; dragging = true; }, { passive: true });
  btn.addEventListener('touchmove', e => {
    if (!dragging) return;
    const dy = e.touches[0].clientY - sy;
    if (Math.abs(dy) > 34) { setOpen(dy < 0); dragging = false; }
  }, { passive: true });
  btn.addEventListener('touchend', () => { dragging = false; });
  setOpen(false);
  return { open: () => setOpen(true), close: () => setOpen(false) };
})();
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.remove('active'));
  $$('.tabpane').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $('#tab-' + t.dataset.tab).classList.add('active');
  if (t.dataset.tab === 'tide' && tideCache) drawTide(tideCache.tl, tideCache.ext);
}));

/* tide day nav + tap/drag-to-read */
const tidePrevBtn = $('#tidePrevDay'), tideNextBtn = $('#tideNextDay'), tideTodayBtn = $('#tideToday');
if (tidePrevBtn) tidePrevBtn.addEventListener('click', () => stepTideDay(-1));
if (tideNextBtn) tideNextBtn.addEventListener('click', () => stepTideDay(1));
if (tideTodayBtn) tideTodayBtn.addEventListener('click', () => { if (state.tideDay !== 0) { state.tideDay = 0; hideTideReadout(); if (state.tideLat != null) loadTide(state.tideLat, state.tideLon); } });
const tideChartEl = $('#tideChart');
if (tideChartEl) {
  let tideDragging = false;
  const start = e => { tideDragging = true; tideReadAt((e.touches ? e.touches[0] : e).clientX); };
  const move = e => { if (!tideDragging) return; tideReadAt((e.touches ? e.touches[0] : e).clientX); if (e.touches) e.preventDefault(); };
  const end = () => { tideDragging = false; };
  tideChartEl.addEventListener('mousedown', start);
  tideChartEl.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  tideChartEl.addEventListener('touchstart', start, { passive: true });
  tideChartEl.addEventListener('touchmove', move, { passive: false });
  tideChartEl.addEventListener('touchend', end);
}

/* map events */
map.on('click', e => showReadout(e.latlng));
map.on('moveend', () => {
  breaksOnMove();
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
  setFads(state.fads);
  if (state.seamarks) seamarks.addTo(map);
  $('#btnBreak').classList.toggle('on', state.breaks);
  await initDates();
  buildDataLayer();
  paintLegend();
  refreshBreaks(false);
  setMapView(state.mapView);
  updateTlTitle();
  paintWindMetricSeg();
  const c = map.getCenter();
  loadConditions(c.lat, c.lng);
  loadTide(c.lat, c.lng);
  startGps();
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch {}
  }
})();

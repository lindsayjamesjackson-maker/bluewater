const APP = 'bw-app-v6';
const TILES = 'bw-tiles-v1';
const SHELL = [
  './', './index.html', './app.js', './styles.css', './manifest.webmanifest',
  './vendor/leaflet.js', './vendor/leaflet.css', './vendor/tide-predictor.js',
  './vendor/images/marker-icon.png', './vendor/images/marker-icon-2x.png', './vendor/images/marker-shadow.png',
  './vendor/images/layers.png', './vendor/images/layers-2x.png',
  './data/au-tide-stations.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== APP && k !== TILES).map(k => caches.delete(k)));
    // v1 cached the imagery date index alongside the tiles, which pinned the date
    // picker to the day the app was first opened. Drop anything that is not a tile.
    try {
      const tiles = await caches.open(TILES);
      const reqs = await tiles.keys();
      await Promise.all(reqs.map(r => {
        const u = new URL(r.url);
        return isTile(u) ? null : tiles.delete(r);
      }));
    } catch {}
    await self.clients.claim();
  })());
});

const TILE_HOSTS = [
  'gibs.earthdata.nasa.gov', 'services.arcgisonline.com',
  'wms.gebco.net', 'tiles.openseamap.org'
];

// Only actual image tiles and the colour scales are safe to serve cache-first.
// Tile URLs carry their date, so they never go stale. The layer's DescribeDomains
// XML - which is how the app learns what the newest imagery is - very much does,
// and caching it froze the date picker on whatever day it was first opened.
const isTile = u => TILE_HOSTS.includes(u.hostname) &&
  (/\.(png|jpe?g|webp)$/i.test(u.pathname) || u.pathname.includes('/colormaps/') || u.search.includes('GetMap'));
const isFresh = u => u.hostname.endsWith('open-meteo.com') ||
  (TILE_HOSTS.includes(u.hostname) && !isTile(u));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // map tiles and colour maps: cache first, then network, then cache again
  if (isTile(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        // never store an opaque response for the imagery host - the app reads those
        // tiles back through a canvas, and an opaque response taints it
        const canvasHost = url.hostname === 'gibs.earthdata.nasa.gov';
        const storable = res && res.ok && (!canvasHost || res.type === 'cors' || res.type === 'basic');
        if (storable) cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch {
        // transparent 1x1 so the map does not show broken tiles offline
        return new Response(
          Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0)),
          { headers: { 'Content-Type': 'image/png', 'X-BW-Placeholder': '1' } });
      }
    })());
    return;
  }

  // anything that changes - forecasts, and the imagery date index - is
  // network first, falling back to the last good copy only when offline
  if (isFresh(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch {
        const hit = await cache.match(req);
        if (hit) return hit;
        throw new Error('offline');
      }
    })());
    return;
  }

  // app shell: cache first, refresh in the background
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(APP);
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      }).catch(() => hit);
      return hit || net;
    })());
  }
});

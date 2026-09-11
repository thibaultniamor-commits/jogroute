/* sw.js — service worker : l'app reste disponible sans réseau.
   · coquille de l'app (HTML/CSS/JS/icônes) : mise en cache à l'installation
   · fonds de carte : mis en cache au fil de la navigation, plafonnés
   · Overpass / Nominatim / Open-Meteo / tuiles d'altitude : jamais interceptés
     (les données utiles sont déjà stockées en IndexedDB par l'application) */
'use strict';

var VERSION = 'jogroute-v3';
var SHELL = VERSION + '-shell';
/* Le cache des fonds de carte est volontairement hors version : une mise à
   jour de l'app ne doit pas effacer les tuiles gardées pour l'hors ligne. */
var TILES = 'jogroute-tiles';
var MAX_TILES = 700;

var ASSETS = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/qrcode/qrcode.js',
  'js/geo.js',
  'js/metrics.js',
  'js/store.js',
  'js/overpass.js',
  'js/elevation.js',
  'js/weather.js',
  'js/share.js',
  'js/graph.js',
  'js/router.js',
  'js/tracker.js',
  'js/app.js',
  'js/worker.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png'
];

/* Hôtes dont les réponses ne doivent jamais être servies depuis le cache HTTP. */
var LIVE_HOSTS = [
  'overpass-api.de', 'overpass.kumi.systems', 'overpass.private.coffee',
  'nominatim.openstreetmap.org', 'api.open-meteo.com',
  's3.amazonaws.com', 'elevation-tiles-prod.s3.amazonaws.com'
];

var TILE_HOSTS = /(^|\.)(tile\.openstreetmap\.org|tile\.opentopomap\.org|tile-cyclosm\.openstreetmap\.fr)$/;

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL).then(function (c) {
      /* addAll échoue en bloc si une seule ressource manque : on tolère les trous. */
      return Promise.all(ASSETS.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function (err) {
          console.warn('[sw] non mis en cache :', u, err.message);
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL && k !== TILES) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function trim(cacheName, max) {
  caches.open(cacheName).then(function (c) {
    c.keys().then(function (keys) {
      if (keys.length <= max) return;
      for (var i = 0; i < keys.length - max; i++) c.delete(keys[i]);
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* Données vivantes : on laisse passer sans toucher au cache. */
  if (LIVE_HOSTS.indexOf(url.hostname) >= 0) return;

  /* Navigation : réseau d'abord, repli sur la version en cache. */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (r) {
        var copy = r.clone();
        caches.open(SHELL).then(function (c) { c.put('index.html', copy); });
        return r;
      }).catch(function () {
        return caches.match('index.html').then(function (r) {
          return r || caches.match('./');
        });
      })
    );
    return;
  }

  /* Fonds de carte : cache d'abord, plafonné. */
  if (TILE_HOSTS.test(url.hostname)) {
    e.respondWith(
      caches.open(TILES).then(function (c) {
        return c.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (r) {
            if (r && (r.ok || r.type === 'opaque')) {
              c.put(req, r.clone());
              trim(TILES, MAX_TILES);
            }
            return r;
          });
        });
      }).catch(function () { return Response.error(); })
    );
    return;
  }

  /* Ressources de l'app : cache d'abord, rafraîchi en arrière-plan. */
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        var net = fetch(req).then(function (r) {
          if (r && r.ok) {
            var copy = r.clone();
            caches.open(SHELL).then(function (c) { c.put(req, copy); });
          }
          return r;
        }).catch(function () { return hit; });
        return hit || net;
      })
    );
  }
});

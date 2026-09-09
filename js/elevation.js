/* elevation.js — relief à partir des tuiles « Terrarium » (AWS Open Data)
   Aucune clé d'API, aucun quota : ce sont des PNG où l'altitude est encodée
   dans les canaux RVB — height = R*256 + G + B/256 - 32768.
   Les tuiles décodées sont mises en cache (IndexedDB) pour l'usage hors ligne. */
(function (global) {
  'use strict';

  var URLS = [
    'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'
  ];
  var SZ = 256;
  var MAX_TILES = 25;

  function lonToX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
  function latToY(lat, z) {
    var s = Math.max(-0.9999, Math.min(0.9999, Math.sin(lat * Math.PI / 180)));
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z);
  }

  /* Zoom choisi pour garder ~20-35 m de résolution sans exploser le nombre de tuiles */
  function zoomFor(radiusM) { return radiusM <= 3200 ? 13 : 12; }

  var canvas = null, ctx = null;
  function decode(bitmap) {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = canvas.height = SZ;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    ctx.clearRect(0, 0, SZ, SZ);
    ctx.drawImage(bitmap, 0, 0, SZ, SZ);
    var px = ctx.getImageData(0, 0, SZ, SZ).data;
    var out = new Float32Array(SZ * SZ);
    for (var i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768;
    }
    return out;
  }

  function loadBitmap(url, signal) {
    return fetch(url, { signal: signal, mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (b) {
      if (global.createImageBitmap) return createImageBitmap(b);
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () { res(img); };
        img.onerror = rej;
        img.src = URL.createObjectURL(b);
      });
    });
  }

  function fetchTile(z, x, y, signal) {
    var i = 0;
    function attempt() {
      var url = URLS[i].replace('{z}', z).replace('{x}', x).replace('{y}', y);
      return loadBitmap(url, signal).catch(function (err) {
        i++;
        if (i < URLS.length) return attempt();
        throw err;
      });
    }
    return attempt().then(decode);
  }

  /* Charge le relief couvrant un disque (lat, lon, radius).
     Renvoie [] si la source est injoignable : l'app continue sans dénivelé. */
  function load(lat, lon, radiusM, onProgress, signal) {
    var z = zoomFor(radiusM);
    var d = radiusM * 1.15;
    var north = Geo.destination(lat, lon, 0, d), south = Geo.destination(lat, lon, 180, d);
    var east = Geo.destination(lat, lon, 90, d), west = Geo.destination(lat, lon, 270, d);

    var x0 = Math.floor(lonToX(west.lon, z)), x1 = Math.floor(lonToX(east.lon, z));
    var y0 = Math.floor(latToY(north.lat, z)), y1 = Math.floor(latToY(south.lat, z));

    var want = [];
    for (var x = x0; x <= x1; x++) {
      for (var y = y0; y <= y1; y++) want.push({ z: z, x: x, y: y });
    }
    if (!want.length || want.length > MAX_TILES) {
      if (want.length > MAX_TILES) console.warn('relief ignoré : ' + want.length + ' tuiles');
      return Promise.resolve([]);
    }

    var done = 0, tiles = [];
    function step() {
      done++;
      onProgress && onProgress(done / want.length);
    }

    return Promise.all(want.map(function (t) {
      return Store.getTile(t.z, t.x, t.y).then(function (hit) {
        if (hit && hit.data && hit.data.length === SZ * SZ) {
          step();
          return { z: t.z, x: t.x, y: t.y, data: hit.data };
        }
        return fetchTile(t.z, t.x, t.y, signal).then(function (data) {
          Store.putTile(t.z, t.x, t.y, data);
          step();
          return { z: t.z, x: t.x, y: t.y, data: data };
        }).catch(function (err) {
          step();
          console.warn('tuile relief ' + t.z + '/' + t.x + '/' + t.y + ' :', err.message || err);
          return null;
        });
      });
    })).then(function (res) {
      tiles = res.filter(Boolean);
      /* Toutes les tuiles doivent partager le même zoom pour l'échantillonnage. */
      return tiles.length >= Math.ceil(want.length * 0.6) ? tiles : [];
    });
  }

  /* Note : les tuiles sont envoyées au worker par copie (pas de transfert) —
     elles restent réutilisables ici pour un second calcul. */
  global.Elevation = { load: load, zoomFor: zoomFor };
})(window);

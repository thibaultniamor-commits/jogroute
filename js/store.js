/* store.js — persistance locale
   IndexedDB : graphes de zone et tuiles d'altitude (volumineux, binaires).
   localStorage : favoris, historique des sorties, préférences.
   Tout est purement local : rien ne quitte l'appareil. */
(function (global) {
  'use strict';

  var DB_NAME = 'jogroute', DB_VERSION = 1;
  var MAX_GRAPHS = 8;                 // zones gardées hors ligne
  var GRAPH_TTL = 45 * 864e5;         // 45 jours : OSM bouge peu
  var MAX_RUNS = 40;

  var dbp = null;

  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('IndexedDB indisponible')); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('graphs')) d.createObjectStore('graphs', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('tiles')) d.createObjectStore('tiles', { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  function tx(storeName, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(storeName, mode);
        var st = t.objectStore(storeName);
        var out = fn(st);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  function all(storeName) {
    return tx(storeName, 'readonly', function (st) { return st.getAll(); })
      .catch(function () { return []; });
  }

  /* ---------------- graphes de zone ---------------- */

  function graphKey(lat, lon, radius) {
    return lat.toFixed(3) + ',' + lon.toFixed(3) + ',' + Math.round(radius / 100);
  }

  /* Cherche une zone déjà téléchargée qui couvre le besoin. */
  function findGraph(lat, lon, needed) {
    return all('graphs').then(function (rows) {
      var now = Date.now(), best = null;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (now - r.t > GRAPH_TTL) continue;
        if (r.radius < needed) continue;
        var d = Geo.haversine(r.lat, r.lon, lat, lon);
        /* le départ doit rester bien à l'intérieur de la zone couverte */
        if (d > Math.max(250, r.radius - needed)) continue;
        if (!best || r.radius < best.radius) best = r;
      }
      return best;
    });
  }

  function putGraph(lat, lon, radius, blob, label) {
    var row = {
      key: graphKey(lat, lon, radius), lat: lat, lon: lon, radius: radius,
      t: Date.now(), label: label || '', blob: blob,
      bytes: (blob.lats.byteLength + blob.lons.byteLength + blob.ea.byteLength +
        blob.eb.byteLength + blob.elen.byteLength + blob.ehw.byteLength +
        blob.eflags.byteLength + blob.ele.byteLength)
    };
    return tx('graphs', 'readwrite', function (st) { st.put(row); })
      .then(evictGraphs)
      .catch(function (e) { console.warn('cache zone :', e); });
  }

  function evictGraphs() {
    return all('graphs').then(function (rows) {
      var now = Date.now();
      var stale = rows.filter(function (r) { return now - r.t > GRAPH_TTL; });
      var fresh = rows.filter(function (r) { return now - r.t <= GRAPH_TTL; })
        .sort(function (a, b) { return b.t - a.t; });
      var kill = stale.concat(fresh.slice(MAX_GRAPHS));
      if (!kill.length) return;
      return tx('graphs', 'readwrite', function (st) {
        kill.forEach(function (r) { st.delete(r.key); });
      });
    });
  }

  function listGraphs() {
    return all('graphs').then(function (rows) {
      return rows.sort(function (a, b) { return b.t - a.t; }).map(function (r) {
        return {
          key: r.key, lat: r.lat, lon: r.lon, radius: r.radius,
          t: r.t, label: r.label, bytes: r.bytes || 0, hasEle: !!(r.blob && r.blob.hasEle)
        };
      });
    });
  }

  function deleteGraph(key) {
    return tx('graphs', 'readwrite', function (st) { st.delete(key); });
  }

  function clearGraphs() {
    return tx('graphs', 'readwrite', function (st) { st.clear(); })
      .then(function () { return tx('tiles', 'readwrite', function (st) { st.clear(); }); });
  }

  /* ---------------- tuiles d'altitude ---------------- */

  function tileKey(z, x, y) { return z + '/' + x + '/' + y; }

  function getTile(z, x, y) {
    return tx('tiles', 'readonly', function (st) { return st.get(tileKey(z, x, y)); })
      .then(function (r) { return r ? r : null; })
      .catch(function () { return null; });
  }

  function putTile(z, x, y, data) {
    return tx('tiles', 'readwrite', function (st) {
      st.put({ key: tileKey(z, x, y), z: z, x: x, y: y, data: data, t: Date.now() });
    }).catch(function () { });
  }

  /* ---------------- localStorage : favoris, historique, préférences ---------------- */

  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem('jogroute.' + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem('jogroute.' + key, JSON.stringify(value)); return true; }
    catch (e) { console.warn('stockage local plein ?', e); return false; }
  }

  function favorites() { return lsGet('favorites', []); }

  function addFavorite(name, lat, lon) {
    var f = favorites();
    f = f.filter(function (x) { return x.name !== name; });
    f.unshift({ name: name, lat: lat, lon: lon, t: Date.now() });
    lsSet('favorites', f.slice(0, 12));
    return f;
  }

  function removeFavorite(name) {
    var f = favorites().filter(function (x) { return x.name !== name; });
    lsSet('favorites', f);
    return f;
  }

  /* ---- historique des sorties : sert à l'anti-répétition ---- */

  function runs() { return lsGet('runs', []); }

  function addRun(cells, km, label) {
    var r = runs();
    r.unshift({ t: Date.now(), cells: cells, km: Math.round(km * 100) / 100, label: label || '' });
    r = r.slice(0, MAX_RUNS);
    /* Si le quota explose, on raccourcit l'historique plutôt que de tout perdre. */
    while (!lsSet('runs', r) && r.length > 1) {
      r = r.slice(0, Math.max(1, r.length - 5));
    }
    return r;
  }

  function clearRuns() { lsSet('runs', []); }

  /* Poids par cellule, décroissant avec l'ancienneté : 1 = couru aujourd'hui,
     0 = plus vieux que `days`. */
  function historyWeights(days) {
    if (!days) return [];
    var now = Date.now(), span = days * 864e5;
    var best = new Map();
    var rs = runs();
    for (var i = 0; i < rs.length; i++) {
      var age = now - rs[i].t;
      if (age > span) continue;
      var w = 1 - age / span;
      var cells = rs[i].cells || [];
      for (var j = 0; j < cells.length; j++) {
        var k = cells[j];
        var cur = best.get(k);
        if (cur === undefined || w > cur) best.set(k, w);
      }
    }
    return Array.from(best.entries());
  }

  /* ---- sortie en cours (suivi en direct) ----
     Recopiée régulièrement pour survivre à un rechargement ; au-delà de
     LIVE_TTL on considère que la sortie a été oubliée, pas interrompue. */

  var LIVE_TTL = 10 * 3600e3;

  function liveSession() {
    var s = lsGet('live', null);
    if (!s || !s.savedAt || Date.now() - s.savedAt > LIVE_TTL) return null;
    return s;
  }
  function saveLive(s) { lsSet('live', s); }
  function clearLive() {
    try { localStorage.removeItem('jogroute.live'); } catch (e) { }
  }

  function settings() { return lsGet('settings', {}); }
  function saveSettings(s) { lsSet('settings', s); }

  /* Place occupée (indicatif) */
  function usage() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
    return navigator.storage.estimate().catch(function () { return null; });
  }

  global.Store = {
    findGraph: findGraph, putGraph: putGraph, listGraphs: listGraphs,
    deleteGraph: deleteGraph, clearGraphs: clearGraphs,
    getTile: getTile, putTile: putTile,
    favorites: favorites, addFavorite: addFavorite, removeFavorite: removeFavorite,
    runs: runs, addRun: addRun, clearRuns: clearRuns, historyWeights: historyWeights,
    liveSession: liveSession, saveLive: saveLive, clearLive: clearLive,
    settings: settings, saveSettings: saveSettings, usage: usage
  };
})(window);

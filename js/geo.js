/* geo.js — utilitaires géométriques (aucune dépendance)
   Chargé aussi bien dans la page que dans le Web Worker : on s'accroche à
   `self`, qui vaut `window` côté page et le global du worker sinon. */
(function (global) {
  'use strict';

  var R_EARTH = 6371008.8; // rayon moyen terrestre (m)
  var toRad = function (d) { return d * Math.PI / 180; };
  var toDeg = function (r) { return r * 180 / Math.PI; };

  /* Distance orthodromique en mètres */
  function haversine(lat1, lon1, lat2, lon2) {
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /* Cap (azimut) de 1 vers 2, en degrés [0,360) */
  function bearing(lat1, lon1, lat2, lon2) {
    var y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    var x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /* Écart angulaire minimal entre deux caps, en degrés [0,180] */
  function angleDiff(a, b) {
    var d = Math.abs((a - b) % 360);
    return d > 180 ? 360 - d : d;
  }

  /* Point atteint depuis (lat,lon) en suivant `brg` sur `dist` mètres */
  function destination(lat, lon, brg, dist) {
    var d = dist / R_EARTH, br = toRad(brg), la = toRad(lat), lo = toRad(lon);
    var la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br));
    var lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la),
      Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return { lat: toDeg(la2), lon: ((toDeg(lo2) + 540) % 360) - 180 };
  }

  /* Ray casting — poly = [{lat,lon}, ...] */
  function pointInPolygon(lat, lon, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var yi = poly[i].lat, xi = poly[i].lon, yj = poly[j].lat, xj = poly[j].lon;
      if (((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-15) + xi)) inside = !inside;
    }
    return inside;
  }

  function fmtDist(m) {
    return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km';
  }

  function fmtDur(sec) {
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    if (m === 60) { h++; m = 0; }
    return h > 0 ? h + ' h ' + String(m).padStart(2, '0') : m + ' min';
  }

  var COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  function compass(deg) { return COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8]; }

  /* ---------- projection plane locale (mètres), suffisante à l'échelle d'une ville ---------- */
  function projector(lat0) {
    var kx = R_EARTH * Math.cos(toRad(lat0)) * Math.PI / 180;
    var ky = R_EARTH * Math.PI / 180;
    return function (lat, lon) { return [lon * kx, lat * ky]; };
  }

  /* ---------- Douglas-Peucker sur une liste [lat, lon] ----------
     Renvoie les INDEX conservés, extrémités incluses. */
  function simplifyIndices(pts, toleranceM) {
    var n = pts.length, q;
    if (n < 3) { var all = []; for (q = 0; q < n; q++) all.push(q); return all; }
    var proj = projector(pts[0][0]);
    var xy = new Array(n);
    for (var i = 0; i < n; i++) xy[i] = proj(pts[i][0], pts[i][1]);

    var keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    var stack = [[0, n - 1]];
    var tol2 = toleranceM * toleranceM;

    while (stack.length) {
      var seg = stack.pop(), a = seg[0], b = seg[1];
      if (b - a < 2) continue;
      var ax = xy[a][0], ay = xy[a][1], bx = xy[b][0], by = xy[b][1];
      var dx = bx - ax, dy = by - ay, dd = dx * dx + dy * dy;
      var best = -1, bestD = -1;
      for (var k = a + 1; k < b; k++) {
        var px = xy[k][0] - ax, py = xy[k][1] - ay, d2;
        if (dd <= 0) {
          d2 = px * px + py * py;
        } else {
          var t = (px * dx + py * dy) / dd;
          t = t < 0 ? 0 : (t > 1 ? 1 : t);
          var ex = px - t * dx, ey = py - t * dy;
          d2 = ex * ex + ey * ey;
        }
        if (d2 > bestD) { bestD = d2; best = k; }
      }
      if (bestD > tol2) {
        keep[best] = 1;
        stack.push([a, best], [best, b]);
      }
    }
    var out = [];
    for (var j = 0; j < n; j++) if (keep[j]) out.push(j);
    return out;
  }

  /* Simplifie jusqu'à ne garder au plus que `maxPts` points (tolérance croissante). */
  function simplifyTo(pts, maxPts) {
    if (pts.length <= maxPts) return pts.slice();
    var tol = 20, idx = null;
    for (var it = 0; it < 40; it++) {
      idx = simplifyIndices(pts, tol);
      if (idx.length <= maxPts) break;
      tol *= 1.6;
    }
    return idx.map(function (i) { return pts[i]; });
  }

  /* ---------- enveloppe convexe (monotone chain) + aire en m² ---------- */
  function hullArea(pts) {
    var n = pts.length, k;
    if (n < 3) return 0;
    var proj = projector(pts[0][0]);
    var p = new Array(n);
    for (var i = 0; i < n; i++) p[i] = proj(pts[i][0], pts[i][1]);
    p.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });

    function cross(o, a, b) {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }
    var lower = [];
    for (k = 0; k < n; k++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[k]) <= 0) lower.pop();
      lower.push(p[k]);
    }
    var upper = [];
    for (k = n - 1; k >= 0; k--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[k]) <= 0) upper.pop();
      upper.push(p[k]);
    }
    var h = lower.slice(0, -1).concat(upper.slice(0, -1));
    if (h.length < 3) return 0;
    var a = 0;
    for (var j = 0, m = h.length; j < m; j++) {
      var qq = h[(j + 1) % m];
      a += h[j][0] * qq[1] - qq[0] * h[j][1];
    }
    return Math.abs(a) / 2;
  }

  /* Compacité isopérimétrique : 1 = cercle parfait, ~0 = aller-retour à plat. */
  function compactness(pts, perimeter) {
    if (!perimeter) return 0;
    var a = hullArea(pts);
    return Math.min(1, 4 * Math.PI * a / (perimeter * perimeter));
  }

  /* ---------- allure ajustée à la pente (Grade Adjusted Pace) ----------
     g = dénivelé / distance (fraction signée). Renvoie un multiplicateur de
     temps : 1 = plat, ~1,46 à 10 % de montée, ~0,83 à 9 % de descente. */
  function gradeFactor(g) {
    if (g > 0) return 1 + 4.6 * Math.min(g, 0.30) + 6 * Math.max(0, g - 0.12);
    var a = -g;
    if (a <= 0.09) return 1 - 1.9 * a;
    return 0.829 + 3.2 * (a - 0.09);
  }

  /* ---------- clé de cellule ~35 m, pour l'historique des sorties ---------- */
  var CELL_SCALE = 3000;
  function cellKey(lat, lon) {
    return Math.round(lat * CELL_SCALE) + ',' + Math.round(lon * CELL_SCALE);
  }

  /* Toutes les cellules traversées par une polyligne, échantillonnée tous les
     `stepM` mètres. Écriture et lecture de l'historique doivent utiliser le
     même échantillonnage, sinon les tronçons longs passent entre les mailles. */
  function cellsAlong(pts, stepM) {
    var step = stepM || 15, out = [], seen = Object.create(null);
    function add(lat, lon) {
      var k = cellKey(lat, lon);
      if (!seen[k]) { seen[k] = 1; out.push(k); }
    }
    if (!pts.length) return out;
    add(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      var d = haversine(a[0], a[1], b[0], b[1]);
      var steps = Math.max(1, Math.ceil(d / step));
      for (var s = 1; s <= steps; s++) {
        var t = s / steps;
        add(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      }
    }
    return out;
  }

  /* ---------- encodage polyline Google (précision 5) ---------- */
  function encodePolyline(pts) {
    var out = '', plat = 0, plon = 0;
    function enc(v) {
      v = v < 0 ? ~(v << 1) : (v << 1);
      var s = '';
      while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      return s + String.fromCharCode(v + 63);
    }
    for (var i = 0; i < pts.length; i++) {
      var la = Math.round(pts[i][0] * 1e5), lo = Math.round(pts[i][1] * 1e5);
      out += enc(la - plat) + enc(lo - plon);
      plat = la; plon = lo;
    }
    return out;
  }

  function decodePolyline(str) {
    var pts = [], i = 0, lat = 0, lon = 0;
    while (i < str.length) {
      var b, shift = 0, result = 0;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lon += (result & 1) ? ~(result >> 1) : (result >> 1);
      pts.push([lat / 1e5, lon / 1e5]);
    }
    return pts;
  }

  global.Geo = {
    haversine: haversine, bearing: bearing, angleDiff: angleDiff,
    destination: destination, pointInPolygon: pointInPolygon,
    fmtDist: fmtDist, fmtDur: fmtDur, compass: compass,
    projector: projector, simplifyIndices: simplifyIndices, simplifyTo: simplifyTo,
    hullArea: hullArea, compactness: compactness, gradeFactor: gradeFactor,
    cellKey: cellKey, cellsAlong: cellsAlong,
    encodePolyline: encodePolyline, decodePolyline: decodePolyline
  };
})(self);

/* geo.js — utilitaires géométriques (aucune dépendance) */
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

  global.Geo = {
    haversine: haversine, bearing: bearing, angleDiff: angleDiff,
    destination: destination, pointInPolygon: pointInPolygon,
    fmtDist: fmtDist, fmtDur: fmtDur, compass: compass
  };
})(window);

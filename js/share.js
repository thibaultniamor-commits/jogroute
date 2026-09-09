/* share.js — partage d'un parcours
   · lien JogRoute (paramètres + tracé encodé) : rouvrable sur n'importe quel appareil
   · lien Google Maps : ouvre l'itinéraire directement dans l'app Maps du téléphone
   · QR code : pour passer du PC au mobile sans rien saisir */
(function (global) {
  'use strict';

  /* Google Maps n'accepte que 9 étapes intermédiaires : on réduit le tracé
     aux points de forme les plus significatifs (Douglas-Peucker). */
  var GMAPS_MAX_WAYPOINTS = 8;

  function f5(v) { return (+v).toFixed(5); }
  function ll(p) { return f5(p[0]) + ',' + f5(p[1]); }

  /* ---------------- lien Google Maps ---------------- */

  /* Un parcours de jogging compte des centaines de points ; Maps en accepte
     une dizaine et recalcule le chemin entre eux. Le résultat est donc une
     approximation fidèle du tracé, pas la trace exacte (le GPX, lui, l'est). */
  function googleMapsUrl(pts, opts) {
    opts = opts || {};
    if (!pts || pts.length < 2) return null;
    var loop = Geo.haversine(pts[0][0], pts[0][1],
      pts[pts.length - 1][0], pts[pts.length - 1][1]) < 40;

    var origin = pts[0];
    var destination = pts[pts.length - 1];
    var middle = pts.slice(1, pts.length - 1);
    var way = Geo.simplifyTo(middle, GMAPS_MAX_WAYPOINTS);

    /* Sur une boucle, Maps a besoin d'étapes bien réparties, sinon il propose
       simplement « rester sur place ». On force un point à mi-parcours. */
    if (loop && way.length < 2 && middle.length) {
      way = [middle[Math.floor(middle.length / 2)]];
    }

    var u = 'https://www.google.com/maps/dir/?api=1' +
      '&origin=' + encodeURIComponent(ll(origin)) +
      '&destination=' + encodeURIComponent(ll(destination)) +
      '&travelmode=walking';
    if (way.length) {
      u += '&waypoints=' + encodeURIComponent(way.map(ll).join('|'));
    }
    if (opts.navigate) u += '&dir_action=navigate';
    return u;
  }

  /* Repli universel : une épingle sur le départ (utile si Maps refuse le
     multi-étapes, ou pour simplement se rendre au point de départ). */
  function googleMapsStartUrl(pt) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' +
      encodeURIComponent(ll(pt)) + '&travelmode=walking';
  }

  function geoUri(pt) { return 'geo:' + f5(pt[0]) + ',' + f5(pt[1]); }

  /* ---------------- lien JogRoute ---------------- */

  function encodeState(st) {
    var q = [];
    function add(k, v) { if (v !== undefined && v !== null && v !== '') q.push(k + '=' + v); }
    add('s', f5(st.lat) + ',' + f5(st.lon));
    if (st.endLat !== undefined && st.endLat !== null) add('e', f5(st.endLat) + ',' + f5(st.endLon));
    add('d', st.dist);
    add('m', st.mode);
    add('p', st.pace);
    add('n', st.nature);
    add('o', st.objective);
    if (st.objective === 'time') add('mn', st.minutes);
    if (st.direction !== null && st.direction !== undefined) add('c', st.direction);
    add('sc', st.sector);
    add('hl', st.hilliness);
    add('dp', st.dplus);
    add('wa', st.water);
    add('fl', st.flags);          // chaîne de drapeaux : g s v l n
    if (st.poly) add('r', st.poly);
    return q.join('&');
  }

  function decodeState(hash) {
    var h = (hash || '').replace(/^#/, '');
    if (!h) return null;
    var out = {}, parts = h.split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (kv.length === 2) out[kv[0]] = decodeURIComponent(kv[1]);
    }
    if (!out.s) return null;
    var s = out.s.split(',');
    var st = {
      lat: +s[0], lon: +s[1],
      dist: out.d !== undefined ? +out.d : undefined,
      mode: out.m, pace: out.p !== undefined ? +out.p : undefined,
      nature: out.n !== undefined ? +out.n : undefined,
      objective: out.o || 'dist',
      minutes: out.mn !== undefined ? +out.mn : undefined,
      direction: out.c !== undefined ? +out.c : null,
      sector: out.sc !== undefined ? +out.sc : undefined,
      hilliness: out.hl !== undefined ? +out.hl : undefined,
      dplus: out.dp !== undefined ? +out.dp : undefined,
      water: out.wa !== undefined ? +out.wa : undefined,
      flags: out.fl || '',
      poly: out.r || null
    };
    if (!isFinite(st.lat) || !isFinite(st.lon)) return null;
    if (out.e) {
      var e = out.e.split(',');
      st.endLat = +e[0]; st.endLon = +e[1];
    }
    return st;
  }

  function appUrl(st) {
    var base = location.origin + location.pathname;
    return base + '#' + encodeState(st);
  }

  /* Le tracé encodé alourdit l'URL : on le simplifie à ~8 m près, ce qui reste
     visuellement fidèle pour un parcours à pied. */
  function encodeRoute(pts) {
    var idx = Geo.simplifyIndices(pts, 8);
    return Geo.encodePolyline(idx.map(function (i) { return pts[i]; }));
  }

  /* ---------------- QR code ---------------- */

  function qrSvg(text, cellSize) {
    if (typeof qrcode !== 'function') return null;
    /* Correction 'L' : plus de capacité, suffisant pour un écran. */
    var qr = qrcode(0, 'L');
    qr.addData(text);
    try { qr.make(); } catch (e) { return null; }
    return qr.createSvgTag({ cellSize: cellSize || 4, margin: 2, scalable: true });
  }

  /* ---------------- partage natif ---------------- */

  function canShare() { return !!(navigator.share); }

  function share(title, text, url) {
    if (navigator.share) return navigator.share({ title: title, text: text, url: url });
    return Promise.reject(new Error('partage natif indisponible'));
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      ok ? resolve() : reject(new Error('copie refusée'));
    });
  }

  global.Share = {
    googleMapsUrl: googleMapsUrl, googleMapsStartUrl: googleMapsStartUrl, geoUri: geoUri,
    encodeState: encodeState, decodeState: decodeState, appUrl: appUrl,
    encodeRoute: encodeRoute, qrSvg: qrSvg,
    canShare: canShare, share: share, copy: copy
  };
})(window);

/* overpass.js — récupération du réseau piéton OSM via l'API Overpass */
(function (global) {
  'use strict';

  var MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];

  /* Types de voies retenues pour la course à pied (les autoroutes/voies rapides
     sont volontairement exclues, ainsi que tout ce qui est interdit d'accès). */
  var HW = 'footway|path|pedestrian|track|steps|cycleway|bridleway|living_street|' +
    'residential|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|' +
    'primary|primary_link|road';

  function netQuery(lat, lon, radius) {
    return '[out:json][timeout:90];' +
      '(way["highway"~"^(' + HW + ')$"]' +
      '["access"!~"^(private|no)$"]' +
      '["foot"!~"^(no|private)$"]' +
      '["area"!="yes"]' +
      '(around:' + Math.round(radius) + ',' + lat + ',' + lon + '););' +
      'out body;>;out skel qt;';
  }

  function greenQuery(lat, lon, radius) {
    var r = Math.round(radius);
    var at = '(around:' + r + ',' + lat + ',' + lon + ');';
    return '[out:json][timeout:60];(' +
      'way["leisure"~"^(park|garden|nature_reserve|recreation_ground|common)$"]' + at +
      'way["landuse"~"^(forest|grass|meadow|village_green|recreation_ground|orchard|vineyard)$"]' + at +
      'way["natural"~"^(wood|scrub|heath|grassland|beach)$"]' + at +
      ');out geom 400;';
  }

  var TIMEOUT = 45000;   // au-delà, on bascule sur un autre miroir

  function post(query, signal) {
    var i = 0;
    function attempt() {
      var url = MIRRORS[i];
      var ctl = new AbortController();
      var to = setTimeout(function () { ctl.abort(); }, TIMEOUT);
      if (signal) signal.addEventListener('abort', function () { ctl.abort(); });
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: ctl.signal
      }).then(function (r) {
        clearTimeout(to);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).catch(function (err) {
        clearTimeout(to);
        if (signal && signal.aborted) throw err;
        i++;
        if (i < MIRRORS.length) return attempt();
        throw new Error('serveurs Overpass saturés ou injoignables (' +
          (err.name === 'AbortError' ? 'délai dépassé' : err.message) + ')');
      });
    }
    return attempt();
  }

  /* Réseau + espaces verts, téléchargés en parallèle */
  function fetchArea(lat, lon, radius, onStatus, signal) {
    onStatus && onStatus('Téléchargement des données OSM (rayon ' +
      (radius / 1000).toFixed(1) + ' km)…');
    var net = post(netQuery(lat, lon, radius), signal);
    var green = post(greenQuery(lat, lon, radius), signal)
      .catch(function () { return { elements: [] }; });
    return Promise.all([net, green]).then(function (r) {
      return { network: r[0].elements || [], green: r[1].elements || [] };
    });
  }

  /* Géocodage simple (Nominatim) */
  function geocode(q) {
    return fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' +
      encodeURIComponent(q), { headers: { 'Accept-Language': 'fr' } })
      .then(function (r) { return r.json(); });
  }

  global.Overpass = { fetchArea: fetchArea, geocode: geocode };
})(window);

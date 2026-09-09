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

  /* Points d'eau et commodités utiles en sortie longue */
  function poiQuery(lat, lon, radius) {
    var r = Math.round(radius);
    var at = '(around:' + r + ',' + lat + ',' + lon + ');';
    return '[out:json][timeout:60];(' +
      'node["amenity"~"^(drinking_water|toilets)$"]' + at +
      'node["man_made"="water_tap"]["drinking_water"!="no"]' + at +
      'node["amenity"="fountain"]["drinking_water"="yes"]' + at +
      ');out body 600;';
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

  /* Réseau, puis espaces verts, puis points d'eau — SÉQUENTIELLEMENT.
     Les serveurs Overpass publics n'accordent que deux créneaux simultanés par
     adresse IP : lancer les trois requêtes en parallèle faisait rejeter les
     deux secondaires, et l'app perdait silencieusement parcs et fontaines.
     Seul le réseau est bloquant ; les autres dégradent, mais le signalent. */
  function fetchArea(lat, lon, radius, onStatus, signal) {
    var notes = [];
    onStatus && onStatus('Téléchargement du réseau OSM (rayon ' +
      (radius / 1000).toFixed(1) + ' km)…');

    return post(netQuery(lat, lon, radius), signal).then(function (net) {
      onStatus && onStatus('Espaces verts (parcs, bois)…');
      return post(greenQuery(lat, lon, radius), signal)
        .catch(function (e) {
          notes.push('espaces verts indisponibles (' + (e.message || e) + ')');
          return { elements: [] };
        })
        .then(function (green) {
          onStatus && onStatus('Points d\'eau et commodités…');
          return post(poiQuery(lat, lon, radius), signal)
            .catch(function (e) {
              notes.push('points d\'eau indisponibles (' + (e.message || e) + ')');
              return { elements: [] };
            })
            .then(function (poi) { return [net, green, poi]; });
        });
    }).then(function (r) {
      var pois = (r[2].elements || []).filter(function (e) {
        return e.type === 'node' && e.lat !== undefined;
      }).map(function (e) {
        var t = e.tags || {};
        return {
          lat: e.lat, lon: e.lon,
          kind: t.amenity === 'toilets' ? 'toilets' : 'water',
          name: t.name || ''
        };
      });
      return {
        network: r[0].elements || [], green: r[1].elements || [],
        pois: pois, notes: notes
      };
    });
  }

  /* Géocodage simple (Nominatim) */
  function geocode(q) {
    return fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' +
      encodeURIComponent(q), { headers: { 'Accept-Language': 'fr' } })
      .then(function (r) { return r.json(); });
  }

  /* Géocodage inverse : nom lisible d'un point (pour nommer les favoris) */
  function reverse(lat, lon) {
    return fetch('https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&lat=' +
      lat + '&lon=' + lon, { headers: { 'Accept-Language': 'fr' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.address) return null;
        var a = j.address;
        return a.road || a.suburb || a.village || a.town || a.city ||
          (j.display_name || '').split(',')[0] || null;
      })
      .catch(function () { return null; });
  }

  global.Overpass = { fetchArea: fetchArea, geocode: geocode, reverse: reverse };
})(window);

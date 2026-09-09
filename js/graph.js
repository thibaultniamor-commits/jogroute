/* graph.js — construction du graphe piéton + pondération "agrément" */
(function (global) {
  'use strict';

  /* Coût de base par type de voie : < 1 = agréable, > 1 = à éviter */
  var HW_COST = {
    path: 0.55, bridleway: 0.58, track: 0.60, footway: 0.70, pedestrian: 0.78,
    cycleway: 0.80, steps: 1.30, living_street: 0.95, residential: 1.05,
    service: 1.12, unclassified: 1.15, road: 1.30,
    tertiary: 1.75, tertiary_link: 1.85, secondary: 2.70, secondary_link: 2.80,
    primary: 4.20, primary_link: 4.40
  };

  var UNPAVED = /^(ground|dirt|earth|mud|grass|gravel|fine_gravel|pebblestone|sand|wood|woodchips|compacted|unpaved|rock|stone)/;
  var PAVED = /^(asphalt|concrete|paving_stones|sett|cobblestone|metal|tartan|paved)/;

  /* Famille de voie, pour les statistiques et les couleurs de la carte */
  function family(hw) {
    if (hw === 'path' || hw === 'track' || hw === 'bridleway') return 'sentier';
    if (hw === 'footway' || hw === 'pedestrian' || hw === 'cycleway' || hw === 'steps') return 'pieton';
    if (hw === 'tertiary' || hw === 'tertiary_link' || hw === 'secondary' ||
      hw === 'secondary_link' || hw === 'primary' || hw === 'primary_link') return 'route';
    return 'calme';
  }

  function bboxOf(geom) {
    var b = { s: 90, n: -90, w: 180, e: -180 };
    for (var i = 0; i < geom.length; i++) {
      var p = geom[i];
      if (p.lat < b.s) b.s = p.lat;
      if (p.lat > b.n) b.n = p.lat;
      if (p.lon < b.w) b.w = p.lon;
      if (p.lon > b.e) b.e = p.lon;
    }
    return b;
  }

  function build(networkEls, greenEls) {
    var idx = new Map();          // id OSM -> index interne
    var lats = [], lons = [], ids = [];
    var i, j;

    for (i = 0; i < networkEls.length; i++) {
      var el = networkEls[i];
      if (el.type !== 'node') continue;
      if (idx.has(el.id)) continue;
      idx.set(el.id, lats.length);
      lats.push(el.lat); lons.push(el.lon); ids.push(el.id);
    }

    /* Polygones de verdure, indexés dans une grille pour un test rapide */
    var CELL = 0.004;                       // ~450 m
    var greens = [], grid = new Map(), big = [];
    for (i = 0; i < greenEls.length; i++) {
      var g = greenEls[i];
      if (!g.geometry || g.geometry.length < 4) continue;
      var poly = { ring: g.geometry, bb: bboxOf(g.geometry) };
      var gi = greens.length;
      greens.push(poly);
      var cy0 = Math.floor(poly.bb.s / CELL), cy1 = Math.floor(poly.bb.n / CELL);
      var cx0 = Math.floor(poly.bb.w / CELL), cx1 = Math.floor(poly.bb.e / CELL);
      if ((cy1 - cy0 + 1) * (cx1 - cx0 + 1) > 900) { big.push(gi); continue; }
      for (var cy = cy0; cy <= cy1; cy++) {
        for (var cx = cx0; cx <= cx1; cx++) {
          var key = cy + ':' + cx, arr = grid.get(key);
          if (!arr) grid.set(key, arr = []);
          arr.push(gi);
        }
      }
    }
    function isGreen(lat, lon) {
      var key = Math.floor(lat / CELL) + ':' + Math.floor(lon / CELL);
      var list = grid.get(key);
      var pools = list ? (big.length ? list.concat(big) : list) : big;
      for (var q = 0; q < pools.length; q++) {
        var G = greens[pools[q]];
        if (lat < G.bb.s || lat > G.bb.n || lon < G.bb.w || lon > G.bb.e) continue;
        if (Geo.pointInPolygon(lat, lon, G.ring)) return true;
      }
      return false;
    }

    var edges = [];
    var adj = new Array(lats.length);
    for (i = 0; i < adj.length; i++) adj[i] = [];

    for (i = 0; i < networkEls.length; i++) {
      var w = networkEls[i];
      if (w.type !== 'way' || !w.nodes || w.nodes.length < 2) continue;
      var t = w.tags || {};
      var hw = t.highway;
      if (!(hw in HW_COST)) continue;
      var surf = (t.surface || '').toLowerCase();
      var sidewalk = t.footway === 'sidewalk';
      var oneFoot = false; // la course ignore les sens uniques (sauf voies rapides, déjà exclues)

      for (j = 0; j < w.nodes.length - 1; j++) {
        var a = idx.get(w.nodes[j]), b = idx.get(w.nodes[j + 1]);
        if (a === undefined || b === undefined || a === b) continue;
        var len = Geo.haversine(lats[a], lons[a], lats[b], lons[b]);
        if (len <= 0) continue;

        var green = isGreen((lats[a] + lats[b]) / 2, (lons[a] + lons[b]) / 2);

        var e = edges.length;
        edges.push({
          a: a, b: b, len: len, hw: hw, fam: family(hw),
          unpaved: UNPAVED.test(surf), paved: PAVED.test(surf),
          sidewalk: sidewalk, green: green, lit: t.lit === 'yes',
          name: t.name || '', mult: 1, cost: len, oneway: oneFoot
        });
        adj[a].push({ to: b, e: e });
        adj[b].push({ to: a, e: e });
      }
    }

    return {
      lats: lats, lons: lons, ids: ids, idx: idx, edges: edges, adj: adj,
      greens: greens.length, n: lats.length
    };
  }

  /* Recalcule le coût de chaque tronçon en fonction des préférences utilisateur.
     opts = { nature: 0..1, avoidSteps: bool, preferGreen: bool } */
  function weight(graph, opts) {
    var k = 2 * (opts.nature === undefined ? 0.6 : opts.nature); // exposant d'accentuation
    var E = graph.edges;
    for (var i = 0; i < E.length; i++) {
      var e = E[i];
      var c = HW_COST[e.hw] || 1.2;
      if (e.hw === 'steps') c = opts.avoidSteps ? 9 : 1.3;
      if (e.unpaved) c *= 0.85;
      else if (e.paved && e.fam === 'sentier') c *= 1.08;
      if (e.sidewalk) c *= 1.18;                       // trottoir le long d'une route
      if (e.green && opts.preferGreen !== false) c *= 0.70;
      if (e.name === '' && e.fam === 'sentier') c *= 0.98;
      e.mult = Math.pow(c, k);
      e.cost = e.len * e.mult;
    }
  }

  /* Nœud du graphe le plus proche d'une position */
  function nearest(graph, lat, lon) {
    var best = -1, bd = Infinity;
    for (var i = 0; i < graph.n; i++) {
      if (graph.adj[i].length === 0) continue;
      var dy = graph.lats[i] - lat, dx = (graph.lons[i] - lon) * Math.cos(lat * Math.PI / 180);
      var d = dy * dy + dx * dx;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  global.RGraph = { build: build, weight: weight, nearest: nearest, family: family };
})(window);

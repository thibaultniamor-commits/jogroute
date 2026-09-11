/* graph.js — construction du graphe piéton, altitude, pondération « agrément »
   Fonctionne dans la page comme dans le Web Worker (`self`). */
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

  /* Ordre stable : sert d'index pour la sérialisation compacte du graphe. */
  var HW_LIST = Object.keys(HW_COST);
  var HW_INDEX = {};
  HW_LIST.forEach(function (h, i) { HW_INDEX[h] = i; });

  var FAM_LIST = ['sentier', 'pieton', 'calme', 'route'];

  var UNPAVED = /^(ground|dirt|earth|mud|grass|gravel|fine_gravel|pebblestone|sand|wood|woodchips|compacted|unpaved|rock|stone)/;
  var PAVED = /^(asphalt|concrete|paving_stones|sett|cobblestone|metal|tartan|paved)/;

  /* Drapeaux binaires par tronçon (sérialisables) */
  var F_UNPAVED = 1, F_PAVED = 2, F_SIDEWALK = 4, F_GREEN = 8, F_LIT = 16, F_NAMED = 32;

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
    var lats = [], lons = [];
    var i, j;

    for (i = 0; i < networkEls.length; i++) {
      var el = networkEls[i];
      if (el.type !== 'node') continue;
      if (idx.has(el.id)) continue;
      idx.set(el.id, lats.length);
      lats.push(el.lat); lons.push(el.lon);
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

    var ea = [], eb = [], elen = [], ehw = [], eflags = [];

    for (i = 0; i < networkEls.length; i++) {
      var w = networkEls[i];
      if (w.type !== 'way' || !w.nodes || w.nodes.length < 2) continue;
      var t = w.tags || {};
      var hw = t.highway;
      if (!(hw in HW_COST)) continue;
      var surf = (t.surface || '').toLowerCase();

      var flagsWay = 0;
      if (UNPAVED.test(surf)) flagsWay |= F_UNPAVED;
      else if (PAVED.test(surf)) flagsWay |= F_PAVED;
      if (t.footway === 'sidewalk') flagsWay |= F_SIDEWALK;
      if (t.lit === 'yes') flagsWay |= F_LIT;
      if (t.name) flagsWay |= F_NAMED;

      for (j = 0; j < w.nodes.length - 1; j++) {
        var a = idx.get(w.nodes[j]), b = idx.get(w.nodes[j + 1]);
        if (a === undefined || b === undefined || a === b) continue;
        var len = Geo.haversine(lats[a], lons[a], lats[b], lons[b]);
        if (len <= 0) continue;

        var fl = flagsWay;
        if (isGreen((lats[a] + lats[b]) / 2, (lons[a] + lons[b]) / 2)) fl |= F_GREEN;

        ea.push(a); eb.push(b); elen.push(len);
        ehw.push(HW_INDEX[hw]); eflags.push(fl);
      }
    }

    return finalize({
      lats: Float64Array.from(lats), lons: Float64Array.from(lons),
      ea: Int32Array.from(ea), eb: Int32Array.from(eb),
      elen: Float32Array.from(elen),
      ehw: Uint8Array.from(ehw), eflags: Uint8Array.from(eflags),
      ele: new Float32Array(lats.length), hasEle: false,
      water: new Uint8Array(lats.length), waterCount: 0,
      greens: greens.length
    });
  }

  /* Complète un graphe « brut » (issu de build ou du cache) : listes
     d'adjacence, tableaux de travail, familles. */
  function finalize(G) {
    var n = G.lats.length, m = G.ea.length, i;
    G.n = n;
    G.m = m;

    G.efam = new Uint8Array(m);
    for (i = 0; i < m; i++) G.efam[i] = FAM_LIST.indexOf(family(HW_LIST[G.ehw[i]]));

    /* Adjacence en CSR : compacte et rapide à parcourir. */
    var deg = new Int32Array(n);
    for (i = 0; i < m; i++) { deg[G.ea[i]]++; deg[G.eb[i]]++; }
    var off = new Int32Array(n + 1);
    for (i = 0; i < n; i++) off[i + 1] = off[i] + deg[i];
    var pos = off.slice(0, n);
    var adjTo = new Int32Array(2 * m), adjEdge = new Int32Array(2 * m);
    for (i = 0; i < m; i++) {
      var a = G.ea[i], b = G.eb[i];
      adjTo[pos[a]] = b; adjEdge[pos[a]] = i; pos[a]++;
      adjTo[pos[b]] = a; adjEdge[pos[b]] = i; pos[b]++;
    }
    G.off = off; G.adjTo = adjTo; G.adjEdge = adjEdge;
    G.deg = deg;

    G.cost = new Float64Array(m);
    G.mult = new Float32Array(m);
    G.etime = new Float32Array(m);   // secondes, rempli par weight()
    G.slope = new Float32Array(m);   // pente absolue (fraction)
    return G;
  }

  /* ---------- altitude : tuiles Terrarium décodées (256×256, mètres) ---------- */
  function tileSampler(tiles) {
    if (!tiles || !tiles.length) return null;
    var byKey = new Map();
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      byKey.set(t.z + '/' + t.x + '/' + t.y, t);
    }
    var z = tiles[0].z, scale = Math.pow(2, z), SZ = 256;

    return function (lat, lon) {
      var s = Math.sin(lat * Math.PI / 180);
      s = Math.max(-0.9999, Math.min(0.9999, s));
      var wx = (lon + 180) / 360 * scale;
      var wy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
      var tx = Math.floor(wx), ty = Math.floor(wy);
      var t = byKey.get(z + '/' + tx + '/' + ty);
      if (!t) return NaN;
      var px = (wx - tx) * SZ, py = (wy - ty) * SZ;
      var x0 = Math.min(SZ - 1, Math.max(0, Math.floor(px)));
      var y0 = Math.min(SZ - 1, Math.max(0, Math.floor(py)));
      var x1 = Math.min(SZ - 1, x0 + 1), y1 = Math.min(SZ - 1, y0 + 1);
      var fx = px - x0, fy = py - y0, d = t.data;
      var v00 = d[y0 * SZ + x0], v10 = d[y0 * SZ + x1];
      var v01 = d[y1 * SZ + x0], v11 = d[y1 * SZ + x1];
      return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
    };
  }

  function attachElevation(G, tiles) {
    var sample = tileSampler(tiles);
    if (!sample) { G.hasEle = false; return false; }
    var ok = 0;
    for (var i = 0; i < G.n; i++) {
      var v = sample(G.lats[i], G.lons[i]);
      if (v === v) { G.ele[i] = v; ok++; } else { G.ele[i] = 0; }
    }
    G.hasEle = ok > G.n * 0.6;
    if (G.hasEle) smoothElevation(G);
    return G.hasEle;
  }

  /* Les tuiles à ~30 m lissent mal les micro-reliefs : un léger filtre sur les
     voisins évite des pentes aberrantes sur les tronçons très courts. */
  function smoothElevation(G) {
    var out = new Float32Array(G.n);
    for (var v = 0; v < G.n; v++) {
      var sum = G.ele[v], cnt = 1;
      for (var k = G.off[v]; k < G.off[v + 1]; k++) { sum += G.ele[G.adjTo[k]]; cnt++; }
      out[v] = sum / cnt;
    }
    G.ele = out;
  }

  /* ---------- points d'eau / toilettes : marquage des nœuds proches ---------- */
  function attachWater(G, pois, radiusM) {
    G.water = new Uint8Array(G.n);
    G.pois = pois || [];
    if (!pois || !pois.length) { G.waterCount = 0; return 0; }
    var R = radiusM || 70;

    /* grille de nœuds ~0,002° (~220 m) */
    var CELL = 0.002, grid = new Map(), i, key;
    for (i = 0; i < G.n; i++) {
      key = Math.floor(G.lats[i] / CELL) + ':' + Math.floor(G.lons[i] / CELL);
      var arr = grid.get(key);
      if (!arr) grid.set(key, arr = []);
      arr.push(i);
    }
    var marked = 0;
    for (var p = 0; p < pois.length; p++) {
      var po = pois[p];
      var cy = Math.floor(po.lat / CELL), cx = Math.floor(po.lon / CELL);
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          var list = grid.get((cy + dy) + ':' + (cx + dx));
          if (!list) continue;
          for (var q = 0; q < list.length; q++) {
            var v = list[q];
            if (G.water[v]) continue;
            if (Geo.haversine(G.lats[v], G.lons[v], po.lat, po.lon) <= R) { G.water[v] = 1; marked++; }
          }
        }
      }
    }
    G.waterCount = marked;
    return marked;
  }

  /* ---------- pondération ----------
     opts = {
       nature: 0..1, avoidSteps, preferGreen, night,
       hilliness: -1 (plat) .. +1 (vallonné),
       paceSecPerKm, history: Set de clés de cellule -> poids 0..1,
       historyStrength: 0..2
     } */
  function weight(G, opts) {
    opts = opts || {};
    var k = 2 * (opts.nature === undefined ? 0.6 : opts.nature);
    var night = !!opts.night;
    var hill = opts.hilliness || 0;
    var paceSecPerM = (opts.paceSecPerKm || 360) / 1000;
    var hist = opts.history || null;
    var hs = opts.historyStrength === undefined ? 1.6 : opts.historyStrength;
    var hasEle = G.hasEle;

    for (var i = 0; i < G.m; i++) {
      var hw = HW_LIST[G.ehw[i]];
      var fam = FAM_LIST[G.efam[i]];
      var fl = G.eflags[i];
      var len = G.elen[i];

      var c = HW_COST[hw] || 1.2;
      if (hw === 'steps') c = opts.avoidSteps ? 9 : 1.3;
      if (fl & F_UNPAVED) c *= 0.85;
      else if ((fl & F_PAVED) && fam === 'sentier') c *= 1.08;
      if (fl & F_SIDEWALK) c *= 1.18;
      if ((fl & F_GREEN) && opts.preferGreen !== false && !night) c *= 0.70;
      if (!(fl & F_NAMED) && fam === 'sentier') c *= 0.98;

      /* Mode nuit : on cherche l'éclairage et on fuit les coins isolés. */
      if (night) {
        if (!(fl & F_LIT)) c *= 2.3;
        if (fl & F_GREEN) c *= 1.45;
        if (fam === 'sentier') c *= 1.35;
      }

      /* Relief */
      var g = 0;
      if (hasEle && len > 0) {
        g = (G.ele[G.eb[i]] - G.ele[G.ea[i]]) / len;
        if (g > 0.45) g = 0.45; else if (g < -0.45) g = -0.45;
      }
      var ag = Math.abs(g);
      G.slope[i] = ag;
      if (hasEle && hill !== 0) {
        if (hill < 0) c *= 1 + (-hill) * Math.min(ag, 0.20) * 6;      // chercher le plat
        else c *= Math.max(0.45, 1 - hill * Math.min(ag, 0.15) * 3);  // chercher le dénivelé
      }

      /* Anti-répétition : pénalise ce qui a déjà été couru récemment.
         On teste les deux extrémités et le milieu — un tronçon de 100 m
         couvre plusieurs cellules de 35 m. */
      if (hist && hist.size) {
        var a = G.ea[i], b = G.eb[i];
        var wgt = hist.get(Geo.cellKey(G.lats[a], G.lons[a])) || 0;
        var w2 = hist.get(Geo.cellKey(G.lats[b], G.lons[b])) || 0;
        if (w2 > wgt) wgt = w2;
        var w3 = hist.get(Geo.cellKey((G.lats[a] + G.lats[b]) / 2,
          (G.lons[a] + G.lons[b]) / 2)) || 0;
        if (w3 > wgt) wgt = w3;
        if (wgt) c *= 1 + hs * wgt;
      }

      G.mult[i] = Math.pow(c, k);
      G.cost[i] = len * G.mult[i];

      /* Temps estimé : moyenne des deux sens (sur une boucle, D+ = D-, donc
         la moyenne donne un total juste) + malus de surface. */
      var tf = hasEle ? (Geo.gradeFactor(g) + Geo.gradeFactor(-g)) / 2 : 1;
      if (fl & F_UNPAVED) tf *= 1.04;
      if (hw === 'steps') tf *= 2.2;
      G.etime[i] = len * paceSecPerM * tf;
    }
  }

  /* ---------- nœud le plus proche d'une position ----------
     Un balayage linéaire, mais sur une distance plane au carré : ni racine, ni
     trigonométrie par nœud. Sur un graphe de 80 000 nœuds cela coûte moins
     d'une milliseconde, deux fois par génération — indexer les nœuds dans une
     grille a été essayé et s'est révélé trois fois plus lent, le coût d'une
     vraie distance par candidat dépassant ce que l'indexation fait économiser.

     Renvoie { node, dist } : `dist` est la distance réelle en mètres, calculée
     une seule fois sur le vainqueur, pour que l'appelant puisse avertir quand
     le départ posé a été ramené à quatre cents mètres de là. `node` vaut -1 si
     le graphe n'a aucun nœud relié. */
  function nearest(G, lat, lon) {
    var best = -1, bd = Infinity;
    var kx = Math.cos(lat * Math.PI / 180);
    for (var i = 0; i < G.n; i++) {
      if (G.off[i] === G.off[i + 1]) continue;     // nœud isolé : inatteignable
      var dy = G.lats[i] - lat, dx = (G.lons[i] - lon) * kx;
      var d = dy * dy + dx * dx;
      if (d < bd) { bd = d; best = i; }
    }
    return {
      node: best,
      dist: best < 0 ? Infinity : Geo.haversine(G.lats[best], G.lons[best], lat, lon)
    };
  }

  /* ---------- sérialisation compacte (IndexedDB / postMessage) ---------- */
  function serialize(G) {
    return {
      v: 2,
      lats: G.lats, lons: G.lons, ea: G.ea, eb: G.eb, elen: G.elen,
      ehw: G.ehw, eflags: G.eflags, ele: G.ele, hasEle: G.hasEle,
      greens: G.greens, pois: G.pois || []
    };
  }

  function deserialize(blob) {
    var G = finalize({
      lats: blob.lats, lons: blob.lons, ea: blob.ea, eb: blob.eb,
      elen: blob.elen, ehw: blob.ehw, eflags: blob.eflags,
      ele: blob.ele, hasEle: blob.hasEle, greens: blob.greens,
      water: new Uint8Array(blob.lats.length), waterCount: 0
    });
    attachWater(G, blob.pois || []);
    return G;
  }

  /* Les tampons à transférer sans copie via postMessage. */
  function buffersOf(blob) {
    return [blob.lats.buffer, blob.lons.buffer, blob.ea.buffer, blob.eb.buffer,
      blob.elen.buffer, blob.ehw.buffer, blob.eflags.buffer, blob.ele.buffer];
  }

  global.RGraph = {
    build: build, weight: weight, nearest: nearest, family: family,
    finalize: finalize, attachElevation: attachElevation, attachWater: attachWater,
    serialize: serialize, deserialize: deserialize, buffersOf: buffersOf,
    HW_LIST: HW_LIST, FAM_LIST: FAM_LIST,
    F_UNPAVED: F_UNPAVED, F_PAVED: F_PAVED, F_SIDEWALK: F_SIDEWALK,
    F_GREEN: F_GREEN, F_LIT: F_LIT, F_NAMED: F_NAMED
  };
})(self);

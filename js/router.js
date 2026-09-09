/* router.js — moteur de calcul d'itinéraires de jogging
   Dijkstra pondéré par « l'agrément » du terrain, puis recherche d'une boucle
   (aller vers un point de demi-tour + retour pénalisant les tronçons déjà
   empruntés). Plusieurs candidats sont testés et notés.
   Fonctionne dans la page comme dans le Web Worker (`self`). */
(function (global) {
  'use strict';

  var FAM_LIST = ['sentier', 'pieton', 'calme', 'route'];

  /* ---------- tas binaire minimal ---------- */
  function Heap() { this.k = []; this.v = []; }
  Heap.prototype.push = function (key, val) {
    var k = this.k, v = this.v, i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      var tk = k[p]; k[p] = k[i]; k[i] = tk;
      var tv = v[p]; v[p] = v[i]; v[i] = tv;
      i = p;
    }
  };
  Heap.prototype.pop = function () {
    var k = this.k, v = this.v, top = v[0], n = k.length - 1;
    k[0] = k[n]; v[0] = v[n]; k.pop(); v.pop();
    var i = 0;
    while (true) {
      var l = 2 * i + 1, r = l + 1, m = i;
      if (l < n && k[l] < k[m]) m = l;
      if (r < n && k[r] < k[m]) m = r;
      if (m === i) break;
      var tk = k[m]; k[m] = k[i]; k[i] = tk;
      var tv = v[m]; v[m] = v[i]; v[i] = tv;
      i = m;
    }
    return top;
  };
  Object.defineProperty(Heap.prototype, 'size', {
    get: function () { return this.k.length; }
  });

  /* ---------- Dijkstra borné ----------
     opts : { maxLen, penal (Float32Array par arête), stopAt } */
  function dijkstra(G, src, opts) {
    opts = opts || {};
    var n = G.n;
    var maxLen = opts.maxLen === undefined ? Infinity : opts.maxLen;
    var penal = opts.penal || null, stopAt = opts.stopAt;

    var cost = new Float64Array(n).fill(Infinity);
    var len = new Float64Array(n).fill(Infinity);
    var pv = new Int32Array(n).fill(-1);
    var pe = new Int32Array(n).fill(-1);
    var done = new Uint8Array(n);
    var seen = [];

    cost[src] = 0; len[src] = 0;
    var h = new Heap();
    h.push(0, src);

    while (h.size) {
      var u = h.pop();
      if (done[u]) continue;
      done[u] = 1; seen.push(u);
      if (u === stopAt) break;
      var lu = len[u];
      if (lu > maxLen) continue;
      for (var k = G.off[u]; k < G.off[u + 1]; k++) {
        var v = G.adjTo[k], e = G.adjEdge[k];
        if (done[v]) continue;
        var nl = lu + G.elen[e];
        if (nl > maxLen) continue;
        var c = cost[u] + G.cost[e] * (penal ? penal[e] : 1);
        if (c < cost[v]) {
          cost[v] = c; len[v] = nl; pv[v] = u; pe[v] = e;
          h.push(c, v);
        }
      }
    }
    return { cost: cost, len: len, pv: pv, pe: pe, done: done, seen: seen };
  }

  function rebuild(res, from, to) {
    var nodes = [to], edges = [], cur = to, guard = 0;
    while (cur !== from) {
      var e = res.pe[cur], p = res.pv[cur];
      if (p < 0 || guard++ > 400000) return null;
      edges.push(e); nodes.push(p); cur = p;
    }
    nodes.reverse(); edges.reverse();
    return { nodes: nodes, edges: edges };
  }

  /* ---------- statistiques d'un parcours ---------- */
  function stats(G, nodes, edges) {
    var s = {
      total: 0, fam: { sentier: 0, pieton: 0, calme: 0, route: 0 },
      unpaved: 0, green: 0, steps: 0, lit: 0, natural: 0, weighted: 0,
      climb: 0, descent: 0, time: 0, maxDryGap: 0, waterStops: 0,
      eleMin: Infinity, eleMax: -Infinity
    };
    var F = RGraph;
    var seen = new Map();
    var i, e;

    for (i = 0; i < edges.length; i++) {
      e = edges[i];
      var len = G.elen[e], fl = G.eflags[e];
      s.total += len;
      s.fam[FAM_LIST[G.efam[e]]] += len;
      if (fl & F.F_UNPAVED) s.unpaved += len;
      if (fl & F.F_GREEN) s.green += len;
      if (fl & F.F_LIT) s.lit += len;
      if (RGraph.HW_LIST[G.ehw[e]] === 'steps') s.steps += len;
      if (G.efam[e] === 0 || (fl & F.F_GREEN) || (fl & F.F_UNPAVED)) s.natural += len;
      s.weighted += G.cost[e];
      s.time += G.etime[e];
      seen.set(e, (seen.get(e) || 0) + 1);
    }

    s.overlap = 0;
    seen.forEach(function (c, id) {
      if (c > 1) s.overlap += G.elen[id] * (c - 1);
    });
    s.avgMult = s.total ? s.weighted / s.total : 1;

    /* Relief le long de la trace + plus longue portion sans point d'eau.
       Le D+ passe par un filtre à hystérésis (seuil THRESH) : sans lui, le
       bruit des tuiles d'altitude gonflerait le dénivelé de plusieurs
       centaines de mètres sur un parcours pourtant plat. */
    var THRESH = 2.5;
    var dry = 0, ref = nodes.length ? G.ele[nodes[0]] : 0;
    for (i = 0; i < nodes.length; i++) {
      var v = nodes[i];
      if (G.hasEle) {
        var z = G.ele[v];
        if (z < s.eleMin) s.eleMin = z;
        if (z > s.eleMax) s.eleMax = z;
        if (z - ref > THRESH) { s.climb += z - ref; ref = z; }
        else if (ref - z > THRESH) { s.descent += ref - z; ref = z; }
      }
      if (i > 0) dry += G.elen[edges[i - 1]];
      if (G.water[v]) { s.waterStops++; if (dry > s.maxDryGap) s.maxDryGap = dry; dry = 0; }
    }
    if (dry > s.maxDryGap) s.maxDryGap = dry;
    if (!G.hasEle) { s.eleMin = 0; s.eleMax = 0; }

    s.climb = Math.round(s.climb);
    s.descent = Math.round(s.descent);
    return s;
  }

  function sleep() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* ---------- assemblage du résultat renvoyé à la page ---------- */
  function pack(G, nodes, edges, extra) {
    var n = nodes.length;
    var coords = new Float64Array(2 * n);
    var ele = new Float32Array(n);
    var cum = new Float32Array(n);
    var fams = new Uint8Array(edges.length);
    var acc = 0, i;
    for (i = 0; i < n; i++) {
      coords[2 * i] = G.lats[nodes[i]];
      coords[2 * i + 1] = G.lons[nodes[i]];
      ele[i] = G.ele[nodes[i]];
      if (i > 0) acc += G.elen[edges[i - 1]];
      cum[i] = acc;
    }
    for (i = 0; i < edges.length; i++) fams[i] = G.efam[edges[i]];

    var out = {
      coords: coords, ele: ele, cum: cum, fams: fams,
      hasEle: G.hasEle, water: []
    };
    for (i = 0; i < n; i++) {
      if (G.water[nodes[i]]) out.water.push([G.lats[nodes[i]], G.lons[nodes[i]], cum[i]]);
    }
    for (var k in extra) out[k] = extra[k];
    return out;
  }

  function transferOf(r) {
    return [r.coords.buffer, r.ele.buffer, r.cum.buffer, r.fams.buffer];
  }

  /* ---------- notation ---------- */
  function score(G, st, ctx, p) {
    var err;
    if (p.objective === 'time' && p.targetTime > 0) {
      err = Math.abs(st.time - p.targetTime) / p.targetTime;
    } else {
      err = Math.abs(st.total - p.target) / p.target;
    }
    var ovFrac = st.total ? st.overlap / st.total : 0;
    var dirPen = p.direction === null || p.direction === undefined
      ? 0 : 0.4 * Geo.angleDiff(ctx.brg, p.direction) / 180;

    var loopPen = 0;
    if (p.mode === 'loop' && p.loopShape) {
      loopPen = p.loopShape * (1 - ctx.compact);
    }
    var dplusPen = 0;
    if (G.hasEle && p.dplus > 0) {
      dplusPen = 1.2 * Math.abs(st.climb - p.dplus) / Math.max(p.dplus, 120);
    }
    var waterPen = 0;
    if (p.waterEvery > 0 && st.maxDryGap > p.waterEvery) {
      waterPen = 0.9 * Math.min(2, (st.maxDryGap - p.waterEvery) / p.waterEvery);
    }
    return {
      err: err, ovFrac: ovFrac,
      value: st.avgMult + 6 * err + 1.4 * ovFrac + dirPen + loopPen + dplusPen + waterPen
    };
  }

  function coordsOf(G, nodes) {
    var pts = new Array(nodes.length);
    for (var i = 0; i < nodes.length; i++) pts[i] = [G.lats[nodes[i]], G.lons[nodes[i]]];
    return pts;
  }

  /* ---------- planification ----------
     p = { src, dst, target (m), objective:'dist'|'time', targetTime (s),
           direction (deg|null), sector (deg), mode:'loop'|'outback'|'p2p',
           overlap, tolerance, variants, loopShape, dplus, waterEvery } */
  async function plan(G, p, onProgress) {
    var target = p.target;
    var mode = p.mode || 'loop';
    var src = p.src;
    var results = [];
    var penal = new Float32Array(G.m).fill(1);
    var i, cands, out, outB;

    onProgress && onProgress(0.08, 'Exploration du réseau…');

    if (mode === 'p2p') {
      if (p.dst === undefined || p.dst < 0 || p.dst === src) {
        return { routes: [], reason: 'nodst' };
      }
      out = dijkstra(G, src, { maxLen: target * 0.9 });
      outB = dijkstra(G, p.dst, { maxLen: target * 0.9 });
      if (!isFinite(outB.len[src]) && !isFinite(out.len[p.dst])) {
        return { routes: [], reason: 'unreachable' };
      }
      var midLat = (G.lats[src] + G.lats[p.dst]) / 2;
      var midLon = (G.lons[src] + G.lons[p.dst]) / 2;
      var bucketsP = new Map();
      var loP = target * 0.82, hiP = target * 1.18;
      for (i = 0; i < out.seen.length; i++) {
        var vv = out.seen[i];
        if (!isFinite(outB.len[vv])) continue;
        var L = out.len[vv] + outB.len[vv];
        if (L < loP || L > hiP) continue;
        var brgP = Geo.bearing(midLat, midLon, G.lats[vv], G.lons[vv]);
        if (p.direction !== null && p.direction !== undefined &&
          Geo.angleDiff(brgP, p.direction) > p.sector / 2) continue;
        var qP = (out.cost[vv] + outB.cost[vv]) / L;
        var keyP = Math.round(brgP / 20);
        var curP = bucketsP.get(keyP);
        if (!curP || qP < curP.q) bucketsP.set(keyP, { v: vv, q: qP, brg: brgP, len: L });
      }
      cands = Array.from(bucketsP.values()).sort(function (a, b) { return a.q - b.q; }).slice(0, 18);
    } else {
      out = dijkstra(G, src, { maxLen: target * 0.62 });

      var loFrac = mode === 'outback' ? 0.46 : 0.34;
      var hiFrac = mode === 'outback' ? 0.54 : 0.55;
      var lo = target * loFrac, hi = target * hiFrac;

      /* Points de demi-tour candidats, diversifiés par secteur angulaire */
      var buckets = new Map();
      var bucketSize = (p.direction === null || p.direction === undefined)
        ? 24 : Math.max(6, p.sector / 6);
      for (i = 0; i < out.seen.length; i++) {
        var v = out.seen[i];
        var Lv = out.len[v];
        if (Lv < lo || Lv > hi) continue;
        var brg = Geo.bearing(G.lats[src], G.lons[src], G.lats[v], G.lons[v]);
        if (p.direction !== null && p.direction !== undefined &&
          Geo.angleDiff(brg, p.direction) > p.sector / 2) continue;
        var q = out.cost[v] / Lv;                 // agrément moyen de l'aller
        var key = Math.round(brg / bucketSize);
        var cur = buckets.get(key);
        if (!cur || q < cur.q) buckets.set(key, { v: v, q: q, brg: brg, len: Lv });
      }
      cands = Array.from(buckets.values()).sort(function (a, b) { return a.q - b.q; });
      cands = cands.slice(0, mode === 'outback' ? 14 : 24);
    }

    if (!cands.length) return { routes: [], reason: 'nocand' };

    for (var ci = 0; ci < cands.length; ci++) {
      var c = cands[ci];
      var A = rebuild(out, src, c.v);
      if (!A) continue;
      var nodes, edges, j;

      if (mode === 'outback') {
        nodes = A.nodes.concat(A.nodes.slice(0, -1).reverse());
        edges = A.edges.concat(A.edges.slice().reverse());
      } else {
        var goal = mode === 'p2p' ? p.dst : src;
        for (j = 0; j < A.edges.length; j++) penal[A.edges[j]] = p.overlap;
        var back = dijkstra(G, c.v, {
          maxLen: Math.max(target * 0.3, target * 1.5 - out.len[c.v]),
          penal: penal, stopAt: goal
        });
        for (j = 0; j < A.edges.length; j++) penal[A.edges[j]] = 1;
        if (!isFinite(back.cost[goal])) continue;
        var B = rebuild(back, c.v, goal);
        if (!B) continue;
        nodes = A.nodes.concat(B.nodes.slice(1));
        edges = A.edges.concat(B.edges);
      }

      var st = stats(G, nodes, edges);
      if (!st.total) continue;
      var pts = coordsOf(G, nodes);
      var compact = mode === 'loop' ? Geo.compactness(pts, st.total) : 0;
      var sc = score(G, st, { brg: c.brg, compact: compact }, p);

      results.push({
        nodes: nodes, edges: edges, stats: st, err: sc.err, score: sc.value,
        turn: c.v, brg: c.brg, overlapFrac: sc.ovFrac, compact: compact
      });

      if (ci % 3 === 2) {
        onProgress && onProgress(0.1 + 0.85 * (ci / cands.length),
          'Évaluation des tracés… (' + (ci + 1) + '/' + cands.length + ')');
        await sleep();
      }
    }

    var tol = p.tolerance === undefined ? 0.14 : p.tolerance;
    var inTol = results.filter(function (r) { return r.err <= tol; });
    var pool = inTol.length ? inTol : results;
    pool.sort(function (a, b) { return a.score - b.score; });

    /* Diversité : pas deux propositions au même cap et à la même distance */
    var picked = [];
    var minAngle = (p.direction === null || p.direction === undefined) ? 35 : 18;
    for (var k = 0; k < pool.length && picked.length < (p.variants || 5); k++) {
      var r = pool[k], ok = true;
      for (var m = 0; m < picked.length; m++) {
        if (Geo.angleDiff(picked[m].brg, r.brg) < minAngle &&
          Math.abs(picked[m].stats.total - r.stats.total) < target * 0.06) { ok = false; break; }
      }
      if (ok) picked.push(r);
    }

    onProgress && onProgress(1, 'Terminé');
    return {
      routes: picked.map(function (r) {
        return pack(G, r.nodes, r.edges, {
          stats: r.stats, err: r.err, score: r.score, brg: r.brg,
          overlapFrac: r.overlapFrac, compact: r.compact,
          turn: [G.lats[r.turn], G.lons[r.turn]]
        });
      }),
      all: pool.length, relaxed: !inTol.length
    };
  }

  global.Router = {
    plan: plan, dijkstra: dijkstra, stats: stats, pack: pack, transferOf: transferOf
  };
})(self);

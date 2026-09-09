/* router.js — moteur de calcul d'itinéraires de jogging
   Principe : Dijkstra pondéré par "l'agrément" du terrain, puis recherche
   d'une boucle = aller vers un point de demi-tour + retour pénalisant les
   tronçons déjà empruntés. Plusieurs candidats sont testés et notés. */
(function (global) {
  'use strict';

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
  function dijkstra(graph, src, opts) {
    opts = opts || {};
    var n = graph.n, E = graph.edges, adj = graph.adj;
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
      var a = adj[u];
      for (var i = 0; i < a.length; i++) {
        var link = a[i], e = E[link.e], v = link.to;
        if (done[v]) continue;
        var nl = lu + e.len;
        if (nl > maxLen) continue;
        var c = cost[u] + e.cost * (penal ? penal[link.e] : 1);
        if (c < cost[v]) {
          cost[v] = c; len[v] = nl; pv[v] = u; pe[v] = link.e;
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
      if (p < 0 || guard++ > 200000) return null;
      edges.push(e); nodes.push(p); cur = p;
    }
    nodes.reverse(); edges.reverse();
    return { nodes: nodes, edges: edges };
  }

  /* ---------- statistiques d'un parcours ---------- */
  function stats(graph, edges) {
    var E = graph.edges;
    var s = {
      total: 0, fam: { sentier: 0, pieton: 0, calme: 0, route: 0 },
      unpaved: 0, green: 0, steps: 0, natural: 0, weighted: 0
    };
    var seen = new Map();
    for (var i = 0; i < edges.length; i++) {
      var e = E[edges[i]];
      s.total += e.len;
      s.fam[e.fam] += e.len;
      if (e.unpaved) s.unpaved += e.len;
      if (e.green) s.green += e.len;
      if (e.hw === 'steps') s.steps += e.len;
      if (e.fam === 'sentier' || e.green || e.unpaved) s.natural += e.len;
      s.weighted += e.cost;
      seen.set(edges[i], (seen.get(edges[i]) || 0) + 1);
    }
    s.overlap = 0;
    seen.forEach(function (c, id) {
      if (c > 1) s.overlap += E[id].len * (c - 1);
    });
    s.avgMult = s.total ? s.weighted / s.total : 1;
    return s;
  }

  function sleep() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* ---------- planification ----------
     p = { target (m), direction (deg|null), sector (deg), mode:'loop'|'outback',
           overlap, tolerance, variants } */
  async function plan(graph, start, p, onProgress) {
    var target = p.target;
    var mode = p.mode || 'loop';
    onProgress && onProgress(0.1, 'Exploration du réseau…');
    var out = dijkstra(graph, start, { maxLen: target * 0.62 });

    var loFrac = mode === 'outback' ? 0.46 : 0.34;
    var hiFrac = mode === 'outback' ? 0.54 : 0.55;
    var lo = target * loFrac, hi = target * hiFrac;

    /* Points de demi-tour candidats, diversifiés par secteur angulaire */
    var buckets = new Map();
    var bucketSize = p.direction === null ? 24 : Math.max(6, p.sector / 6);
    for (var si = 0; si < out.seen.length; si++) {
      var v = out.seen[si];
      var L = out.len[v];
      if (L < lo || L > hi) continue;
      var brg = Geo.bearing(graph.lats[start], graph.lons[start],
        graph.lats[v], graph.lons[v]);
      if (p.direction !== null && Geo.angleDiff(brg, p.direction) > p.sector / 2) continue;
      var q = out.cost[v] / L;                 // agrément moyen de l'aller
      var key = Math.round(brg / bucketSize);
      var cur = buckets.get(key);
      if (!cur || q < cur.q) buckets.set(key, { v: v, q: q, brg: brg, len: L });
    }
    var cands = Array.from(buckets.values()).sort(function (a, b) { return a.q - b.q; });
    if (!cands.length) return { routes: [], reason: 'nocand' };
    cands = cands.slice(0, mode === 'outback' ? 14 : 22);

    var results = [];
    var penal = new Float32Array(graph.edges.length).fill(1);

    for (var ci = 0; ci < cands.length; ci++) {
      var c = cands[ci];
      var A = rebuild(out, start, c.v);
      if (!A) continue;
      var i, nodes, edges;

      if (mode === 'outback') {
        nodes = A.nodes.concat(A.nodes.slice(0, -1).reverse());
        edges = A.edges.concat(A.edges.slice().reverse());
      } else {
        for (i = 0; i < A.edges.length; i++) penal[A.edges[i]] = p.overlap;
        var back = dijkstra(graph, c.v, {
          maxLen: Math.max(target * 0.3, target * 1.4 - out.len[c.v]),
          penal: penal, stopAt: start
        });
        for (i = 0; i < A.edges.length; i++) penal[A.edges[i]] = 1;
        if (!isFinite(back.cost[start])) continue;
        var B = rebuild(back, c.v, start);
        if (!B) continue;
        nodes = A.nodes.concat(B.nodes.slice(1));
        edges = A.edges.concat(B.edges);
      }

      var st = stats(graph, edges);
      var err = Math.abs(st.total - target) / target;
      var ovFrac = st.overlap / st.total;
      var dirPen = p.direction === null ? 0 : 0.4 * Geo.angleDiff(c.brg, p.direction) / 180;
      var score = st.avgMult + 6 * err + 1.4 * ovFrac + dirPen;
      results.push({
        nodes: nodes, edges: edges, stats: st, err: err, score: score,
        turn: c.v, brg: c.brg, overlapFrac: ovFrac
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
    for (var k = 0; k < pool.length && picked.length < (p.variants || 4); k++) {
      var r = pool[k], ok = true;
      for (var m = 0; m < picked.length; m++) {
        if (Geo.angleDiff(picked[m].brg, r.brg) < (p.direction === null ? 35 : 18) &&
          Math.abs(picked[m].stats.total - r.stats.total) < target * 0.06) { ok = false; break; }
      }
      if (ok) picked.push(r);
    }
    onProgress && onProgress(1, 'Terminé');
    return { routes: picked, all: pool.length, relaxed: !inTol.length };
  }

  global.Router = { plan: plan, dijkstra: dijkstra, stats: stats };
})(window);

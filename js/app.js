/* app.js — interface : carte OpenStreetMap, paramètres, rendu des parcours */
(function () {
  'use strict';

  var COLORS = { sentier: '#46d17a', pieton: '#4ea8ff', calme: '#f0c419', route: '#ff6b5e' };

  var state = {
    start: null,          // {lat, lon}
    marker: null,
    cache: null,          // {lat, lon, radius, graph}
    routes: [],
    current: 0,
    busy: false
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- carte ---------------- */
  var map = L.map('map', { zoomControl: true, minZoom: 3 }).setView([48.8566, 2.3522], 14);

  var base = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://osm.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  var topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, subdomains: 'abc',
    attribution: '&copy; OpenStreetMap · SRTM · <a href="https://opentopomap.org">OpenTopoMap</a>'
  });
  var cyclo = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap · CyclOSM'
  });
  L.control.layers({ 'Plan OSM': base, 'Relief (OpenTopoMap)': topo, 'CyclOSM': cyclo },
    null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  var routeLayer = L.layerGroup().addTo(map);
  var markerLayer = L.layerGroup().addTo(map);

  function startIcon() {
    return L.divIcon({
      className: '', iconSize: [18, 18], iconAnchor: [9, 9],
      html: '<div class="pin" style="color:#46d17a;background:#46d17a"></div>'
    });
  }
  function turnIcon() {
    return L.divIcon({
      className: '', iconSize: [14, 14], iconAnchor: [7, 7],
      html: '<div class="pin" style="color:#4ea8ff;background:#4ea8ff;width:12px;height:12px"></div>'
    });
  }

  function setStart(lat, lon, fly) {
    state.start = { lat: lat, lon: lon };
    if (!state.marker) {
      state.marker = L.marker([lat, lon], { icon: startIcon(), draggable: true, zIndexOffset: 1000 })
        .addTo(markerLayer).bindTooltip('Départ', { direction: 'top', offset: [0, -8] });
      state.marker.on('dragend', function (e) {
        var p = e.target.getLatLng();
        state.start = { lat: p.lat, lon: p.lng };
        updateStartInfo();
      });
    } else {
      state.marker.setLatLng([lat, lon]);
    }
    if (fly) map.setView([lat, lon], Math.max(map.getZoom(), 14));
    updateStartInfo();
  }

  function updateStartInfo() {
    $('startInfo').innerHTML = state.start
      ? 'Départ : <b>' + state.start.lat.toFixed(5) + ', ' + state.start.lon.toFixed(5) + '</b>'
      : 'Cliquez sur la carte pour poser le départ (ou déplacez le marqueur).';
  }

  map.on('click', function (e) { setStart(e.latlng.lat, e.latlng.lng, false); });

  /* ---------------- contrôles ---------------- */
  var direction = null;

  function paceText(v) {
    var m = Math.floor(v), s = Math.round((v - m) * 60);
    return m + ':' + String(s).padStart(2, '0') + ' /km';
  }

  function syncLabels() {
    $('distOut').textContent = (+$('dist').value).toFixed(1).replace('.', ',') + ' km';
    $('paceOut').textContent = paceText(+$('pace').value);
    $('sectorOut').textContent = $('sector').value + '°';
    $('natOut').textContent = $('nature').value + ' %';
    $('sectorWrap').style.opacity = direction === null ? .4 : 1;
    $('sector').disabled = direction === null;
  }
  ['dist', 'pace', 'sector', 'nature'].forEach(function (id) {
    $(id).addEventListener('input', syncLabels);
  });

  $('compass').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) { x.classList.remove('on'); });
    b.classList.add('on');
    direction = b.dataset.dir === '' ? null : +b.dataset.dir;
    syncLabels();
  });

  /* ---------------- statut ---------------- */
  var timer = null, t0 = 0, lastMsg = '';

  function startTimer() {
    t0 = Date.now();
    clearInterval(timer);
    timer = setInterval(function () {
      var el = $('status');
      if (!el.classList.contains('on')) return;
      var s = Math.round((Date.now() - t0) / 1000);
      el.querySelector('.msg').textContent = lastMsg + '  (' + s + ' s)';
    }, 1000);
  }
  function stopTimer() { clearInterval(timer); timer = null; }

  function status(msg, frac, err) {
    var el = $('status');
    el.className = 'on' + (err ? ' err' : '');
    lastMsg = msg;
    el.querySelector('.msg').textContent = msg;
    el.querySelector('.bar i').style.width = Math.round((frac || 0) * 100) + '%';
    el.scrollIntoView({ block: 'nearest' });
  }
  function statusOff() { $('status').className = ''; stopTimer(); }

  /* ---------------- géocodage / géoloc ---------------- */
  $('btnSearch').addEventListener('click', doSearch);
  $('search').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });

  function doSearch() {
    var q = $('search').value.trim();
    if (!q) return;
    status('Recherche de « ' + q + ' »…', .3);
    Overpass.geocode(q).then(function (r) {
      if (!r || !r.length) { status('Lieu introuvable.', 0, true); return; }
      statusOff();
      setStart(+r[0].lat, +r[0].lon, true);
      $('search').value = r[0].display_name.split(',').slice(0, 3).join(',');
    }).catch(function () { status('Recherche impossible (réseau ?).', 0, true); });
  }

  $('btnGeo').addEventListener('click', function () {
    if (!navigator.geolocation) { status('Géolocalisation indisponible.', 0, true); return; }
    status('Localisation en cours…', .3);
    navigator.geolocation.getCurrentPosition(function (p) {
      statusOff();
      setStart(p.coords.latitude, p.coords.longitude, true);
    }, function () { status('Position refusée ou indisponible.', 0, true); },
      { enableHighAccuracy: true, timeout: 10000 });
  });

  /* ---------------- génération ---------------- */
  $('btnGo').addEventListener('click', run);
  $('btnMore').addEventListener('click', function () {
    if (state.routes.length < 2) return;
    select((state.current + 1) % state.routes.length);
  });

  function params() {
    var target = +$('dist').value * 1000;
    return {
      target: target,
      mode: $('mode').value,
      direction: direction,
      sector: +$('sector').value,
      overlap: $('varied').checked ? 7 : 1.6,
      tolerance: 0.14,
      variants: 5,
      weights: {
        nature: +$('nature').value / 100,
        avoidSteps: $('steps').checked,
        preferGreen: $('green').checked
      }
    };
  }

  async function run() {
    if (state.busy) return;
    if (!state.start) { status('Posez d\'abord un point de départ sur la carte.', 0, true); return; }
    var p = params();
    state.busy = true;
    $('btnGo').disabled = true;
    $('btnGo').textContent = 'Calcul en cours…';
    startTimer();
    try {
      /* Rayon de téléchargement : le point de mi-parcours est à ~0,5 × la
         distance *par les chemins*, soit nettement moins à vol d'oiseau. */
      var needed = Math.min(6500, Math.max(1300,
        p.target * (p.mode === 'outback' ? 0.55 : 0.40)));
      var c = state.cache;
      var reuse = c && c.radius >= needed &&
        Geo.haversine(c.lat, c.lon, state.start.lat, state.start.lon) < 250;

      if (!reuse) {
        var data = await Overpass.fetchArea(state.start.lat, state.start.lon, needed,
          function (m) { status(m + ' — 10 à 60 s selon la charge du serveur', .25); });
        status('Construction du graphe…', .5);
        await new Promise(function (r) { setTimeout(r, 10); });
        console.time('graphe');
        var g = RGraph.build(data.network, data.green);
        console.timeEnd('graphe');
        console.log('graphe : ' + g.n + ' noeuds, ' + g.edges.length + ' troncons, ' +
          g.greens + ' espaces verts');
        if (g.n < 20) throw new Error('Zone trop pauvre en chemins cartographiés.');
        state.cache = c = {
          lat: state.start.lat, lon: state.start.lon, radius: needed, graph: g
        };
      }

      RGraph.weight(c.graph, p.weights);
      var src = RGraph.nearest(c.graph, state.start.lat, state.start.lon);
      if (src < 0) throw new Error('Aucun chemin trouvé près du départ.');

      var res = await Router.plan(c.graph, src, p, function (f, m) { status(m, .55 + .4 * f); });
      if (!res.routes.length) {
        status('Aucune boucle trouvée : essayez une autre distance, une direction plus large ' +
          'ou un autre point de départ.', 0, true);
        state.routes = [];
        $('results').style.display = 'none';
        $('variantsBox').style.display = 'none';
        return;
      }
      state.routes = res.routes;
      state.graph = c.graph;
      state.src = src;
      select(0, true);
      statusOff();
      $('results').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (res.relaxed) {
        status('Distance approchée : le réseau local ne permet pas de coller exactement à la cible.', 1);
      }
    } catch (err) {
      console.error(err);
      status('Erreur : ' + (err && err.message ? err.message : err) +
        ' — réessayez dans un instant (serveur Overpass occupé ?).', 0, true);
    } finally {
      state.busy = false;
      $('btnGo').disabled = false;
      $('btnGo').textContent = 'Générer le parcours';
      stopTimer();
    }
  }

  /* ---------------- rendu ---------------- */
  function select(i, fit) {
    state.current = i;
    var r = state.routes[i], g = state.graph;
    draw(g, r, fit);
    showStats(r);
    renderVariants();
  }

  function draw(g, r, fit) {
    routeLayer.clearLayers();
    var pts = r.nodes.map(function (n) { return [g.lats[n], g.lons[n]]; });

    L.polyline(pts, { color: '#0b0e13', weight: 10, opacity: .55, lineJoin: 'round' }).addTo(routeLayer);

    /* segments regroupés par famille de voie */
    var i = 0;
    while (i < r.edges.length) {
      var fam = g.edges[r.edges[i]].fam, j = i;
      while (j < r.edges.length && g.edges[r.edges[j]].fam === fam) j++;
      L.polyline(pts.slice(i, j + 1), {
        color: COLORS[fam], weight: 5, opacity: .95, lineJoin: 'round', lineCap: 'round'
      }).addTo(routeLayer);
      i = j;
    }

    /* bornes kilométriques */
    var acc = 0, next = 1000;
    for (i = 0; i < r.edges.length; i++) {
      acc += g.edges[r.edges[i]].len;
      if (acc >= next) {
        L.marker(pts[i + 1], {
          icon: L.divIcon({
            className: '', iconSize: [26, 15], iconAnchor: [13, 7],
            html: '<div class="km-badge">' + (next / 1000) + '</div>'
          }), interactive: false
        }).addTo(routeLayer);
        next += 1000;
      }
    }

    markerLayer.clearLayers();
    if (state.marker) state.marker.addTo(markerLayer);
    L.marker([g.lats[r.turn], g.lons[r.turn]], { icon: turnIcon() })
      .bindTooltip('Mi-parcours', { direction: 'top', offset: [0, -8] }).addTo(markerLayer);

    $('maplegend').className = 'on';
    if (fit) map.fitBounds(L.polyline(pts).getBounds(), { padding: [40, 40] });
  }

  function pct(a, b) { return b ? Math.round(100 * a / b) + ' %' : '0 %'; }

  function showStats(r) {
    var s = r.stats, pace = +$('pace').value;
    $('results').style.display = '';
    $('rDist').textContent = (s.total / 1000).toFixed(2).replace('.', ',') + ' km';
    $('rTime').textContent = Geo.fmtDur(s.total / 1000 * pace * 60);
    $('rNat').textContent = pct(s.natural, s.total);

    var order = ['sentier', 'pieton', 'calme', 'route'];
    $('rStack').innerHTML = order.map(function (f) {
      return '<i style="width:' + (100 * s.fam[f] / s.total) + '%;background:' + COLORS[f] +
        '" title="' + f + ' : ' + Geo.fmtDist(s.fam[f]) + '"></i>';
    }).join('');

    $('rUnp').textContent = pct(s.unpaved, s.total);
    $('rGreen').textContent = pct(s.green, s.total);
    $('rOver').textContent = pct(s.overlap, s.total);
    $('rSteps').textContent = s.steps > 5 ? Geo.fmtDist(s.steps) : 'aucun';
  }

  function renderVariants() {
    var box = $('variants');
    if (state.routes.length < 2) { $('variantsBox').style.display = 'none'; return; }
    $('variantsBox').style.display = '';
    box.innerHTML = '';
    state.routes.forEach(function (r, i) {
      var b = document.createElement('button');
      b.className = 'variant' + (i === state.current ? ' on' : '');
      b.innerHTML = '<span class="n">' + (i + 1) + '</span><span>' +
        '<span class="d">' + (r.stats.total / 1000).toFixed(2).replace('.', ',') + ' km</span> · ' +
        '<span class="s">vers le ' + Geo.compass(r.brg) + ' · ' +
        Math.round(100 * (r.stats.fam.sentier + r.stats.fam.pieton) / r.stats.total) + ' % hors route · ' +
        Math.round(100 * r.overlapFrac) + ' % en double</span></span>';
      b.addEventListener('click', function () { select(i, true); });
      box.appendChild(b);
    });
  }

  /* ---------------- export GPX ---------------- */
  function buildGpx(r, g) {
    var km = (r.stats.total / 1000).toFixed(2);
    var pts = r.nodes.map(function (n) {
      return '   <trkpt lat="' + g.lats[n].toFixed(7) + '" lon="' + g.lons[n].toFixed(7) + '"/>';
    }).join('\n');
    var NL = '\n';
    return '<?xml version="1.0" encoding="UTF-8"?>' + NL +
      '<gpx version="1.1" creator="JogRoute" xmlns="http://www.topografix.com/GPX/1/1">' + NL +
      ' <metadata><name>Jogging ' + km + ' km</name><time>' +
      new Date().toISOString() + '</time></metadata>' + NL +
      ' <trk><name>Jogging ' + km + ' km</name><trkseg>' + NL +
      pts + NL + ' </trkseg></trk>' + NL + '</gpx>' + NL;
  }

  $('btnGpx').addEventListener('click', function () {
    var r = state.routes[state.current];
    if (!r) return;
    var gpx = buildGpx(r, state.graph);
    var url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'jogging-' + (r.stats.total / 1000).toFixed(1).replace('.', '_') + 'km.gpx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  /* Accès de débogage depuis la console du navigateur */
  window.JogRoute = { state: state, map: map, buildGpx: buildGpx, run: run, setStart: setStart };

  /* ---------------- démarrage ---------------- */
  syncLabels();
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(function (p) {
      if (!state.start) setStart(p.coords.latitude, p.coords.longitude, true);
    }, function () { }, { timeout: 8000 });
  }
})();

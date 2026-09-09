/* app.js — interface : carte, paramètres, rendu, partage, hors ligne.
   Le calcul lui-même vit dans js/worker.js ; ce fichier ne fait que
   rassembler les données, piloter le moteur et afficher le résultat. */
(function () {
  'use strict';

  var COLORS = { sentier: '#46d17a', pieton: '#4ea8ff', calme: '#f0c419', route: '#ff6b5e' };
  var FAM_LIST = ['sentier', 'pieton', 'calme', 'route'];

  var state = {
    start: null,          // {lat, lon}
    end: null,            // {lat, lon} — mode point à point
    marker: null,
    endMarker: null,
    pickEnd: false,
    userPicked: false,     // l'utilisateur a choisi un départ : le GPS ne l'écrase plus
    routes: [],
    current: 0,
    busy: false,
    zone: null,           // {lat, lon, radius} de la zone chargée dans le moteur
    pois: [],
    weather: null,
    shared: null          // tracé reçu par lien, affiché sans recalcul
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ================= moteur (worker, avec repli dans la page) ================= */

  var engine = (function () {
    var worker = null, pending = new Map(), seq = 0;

    function boot() {
      if (worker !== null) return worker;
      try {
        worker = new Worker('js/worker.js');
        worker.onmessage = function (ev) {
          var m = ev.data, p = pending.get(m.id);
          if (!p) return;
          if (m.type === 'progress') { p.onProgress && p.onProgress(m.frac, m.msg); return; }
          pending.delete(m.id);
          if (m.type === 'error') p.reject(new Error(m.message));
          else p.resolve(m);
        };
        worker.onerror = function (e) {
          console.warn('worker indisponible, repli dans la page :', e.message);
          worker = false;
        };
      } catch (e) {
        console.warn('worker impossible, repli dans la page :', e);
        worker = false;
      }
      return worker;
    }

    function call(type, payload, onProgress) {
      var w = boot();
      if (!w) return inline(type, payload, onProgress);
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        pending.set(id, { resolve: resolve, reject: reject, onProgress: onProgress });
        w.postMessage(Object.assign({ type: type, id: id }, payload));
      });
    }

    /* Repli : les mêmes modules sont déjà chargés dans la page. */
    var G = null;
    function inline(type, msg, onProgress) {
      return Promise.resolve().then(function () {
        if (type === 'build') {
          onProgress && onProgress(0.55, 'Construction du graphe…');
          G = RGraph.build(msg.net, msg.green);
          if (G.n < 20) throw new Error('Zone trop pauvre en chemins cartographiés.');
          if (msg.tiles && msg.tiles.length) RGraph.attachElevation(G, msg.tiles);
          RGraph.attachWater(G, msg.pois || []);
          return { n: G.n, m: G.m, hasEle: G.hasEle, waterCount: G.waterCount, blob: RGraph.serialize(G) };
        }
        if (type === 'load') {
          G = RGraph.deserialize(msg.blob);
          return { n: G.n, m: G.m, hasEle: G.hasEle, waterCount: G.waterCount };
        }
        if (type === 'plan') {
          var hist = null;
          if (msg.history && msg.history.length) {
            hist = new Map();
            msg.history.forEach(function (h) { hist.set(h[0], h[1]); });
          }
          RGraph.weight(G, Object.assign({}, msg.weights, { history: hist }));
          var p = msg.p;
          p.src = RGraph.nearest(G, p.startLat, p.startLon);
          if (p.src < 0) throw new Error('Aucun chemin trouvé près du départ.');
          if (p.mode === 'p2p' && p.endLat != null) p.dst = RGraph.nearest(G, p.endLat, p.endLon);
          return Router.plan(G, p, onProgress).then(function (res) {
            return { routes: res.routes, reason: res.reason, relaxed: res.relaxed, all: res.all };
          });
        }
        return {};
      });
    }

    return { call: call };
  })();

  /* ================= carte ================= */

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
  var poiLayer = L.layerGroup().addTo(map);
  var cursor = null;

  function dot(color, size) {
    return L.divIcon({
      className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: '<div class="pin" style="color:' + color + ';background:' + color +
        ';width:' + (size - 6) + 'px;height:' + (size - 6) + 'px"></div>'
    });
  }

  function setStart(lat, lon, fly) {
    state.start = { lat: lat, lon: lon };
    if (!state.marker) {
      state.marker = L.marker([lat, lon], { icon: dot('#46d17a', 18), draggable: true, zIndexOffset: 1000 })
        .addTo(markerLayer).bindTooltip('Départ', { direction: 'top', offset: [0, -8] });
      state.marker.on('dragend', function (e) {
        var p = e.target.getLatLng();
        state.start = { lat: p.lat, lon: p.lng };
        state.userPicked = true;
        clearAccuracy();
        updateStartInfo();
        saveSettings();
      });
    } else {
      state.marker.setLatLng([lat, lon]);
    }
    if (fly) map.setView([lat, lon], Math.max(map.getZoom(), 14));
    updateStartInfo();
    saveSettings();
  }

  function setEnd(lat, lon) {
    state.end = { lat: lat, lon: lon };
    if (!state.endMarker) {
      state.endMarker = L.marker([lat, lon], { icon: dot('#ff6b5e', 18), draggable: true, zIndexOffset: 900 })
        .addTo(markerLayer).bindTooltip('Arrivée', { direction: 'top', offset: [0, -8] });
      state.endMarker.on('dragend', function (e) {
        var p = e.target.getLatLng();
        state.end = { lat: p.lat, lon: p.lng };
        updateEndInfo();
      });
    } else {
      state.endMarker.setLatLng([lat, lon]);
    }
    updateEndInfo();
  }

  function clearEnd() {
    state.end = null;
    if (state.endMarker) { markerLayer.removeLayer(state.endMarker); state.endMarker = null; }
    updateEndInfo();
  }

  function updateStartInfo() {
    $('startInfo').innerHTML = state.start
      ? 'Départ : <b>' + state.start.lat.toFixed(5) + ', ' + state.start.lon.toFixed(5) + '</b>'
      : 'Cliquez sur la carte pour poser le départ (ou déplacez le marqueur).';
  }

  function updateEndInfo() {
    $('endInfo').innerHTML = state.end
      ? 'Arrivée : <b>' + state.end.lat.toFixed(5) + ', ' + state.end.lon.toFixed(5) + '</b>'
      : 'Aucune arrivée définie — cliquez sur « Définir l\'arrivée » puis sur la carte.';
  }

  map.on('click', function (e) {
    if (state.pickEnd) {
      setEnd(e.latlng.lat, e.latlng.lng);
      state.pickEnd = false;
      $('btnSetEnd').textContent = '🏁 Définir l\'arrivée';
      return;
    }
    state.userPicked = true;
    clearAccuracy();
    setStart(e.latlng.lat, e.latlng.lng, false);
  });

  /* ================= contrôles ================= */

  var direction = null;

  function paceText(v) {
    var m = Math.floor(v), s = Math.round((v - m) * 60);
    return m + ':' + String(s).padStart(2, '0') + ' /km';
  }

  function hillText(v) {
    if (v <= -70) return 'le plus plat possible';
    if (v < -20) return 'plutôt plat';
    if (v <= 20) return 'indifférent';
    if (v < 70) return 'plutôt vallonné';
    return 'chercher le dénivelé';
  }

  function syncLabels() {
    var obj = $('objective').value;
    $('distWrap').hidden = obj !== 'dist';
    $('timeWrap').hidden = obj !== 'time';
    $('distOut').textContent = (+$('dist').value).toFixed(1).replace('.', ',') + ' km';
    $('timeOut').textContent = Geo.fmtDur(+$('minutes').value * 60);
    $('paceOut').textContent = paceText(+$('pace').value);
    $('sectorOut').textContent = $('sector').value + '°';
    $('natOut').textContent = $('nature').value + ' %';
    $('hillOut').textContent = hillText(+$('hilliness').value);
    var dp = +$('dplus').value;
    $('dplusOut').textContent = dp === 0 ? 'peu importe' : dp + ' m';
    var fr = +$('fresh').value;
    $('freshOut').textContent = fr === 0 ? 'désactivé' : fr + ' derniers jours';
    var wa = +$('water').value;
    $('waterOut').textContent = wa === 0 ? 'peu importe' : wa + ' km';
    $('sectorWrap').style.opacity = direction === null ? .4 : 1;
    $('sector').disabled = direction === null;

    var p2p = $('mode').value === 'p2p';
    $('endWrap').hidden = !p2p;
    $('round').closest('label').style.opacity = $('mode').value === 'loop' ? 1 : .45;

    var runs = Store.runs().length;
    $('freshHint').textContent = runs
      ? runs + ' sortie' + (runs > 1 ? 's' : '') + ' en mémoire (locale). Le bouton « J\'ai couru ça » alimente cette liste.'
      : 'Aucune sortie mémorisée : validez un parcours avec « J\'ai couru ça » pour que le moteur commence à varier.';
    saveSettings();
  }

  ['dist', 'minutes', 'pace', 'sector', 'nature', 'hilliness', 'dplus', 'fresh', 'water']
    .forEach(function (id) { $(id).addEventListener('input', syncLabels); });
  ['mode', 'objective'].forEach(function (id) { $(id).addEventListener('change', syncLabels); });
  ['green', 'steps', 'varied', 'round', 'night'].forEach(function (id) {
    $(id).addEventListener('change', syncLabels);
  });

  $('compass').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) { x.classList.remove('on'); });
    b.classList.add('on');
    direction = b.dataset.dir === '' ? null : +b.dataset.dir;
    syncLabels();
  });

  function setDirection(deg) {
    direction = deg;
    Array.prototype.forEach.call($('compass').querySelectorAll('button'), function (x) {
      x.classList.remove('on');
      var d = x.dataset.dir === '' ? null : +x.dataset.dir;
      if (deg === null ? d === null : (d !== null && Geo.angleDiff(d, deg) < 22.5)) x.classList.add('on');
    });
    syncLabels();
  }

  $('btnSetEnd').addEventListener('click', function () {
    state.pickEnd = !state.pickEnd;
    this.textContent = state.pickEnd ? '👉 Cliquez sur la carte…' : '🏁 Définir l\'arrivée';
  });
  $('btnClearEnd').addEventListener('click', clearEnd);

  /* ================= statut ================= */

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
  }
  function statusOff() { $('status').className = ''; stopTimer(); }

  /* ================= géocodage / géoloc / favoris ================= */

  $('btnSearch').addEventListener('click', doSearch);
  $('search').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });

  function doSearch() {
    var q = $('search').value.trim();
    if (!q) return;
    status('Recherche de « ' + q + ' »…', .3);
    Overpass.geocode(q).then(function (r) {
      if (!r || !r.length) { status('Lieu introuvable.', 0, true); return; }
      statusOff();
      state.userPicked = true;
      clearAccuracy();
      setStart(+r[0].lat, +r[0].lon, true);
      $('search').value = r[0].display_name.split(',').slice(0, 3).join(',');
    }).catch(function () { status('Recherche impossible (réseau ?).', 0, true); });
  }

  /* ---------------- géolocalisation ----------------
     Sur téléphone, une seule tentative « haute précision » échoue souvent :
     à l'intérieur le GPS n'accroche pas, et le premier point peut demander
     une trentaine de secondes. On procède donc en deux temps — un point
     rapide (réseau/wifi, éventuellement en cache), puis un affinage GPS en
     tâche de fond — et surtout on explique chaque échec au lieu de l'avaler. */

  var accCircle = null;

  function showAccuracy(lat, lon, acc) {
    if (!acc || acc > 3000) { clearAccuracy(); return; }
    if (!accCircle) {
      accCircle = L.circle([lat, lon], {
        radius: acc, color: '#4ea8ff', weight: 1,
        fillColor: '#4ea8ff', fillOpacity: .08, interactive: false
      }).addTo(map);
    } else {
      accCircle.setLatLng([lat, lon]).setRadius(acc);
    }
  }

  function clearAccuracy() {
    if (accCircle) { map.removeLayer(accCircle); accCircle = null; }
  }

  /* Cause bloquante connue d'avance (inutile de demander la position). */
  function geoUnavailableReason() {
    if (!navigator.geolocation) {
      return 'Ce navigateur ne propose pas de géolocalisation.';
    }
    var h = location.hostname;
    var local = h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '';
    if (!window.isSecureContext && !local) {
      return 'La géolocalisation exige une connexion sécurisée : ouvrez le site en ' +
        'https:// (adresse actuelle : ' + location.protocol + '//' + location.host + ').';
    }
    return null;
  }

  function geoErrorText(err) {
    var code = err && err.code;
    if (code === 1) {
      return 'Localisation refusée. Autorisez l\'accès à la position pour ce site ' +
        '(icône à gauche de l\'adresse, ou Réglages → Site), et vérifiez que la ' +
        'localisation du téléphone est activée.';
    }
    if (code === 2) {
      return 'Position introuvable : le téléphone n\'obtient pas de point. ' +
        'Activez la localisation, sortez à l\'air libre, puis réessayez.';
    }
    if (code === 3) {
      return 'Le GPS met trop de temps à répondre. Réessayez : le tout premier ' +
        'point peut demander une trentaine de secondes.';
    }
    return (err && err.message) || 'Localisation impossible.';
  }

  /* Résout au premier point exploitable ; `onUpdate` reçoit les affinages. */
  function locate(onUpdate) {
    return new Promise(function (resolve, reject) {
      var why = geoUnavailableReason();
      if (why) { reject({ code: 0, message: why }); return; }

      var settled = false, watchId = null, timer = null;
      var lastErr = null, bestAcc = Infinity;

      function stopWatch() {
        if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
        clearTimeout(timer);
      }

      function accept(pos) {
        var v = {
          lat: pos.coords.latitude, lon: pos.coords.longitude,
          acc: pos.coords.accuracy || 0
        };
        bestAcc = v.acc;
        if (!settled) { settled = true; resolve(v); }
        else if (onUpdate) onUpdate(v);
        if (v.acc <= 25) stopWatch();       // assez précis, on arrête le GPS
      }

      /* 2e temps : GPS précis, en tâche de fond. */
      function refine() {
        if (bestAcc <= 40) return;
        watchId = navigator.geolocation.watchPosition(function (pos) {
          if (!settled || (pos.coords.accuracy || 1e9) < bestAcc) accept(pos);
        }, function (err) {
          lastErr = err;
          if (!settled && err.code === 1) { stopWatch(); reject(err); }
        }, { enableHighAccuracy: true, timeout: 35000, maximumAge: 0 });

        timer = setTimeout(function () {
          stopWatch();
          if (!settled) reject(lastErr || { code: 3 });
        }, 35000);
      }

      /* 1er temps : point rapide, accepté même approximatif ou récent. */
      navigator.geolocation.getCurrentPosition(function (pos) {
        accept(pos);
        refine();
      }, function (err) {
        lastErr = err;
        if (err.code === 1) { reject(err); return; }   // refus : insister ne sert à rien
        refine();
      }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
    });
  }

  $('btnGeo').addEventListener('click', function () {
    var btn = this, old = btn.textContent;
    state.userPicked = true;
    btn.disabled = true;
    btn.textContent = '📍 Recherche…';
    status('Localisation en cours — le premier point GPS peut demander 30 s…', .3);

    locate(function (v) {                       // affinages successifs
      setStart(v.lat, v.lon, false);
      showAccuracy(v.lat, v.lon, v.acc);
      status('Position affinée : précision ' + Math.round(v.acc) + ' m.', 1);
    }).then(function (v) {
      setStart(v.lat, v.lon, true);
      showAccuracy(v.lat, v.lon, v.acc);
      status('Position trouvée (précision ' + Math.round(v.acc) + ' m).', 1);
      setTimeout(function () {
        if (!state.busy) statusOff();
      }, 4000);
    }).catch(function (err) {
      status(geoErrorText(err), 0, true);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = old;
    });
  });

  $('btnFav').addEventListener('click', function () {
    if (!state.start) { status('Posez d\'abord un point de départ.', 0, true); return; }
    var lat = state.start.lat, lon = state.start.lon;
    Overpass.reverse(lat, lon).then(function (guess) {
      var name = prompt('Nom du départ favori :', guess || 'Départ');
      if (!name) return;
      Store.addFavorite(name.trim().slice(0, 28), lat, lon);
      renderFavorites();
    });
  });

  function renderFavorites() {
    var box = $('favs'), favs = Store.favorites();
    box.innerHTML = '';
    favs.forEach(function (f) {
      var b = document.createElement('button');
      b.className = 'chip';
      b.innerHTML = '<span>' + escapeHtml(f.name) + '</span><i title="Retirer">✕</i>';
      b.addEventListener('click', function (e) {
        if (e.target.tagName === 'I') {
          Store.removeFavorite(f.name);
          renderFavorites();
          return;
        }
        state.userPicked = true;
        clearAccuracy();
        setStart(f.lat, f.lon, true);
      });
      box.appendChild(b);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ================= météo / vent ================= */

  $('btnWind').addEventListener('click', function () {
    if (!state.start) { status('Posez d\'abord un point de départ.', 0, true); return; }
    var btn = this;
    btn.disabled = true;
    Weather.current(state.start.lat, state.start.lon).then(function (w) {
      state.weather = w;
      setDirection(w.windFrom);
      $('windInfo').innerHTML = 'Vent <b>' + Math.round(w.windKmh) + ' km/h</b> de ' +
        Geo.compass(w.windFrom) + ' · ' + Math.round(w.temp) + ' °C, ' + w.text +
        ' — départ face au vent, retour poussé.';
    }).catch(function () {
      $('windInfo').textContent = 'Météo indisponible (hors ligne ?).';
    }).finally(function () { btn.disabled = false; });
  });

  /* ================= paramètres ================= */

  function params() {
    var objective = $('objective').value;
    var paceSecPerKm = +$('pace').value * 60;
    var minutes = +$('minutes').value;
    var target = objective === 'time'
      ? (minutes * 60 / paceSecPerKm) * 1000
      : +$('dist').value * 1000;

    return {
      p: {
        target: target,
        objective: objective,
        targetTime: minutes * 60,
        mode: $('mode').value,
        direction: direction,
        sector: +$('sector').value,
        overlap: $('varied').checked ? 7 : 1.6,
        tolerance: 0.14,
        variants: 5,
        loopShape: $('round').checked ? 0.6 : 0,
        dplus: +$('dplus').value,
        waterEvery: +$('water').value * 1000,
        startLat: state.start.lat, startLon: state.start.lon,
        endLat: state.end ? state.end.lat : null,
        endLon: state.end ? state.end.lon : null
      },
      weights: {
        nature: +$('nature').value / 100,
        avoidSteps: $('steps').checked,
        preferGreen: $('green').checked,
        night: $('night').checked,
        hilliness: +$('hilliness').value / 100,
        paceSecPerKm: paceSecPerKm,
        historyStrength: 1.6
      },
      freshDays: +$('fresh').value
    };
  }

  /* Paliers de rayon de téléchargement. Sans eux, bouger le curseur de
     distance d'un kilomètre change le rayon requis de quelques dizaines de
     mètres et invalide le cache : on repayait 60 s d'Overpass pour rien.
     En arrondissant au palier supérieur, toutes les distances voisines
     partagent la même zone téléchargée. */
  var RADIUS_STEPS = [1500, 2000, 2600, 3400, 4400, 5600, 7000];

  function neededRadius(p) {
    var raw;
    if (p.mode === 'p2p' && state.end) {
      var apart = Geo.haversine(state.start.lat, state.start.lon, state.end.lat, state.end.lon);
      raw = Math.max(1500, apart / 2 + p.target * 0.35);
    } else {
      raw = Math.max(1300, p.target * (p.mode === 'outback' ? 0.55 : 0.40));
    }
    raw *= 1.15;                                  // marge : petits ajustements gratuits
    for (var i = 0; i < RADIUS_STEPS.length; i++) {
      if (RADIUS_STEPS[i] >= raw) return RADIUS_STEPS[i];
    }
    return RADIUS_STEPS[RADIUS_STEPS.length - 1];
  }

  /* ================= génération ================= */

  $('btnGo').addEventListener('click', run);
  $('btnMore').addEventListener('click', function () {
    if (state.routes.length < 2) return;
    select((state.current + 1) % state.routes.length);
  });

  function zoneCovers(z, lat, lon, needed) {
    if (!z) return false;
    if (z.radius < needed) return false;
    return Geo.haversine(z.lat, z.lon, lat, lon) <= Math.max(250, z.radius - needed);
  }

  async function ensureGraph(needed) {
    var lat = state.start.lat, lon = state.start.lon;

    /* 1. zone déjà chargée dans le moteur */
    if (zoneCovers(state.zone, lat, lon, needed)) return 'memoire';

    /* 2. zone en cache local (hors ligne possible) */
    var hit = await Store.findGraph(lat, lon, needed);
    if (hit) {
      status('Zone en cache local — chargement…', .35);
      var r = await engine.call('load', { blob: hit.blob });
      state.zone = { lat: hit.lat, lon: hit.lon, radius: hit.radius };
      state.pois = (hit.blob.pois || []);
      logGraph(r, 'cache');
      return 'cache';
    }

    /* 3. téléchargement */
    if (!navigator.onLine) {
      throw new Error('hors ligne et cette zone n\'est pas en cache — connectez-vous une fois ici pour la télécharger.');
    }
    var data = await Overpass.fetchArea(lat, lon, needed, function (m) {
      status(m + ' — 10 à 60 s selon la charge du serveur', .2);
    });

    status('Relief : téléchargement des tuiles d\'altitude…', .38);
    var tiles = await Elevation.load(lat, lon, needed, function (f) {
      status('Relief : tuiles d\'altitude ' + Math.round(f * 100) + ' %', .38 + .1 * f);
    }).catch(function () { return []; });

    var res = await engine.call('build',
      { net: data.network, green: data.green, pois: data.pois, tiles: tiles },
      function (f, m) { status(m, .5 + .1 * f); });

    state.zone = { lat: lat, lon: lon, radius: needed };
    state.pois = data.pois;
    state.notes = data.notes || [];
    logGraph(res, 'réseau');
    if (state.notes.length) console.warn('Overpass partiel : ' + state.notes.join(' · '));
    $('waterHint').textContent = data.pois.length
      ? data.pois.length + ' points d\'eau / toilettes cartographiés dans la zone.'
      : 'Aucun point d\'eau récupéré' +
        (state.notes.length ? ' (serveur Overpass occupé — réessayez plus tard).'
          : ' : rien de cartographié dans OSM ici.');
    if (res.blob) {
      var label = ($('search').value || '').split(',')[0].trim();
      Store.putGraph(lat, lon, needed, res.blob, label).then(renderZones);
    }
    return 'reseau';
  }

  function logGraph(r, origine) {
    console.log('graphe (' + origine + ') : ' + r.n + ' noeuds, ' + r.m + ' troncons, ' +
      'relief=' + (r.hasEle ? 'oui' : 'non') + ', points d\'eau=' + (r.waterCount || 0));
    $('eleHint').textContent = r.hasEle
      ? 'Relief chargé — dénivelé, profil et allure ajustée à la pente sont actifs.'
      : 'Relief indisponible pour cette zone : le dénivelé n\'est pas pris en compte.';
  }

  async function run() {
    if (state.busy) return;
    if (!state.start) { status('Posez d\'abord un point de départ sur la carte.', 0, true); return; }
    var cfg = params();
    if (cfg.p.mode === 'p2p' && !state.end) {
      status('Mode point à point : définissez d\'abord une arrivée.', 0, true);
      return;
    }

    state.busy = true;
    state.shared = null;
    $('btnGo').disabled = true;
    $('btnGo').textContent = 'Calcul en cours…';
    startTimer();

    try {
      var needed = neededRadius(cfg.p);
      await ensureGraph(needed);

      var history = cfg.freshDays ? Store.historyWeights(cfg.freshDays) : [];
      var res = await engine.call('plan',
        { p: cfg.p, weights: cfg.weights, history: history },
        function (f, m) { status(m, .6 + .38 * f); });

      if (!res.routes || !res.routes.length) {
        var why = res.reason === 'nodst' ? 'arrivée introuvable sur le réseau'
          : res.reason === 'unreachable' ? 'arrivée non reliée au départ dans ce rayon'
            : 'aucune boucle satisfaisante';
        status('Aucun parcours trouvé (' + why + ') : essayez une autre distance, ' +
          'une direction plus large ou un autre point de départ.', 0, true);
        state.routes = [];
        $('results').style.display = 'none';
        $('variantsBox').style.display = 'none';
        return;
      }

      state.routes = res.routes;
      renderPois();
      select(0, true);
      statusOff();
      writeHash(false);
      $('results').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (res.relaxed) {
        status('Distance approchée : le réseau local ne permet pas de coller exactement à la cible.', 1);
      }
    } catch (err) {
      console.error(err);
      status('Erreur : ' + (err && err.message ? err.message : err), 0, true);
    } finally {
      state.busy = false;
      $('btnGo').disabled = false;
      $('btnGo').textContent = 'Générer le parcours';
      stopTimer();
    }
  }

  /* ================= rendu ================= */

  function ptsOf(r) {
    var n = r.coords.length / 2, pts = new Array(n);
    for (var i = 0; i < n; i++) pts[i] = [r.coords[2 * i], r.coords[2 * i + 1]];
    return pts;
  }

  function select(i, fit) {
    state.current = i;
    var r = state.routes[i];
    draw(r, fit);
    showStats(r);
    renderVariants();
  }

  function draw(r, fit) {
    routeLayer.clearLayers();
    var pts = ptsOf(r);

    L.polyline(pts, { color: '#0b0e13', weight: 10, opacity: .55, lineJoin: 'round' }).addTo(routeLayer);

    /* segments regroupés par famille de voie */
    var i = 0;
    while (i < r.fams.length) {
      var fam = r.fams[i], j = i;
      while (j < r.fams.length && r.fams[j] === fam) j++;
      L.polyline(pts.slice(i, j + 1), {
        color: COLORS[FAM_LIST[fam]], weight: 5, opacity: .95, lineJoin: 'round', lineCap: 'round'
      }).addTo(routeLayer);
      i = j;
    }

    /* bornes kilométriques, à partir de la distance cumulée */
    var next = 1000;
    for (i = 1; i < pts.length; i++) {
      if (r.cum[i] >= next) {
        L.marker(pts[i], {
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
    if (state.endMarker) state.endMarker.addTo(markerLayer);
    if (r.turn) {
      L.marker(r.turn, { icon: dot('#4ea8ff', 14) })
        .bindTooltip('Mi-parcours', { direction: 'top', offset: [0, -8] }).addTo(markerLayer);
    }

    cursor = L.circleMarker(pts[0], {
      radius: 5, color: '#4ea8ff', fillColor: '#4ea8ff', fillOpacity: 1, weight: 2
    });

    $('maplegend').className = 'on';
    if (fit) map.fitBounds(L.polyline(pts).getBounds(), { padding: [40, 40] });
  }

  function renderPois() {
    poiLayer.clearLayers();
    (state.pois || []).forEach(function (p) {
      L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: '', iconSize: [9, 9], iconAnchor: [4, 4], html: '<div class="poi-dot"></div>' })
      }).bindTooltip((p.kind === 'toilets' ? 'Toilettes' : 'Point d\'eau') +
        (p.name ? ' — ' + p.name : ''), { direction: 'top' }).addTo(poiLayer);
    });
  }

  function pct(a, b) { return b ? Math.round(100 * a / b) + ' %' : '0 %'; }

  function shapeText(c) {
    if (c >= .55) return 'très ronde';
    if (c >= .38) return 'bonne boucle';
    if (c >= .22) return 'allongée';
    if (c > 0) return 'proche d\'un aller-retour';
    return '—';
  }

  function showStats(r) {
    var s = r.stats;
    $('results').style.display = '';
    $('rDist').textContent = (s.total / 1000).toFixed(2).replace('.', ',') + ' km';
    $('rTime').textContent = Geo.fmtDur(s.time);
    $('rClimb').textContent = r.hasEle ? s.climb + ' m' : '—';
    $('rNat').textContent = pct(s.natural, s.total);

    var order = ['sentier', 'pieton', 'calme', 'route'];
    $('rStack').innerHTML = order.map(function (f) {
      return '<i style="width:' + (100 * s.fam[f] / s.total) + '%;background:' + COLORS[f] +
        '" title="' + f + ' : ' + Geo.fmtDist(s.fam[f]) + '"></i>';
    }).join('');

    $('rUnp').textContent = pct(s.unpaved, s.total);
    $('rGreen').textContent = pct(s.green, s.total);
    $('rOver').textContent = pct(s.overlap, s.total);
    $('rLit').textContent = pct(s.lit, s.total);
    $('rSteps').textContent = s.steps > 5 ? Geo.fmtDist(s.steps) : 'aucun';
    $('rShape').textContent = shapeText(r.compact);
    $('rWater').textContent = s.waterStops ? s.waterStops + ' passage' + (s.waterStops > 1 ? 's' : '') : 'aucun';
    $('rDry').textContent = s.waterStops ? Geo.fmtDist(s.maxDryGap) : '—';

    drawProfile(r);
  }

  /* ---- profil altimétrique ---- */
  function drawProfile(r) {
    var box = $('profileBox');
    if (!r.hasEle || !r.ele || r.ele.length < 3) { box.hidden = true; return; }
    box.hidden = false;

    var W = 300, H = 84, PL = 26, PR = 6, PT = 8, PB = 16;
    var n = r.ele.length, total = r.cum[n - 1] || 1;
    var lo = Infinity, hi = -Infinity, i;
    for (i = 0; i < n; i++) { if (r.ele[i] < lo) lo = r.ele[i]; if (r.ele[i] > hi) hi = r.ele[i]; }
    if (hi - lo < 10) { var mid = (hi + lo) / 2; lo = mid - 5; hi = mid + 5; }

    var x = function (k) { return PL + (r.cum[k] / total) * (W - PL - PR); };
    var y = function (v) { return PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB); };

    /* on n'a pas besoin de tous les points pour une courbe de 300 px de large */
    var stepI = Math.max(1, Math.floor(n / 320));
    var d = '';
    for (i = 0; i < n; i += stepI) d += (d ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(r.ele[i]).toFixed(1);
    d += 'L' + x(n - 1).toFixed(1) + ' ' + y(r.ele[n - 1]).toFixed(1);
    var area = d + 'L' + x(n - 1).toFixed(1) + ' ' + (H - PB) + 'L' + PL + ' ' + (H - PB) + 'Z';

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<line class="pf-grid" x1="' + PL + '" y1="' + y(hi) + '" x2="' + (W - PR) + '" y2="' + y(hi) + '"/>' +
      '<line class="pf-grid" x1="' + PL + '" y1="' + y(lo) + '" x2="' + (W - PR) + '" y2="' + y(lo) + '"/>' +
      '<path class="pf-area" d="' + area + '"/>' +
      '<path class="pf-line" d="' + d + '"/>' +
      '<text class="pf-txt" x="2" y="' + (y(hi) + 3) + '">' + Math.round(hi) + '</text>' +
      '<text class="pf-txt" x="2" y="' + (y(lo) + 3) + '">' + Math.round(lo) + '</text>' +
      '<text class="pf-txt" x="' + PL + '" y="' + (H - 4) + '">0</text>' +
      '<text class="pf-txt" x="' + (W - PR) + '" y="' + (H - 4) + '" text-anchor="end">' +
      (total / 1000).toFixed(1) + ' km</text>' +
      '<line class="pf-cursor" id="pfCursor" x1="0" y1="' + PT + '" x2="0" y2="' + (H - PB) + '" style="display:none"/>' +
      '</svg>';
    $('profile').innerHTML = svg;

    /* survol : suit le parcours sur la carte */
    var el = $('profile');
    var pts = ptsOf(r);
    el.onmousemove = function (ev) {
      var rect = el.getBoundingClientRect();
      var frac = (ev.clientX - rect.left) / rect.width;
      var px = frac * W;
      if (px < PL || px > W - PR) return;
      var dist = ((px - PL) / (W - PL - PR)) * total;
      var k = 0;
      while (k < n - 1 && r.cum[k] < dist) k++;
      var line = el.querySelector('#pfCursor');
      if (line) { line.setAttribute('x1', px); line.setAttribute('x2', px); line.style.display = ''; }
      if (cursor) { cursor.setLatLng(pts[k]); if (!map.hasLayer(cursor)) cursor.addTo(map); }
    };
    el.onmouseleave = function () {
      var line = el.querySelector('#pfCursor');
      if (line) line.style.display = 'none';
      if (cursor && map.hasLayer(cursor)) map.removeLayer(cursor);
    };
  }

  function renderVariants() {
    var box = $('variants');
    if (state.routes.length < 2) { $('variantsBox').style.display = 'none'; return; }
    $('variantsBox').style.display = '';
    box.innerHTML = '';
    state.routes.forEach(function (r, i) {
      var b = document.createElement('button');
      b.className = 'variant' + (i === state.current ? ' on' : '');
      var s = r.stats;
      b.innerHTML = '<span class="n">' + (i + 1) + '</span><span>' +
        '<span class="d">' + (s.total / 1000).toFixed(2).replace('.', ',') + ' km</span> · ' +
        Geo.fmtDur(s.time) + (r.hasEle ? ' · D+' + s.climb + ' m' : '') +
        '<br><span class="s">vers le ' + Geo.compass(r.brg) + ' · ' +
        Math.round(100 * (s.fam.sentier + s.fam.pieton) / s.total) + ' % hors route · ' +
        Math.round(100 * r.overlapFrac) + ' % en double</span></span>';
      b.addEventListener('click', function () { select(i, true); });
      box.appendChild(b);
    });
  }

  /* ================= partage ================= */

  function currentRoute() {
    if (state.shared) return state.shared;
    return state.routes[state.current] || null;
  }

  function shareState(withPoly) {
    var r = currentRoute();
    var st = {
      lat: state.start.lat, lon: state.start.lon,
      dist: $('dist').value, mode: $('mode').value, pace: $('pace').value,
      nature: $('nature').value, objective: $('objective').value,
      minutes: $('minutes').value, direction: direction, sector: $('sector').value,
      hilliness: $('hilliness').value, dplus: $('dplus').value, water: $('water').value,
      flags: ($('green').checked ? 'g' : '') + ($('steps').checked ? 's' : '') +
        ($('varied').checked ? 'v' : '') + ($('round').checked ? 'r' : '') +
        ($('night').checked ? 'n' : '')
    };
    if (state.end) { st.endLat = state.end.lat; st.endLon = state.end.lon; }
    if (withPoly && r) st.poly = Share.encodeRoute(ptsOf(r));
    return st;
  }

  function writeHash(withPoly) {
    if (!state.start) return;
    try {
      history.replaceState(null, '', '#' + Share.encodeState(shareState(withPoly)));
    } catch (e) { /* pas bloquant */ }
  }

  $('btnGmaps').addEventListener('click', function () {
    var r = currentRoute();
    if (!r) return;
    var url = Share.googleMapsUrl(ptsOf(r));
    if (!url) return;
    window.open(url, '_blank', 'noopener');
    $('shareHint').innerHTML = 'Google Maps recalcule le chemin entre une dizaine de points clés : ' +
      'le tracé y est <b>approché</b>. Pour la trace exacte, utilisez le GPX.';
  });

  $('btnQr').addEventListener('click', function () {
    var r = currentRoute();
    if (!r) return;
    var gm = Share.googleMapsUrl(ptsOf(r));
    var svg = Share.qrSvg(gm, 4);
    openModal('Ouvrir sur le téléphone',
      (svg ? '<div class="qr">' + svg + '</div>' : '') +
      '<p class="hint" style="margin:0 0 10px">Scannez avec l\'appareil photo du téléphone : ' +
      'Google Maps s\'ouvre directement sur le parcours.</p>' +
      '<div class="url">' + escapeHtml(gm) + '</div>' +
      '<div class="row"><button id="mdCopy">Copier le lien Maps</button>' +
      '<button id="mdOpen" class="primary-soft">Ouvrir ici</button></div>');
    $('mdCopy').addEventListener('click', function () {
      Share.copy(gm).then(function () { this.textContent = 'Copié ✓'; }.bind(this));
    });
    $('mdOpen').addEventListener('click', function () { window.open(gm, '_blank', 'noopener'); });
  });

  $('btnShare').addEventListener('click', function () {
    var url = Share.appUrl(shareState(true));
    var r = currentRoute();
    var km = r ? (r.stats.total / 1000).toFixed(1).replace('.', ',') : '';
    var text = 'Parcours de course à pied ' + km + ' km';
    if (Share.canShare()) {
      Share.share('JogRoute', text, url).catch(function () { qrModalFor(url); });
    } else {
      qrModalFor(url);
    }
  });

  function qrModalFor(url) {
    var svg = Share.qrSvg(url, 3);
    openModal('Lien du parcours',
      (svg ? '<div class="qr">' + svg + '</div>' : '') +
      '<p class="hint" style="margin:0 0 10px">Ce lien rouvre JogRoute avec le tracé exact, ' +
      'sur n\'importe quel appareil.</p>' +
      '<div class="url">' + escapeHtml(url) + '</div>' +
      '<div class="row"><button id="mdCopy2" class="primary-soft">Copier le lien</button></div>');
    $('mdCopy2').addEventListener('click', function () {
      var b = this;
      Share.copy(url).then(function () { b.textContent = 'Copié ✓'; })
        .catch(function () { b.textContent = 'Copie refusée'; });
    });
  }

  function openModal(title, html) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = html;
    $('modal').hidden = false;
  }
  function closeModal() { $('modal').hidden = true; }
  $('modalClose').addEventListener('click', closeModal);
  $('modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  /* ================= historique « j'ai couru ça » ================= */

  $('btnSaveRun').addEventListener('click', function () {
    var r = currentRoute();
    if (!r) return;
    var pts = ptsOf(r);
    var cells = Geo.cellsAlong(pts, 15);
    Store.addRun(cells, r.stats.total / 1000, '');
    this.textContent = '✓ Enregistré';
    var b = this;
    setTimeout(function () { b.textContent = '✓ J\'ai couru ça'; }, 2500);
    syncLabels();
  });

  $('btnClearRuns').addEventListener('click', function () {
    if (!confirm('Effacer l\'historique des sorties mémorisées ?')) return;
    Store.clearRuns();
    syncLabels();
  });

  /* ================= export GPX ================= */

  function buildGpx(r) {
    var km = (r.stats.total / 1000).toFixed(2);
    var pts = ptsOf(r);
    var NL = '\n';
    var body = pts.map(function (p, i) {
      var e = r.hasEle && r.ele ? '<ele>' + r.ele[i].toFixed(1) + '</ele>' : '';
      return '   <trkpt lat="' + p[0].toFixed(7) + '" lon="' + p[1].toFixed(7) + '">' + e + '</trkpt>';
    }).join(NL);
    return '<?xml version="1.0" encoding="UTF-8"?>' + NL +
      '<gpx version="1.1" creator="JogRoute" xmlns="http://www.topografix.com/GPX/1/1">' + NL +
      ' <metadata><name>Jogging ' + km + ' km</name><time>' +
      new Date().toISOString() + '</time></metadata>' + NL +
      ' <trk><name>Jogging ' + km + ' km</name><trkseg>' + NL +
      body + NL + ' </trkseg></trk>' + NL + '</gpx>' + NL;
  }

  $('btnGpx').addEventListener('click', function () {
    var r = currentRoute();
    if (!r) return;
    var url = URL.createObjectURL(new Blob([buildGpx(r)], { type: 'application/gpx+xml' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'jogging-' + (r.stats.total / 1000).toFixed(1).replace('.', '_') + 'km.gpx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  /* ================= zones hors ligne ================= */

  $('btnOffline').addEventListener('click', async function () {
    if (!state.start) { status('Posez d\'abord un point de départ.', 0, true); return; }
    var btn = this;
    btn.disabled = true;
    state.busy = true;
    startTimer();
    try {
      var cfg = params();
      /* on prend un palier de plus, pour couvrir aussi les distances voisines */
      var idx = RADIUS_STEPS.indexOf(neededRadius(cfg.p));
      var needed = RADIUS_STEPS[Math.min(RADIUS_STEPS.length - 1, idx + 1)];
      state.zone = null;
      await ensureGraph(needed);
      status('Zone gardée hors ligne ✓', 1);
      renderZones();
    } catch (err) {
      status('Téléchargement impossible : ' + (err.message || err), 0, true);
    } finally {
      btn.disabled = false;
      state.busy = false;
      stopTimer();
    }
  });

  $('btnClearZones').addEventListener('click', function () {
    if (!confirm('Vider le cache des zones et des tuiles de relief ?')) return;
    Store.clearGraphs().then(function () {
      state.zone = null;
      renderZones();
    });
  });

  function renderZones() {
    Store.listGraphs().then(function (rows) {
      var box = $('zones');
      box.innerHTML = '';
      if (!rows.length) {
        box.innerHTML = '<p class="hint" style="margin:0">Aucune zone en cache pour l\'instant.</p>';
      }
      rows.forEach(function (z) {
        var el = document.createElement('div');
        el.className = 'zone';
        var age = Math.round((Date.now() - z.t) / 864e5);
        el.innerHTML = '<span class="zn"><b>' +
          escapeHtml(z.label || (z.lat.toFixed(3) + ', ' + z.lon.toFixed(3))) + '</b>' +
          '<span>rayon ' + (z.radius / 1000).toFixed(1) + ' km · ' +
          Math.round(z.bytes / 1024) + ' Ko · ' + (z.hasEle ? 'relief · ' : '') +
          (age === 0 ? 'aujourd\'hui' : 'il y a ' + age + ' j') + '</span></span>';
        var go = document.createElement('button');
        go.textContent = 'Aller';
        go.addEventListener('click', function () { setStart(z.lat, z.lon, true); });
        var del = document.createElement('button');
        del.textContent = '✕';
        del.addEventListener('click', function () {
          Store.deleteGraph(z.key).then(renderZones);
        });
        el.appendChild(go); el.appendChild(del);
        box.appendChild(el);
      });
      return Store.usage();
    }).then(function (u) {
      if (u && u.usage) {
        $('storageInfo').textContent = 'Espace utilisé : ' + (u.usage / 1048576).toFixed(1) + ' Mo';
      }
    }).catch(function () { });
  }

  /* ================= préférences persistantes ================= */

  var SETTING_IDS = ['dist', 'minutes', 'pace', 'sector', 'nature', 'hilliness', 'dplus',
    'fresh', 'water', 'mode', 'objective'];
  var CHECK_IDS = ['green', 'steps', 'varied', 'round', 'night'];

  function saveSettings() {
    /* On repart des préférences stockées : syncLabels() s'exécute au
       démarrage, avant que le dernier départ ne soit restauré, et un objet
       neuf effacerait `lastStart` à chaque ouverture. */
    var s = Store.settings() || {};
    SETTING_IDS.forEach(function (id) { s[id] = $(id).value; });
    CHECK_IDS.forEach(function (id) { s[id] = $(id).checked; });
    s.direction = direction;
    if (state.start) s.lastStart = { lat: state.start.lat, lon: state.start.lon };
    Store.saveSettings(s);
  }

  function loadSettings() {
    var s = Store.settings();
    if (!s || !Object.keys(s).length) return;
    SETTING_IDS.forEach(function (id) { if (s[id] !== undefined) $(id).value = s[id]; });
    CHECK_IDS.forEach(function (id) { if (s[id] !== undefined) $(id).checked = s[id]; });
    if (s.direction !== undefined) setDirection(s.direction);
  }

  /* ================= lien entrant ================= */

  function applyShared(st) {
    if (st.dist !== undefined) $('dist').value = st.dist;
    if (st.minutes !== undefined) $('minutes').value = st.minutes;
    if (st.mode) $('mode').value = st.mode;
    if (st.objective) $('objective').value = st.objective;
    if (st.pace !== undefined) $('pace').value = st.pace;
    if (st.nature !== undefined) $('nature').value = st.nature;
    if (st.sector !== undefined) $('sector').value = st.sector;
    if (st.hilliness !== undefined) $('hilliness').value = st.hilliness;
    if (st.dplus !== undefined) $('dplus').value = st.dplus;
    if (st.water !== undefined) $('water').value = st.water;
    if (st.flags !== undefined && st.flags !== '') {
      $('green').checked = st.flags.indexOf('g') >= 0;
      $('steps').checked = st.flags.indexOf('s') >= 0;
      $('varied').checked = st.flags.indexOf('v') >= 0;
      $('round').checked = st.flags.indexOf('r') >= 0;
      $('night').checked = st.flags.indexOf('n') >= 0;
    }
    setDirection(st.direction === null || st.direction === undefined ? null : st.direction);
    setStart(st.lat, st.lon, true);
    if (st.endLat !== undefined) setEnd(st.endLat, st.endLon);
    syncLabels();

    if (!st.poly) return;

    /* Tracé partagé : affiché tel quel, sans attendre Overpass. */
    var pts = Geo.decodePolyline(st.poly);
    if (pts.length < 2) return;
    var n = pts.length;
    var coords = new Float64Array(2 * n), cum = new Float32Array(n);
    var acc = 0;
    for (var i = 0; i < n; i++) {
      coords[2 * i] = pts[i][0]; coords[2 * i + 1] = pts[i][1];
      if (i > 0) acc += Geo.haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      cum[i] = acc;
    }
    var paceSecPerKm = +$('pace').value * 60;
    state.shared = {
      coords: coords, cum: cum, ele: new Float32Array(n), hasEle: false,
      fams: new Uint8Array(n - 1).fill(2), compact: Geo.compactness(pts, acc),
      brg: Geo.bearing(pts[0][0], pts[0][1], pts[Math.floor(n / 2)][0], pts[Math.floor(n / 2)][1]),
      overlapFrac: 0, turn: null,
      stats: {
        total: acc, time: acc / 1000 * paceSecPerKm,
        fam: { sentier: 0, pieton: 0, calme: acc, route: 0 },
        unpaved: 0, green: 0, steps: 0, lit: 0, natural: 0, overlap: 0,
        climb: 0, descent: 0, waterStops: 0, maxDryGap: 0
      }
    };
    state.routes = [];
    draw(state.shared, true);
    showStats(state.shared);
    $('variantsBox').style.display = 'none';
    $('shareHint').textContent = 'Tracé reçu par lien : distance et durée sont exactes, ' +
      'mais les statistiques de terrain demandent un calcul local (bouton « Générer »).';
  }

  /* ================= PWA ================= */

  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    $('btnInstall').hidden = false;
  });
  $('btnInstall').addEventListener('click', function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.finally(function () {
      deferredPrompt = null;
      $('btnInstall').hidden = true;
    });
  });

  function updateOnline() {
    $('offlineBadge').hidden = navigator.onLine;
  }
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('service worker non enregistré :', e.message);
      });
    });
  }

  /* Accès de débogage depuis la console du navigateur */
  window.JogRoute = {
    state: state, map: map, run: run, setStart: setStart, setEnd: setEnd,
    buildGpx: buildGpx, engine: engine, Store: Store
  };

  /* ================= démarrage ================= */

  loadSettings();
  syncLabels();
  renderFavorites();
  renderZones();
  updateOnline();
  updateEndInfo();

  /* Dernier départ connu : l'app s'ouvre là où on était, même si le GPS
     tarde ou échoue. */
  function restoreLastStart() {
    var s = Store.settings();
    if (s && s.lastStart && isFinite(s.lastStart.lat) && isFinite(s.lastStart.lon)) {
      setStart(s.lastStart.lat, s.lastStart.lon, true);
      return true;
    }
    return false;
  }

  function geoHint(html) { $('startInfo').innerHTML = html; }

  function autoLocate() {
    var why = geoUnavailableReason();
    if (why) {
      geoHint('<b>Position automatique indisponible.</b> ' + escapeHtml(why));
      return;
    }

    function attempt() {
      locate(function (v) {
        if (state.userPicked) return;
        setStart(v.lat, v.lon, false);
        showAccuracy(v.lat, v.lon, v.acc);
      }).then(function (v) {
        if (state.userPicked) return;          // l'utilisateur a choisi entre-temps
        setStart(v.lat, v.lon, true);
        showAccuracy(v.lat, v.lon, v.acc);
      }).catch(function (err) {
        if (state.userPicked) return;
        geoHint('<b>Position automatique impossible.</b> ' + escapeHtml(geoErrorText(err)) +
          '<br>Touchez <b>« 📍 Ma position »</b> pour réessayer, cherchez une adresse, ' +
          'ou touchez simplement la carte.');
      });
    }

    /* Si la permission a déjà été refusée, inutile de relancer une demande que
       le navigateur bloquera : on l'explique tout de suite. */
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' }).then(function (p) {
        if (p.state === 'denied') {
          geoHint('<b>Position automatique impossible.</b> ' + escapeHtml(geoErrorText({ code: 1 })));
          return;
        }
        attempt();
      }).catch(attempt);
    } else {
      attempt();
    }
  }

  var incoming = Share.decodeState(location.hash);
  if (incoming) {
    applyShared(incoming);
  } else {
    restoreLastStart();
    autoLocate();
  }
})();

/* tracker.js — suivi en direct d'une sortie : distance parcourue et nombre de pas.

   · distance — positions GPS filtrées (précision, bruit d'immobilité, sauts)
     puis cumulées ; la trace réelle est conservée pour l'export GPX ;
   · pas — détection de crêtes sur l'accéléromètre (DeviceMotion). Sans capteur
     (ordinateur, permission refusée), les pas sont *estimés* à partir de la
     distance et de la vitesse via une longueur de foulée.

   Les deux algorithmes de mesure eux-mêmes vivent dans `js/metrics.js`, sans
   aucune dépendance au navigateur, pour pouvoir être mis sur un banc d'essai
   (`test/metrics.test.js`). Ce fichier-ci branche les capteurs, tient les
   cumuls, et gère la vie de la sortie : pause, gel, sauvegarde, reprise.

   Rien ne quitte l'appareil. La sortie en cours est recopiée en localStorage à
   intervalle régulier : un rechargement de page (ou un onglet tué par le
   téléphone) ne perd ni la distance, ni les pas, ni la trace. */
(function (global) {
  'use strict';

  var SAVE_EVERY = 5000;    // ms entre deux sauvegardes locales

  /* Le filtre de distance : réarmé à chaque pause, chaque gel et chaque
     nouvelle sortie, pour que l'immobilité écoulée ne compte jamais. */
  var gps = new Metrics.DistanceFilter();

  /* ================= podomètre =================
     L'algorithme est dans Metrics.Pedometer ; ici on ne fait que l'abonner au
     capteur, et gérer la permission que réclame iOS. */

  var Ped = (function () {
    var ped = new Metrics.Pedometer();
    var listening = false;

    function onMotion(ev) {
      var a = ev.accelerationIncludingGravity || ev.acceleration;
      if (!a || a.x === null || a.x === undefined) return;
      ped.sample(Date.now(), a.x, a.y, a.z);
    }

    function supported() {
      return typeof global.DeviceMotionEvent !== 'undefined';
    }

    /* iOS ≥ 13 exige une demande explicite, déclenchée par un geste utilisateur. */
    function request() {
      if (!supported()) return Promise.resolve(false);
      var D = global.DeviceMotionEvent;
      if (typeof D.requestPermission !== 'function') return Promise.resolve(true);
      try {
        return D.requestPermission()
          .then(function (r) { return r === 'granted'; })
          .catch(function () { return false; });
      } catch (e) { return Promise.resolve(false); }
    }

    return {
      supported: supported,
      request: request,
      start: function () {
        if (listening || !supported()) return;
        ped.rearm();                     // le capteur repart, le compteur non
        global.addEventListener('devicemotion', onMotion);
        listening = true;
      },
      stop: function () {
        if (!listening) return;
        global.removeEventListener('devicemotion', onMotion);
        listening = false;
      },
      reset: function () { ped.reset(); },
      set: function (n) { ped.set(n); },
      count: function () { return ped.count(); },
      /* Le capteur envoie-t-il vraiment des données ? (permission muette, PC fixe…) */
      live: function () { return listening && ped.receiving(); },
      cadence: function () { return ped.cadence(); }
    };
  })();

  var strideFor = Metrics.strideFor;

  /* ================= session ================= */

  var listeners = [];
  var S = null, watchId = null, ticker = null, saver = null, wakeLock = null;

  /* Le filtre de distance vit au niveau du module : toute session qui naît ou
     renaît doit le réarmer, sinon elle hériterait de l'ancre de la précédente. */
  function blank() {
    gps.reset();
    return {
      active: false,        // une sortie est ouverte (en cours ou en pause)
      paused: false,
      done: false,          // terminée, en attente d'export/enregistrement
      t0: 0,                // horodatage du départ
      base: 0,              // secondes déjà écoulées avant la reprise courante
      since: 0,             // ms du dernier départ/reprise
      dist: 0,              // mètres
      steps: 0,             // pas comptés par le capteur
      est: 0,               // pas estimés (repli sans capteur), fractionnaire
      sensor: false,        // le capteur a fourni assez de pas pour être cru
      speed: 0,             // m/s lissée
      acc: null,            // précision GPS courante (m)
      pts: [],              // trace réelle [[lat, lon], …]
      ts: [],               // secondes depuis t0, en parallèle de pts
      lastBeat: 0,          // dernier battement d'horloge (détection des gels)
      frozen: 0,            // secondes pendant lesquelles la page était gelée
      gaps: 0,              // nombre de trous rencontrés
      error: null,
      restored: false
    };
  }

  function seconds() {
    if (!S) return 0;
    if (!S.active) return S.base;
    return S.base + (S.paused ? 0 : (Date.now() - S.since) / 1000);
  }

  function snapshot() {
    if (!S) S = blank();
    var sec = seconds();
    /* Temps réellement mesuré : pendant un gel, la montre avance mais pas la
       distance. Rapporter l'un à l'autre donnerait une allure fantaisiste, donc
       l'allure se calcule sur le temps compté, et le trou est signalé à part. */
    var counted = Math.max(0, sec - S.frozen);
    var steps = S.sensor ? S.steps : Math.round(S.est);
    return {
      active: S.active, paused: S.paused, done: S.done,
      seconds: sec,
      counted: counted,
      frozen: S.frozen,
      gaps: S.gaps,
      dist: S.dist,
      steps: steps,
      estimated: !S.sensor,
      sensing: Ped.live(),        // le capteur parle, mais il est trop tôt pour trancher
      cadence: S.sensor ? Ped.cadence() : (counted > 30 && steps ? Math.round(steps * 60 / counted) : 0),
      stride: steps > 20 ? S.dist / steps : 0,
      speed: S.speed,
      pace: S.dist > 80 && counted > 20 ? counted / (S.dist / 1000) : 0,
      acc: S.acc,
      background: bgWanted,       // l'utilisateur veut survivre à l'écran éteint
      backgroundOk: bgOk,         // …et le navigateur l'a effectivement accordé
      pts: S.pts,
      ts: S.ts,
      error: S.error,
      restored: S.restored,
      t0: S.t0
    };
  }

  function emit() {
    var s = snapshot();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](s); } catch (e) { console.warn('tracker:', e); }
    }
  }

  /* ---------------- GPS ----------------
     Le filtrage (bruit d'immobilité, bruit de marche, sauts de position) est
     dans Metrics.DistanceFilter. Ici on ne fait qu'accumuler ce qu'il valide,
     et traduire ses verdicts en messages lisibles. */

  function push(lat, lon, t) {
    S.pts.push([lat, lon]);
    S.ts.push(Math.round((t - S.t0) / 1000));
    if (S.pts.length > 20000) { S.pts.shift(); S.ts.shift(); }
  }

  function onPos(pos) {
    if (!S || !S.active || S.paused) return;
    var c = pos.coords;
    var t = pos.timestamp || Date.now();
    S.acc = c.accuracy || 0;

    var r = gps.push(c.latitude, c.longitude, c.accuracy || 0, t);

    if (r.status === 'stale') return;                         // horodatage non croissant

    if (r.status === 'inaccurate') {
      S.error = 'Signal GPS trop imprécis (± ' + Math.round(r.acc) + ' m) — la distance ' +
        'ne compte pas encore. Sortez à l\'air libre.';
      emit();
      return;
    }

    S.error = null;

    if (r.status === 'first') { push(r.lat, r.lon, t); emit(); return; }

    if (r.status === 'move') {
      S.dist += r.d;
      S.speed = S.speed ? S.speed + 0.4 * (r.speed - S.speed) : r.speed;
      if (!S.sensor) S.est += r.d / strideFor(r.speed);        // repli sans capteur
      push(r.lat, r.lon, t);
    }
    emit();
  }

  function onPosError(err) {
    if (!S) return;
    var code = err && err.code;
    S.error = code === 1
      ? 'Position refusée : autorisez l\'accès à la position pour compter la distance.'
      : (code === 2
        ? 'Signal GPS perdu — la distance repart dès que le point revient.'
        : 'Le GPS met du temps à répondre…');
    emit();
  }

  function startWatch() {
    if (watchId !== null || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition(onPos, onPosError, {
      enableHighAccuracy: true, timeout: 30000, maximumAge: 0
    });
  }

  function stopWatch() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }

  /* ---------------- écran allumé ---------------- */

  function keepAwake(on) {
    if (!navigator.wakeLock) return;
    if (on) {
      if (wakeLock) return;
      navigator.wakeLock.request('screen').then(function (w) {
        wakeLock = w;
        w.addEventListener('release', function () { wakeLock = null; });
      }).catch(function () { });
    } else if (wakeLock) {
      wakeLock.release().catch(function () { });
      wakeLock = null;
    }
  }

  /* ---------------- survivre à l'écran éteint ----------------
     Un onglet muet est gelé dès que l'écran s'éteint : plus de GPS, plus
     d'accéléromètre, plus de minuteur. Un onglet qui *émet du son*, lui, reste
     vivant sur Android (et souvent sur iOS). On diffuse donc une piste d'une
     seconde bouclée dont les échantillons valent ±1 sur 16 bits — soit −90 dBFS,
     rigoureusement inaudible, mais un flux sonore aux yeux du navigateur.

     Ce n'est pas une garantie : iOS peut suspendre quand même, et Android donne
     le focus audio à la page, ce qui peut mettre la musique en pause. D'où une
     case à cocher, et non un comportement imposé. */

  var audioEl = null, bgWanted = false, bgOk = false;

  function silentTrack() {
    var rate = 8000, n = rate;                       // une seconde, bouclée
    var buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), i;
    function str(off, s) { for (i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (i = 0; i < n; i++) v.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  function keepAlive(on) {
    if (typeof Audio === 'undefined') return;
    if (on && bgWanted) {
      if (!audioEl) {
        audioEl = new Audio(silentTrack());
        audioEl.loop = true;
        audioEl.volume = 1;
        audioEl.setAttribute('playsinline', '');
      }
      /* Le navigateur peut refuser la lecture : autant le savoir et le dire,
         plutôt que de laisser croire à une protection qui n'existe pas. */
      var p = audioEl.play();
      if (p && p.then) {
        p.then(function () { bgOk = true; emit(); },
          function () { bgOk = false; emit(); });
      } else {
        bgOk = true;
      }
      /* Le bandeau média annonce ce qui tourne, au lieu d'un « son inconnu ». */
      if (navigator.mediaSession && global.MediaMetadata) {
        try {
          navigator.mediaSession.metadata = new global.MediaMetadata({
            title: 'Sortie en cours', artist: 'JogRoute'
          });
        } catch (e) { }
      }
    } else if (audioEl) {
      audioEl.pause();
      bgOk = false;
    }
  }

  /* Préférence « continuer écran éteint », pilotée depuis l'interface. */
  function background(on) {
    bgWanted = !!on;
    keepAlive(bgWanted && !!S && S.active && !S.paused);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') { save(); return; }
    if (S && S.active && !S.paused) keepAwake(true);
    beat();                       // retour au premier plan : mesurer le trou tout de suite
  });

  /* ---------------- battement : durée, cadence, gels ---------------- */

  var GAP_MIN = 20;               // s — au-delà, la page a bel et bien été gelée

  function beat() {
    if (!S || !S.active || S.paused) return;
    var now = Date.now();

    /* Si le battement d'une seconde a sauté plusieurs dizaines de secondes,
       c'est que le téléphone a suspendu la page. On ne relie pas les deux bords
       du trou — la distance parcourue entre-temps est inconnue, pas nulle — et
       on la déclare au lieu de l'inventer. */
    if (S.lastBeat && now - S.lastBeat > GAP_MIN * 1000) {
      S.frozen += (now - S.lastBeat) / 1000;
      S.gaps++;
      gps.reset();
    }
    S.lastBeat = now;

    /* Le capteur a pris le relais : on abandonne l'estimation par la foulée. */
    if (!S.sensor && Ped.live() && Ped.count() > 8) {
      S.sensor = true;
      S.steps = Ped.count();
    }
    if (S.sensor) S.steps = Ped.count();
    emit();
  }

  function loops(on) {
    clearInterval(ticker); clearInterval(saver);
    ticker = saver = null;
    if (!on) return;
    ticker = setInterval(beat, 1000);
    saver = setInterval(save, SAVE_EVERY);
  }

  /* ---------------- sauvegarde locale ---------------- */

  function save() {
    if (!S || !S.active) return;
    Store.saveLive({
      v: 1, t0: S.t0, base: seconds(), dist: S.dist, steps: S.steps,
      est: S.est, sensor: S.sensor, savedAt: Date.now(),
      frozen: S.frozen, gaps: S.gaps,
      poly: Geo.encodePolyline(S.pts), ts: S.ts
    });
  }

  /* ================= API ================= */

  function start() {
    S = blank();
    S.active = true;
    S.t0 = Date.now();
    S.since = S.t0;
    S.lastBeat = S.t0;
    Ped.reset();
    return Ped.request().then(function (ok) {
      if (ok) Ped.start();
      startWatch();
      keepAwake(true);
      keepAlive(true);
      loops(true);
      emit();
      return ok;
    });
  }

  function pause() {
    if (!S || !S.active || S.paused) return;
    S.base = seconds();
    S.paused = true;
    gps.reset();                      // à la reprise, l'immobilité ne compte pas
    Ped.stop();
    stopWatch();
    keepAwake(false);
    keepAlive(false);
    save();
    emit();
  }

  function resume() {
    if (!S || !S.active || !S.paused) return;
    S.paused = false;
    S.since = Date.now();
    S.lastBeat = S.since;             // la pause n'est pas un gel : pas de trou à compter
    S.restored = false;
    Ped.set(S.steps);
    Ped.request().then(function (ok) {
      if (ok) Ped.start();
      startWatch();
      keepAwake(true);
      keepAlive(true);
      loops(true);
      emit();
    });
  }

  function stop() {
    if (!S || !S.active) return null;
    S.base = seconds();
    S.active = false;
    S.paused = false;
    S.done = true;
    S.restored = false;      // la sortie n'est plus « en attente de décision »
    Ped.stop();
    stopWatch();
    keepAwake(false);
    keepAlive(false);
    loops(false);
    Store.clearLive();
    emit();
    return snapshot();
  }

  function reset() {
    Ped.stop(); Ped.reset(); stopWatch(); keepAwake(false); keepAlive(false); loops(false);
    Store.clearLive();
    S = blank();
    emit();
  }

  /* Sortie interrompue par un rechargement : on la rouvre en pause. */
  function restore() {
    var raw = Store.liveSession();
    if (!raw || !raw.t0) return null;
    S = blank();
    S.active = true;
    S.paused = true;
    S.restored = true;
    S.t0 = raw.t0;
    S.base = raw.base || 0;
    S.dist = raw.dist || 0;
    S.steps = raw.steps || 0;
    S.est = raw.est || 0;
    S.sensor = !!raw.sensor;
    S.frozen = raw.frozen || 0;
    S.gaps = raw.gaps || 0;
    S.pts = raw.poly ? Geo.decodePolyline(raw.poly) : [];
    S.ts = raw.ts || [];
    /* Le temps écoulé depuis la dernière sauvegarde n'a pas été mesuré non plus :
       la sortie était interrompue, pas en pause. */
    var lost = (Date.now() - (raw.savedAt || Date.now())) / 1000;
    if (lost > GAP_MIN) { S.frozen += lost; S.gaps++; S.base += lost; }
    Ped.set(S.steps);
    emit();
    return snapshot();
  }

  global.Tracker = {
    start: start, pause: pause, resume: resume, stop: stop, reset: reset,
    restore: restore, snapshot: snapshot, background: background,
    pedometer: Ped, strideFor: strideFor,
    on: function (fn) { listeners.push(fn); return fn; }
  };
})(window);

/* coach.js — ce que l'application dit et fait pendant la course.

   Le reste de l'app suppose qu'on regarde l'écran. En courant, on ne le regarde
   pas : il est dans une poche, ou noir. Ce module s'adresse donc aux deux sens
   qui restent disponibles — l'ouïe et le toucher :

   · **annonces vocales** à chaque kilomètre (distance, temps, allure du km) ;
   · **vibration** à l'approche d'un changement de direction du parcours ;
   · **temps de passage** par kilomètre, relevés pendant la sortie et
     consultables à l'arrivée.

   Trois choses qu'il ne fait pas, délibérément :
   · parler sans qu'on le lui ait demandé — tout est derrière une case à cocher ;
   · prétendre vibrer là où c'est impossible — `supportsVibration()` dit la
     vérité, et iOS ne l'accorde à aucune page web ;
   · deviner un temps de passage. Un kilomètre franchi pendant un gel de la page
     n'est pas annoncé : la distance parcourue entre-temps est inconnue.

   Aucun état durable : tout se reconstruit au démarrage d'une sortie. */
(function (global) {
  'use strict';

  /* ================= réglages ================= */

  var cfg = { voice: false, vibrate: false };

  function configure(opts) {
    if (opts.voice !== undefined) cfg.voice = !!opts.voice;
    if (opts.vibrate !== undefined) cfg.vibrate = !!opts.vibrate;
  }

  function supportsVoice() {
    return typeof global.speechSynthesis !== 'undefined' &&
      typeof global.SpeechSynthesisUtterance !== 'undefined';
  }

  /* iOS ne l'expose sur aucun navigateur, y compris Chrome et Firefox : leur
     moteur est celui de Safari. Mieux vaut griser la case que promettre. */
  function supportsVibration() {
    return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }

  /* ================= voix ================= */

  var voice = null, voiceChecked = false;

  /* La liste des voix arrive de façon asynchrone sur la plupart des
     navigateurs : on la relit tant qu'elle est vide. */
  function pickVoice() {
    if (voiceChecked && voice) return voice;
    if (!supportsVoice()) return null;
    var all = global.speechSynthesis.getVoices() || [];
    if (!all.length) return null;
    voiceChecked = true;
    for (var i = 0; i < all.length; i++) {
      if (/^fr/i.test(all[i].lang)) { voice = all[i]; return voice; }
    }
    voice = null;                       // pas de voix française : on laisse choisir
    return null;
  }

  if (supportsVoice() && global.speechSynthesis.addEventListener) {
    global.speechSynthesis.addEventListener('voiceschanged', function () {
      voiceChecked = false;
      pickVoice();
    });
  }

  function say(text) {
    if (!cfg.voice || !supportsVoice() || !text) return false;
    try {
      var u = new global.SpeechSynthesisUtterance(text);
      u.lang = 'fr-FR';
      u.rate = 1;
      var v = pickVoice();
      if (v) u.voice = v;
      global.speechSynthesis.speak(u);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* Safari et Chrome refusent de parler si la toute première prise de parole
     n'est pas déclenchée par un geste. On dépense donc une phrase vide au
     moment où l'utilisateur appuie sur « Démarrer ».

     Uniquement si la voix est demandée : prendre le focus audio pour rien
     couperait la musique de quelqu'un qui n'a rien réclamé. */
  function prime() {
    if (!cfg.voice || !supportsVoice()) return;
    try {
      var u = new global.SpeechSynthesisUtterance(' ');
      u.volume = 0;
      global.speechSynthesis.speak(u);
    } catch (e) { }
    pickVoice();
  }

  function buzz(pattern) {
    if (!cfg.vibrate || !supportsVibration()) return false;
    try { return navigator.vibrate(pattern) !== false; } catch (e) { return false; }
  }

  /* ================= formulation ================= */

  /* « 5 kilomètres, 27 minutes 30, dernier kilomètre en 5 minutes 24 ».
     On écrit les nombres en toutes lettres plutôt qu'en chiffres : « 5:24 »
     se prononce « cinq deux points vingt-quatre » sur plusieurs moteurs. */
  function spokenDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var out = [];
    if (h) out.push(h + (h > 1 ? ' heures' : ' heure'));
    if (m) out.push(m + (m > 1 ? ' minutes' : ' minute'));
    if (s || !out.length) out.push(s + (s > 1 ? ' secondes' : ' seconde'));
    return out.join(' ');
  }

  function splitSentence(km, elapsed, lastKmSec) {
    var phrase = km + (km > 1 ? ' kilomètres' : ' kilomètre') +
      ', ' + spokenDuration(elapsed);
    if (lastKmSec > 0) phrase += ', dernier kilomètre en ' + spokenDuration(lastKmSec);
    return phrase + '.';
  }

  /* ================= temps de passage ================= */

  var splits = [];            // [{ km, at (s depuis le départ), sec (durée du km) }]
  var nextKm = 1;
  var prev = null;            // dernier échantillon { dist, counted }
  var lastGaps = 0;           // pour savoir si un gel s'est glissé dans ce km

  function resetSplits() {
    splits = [];
    nextKm = 1;
    prev = null;
    lastGaps = 0;
  }

  /* Un kilomètre est franchi entre deux relevés : on interpole l'instant exact
     plutôt que de prendre celui du relevé suivant, qui décalerait chaque temps
     de passage d'une fraction de seconde de plus que le précédent. */
  function crossKm(dist, counted) {
    var out = [];
    while (dist >= nextKm * 1000) {
      var at;
      if (prev && dist > prev.dist) {
        var f = (nextKm * 1000 - prev.dist) / (dist - prev.dist);
        at = prev.counted + f * (counted - prev.counted);
      } else {
        at = counted;
      }
      var before = splits.length ? splits[splits.length - 1].at : 0;
      var s = { km: nextKm, at: at, sec: at - before };
      splits.push(s);
      out.push(s);
      nextKm++;
    }
    return out;
  }

  /* ================= virages du parcours ================= */

  var route = null;           // { pts, cum, turns:[{i, cum, side, angle}] }
  var lastIndex = 0;          // où l'on se croit sur le tracé
  var announcedTurn = -1;     // index du dernier virage signalé
  var stagedTurn = -1;        // virage déjà annoncé de loin

  var TURN_MIN_ANGLE = 40;    // ° — en deçà, c'est une courbe, pas un virage
  var TURN_FAR = 45;          // m — premier avertissement
  var TURN_NEAR = 12;         // m — « c'est maintenant »

  /* Repère les vrais changements de direction. Un tracé OSM est découpé en
     segments courts : on compare donc des caps mesurés sur une trentaine de
     mètres de part et d'autre, sinon chaque irrégularité du relevé passerait
     pour un virage. */
  function findTurns(pts, cum) {
    var turns = [], n = pts.length;
    var SPAN = 30;
    for (var i = 1; i < n - 1; i++) {
      var a = i, b = i;
      while (a > 0 && cum[i] - cum[a] < SPAN) a--;
      while (b < n - 1 && cum[b] - cum[i] < SPAN) b++;
      if (a === i || b === i) continue;

      var inBrg = Geo.bearing(pts[a][0], pts[a][1], pts[i][0], pts[i][1]);
      var outBrg = Geo.bearing(pts[i][0], pts[i][1], pts[b][0], pts[b][1]);
      var delta = Geo.angleDiff(inBrg, outBrg);
      if (delta < TURN_MIN_ANGLE) continue;

      /* Deux sommets voisins décrivent le même virage : on garde le plus net. */
      var last = turns[turns.length - 1];
      if (last && cum[i] - last.cum < SPAN) {
        if (delta > last.angle) { last.i = i; last.cum = cum[i]; last.angle = delta; last.side = side(inBrg, outBrg); }
        continue;
      }
      turns.push({ i: i, cum: cum[i], angle: delta, side: side(inBrg, outBrg) });
    }
    return turns;
  }

  function side(inBrg, outBrg) {
    var d = ((outBrg - inBrg + 540) % 360) - 180;
    return d > 0 ? 'droite' : 'gauche';
  }

  /* Le parcours affiché, ou null. `pts` = [[lat, lon], …]. */
  function setRoute(pts) {
    lastIndex = 0;
    announcedTurn = -1;
    stagedTurn = -1;
    if (!pts || pts.length < 3) { route = null; return null; }

    var cum = new Float64Array(pts.length);
    for (var i = 1; i < pts.length; i++) {
      cum[i] = cum[i - 1] +
        Geo.haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    }
    route = { pts: pts, cum: cum, turns: findTurns(pts, cum) };
    return route;
  }

  /* Où en est-on sur le tracé ? On cherche autour de la position précédente et
     non sur tout le parcours : sur une boucle, le point le plus proche dans
     l'absolu peut être de l'autre côté, à quelques mètres mais à des kilomètres
     de marche. La fenêtre s'élargit tant qu'on ne trouve rien de crédible. */
  var MATCH_TOLERANCE = 40;   // m — au-delà, on considère qu'on a quitté le tracé

  function locate(lat, lon) {
    if (!route) return -1;
    var pts = route.pts, n = pts.length;
    for (var span = 60; span <= n; span *= 4) {
      var lo = Math.max(0, lastIndex - 10);
      var hi = Math.min(n - 1, lastIndex + span);
      var best = -1, bd = Infinity;
      for (var i = lo; i <= hi; i++) {
        var d = Geo.haversine(pts[i][0], pts[i][1], lat, lon);
        if (d < bd) { bd = d; best = i; }
      }
      if (bd <= MATCH_TOLERANCE) { lastIndex = best; return best; }
      if (hi === n - 1 && lo === 0) break;
    }
    return -1;
  }

  /* Le prochain virage devant soi, et la distance qui en sépare. */
  function nextTurn(index) {
    if (!route || index < 0) return null;
    var here = route.cum[index];
    for (var k = 0; k < route.turns.length; k++) {
      var t = route.turns[k];
      if (t.cum <= here) continue;
      return { turn: t, index: k, away: t.cum - here };
    }
    return null;
  }

  /* ================= le fil de la sortie ================= */

  var running = false;

  function start() {
    resetSplits();
    announcedTurn = -1;
    stagedTurn = -1;
    lastIndex = 0;
    running = true;
    prime();
  }

  function stop() { running = false; }

  /* Appelé à chaque rafraîchissement du suivi. `s` est l'instantané du
     Tracker. Renvoie ce qui a été déclenché, pour que l'appelant puisse
     l'afficher — et pour que les tests puissent le vérifier. */
  function tick(s) {
    var events = [];
    if (!running || !s.active || s.paused) return events;

    /* --- kilomètres --- */
    var crossed = crossKm(s.dist, s.counted);
    for (var i = 0; i < crossed.length; i++) {
      var c = crossed[i];
      events.push({ type: 'split', split: c });
      /* Un kilomètre franchi à cheval sur un gel : le temps du km est faux,
         on annonce la distance sans prétendre en donner l'allure. */
      say(splitSentence(c.km, c.at, s.gaps === lastGaps ? c.sec : 0));
      buzz([180, 90, 180]);
    }
    lastGaps = s.gaps;

    /* --- virages --- */
    if (route && s.pts.length) {
      var last = s.pts[s.pts.length - 1];
      var idx = locate(last[0], last[1]);
      var nt = nextTurn(idx);
      if (nt) {
        if (nt.away <= TURN_NEAR && announcedTurn !== nt.index) {
          announcedTurn = nt.index;
          stagedTurn = nt.index;
          events.push({ type: 'turn', when: 'now', side: nt.turn.side });
          buzz(nt.turn.side === 'droite' ? [300] : [120, 80, 120]);
          say('Tournez à ' + nt.turn.side + '.');
        } else if (nt.away <= TURN_FAR && stagedTurn !== nt.index) {
          stagedTurn = nt.index;
          events.push({ type: 'turn', when: 'soon', side: nt.turn.side, away: nt.away });
          buzz([60]);
        }
      }
    }

    prev = { dist: s.dist, counted: s.counted };
    return events;
  }

  global.Coach = {
    configure: configure,
    supportsVoice: supportsVoice,
    supportsVibration: supportsVibration,
    start: start, stop: stop, tick: tick,
    setRoute: setRoute,
    splits: function () { return splits.slice(); },
    resetSplits: resetSplits,
    /* exposés pour le banc d'essai */
    findTurns: findTurns, splitSentence: splitSentence, spokenDuration: spokenDuration,
    locate: locate, nextTurn: nextTurn, say: say, buzz: buzz
  };
})(self);

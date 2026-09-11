/* metrics.js — les deux mesures de la sortie, à l'état pur.

   Ce fichier ne connaît ni le DOM, ni les capteurs, ni le stockage : il reçoit
   des nombres et en rend d'autres. C'est délibéré — ce sont les deux
   algorithmes les plus délicats de l'application (et les plus faciles à casser
   sans s'en apercevoir), donc les seuls qu'on veuille pouvoir faire tourner sur
   un banc d'essai. `js/tracker.js` se charge des capteurs et leur donne à
   manger ; `test/` leur donne des signaux synthétiques.

   · Pedometer     — compte les pas dans un signal d'accéléromètre ;
   · DistanceFilter — décide quelle part d'un flux GPS bruité est du déplacement.

   Chargé dans la page comme dans un test Node : on s'accroche à `self`. */
(function (global) {
  'use strict';

  /* ================= podomètre =================
     La magnitude de l'accélération oscille autour de g d'environ ±2 m/s² à la
     marche et ±6 m/s² en courant. On lisse légèrement, puis on compte une crête
     par pas : le seuil est la moyenne des extrêmes de la dernière seconde, ce
     qui s'adapte tout seul à l'allure et à la façon de porter le téléphone
     (main, brassard, poche). */

  var PED_DEFAULTS = {
    minInterval: 250,   // ms — plafonne la cadence à ~240 pas/min
    minAmp: 1.2,        // m/s² crête-à-crête : en deçà, l'appareil est posé
    winMs: 1000,        // fenêtre du seuil adaptatif
    cadWin: 12000,      // fenêtre de calcul de la cadence
    smoothing: 0.35,    // gain du lissage de la magnitude
    liveMs: 3000        // au-delà, le capteur s'est tu
  };

  function Pedometer(opts) {
    this.o = {};
    for (var k in PED_DEFAULTS) {
      this.o[k] = opts && opts[k] !== undefined ? opts[k] : PED_DEFAULTS[k];
    }
    this.reset();
  }

  Pedometer.prototype.reset = function () {
    this.steps = 0;
    this.marks = [];        // horodatage des pas récents, pour la cadence
    this.lastStep = 0;
    this.buf = [];          // paires (t, v) à plat sur la fenêtre du seuil
    this.rearm();
  };

  /* Réarme la détection — lissage, seuil adaptatif, état de crête — sans
     toucher au compteur : c'est ce qu'il faut à la reprise d'une sortie, où le
     capteur repart de zéro mais où les pas déjà comptés doivent rester. */
  Pedometer.prototype.rearm = function () {
    this.buf = [];
    this.smooth = null;
    this.above = false;
    this.lastEvent = 0;
  };

  /* Repart d'un total connu (reprise d'une sortie) sans perdre la cadence. */
  Pedometer.prototype.set = function (n) { this.steps = n || 0; };
  Pedometer.prototype.count = function () { return this.steps; };

  /* Un échantillon d'accéléromètre. `t` en ms, l'accélération en m/s² gravité
     comprise. Renvoie true si ce point a fait avancer le compteur. */
  Pedometer.prototype.sample = function (t, x, y, z) {
    var o = this.o;
    this.lastEvent = t;

    var m = Math.sqrt(x * x + y * y + z * z);
    this.smooth = this.smooth === null ? m : this.smooth + o.smoothing * (m - this.smooth);

    var buf = this.buf;
    buf.push(t, this.smooth);
    while (buf.length > 2 && t - buf[0] > o.winMs) buf.splice(0, 2);

    var mn = Infinity, mx = -Infinity;
    for (var i = 1; i < buf.length; i += 2) {
      if (buf[i] < mn) mn = buf[i];
      if (buf[i] > mx) mx = buf[i];
    }
    var amp = mx - mn;
    if (amp < o.minAmp) { this.above = false; return false; }   // immobile : rien à compter

    var mid = (mx + mn) / 2, margin = amp * 0.1;                // hystérésis : pas de rebond
    if (!this.above) {
      if (this.smooth > mid + margin) this.above = true;
      return false;
    }
    if (this.smooth >= mid - margin) return false;

    this.above = false;
    if (t - this.lastStep < o.minInterval) return false;
    this.lastStep = t;
    this.steps++;
    this.marks.push(t);
    if (this.marks.length > 400) this.marks.splice(0, this.marks.length - 400);
    return true;
  };

  /* Le capteur envoie-t-il vraiment des données ? (permission muette, PC fixe…) */
  Pedometer.prototype.receiving = function (now) {
    return this.lastEvent > 0 && (now || Date.now()) - this.lastEvent < this.o.liveMs;
  };

  Pedometer.prototype.cadence = function (now) {
    now = now || Date.now();
    var marks = this.marks, i = 0;
    while (i < marks.length && now - marks[i] > this.o.cadWin) i++;
    var n = marks.length - i;
    if (n < 3) return 0;
    var span = marks[marks.length - 1] - marks[i];
    return span > 0 ? Math.round((n - 1) * 60000 / span) : 0;
  };

  /* Longueur de foulée plausible en fonction de la vitesse — sert au repli sans
     capteur (~0,73 m à 5 km/h, ~1,08 m à 3 m/s soit 5:30/km). */
  function strideFor(speed) {
    var v = speed > 0 ? speed : 1.4;
    return Math.max(0.45, Math.min(1.6, 0.42 + 0.22 * v));
  }

  /* ================= distance GPS =================
     Trois pièges, et un remède commun.

     · le bruit d'immobilité : un point qui « danse » de quelques mètres ajoute
       des kilomètres sur une heure ;
     · le bruit en marche : mesurer chaque segment de 3 m entre deux points
       bruités surestime la distance de 15 à 20 % ;
     · le saut brutal quand le téléphone raccroche le GPS.

     Le remède : on lisse la position (filtre exponentiel dont le gain suit la
     précision annoncée), puis on ne compte la distance que par bonds depuis une
     *ancre* — le dernier point validé. Tant que la position lissée n'a pas
     quitté un rayon d'environ une précision GPS autour de l'ancre, rien n'est
     compté ; sinon on ajoute la corde entière et l'ancre s'y déplace. La
     distance est donc mesurée par cordes d'une dizaine de mètres, bien moins
     sensibles au bruit que des segments de 3 m.

     Réserve honnête : à l'arrêt, le compteur est figé tant que le signal est
     bon, mais à ±8 m annoncés le rayon d'ancre ne vaut plus qu'environ 3,5
     écarts-types de la position lissée, et une station debout prolongée finit
     par faire grimper le compteur de quelques centaines de mètres à l'heure.
     L'élargir figerait l'arrêt mais sous-estimerait les trajets sinueux :
     l'arbitrage reste à trancher (test marqué `todo` dans metrics.test.js).

     Le filtre ne tient aucun total : il dit, point par point, ce qui compte.
     Les cumuls appartiennent à la sortie, qui doit pouvoir les restaurer. */

  var GPS_DEFAULTS = {
    maxAcc: 40,       // m — au-delà, le point est inexploitable
    maxSpeed: 12,     // m/s — au-delà, c'est un saut de position, pas une foulée
    jumpMargin: 4,    // marge de bruit, en précisions annoncées (voir plus bas)
    minMove: 8,       // m — rayon d'ancre plancher
    accFactor: 1.2,   // rayon d'ancre = max(minMove, accFactor × précision)
    tauPerAcc: 8,     // précision ÷ ceci = constante de temps du lissage (s)
    tauMin: 1, tauMax: 6
  };

  function DistanceFilter(opts) {
    this.o = {};
    for (var k in GPS_DEFAULTS) {
      this.o[k] = opts && opts[k] !== undefined ? opts[k] : GPS_DEFAULTS[k];
    }
    this.reset();
  }

  /* Oublie la position courante sans rien effacer d'autre : à la reprise d'une
     pause ou après un gel, l'immobilité écoulée ne doit pas compter. */
  DistanceFilter.prototype.reset = function () {
    this.filt = null;     // position lissée
    this.raw = null;      // dernier point brut (détection des sauts)
    this.anchor = null;   // dernier point dont la distance a été comptée
  };

  /* Un point GPS. Renvoie toujours un verdict :
       { status, d, lat, lon, speed }
     status vaut 'inaccurate' (point jeté), 'first' (origine posée),
     'stale' (horodatage non croissant), 'jump' (téléportation, filtre réarmé),
     'noisy' (dans le bruit : rien à compter) ou 'move' (d mètres de plus).
     `lat`/`lon` ne sont fournis que quand un point entre dans la trace. */
  DistanceFilter.prototype.push = function (lat, lon, acc, t) {
    var o = this.o;
    acc = acc || 0;

    if (acc > o.maxAcc) return { status: 'inaccurate', d: 0, acc: acc };

    if (!this.filt) {
      this.filt = { lat: lat, lon: lon, t: t };
      this.raw = { lat: lat, lon: lon, t: t };
      this.anchor = { lat: lat, lon: lon, t: t };
      return { status: 'first', d: 0, lat: lat, lon: lon };
    }

    var dt = (t - this.filt.t) / 1000;
    if (dt <= 0) return { status: 'stale', d: 0 };

    /* Saut aberrant — comparé au dernier point *brut* : la position lissée est
       en retard par construction, la mesurer contre elle gonflerait la vitesse
       apparente et ferait passer une course honnête pour une téléportation.

       La tolérance n'est pas qu'une vitesse : deux points bruts consécutifs
       diffèrent déjà du bruit de mesure, et ce bruit ne dépend pas du temps
       écoulé. Comparer la seule vitesse revenait à traiter comme téléportation
       tout écart de plus de 12 m en une seconde — ce qu'un GPS annoncé à ±8 m
       produit à froid une fois sur six, sans que personne n'ait bougé. Chaque
       faux positif réarmait l'ancre et jetait la distance en attente : sur un
       banc d'essai, 2 km parcourus n'en donnaient plus que 1. D'où une marge de
       bruit proportionnelle à la précision annoncée, qui laisse passer le bruit
       et continue d'attraper les vraies téléportations (centaines de mètres). */
    var jump = Geo.haversine(this.raw.lat, this.raw.lon, lat, lon);
    var rawDt = (t - this.raw.t) / 1000;
    var tolerance = o.maxSpeed * rawDt + o.jumpMargin * Math.max(o.minMove, acc);
    this.raw = { lat: lat, lon: lon, t: t };
    if (rawDt > 0 && jump > tolerance) {
      this.filt = { lat: lat, lon: lon, t: t };
      this.anchor = { lat: lat, lon: lon, t: t };
      return { status: 'jump', d: 0 };
    }

    /* Lissage à constante de temps : le gain suit l'intervalle réel entre deux
       points, sinon un GPS qui ne parle qu'une fois toutes les 5 s traînerait
       très loin derrière le coureur. τ ≈ 1 s pour ±8 m, 3 s pour ±25 m. */
    var tau = Math.max(o.tauMin, Math.min(o.tauMax, acc / o.tauPerAcc));
    var a = 1 - Math.exp(-dt / tau);
    this.filt.lat += a * (lat - this.filt.lat);
    this.filt.lon += a * (lon - this.filt.lon);
    this.filt.t = t;

    var d = Geo.haversine(this.anchor.lat, this.anchor.lon, this.filt.lat, this.filt.lon);
    if (d < Math.max(o.minMove, o.accFactor * acc)) return { status: 'noisy', d: 0 };

    var span = (t - this.anchor.t) / 1000;
    var out = {
      status: 'move', d: d, speed: span > 0 ? d / span : 0,
      lat: this.filt.lat, lon: this.filt.lon
    };
    this.anchor = { lat: this.filt.lat, lon: this.filt.lon, t: t };
    return out;
  };

  global.Metrics = {
    Pedometer: Pedometer, DistanceFilter: DistanceFilter, strideFor: strideFor,
    PED_DEFAULTS: PED_DEFAULTS, GPS_DEFAULTS: GPS_DEFAULTS
  };
})(self);

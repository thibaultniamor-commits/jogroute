/* harness.js — faire tourner le code de l'app dans Node, sans le modifier.

   Les modules de JogRoute sont de simples scripts qui s'accrochent à `self`
   (`window` dans la page, le global du worker sinon). On leur fabrique donc ici
   un contexte minimal où `self` existe, et on les y évalue tels quels : aucun
   bundler, aucune variante « pour les tests », et donc aucun risque de tester
   autre chose que ce qui part en production. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* Charge une liste de fichiers de `js/` dans un contexte neuf et le renvoie :
   `load(['geo.js']).Geo` est le module tel que la page le verrait. */
function load(files) {
  const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.createContext(sandbox);
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    vm.runInContext(src, sandbox, { filename: f });
  }
  return sandbox;
}

/* Le moteur complet : géométrie, mesures, graphe, itinéraires. */
function engine() {
  return load(['geo.js', 'metrics.js', 'graph.js', 'router.js']);
}

/* ---------- générateurs déterministes ----------
   Un test qui échoue une fois sur vingt ne sert à rien : tout l'aléatoire de
   ce dossier sort de ce générateur, semé explicitement. */

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Bruit gaussien centré, d'écart-type sigma (Box-Muller). */
function gauss(rand, sigma) {
  const u = Math.max(1e-12, rand()), v = rand();
  return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ---------- bruit de position réaliste ----------
   L'erreur d'un GPS n'est pas blanche : elle dérive lentement, au rythme de la
   géométrie des satellites et des réflexions du terrain, avec un temps de
   corrélation de l'ordre de la demi-minute. Un bruit blanc serait à la fois
   trop dur (il ferait sauter tout détecteur de téléportation) et trop facile
   (il s'annule en moyenne). On modélise donc un AR(1) de temps caractéristique
   `tauS` secondes — et on garde `tauS: 0`, c'est-à-dire le blanc, comme cas
   pessimiste explicite.

   `sigma` est l'écart-type par axe, en mètres. La propriété `accuracy` de l'API
   Geolocation est donnée à 95 % de confiance : une précision annoncée de 8 m
   correspond donc à peu près à sigma = 4 m. */
function positionNoise(rand, opts) {
  const sigma = opts.sigma;
  const dt = opts.dt === undefined ? 1 : opts.dt;
  const tauS = opts.tauS === undefined ? 30 : opts.tauS;
  const rho = tauS > 0 ? Math.exp(-dt / tauS) : 0;
  const k = Math.sqrt(1 - rho * rho);
  let north = 0, east = 0;
  return function () {
    north = rho * north + k * gauss(rand, sigma);
    east = rho * east + k * gauss(rand, sigma);
    return { north: north, east: east };
  };
}

/* ---------- un quartier synthétique ----------
   Une grille régulière de `side`×`side` carrefours espacés de `spacing` mètres,
   au format que rend l'API Overpass. Assez riche pour qu'un Dijkstra ait de
   vrais choix à faire, assez petite pour qu'un test s'exécute en un clin d'œil.

   `elevation(ix, iy)` (optionnel) donne l'altitude de chaque carrefour. */
function gridArea(opts) {
  opts = opts || {};
  const side = opts.side || 21;
  const spacing = opts.spacing || 100;
  const lat0 = opts.lat === undefined ? 48.85 : opts.lat;
  const lon0 = opts.lon === undefined ? 2.35 : opts.lon;
  const highway = opts.highway || 'residential';

  const dLat = spacing / 111194.93;
  const dLon = spacing / (111194.93 * Math.cos(lat0 * Math.PI / 180));

  const elements = [];
  const id = (ix, iy) => 1 + iy * side + ix;

  for (let iy = 0; iy < side; iy++) {
    for (let ix = 0; ix < side; ix++) {
      elements.push({
        type: 'node', id: id(ix, iy),
        lat: lat0 + iy * dLat, lon: lon0 + ix * dLon
      });
    }
  }

  /* Un quartier où toutes les rues se valent est un cas dégénéré : tous les
     candidats de demi-tour obtiennent exactement le même agrément moyen, le
     départage se fait alors sur l'ordre de sortie du tas — c'est-à-dire sur la
     proximité — et toutes les boucles proposées sont trop courtes. Un vrai
     tissu urbain mélange les types de voies ; on fait donc pareil par défaut,
     et `uniform: true` permet de retrouver exprès le cas dégénéré. */
  const MIX = ['residential', 'footway', 'path', 'residential', 'tertiary',
    'residential', 'living_street', 'cycleway'];
  const kind = (i) => (opts.uniform ? highway : MIX[i % MIX.length]);

  let wayId = 100000;
  for (let iy = 0; iy < side; iy++) {                 // rues est-ouest
    elements.push({
      type: 'way', id: wayId++, tags: { highway: kind(iy) },
      nodes: Array.from({ length: side }, (_, ix) => id(ix, iy))
    });
  }
  for (let ix = 0; ix < side; ix++) {                 // rues nord-sud
    elements.push({
      type: 'way', id: wayId++, tags: { highway: kind(ix + 3) },
      nodes: Array.from({ length: side }, (_, iy) => id(ix, iy))
    });
  }

  return {
    elements, side, spacing, lat0, lon0, dLat, dLon,
    /* coordonnées d'un carrefour, pour viser un point précis dans les tests */
    at: (ix, iy) => ({ lat: lat0 + iy * dLat, lon: lon0 + ix * dLon })
  };
}

/* Construit et pondère le graphe correspondant. `weights` complète les défauts. */
function gridGraph(E, opts, weights) {
  const area = gridArea(opts);
  const G = E.RGraph.build(area.elements, []);
  if (opts && opts.elevation) {
    const ele = new Float32Array(G.n);
    for (let i = 0; i < G.n; i++) {
      const ix = Math.round((G.lons[i] - area.lon0) / area.dLon);
      const iy = Math.round((G.lats[i] - area.lat0) / area.dLat);
      ele[i] = opts.elevation(ix, iy);
    }
    G.ele = ele;
    G.hasEle = true;
  }
  E.RGraph.weight(G, Object.assign({
    nature: 0.6, preferGreen: true, hilliness: 0, paceSecPerKm: 360
  }, weights || {}));
  return { G, area };
}

module.exports = { load, engine, rng, gauss, positionNoise, gridArea, gridGraph, ROOT };

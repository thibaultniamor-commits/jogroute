/* bench.js — coût d'une génération de parcours. Volontairement hors de la suite
   de tests (pas de `.test.js`) : on le lance à la main quand on touche au
   moteur.

       node test/bench.js                    # taille par défaut
       SIDE=161 SPACING=25 node test/bench.js

   Il compare deux régimes sur le même graphe et la même demande :
     · « avant » — chaque parcours alloue ses cinq tableaux et les remplit
       d'Infinity, comme le faisait le code d'origine ;
     · « actuel » — les tampons sont réutilisés, un compteur de génération
       tenant lieu de remise à zéro.

   La variante « avant » est obtenue en réinjectant l'allocation dans le source
   de router.js : le reste de l'algorithme est rigoureusement identique.

   Précautions de mesure, apprises à la dure : chaque variante tourne dans son
   propre processus (sinon le graphe et les tampons de la première faussent la
   seconde par pression mémoire), les deux mesures sont alternées, et on retient
   la médiane plutôt que la moyenne. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { gridGraph } = require('./harness');

const ROOT = path.join(__dirname, '..');

const SIDE = +(process.env.SIDE || 141);
const SPACING = +(process.env.SPACING || 30);
const RUNS = +(process.env.RUNS || 7);

/* ---------- un tour de mesure, dans un processus dédié ---------- */

function loadEngine(transform) {
  const sandbox = { console, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  sandbox.self = sandbox;
  for (const f of ['geo.js', 'metrics.js', 'graph.js', 'router.js']) {
    let src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    if (f === 'router.js' && transform) src = transform(src);
    vm.runInContext(src, sandbox, { filename: f });
  }
  return sandbox;
}

const ANCIEN = (src) => {
  const cible = 'var S = (opts.scratch || scratchFor(G)).begin();';
  if (src.indexOf(cible) < 0) throw new Error('router.js a changé : ajuster le banc');
  return src.replace(cible,
    'var S = new Scratch(G.n); S.begin();' +
    ' S.cost.fill(Infinity); S.len.fill(Infinity);' +
    ' S.pv.fill(-1); S.pe.fill(-1);');
};

function params(src) {
  return {
    src, target: 5000, objective: 'dist', mode: 'loop',
    direction: null, sector: 180, overlap: 7, tolerance: 0.14,
    variants: 5, loopShape: 0.6, dplus: 0, waterEvery: 0
  };
}

async function child(variante) {
  const E = loadEngine(variante === 'ancien' ? ANCIEN : null);
  const { G, area } = gridGraph(E, { side: SIDE, spacing: SPACING });
  const src = E.RGraph.nearest(G, area.at(
    (SIDE - 1) >> 1, (SIDE - 1) >> 1).lat, area.at(
    (SIDE - 1) >> 1, (SIDE - 1) >> 1).lon).node;

  /* Trois générations de chauffe : une seule ne suffit pas à faire compiler le
     cœur de Dijkstra, et la mesure ne reflétait alors que l'interpréteur. */
  for (let i = 0; i < 3; i++) await E.Router.plan(G, params(src));

  const mesures = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    await E.Router.plan(G, params(src));
    mesures.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  mesures.sort((a, b) => a - b);

  process.stdout.write(JSON.stringify({ ms: mesures[2], n: G.n, m: G.m }));
}

/* ---------- pilote ---------- */

function measure(variante) {
  const out = execFileSync(process.execPath, [__filename, variante], {
    env: Object.assign({}, process.env, { SIDE: SIDE, SPACING: SPACING }),
    encoding: 'utf8'
  });
  return JSON.parse(out);
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

function main() {
  const ancien = [], actuel = [];
  let taille = null;

  for (let i = 0; i < RUNS; i++) {
    /* Alterné, pour que ni l'une ni l'autre ne profite d'une machine plus
       calme en début ou en fin de série. */
    const a = measure(i % 2 ? 'actuel' : 'ancien');
    const b = measure(i % 2 ? 'ancien' : 'actuel');
    (i % 2 ? actuel : ancien).push(a.ms);
    (i % 2 ? ancien : actuel).push(b.ms);
    taille = taille || a;
  }

  const mAncien = median(ancien), mActuel = median(actuel);
  console.log(`graphe : ${taille.n} nœuds, ${taille.m} tronçons ` +
    `(${SIDE}×${SIDE} carrefours espacés de ${SPACING} m)`);
  console.log(`demande : boucle de 5 km · médiane de ${RUNS} mesures\n`);
  console.log('  tampons alloués à chaque parcours  ' + mAncien.toFixed(0).padStart(5) + ' ms');
  console.log('  tampons réutilisés (actuel)        ' + mActuel.toFixed(0).padStart(5) + ' ms');
  console.log(`\ngain : ${((1 - mActuel / mAncien) * 100).toFixed(0)} % ` +
    `(${(mAncien - mActuel).toFixed(0)} ms par génération)`);
}

const arg = process.argv[2];
if (arg === 'ancien' || arg === 'actuel') child(arg);
else main();

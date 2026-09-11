/* coach.test.js — ce que l'application dit et fait pendant la course.

   Ces déclenchements sont, par nature, les plus difficiles à vérifier à la
   main : ils se produisent en courant, souvent écran noir, et une annonce
   manquée ne laisse aucune trace. On rejoue donc des sorties entières —
   franchissements de kilomètre, parcours à virages, gels de la page — et on
   vérifie ce qui aurait été dit et senti.

   La voix et le vibreur n'existent pas dans Node : on les remplace par des
   témoins qui enregistrent les appels, ce qui est exactement ce qu'on veut
   mesurer. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { load, gridArea } = require('./harness');

/* Un contexte neuf par test : le coach garde l'état de la sortie en cours. */
function fresh() {
  const E = load(['geo.js', 'metrics.js', 'coach.js']);
  const dits = [], vibrations = [];

  /* Faux moteur de synthèse vocale, fidèle à l'API réelle. */
  E.speechSynthesis = { speak: (u) => dits.push(u.text), getVoices: () => [] };
  E.SpeechSynthesisUtterance = function (text) { this.text = text; };
  E.navigator = { vibrate: (p) => { vibrations.push(p); return true; } };

  E.Coach.configure({ voice: true, vibrate: true });

  /* `dits` retient aussi la phrase vide d'amorçage — celle qui achète au
     navigateur le droit de parler plus tard. Les tests s'intéressent aux
     phrases réelles : `phrases()` écarte l'amorce. */
  const phrases = () => dits.filter((d) => d.trim().length > 0);
  return { E, Coach: E.Coach, Geo: E.Geo, dits, phrases, vibrations };
}

/* Un instantané de Tracker, tel que le coach le reçoit. */
function snap(dist, counted, pts, extra) {
  return Object.assign({
    active: true, paused: false, dist: dist, counted: counted,
    gaps: 0, pts: pts || []
  }, extra || {});
}

/* ================= capacités annoncées ================= */

test('capacités — ne prétend rien là où le navigateur ne suit pas', () => {
  const nu = load(['geo.js', 'metrics.js', 'coach.js']);
  assert.strictEqual(nu.Coach.supportsVoice(), false, 'pas de synthèse dans Node');
  assert.strictEqual(nu.Coach.supportsVibration(), false, 'pas de vibreur non plus');

  const { Coach } = fresh();
  assert.strictEqual(Coach.supportsVoice(), true);
  assert.strictEqual(Coach.supportsVibration(), true);
});

test('capacités — rien n\'est dit ni senti tant que ce n\'est pas demandé', () => {
  const { Coach, dits, vibrations } = fresh();
  Coach.configure({ voice: false, vibrate: false });
  Coach.start();
  Coach.tick(snap(1200, 360));
  assert.strictEqual(dits.length, 0, 'aucune parole non sollicitée');
  assert.strictEqual(vibrations.length, 0, 'aucune vibration non sollicitée');
});

/* ================= formulation ================= */

test('durées — dites en toutes lettres, pas en chiffres à deux points', () => {
  const { Coach } = fresh();
  assert.strictEqual(Coach.spokenDuration(0), '0 seconde');
  assert.strictEqual(Coach.spokenDuration(1), '1 seconde');
  assert.strictEqual(Coach.spokenDuration(45), '45 secondes');
  assert.strictEqual(Coach.spokenDuration(60), '1 minute');
  assert.strictEqual(Coach.spokenDuration(324), '5 minutes 24 secondes');
  assert.strictEqual(Coach.spokenDuration(3600), '1 heure');
  assert.strictEqual(Coach.spokenDuration(3725), '1 heure 2 minutes 5 secondes');
});

test('annonce — contient distance, temps écoulé et allure du kilomètre', () => {
  const { Coach } = fresh();
  const p = Coach.splitSentence(5, 1650, 324);
  assert.ok(p.indexOf('5 kilomètres') >= 0, p);
  assert.ok(p.indexOf('27 minutes 30 secondes') >= 0, p);
  assert.ok(p.indexOf('dernier kilomètre en 5 minutes 24 secondes') >= 0, p);
  /* Le singulier au premier kilomètre. */
  assert.ok(Coach.splitSentence(1, 330, 330).indexOf('1 kilomètre,') >= 0);
});

/* ================= temps de passage ================= */

test('kilomètres — un seul par borne, aucun oublié, aucun doublon', () => {
  const { Coach, phrases } = fresh();
  Coach.start();
  /* 5 km à 5:00/km, relevés toutes les secondes. */
  for (let t = 1; t <= 1500; t++) Coach.tick(snap(t * (1000 / 300), t));

  const splits = Coach.splits();
  assert.strictEqual(splits.length, 5, `${splits.length} kilomètres relevés`);
  splits.forEach((s, i) => assert.strictEqual(s.km, i + 1, 'numérotation continue'));
  assert.strictEqual(phrases().length, 5, 'une annonce par kilomètre');
});

test('kilomètres — l\'instant du passage est interpolé, pas arrondi au relevé', () => {
  const { Coach } = fresh();
  Coach.start();
  /* Relevés espacés de 10 s : sans interpolation, chaque temps de passage
     dériverait un peu plus que le précédent. */
  for (let t = 10; t <= 1800; t += 10) Coach.tick(snap(t * (1000 / 300), t));

  const splits = Coach.splits();
  assert.ok(splits.length >= 5);
  splits.forEach((s) => {
    assert.ok(Math.abs(s.at - s.km * 300) < 1.5,
      `km ${s.km} annoncé à ${s.at.toFixed(1)} s au lieu de ${s.km * 300}`);
    assert.ok(Math.abs(s.sec - 300) < 2, `km ${s.km} : ${s.sec.toFixed(1)} s`);
  });
});

test('kilomètres — plusieurs franchis d\'un coup après un trou sont tous relevés', () => {
  /* Après un gel, la distance peut faire un bond : on ne saute pas de borne. */
  const { Coach } = fresh();
  Coach.start();
  Coach.tick(snap(500, 150));
  Coach.tick(snap(3200, 900, [], { gaps: 1 }));
  const splits = Coach.splits();
  assert.strictEqual(splits.length, 3, 'les kilomètres 1, 2 et 3');
  assert.deepEqual(splits.map((s) => s.km), [1, 2, 3]);
});

test('kilomètres — un gel ne produit pas d\'allure inventée', () => {
  /* Le temps du kilomètre est faux si la page a dormi pendant : on annonce la
     distance, et on se tait sur l'allure plutôt que d'annoncer une absurdité. */
  const { Coach, dits } = fresh();
  Coach.start();
  Coach.tick(snap(900, 270));
  dits.length = 0;
  Coach.tick(snap(1100, 300, [], { gaps: 1 }));
  assert.strictEqual(dits.length, 1);
  assert.ok(dits[0].indexOf('dernier kilomètre') < 0,
    'l\'allure ne doit pas être annoncée après un gel : ' + dits[0]);
  assert.ok(dits[0].indexOf('1 kilomètre') >= 0, dits[0]);
});

test('kilomètres — rien n\'est compté en pause ni hors sortie', () => {
  const { Coach } = fresh();
  Coach.start();
  Coach.tick(snap(2000, 600, [], { paused: true }));
  Coach.tick(snap(3000, 900, [], { active: false }));
  assert.strictEqual(Coach.splits().length, 0);
});

test('kilomètres — une nouvelle sortie repart de zéro', () => {
  const { Coach } = fresh();
  Coach.start();
  for (let t = 1; t <= 900; t++) Coach.tick(snap(t * (1000 / 300), t));
  assert.strictEqual(Coach.splits().length, 3);
  Coach.start();
  assert.strictEqual(Coach.splits().length, 0, 'les temps de la sortie précédente');
  Coach.tick(snap(1100, 330));
  assert.deepEqual(Coach.splits().map((s) => s.km), [1]);
});

/* ================= virages ================= */

/* Un tracé en L : tout droit vers l'est, puis plein nord. */
function elbow(Geo, legM, stepM) {
  const pts = [[48.85, 2.35]];
  let p = { lat: 48.85, lon: 2.35 };
  for (let d = stepM; d <= legM; d += stepM) {
    p = Geo.destination(48.85, 2.35, 90, d);
    pts.push([p.lat, p.lon]);
  }
  const corner = p;
  for (let d = stepM; d <= legM; d += stepM) {
    const q = Geo.destination(corner.lat, corner.lon, 0, d);
    pts.push([q.lat, q.lon]);
  }
  return pts;
}

test('virages — un coude franc est repéré, une ligne droite ne l\'est pas', () => {
  const { Coach, Geo } = fresh();

  const droit = [];
  for (let d = 0; d <= 600; d += 20) {
    const p = Geo.destination(48.85, 2.35, 90, d);
    droit.push([p.lat, p.lon]);
  }
  let cum = cumOf(Geo, droit);
  assert.strictEqual(Coach.findTurns(droit, cum).length, 0, 'aucun virage en ligne droite');

  const pts = elbow(Geo, 300, 20);
  cum = cumOf(Geo, pts);
  const turns = Coach.findTurns(pts, cum);
  assert.strictEqual(turns.length, 1, `${turns.length} virages pour un seul coude`);
  assert.ok(Math.abs(turns[0].angle - 90) < 15, `angle ${turns[0].angle.toFixed(0)}°`);
  assert.strictEqual(turns[0].side, 'gauche', 'est puis nord, c\'est à gauche');
  assert.ok(Math.abs(turns[0].cum - 300) < 25, `coude à ${turns[0].cum.toFixed(0)} m`);
});

test('virages — le côté annoncé est le bon dans les deux sens', () => {
  const { Coach, Geo } = fresh();
  /* Est puis sud : à droite. */
  const pts = [[48.85, 2.35]];
  let p = { lat: 48.85, lon: 2.35 };
  for (let d = 20; d <= 300; d += 20) { p = Geo.destination(48.85, 2.35, 90, d); pts.push([p.lat, p.lon]); }
  const corner = p;
  for (let d = 20; d <= 300; d += 20) {
    const q = Geo.destination(corner.lat, corner.lon, 180, d);
    pts.push([q.lat, q.lon]);
  }
  const turns = Coach.findTurns(pts, cumOf(Geo, pts));
  assert.strictEqual(turns.length, 1);
  assert.strictEqual(turns[0].side, 'droite');
});

test('virages — une courbe douce n\'est pas un virage', () => {
  /* Un arc de 90° étalé sur 400 m se prend sans y penser : le signaler serait
     du bruit. Un tracé OSM en est plein. */
  const { Coach, Geo } = fresh();
  const R = 400 / (Math.PI / 2);
  const pts = [];
  for (let a = 0; a <= 90; a += 2) {
    const q = Geo.destination(48.85, 2.35, a, R);
    pts.push([q.lat, q.lon]);
  }
  const turns = Coach.findTurns(pts, cumOf(Geo, pts));
  assert.strictEqual(turns.length, 0, `${turns.length} virages sur une courbe douce`);
});

test('virages — deux sommets voisins ne font qu\'un seul virage', () => {
  /* Un angle droit décrit par deux sommets rapprochés (fréquent dans OSM aux
     carrefours arrondis) ne doit pas vibrer deux fois. */
  const { Coach, Geo } = fresh();
  const pts = [];
  for (let d = 0; d <= 200; d += 20) {
    const q = Geo.destination(48.85, 2.35, 90, d);
    pts.push([q.lat, q.lon]);
  }
  const c = Geo.destination(48.85, 2.35, 90, 200);
  const c2 = Geo.destination(c.lat, c.lon, 45, 12);          // sommet intermédiaire
  pts.push([c2.lat, c2.lon]);
  for (let d = 20; d <= 200; d += 20) {
    const q = Geo.destination(c2.lat, c2.lon, 0, d);
    pts.push([q.lat, q.lon]);
  }
  const turns = Coach.findTurns(pts, cumOf(Geo, pts));
  assert.strictEqual(turns.length, 1, `${turns.length} virages pour un carrefour arrondi`);
});

function cumOf(Geo, pts) {
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + Geo.haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  }
  return cum;
}

/* ================= vibrations en situation ================= */

test('virages — deux vibrations par virage : l\'approche, puis le virage', () => {
  const { Coach, Geo, vibrations } = fresh();
  const pts = elbow(Geo, 300, 10);
  Coach.setRoute(pts);
  Coach.start();
  vibrations.length = 0;

  /* On parcourt le tracé, point par point, sans franchir de kilomètre. */
  for (let i = 0; i < pts.length; i++) {
    Coach.tick(snap(i * 10, i * 3, pts.slice(0, i + 1)));
  }
  assert.strictEqual(vibrations.length, 2,
    `${vibrations.length} vibrations pour un virage`);
});

test('virages — rien n\'est signalé sans parcours affiché', () => {
  const { Coach, Geo, vibrations } = fresh();
  const pts = elbow(Geo, 300, 10);
  Coach.setRoute(null);
  Coach.start();
  vibrations.length = 0;
  for (let i = 0; i < pts.length; i++) Coach.tick(snap(i * 10, i * 3, pts.slice(0, i + 1)));
  assert.strictEqual(vibrations.length, 0);
});

test('virages — le même virage n\'est jamais annoncé deux fois', () => {
  const { Coach, Geo, dits } = fresh();
  const pts = elbow(Geo, 300, 10);
  Coach.setRoute(pts);
  Coach.start();
  dits.length = 0;
  /* On s'attarde : plusieurs relevés à la même position, comme à un feu. */
  for (let i = 0; i < pts.length; i++) {
    Coach.tick(snap(i * 10, i * 3, pts.slice(0, i + 1)));
    Coach.tick(snap(i * 10, i * 3 + 1, pts.slice(0, i + 1)));
    Coach.tick(snap(i * 10, i * 3 + 2, pts.slice(0, i + 1)));
  }
  const tournez = dits.filter((d) => d.indexOf('Tournez') >= 0);
  assert.strictEqual(tournez.length, 1, `${tournez.length} fois « tournez »`);
});

test('virages — sur une boucle, on ne se croit pas de l\'autre côté', () => {
  /* Le point le plus proche dans l'absolu peut appartenir au retour de la
     boucle, à quelques mètres mais à des kilomètres de course. La recherche est
     donc locale : ce test verrouille ce comportement. */
  const { Coach, Geo } = fresh();
  const R = 300;
  const pts = [];
  for (let a = 0; a <= 360; a += 3) {
    const q = Geo.destination(48.85, 2.35, a, R);
    pts.push([q.lat, q.lon]);
  }
  /* Un aller et un retour très proches l'un de l'autre : on rajoute le tour
     en sens inverse, décalé de 8 m vers l'intérieur. */
  for (let a = 360; a >= 0; a -= 3) {
    const q = Geo.destination(48.85, 2.35, a, R - 8);
    pts.push([q.lat, q.lon]);
  }
  Coach.setRoute(pts);
  Coach.start();

  /* On avance le long de l'aller ; l'index suivi doit rester dans la première
     moitié du tracé, et non sauter sur le retour voisin. */
  for (let i = 0; i < 100; i++) {
    Coach.tick(snap(i * 15, i * 5, pts.slice(0, i + 1)));
    const idx = Coach.locate(pts[i][0], pts[i][1]);
    assert.ok(Math.abs(idx - i) < 10,
      `au point ${i}, le coach se croit au point ${idx}`);
  }
});

test('virages — quitter le tracé ne déclenche rien', () => {
  const { Coach, Geo, vibrations } = fresh();
  const pts = elbow(Geo, 300, 10);
  Coach.setRoute(pts);
  Coach.start();
  vibrations.length = 0;
  /* 500 m à côté du parcours : aucun virage ne nous concerne. */
  const loin = Geo.destination(48.85, 2.35, 180, 500);
  for (let i = 0; i < 40; i++) {
    Coach.tick(snap(i * 10, i * 3, [[loin.lat, loin.lon]]));
  }
  assert.strictEqual(vibrations.length, 0);
});

/* ================= bout en bout ================= */

test('sortie complète — un parcours de quartier, annoncé et senti', () => {
  const { Coach, Geo, dits, phrases, vibrations } = fresh();
  const area = gridArea({ side: 11, spacing: 100 });

  /* Un tracé en escalier dans la grille : 10 virages francs. */
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const a = area.at(k, k), b = area.at(k + 1, k);
    pts.push([a.lat, a.lon], [b.lat, b.lon]);
  }
  Coach.setRoute(pts);
  const turns = Coach.findTurns(pts, cumOf(Geo, pts));
  assert.ok(turns.length >= 8, `${turns.length} virages repérés`);

  Coach.start();
  dits.length = 0;
  vibrations.length = 0;

  /* On court le tracé à 3 m/s. */
  let dist = 0;
  for (let i = 1; i < pts.length; i++) {
    dist += Geo.haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    Coach.tick(snap(dist, dist / 3, pts.slice(0, i + 1)));
  }

  const km = Coach.splits();
  assert.ok(km.length >= 1, 'au moins un kilomètre relevé');
  assert.ok(phrases().length >= km.length, 'chaque kilomètre a été annoncé');
  assert.ok(vibrations.length > 0, 'les virages ont été signalés');
});

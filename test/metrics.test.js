/* metrics.test.js — le banc d'essai des deux compteurs.

   C'est le code le plus exposé de l'application : il tourne sur un téléphone
   qui bouge, avec un GPS qui ment et un accéléromètre qui vibre, et personne ne
   peut vérifier son résultat sur le terrain. On lui donne donc ici des signaux
   dont on connaît la vérité — marche, course, sprint, arrêt, GPS dégradé,
   téléportation — et on exige que les chiffres tombent juste.

   Tout l'aléatoire vient d'un générateur semé : un échec est reproductible. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { engine, rng, gauss, positionNoise } = require('./harness');

const { Geo, Metrics } = engine();

/* ================= podomètre ================= */

/* Un porteur qui avance : la magnitude de l'accélération oscille autour de g,
   d'autant plus fort qu'il va vite. `hz` pas par seconde, `amp` en m/s². */
function runSignal(ped, opts) {
  const hz = opts.hz, amp = opts.amp;
  const seconds = opts.seconds, rate = opts.rate || 50;
  const rand = rng(opts.seed || 1);
  const noise = opts.noise || 0;
  const t0 = opts.t0 || 1700000000000;

  const n = Math.round(seconds * rate);
  for (let i = 0; i < n; i++) {
    const t = t0 + (i * 1000) / rate;
    const phase = 2 * Math.PI * hz * (i / rate);
    /* Le signal est porté par l'axe vertical, les autres captent le ballant. */
    const z = 9.81 + amp * Math.sin(phase) + gauss(rand, noise);
    const x = 0.4 * amp * Math.sin(phase * 0.5) + gauss(rand, noise);
    const y = gauss(rand, noise);
    ped.sample(t, x, y, z);
  }
  return { t0, tEnd: t0 + (n * 1000) / rate, expected: Math.floor(seconds * hz) };
}

test('podomètre — marche : compté au pas près', () => {
  const ped = new Metrics.Pedometer();
  const r = runSignal(ped, { hz: 1.8, amp: 2.0, seconds: 60, noise: 0.15, seed: 3 });
  const err = Math.abs(ped.count() - r.expected);
  assert.ok(err <= 2, `${ped.count()} pas comptés pour ${r.expected} réels`);
});

test('podomètre — course : compté au pas près', () => {
  const ped = new Metrics.Pedometer();
  const r = runSignal(ped, { hz: 2.8, amp: 6.0, seconds: 60, noise: 0.4, seed: 4 });
  const err = Math.abs(ped.count() - r.expected);
  assert.ok(err <= 2, `${ped.count()} pas comptés pour ${r.expected} réels`);
});

test('podomètre — sprint : compté au pas près', () => {
  const ped = new Metrics.Pedometer();
  const r = runSignal(ped, { hz: 3.6, amp: 9.0, seconds: 30, noise: 0.5, seed: 5 });
  const err = Math.abs(ped.count() - r.expected);
  assert.ok(err <= 2, `${ped.count()} pas comptés pour ${r.expected} réels`);
});

test('podomètre — s\'adapte sans réglage d\'une allure à l\'autre', () => {
  /* Marche, puis course, puis marche de nouveau, sans rien lui dire : le seuil
     est censé suivre tout seul. C'est ce qui permet de porter le téléphone
     n'importe comment. */
  const ped = new Metrics.Pedometer();
  let t = 1700000000000, expected = 0;
  for (const leg of [{ hz: 1.7, amp: 2.0, s: 40 }, { hz: 2.9, amp: 7.0, s: 40 },
    { hz: 1.7, amp: 2.0, s: 40 }]) {
    const r = runSignal(ped, {
      hz: leg.hz, amp: leg.amp, seconds: leg.s, noise: 0.3, seed: 9, t0: t
    });
    expected += r.expected;
    t = r.tEnd;
  }
  const err = Math.abs(ped.count() - expected);
  assert.ok(err <= 5, `${ped.count()} pas comptés pour ~${expected} réels`);
});

test('podomètre — un téléphone posé ne compte rien', () => {
  const ped = new Metrics.Pedometer();
  const rand = rng(12);
  const t0 = 1700000000000;
  /* Dix minutes sur une table : dérive du capteur et vibrations ambiantes. */
  for (let i = 0; i < 50 * 600; i++) {
    ped.sample(t0 + i * 20, gauss(rand, 0.05), gauss(rand, 0.05), 9.81 + gauss(rand, 0.08));
  }
  assert.strictEqual(ped.count(), 0, `${ped.count()} pas inventés à l'arrêt`);
});

test('podomètre — une vibration brève ne fait pas un pas', () => {
  const ped = new Metrics.Pedometer();
  const t0 = 1700000000000;
  /* Une notification : forte, mais sous le seuil d'amplitude soutenue. */
  for (let i = 0; i < 25; i++) {
    ped.sample(t0 + i * 20, 0, 0, 9.81 + 0.5 * Math.sin(i));
  }
  assert.strictEqual(ped.count(), 0);
});

test('podomètre — la cadence reflète l\'allure courante', () => {
  const ped = new Metrics.Pedometer();
  const r = runSignal(ped, { hz: 2.8, amp: 6.0, seconds: 40, noise: 0.3, seed: 6 });
  const cad = ped.cadence(r.tEnd);
  /* 2,8 pas/s = 168 pas/min */
  assert.ok(Math.abs(cad - 168) < 8, `cadence ${cad} pas/min`);
});

test('podomètre — reset repart de zéro, set reprend un total', () => {
  const ped = new Metrics.Pedometer();
  runSignal(ped, { hz: 2.8, amp: 6.0, seconds: 20, noise: 0.3, seed: 7 });
  assert.ok(ped.count() > 30);
  ped.reset();
  assert.strictEqual(ped.count(), 0);
  ped.set(1234);
  assert.strictEqual(ped.count(), 1234);
  /* Et il continue d'incrémenter à partir de là — c'est ce qui permet de
     reprendre une sortie interrompue sans perdre les pas déjà comptés. */
  const r = runSignal(ped, { hz: 2.8, amp: 6.0, seconds: 20, noise: 0.3, seed: 8 });
  assert.ok(ped.count() > 1234 + 40, `${ped.count()} après reprise`);
  assert.ok(Math.abs(ped.count() - 1234 - r.expected) <= 3);
});

test('podomètre — plafonne à une cadence physiquement possible', () => {
  /* Un signal à 8 Hz (480 pas/min) n'est pas de la course : l'intervalle
     minimal doit l'écrêter plutôt que de gonfler le compteur. */
  const ped = new Metrics.Pedometer();
  runSignal(ped, { hz: 8, amp: 6.0, seconds: 10, rate: 100, noise: 0.2, seed: 10 });
  assert.ok(ped.count() <= 41, `${ped.count()} pas pour 10 s : au-delà de 240/min`);
});

test('podomètre — receiving() distingue un capteur muet d\'un capteur immobile', () => {
  const ped = new Metrics.Pedometer();
  const t0 = 1700000000000;
  assert.ok(!ped.receiving(t0), 'aucun échantillon reçu');
  ped.sample(t0, 0, 0, 9.81);
  assert.ok(ped.receiving(t0 + 500), 'le capteur vient de parler');
  assert.ok(!ped.receiving(t0 + 5000), 'plus rien depuis 5 s');
});

/* ================= foulée ================= */

test('strideFor — plausible, bornée, croissante', () => {
  const walk = Metrics.strideFor(1.4);       // 5 km/h
  const run = Metrics.strideFor(3.0);        // 5:33 /km
  assert.ok(walk > 0.6 && walk < 0.85, `marche : ${walk.toFixed(2)} m`);
  assert.ok(run > 1.0 && run < 1.2, `course : ${run.toFixed(2)} m`);
  assert.ok(run > walk);
  assert.strictEqual(Metrics.strideFor(0), Metrics.strideFor(1.4), 'vitesse nulle : repli marche');
  assert.ok(Metrics.strideFor(50) <= 1.6, 'bornée en haut');
  assert.ok(Metrics.strideFor(-5) >= 0.45, 'bornée en bas');
});

/* ================= distance GPS =================

   Rejoue un trajet dont on connaît la vérité. `path(t)` rend la position vraie
   à l'instant t (s) ; le bruit vient du modèle AR(1) du harnais, réaliste par
   défaut, blanc si `tauS: 0`.

   On compare toujours à la somme naïve des segments bruts : c'est le chiffre
   qu'afficherait un compteur sans filtre, et donc la mesure de ce que le filtre
   apporte réellement. */
function replay(opts) {
  const filter = new Metrics.DistanceFilter();
  const rand = rng(opts.seed || 1);
  const acc = opts.acc;
  const hz = opts.hz === undefined ? 1 : opts.hz;
  const dt = 1 / hz;
  const noise = positionNoise(rand, {
    sigma: opts.sigma === undefined ? acc / 2 : opts.sigma,
    dt: dt, tauS: opts.tauS
  });
  const t0 = 1700000000000;

  let counted = 0, naive = 0, prev = null, kept = 0;
  const n = Math.round(opts.seconds * hz);

  for (let i = 0; i <= n; i++) {
    const t = i * dt;
    const truth = opts.path(t);
    const e = noise();
    const lat = truth.lat + e.north / 111194.93;
    const lon = truth.lon + e.east /
      (111194.93 * Math.cos(truth.lat * Math.PI / 180));

    if (prev) naive += Geo.haversine(prev[0], prev[1], lat, lon);
    prev = [lat, lon];

    const r = filter.push(lat, lon, acc, t0 + t * 1000);
    counted += r.d;
    if (r.status === 'move' || r.status === 'first') kept++;
  }
  return { counted, naive, kept, filter };
}

/* Un trajet en ligne droite à vitesse constante. */
function straight(lat0, lon0, brg, speed) {
  return (t) => Geo.destination(lat0, lon0, brg, speed * t);
}

const SPEED = 3.0;            // 3 m/s = 5:33 /km, une allure de sortie ordinaire

test('distance — 2 km en ligne droite, GPS correct : à 3 % près', () => {
  const r = replay({
    seconds: 2000 / SPEED, hz: 1, acc: 8, seed: 23,
    path: straight(48.85, 2.35, 42, SPEED)
  });
  const err = Math.abs(r.counted - 2000) / 2000;
  assert.ok(err < 0.03,
    `${Math.round(r.counted)} m pour 2 000 (${(err * 100).toFixed(1)} %)`);
  /* Sous bruit corrélé, la somme naïve n'explose pas — elle se contente de
     surestimer. Ce qu'on exige, c'est que le filtre tombe plus juste qu'elle. */
  assert.ok(Math.abs(r.naive - 2000) > Math.abs(r.counted - 2000),
    `témoin : sans filtre ${Math.round(r.naive)} m, avec ${Math.round(r.counted)} m`);
});

test('distance — GPS dégradé à ±25 m, un point toutes les 5 s : à 5 % près', () => {
  const r = replay({
    seconds: 2000 / SPEED, hz: 0.2, acc: 25, seed: 24,
    path: straight(48.85, 2.35, 42, SPEED)
  });
  const err = Math.abs(r.counted - 2000) / 2000;
  assert.ok(err < 0.05,
    `${Math.round(r.counted)} m pour 2 000 (${(err * 100).toFixed(1)} %)`);
});

test('distance — une boucle de 2 km revient juste', () => {
  /* Un tour de piste : la trace se referme, donc les erreurs ne peuvent pas
     s'annuler comme sur un aller-retour. */
  const R = 2000 / (2 * Math.PI);
  const r = replay({
    seconds: 2000 / SPEED, hz: 1, acc: 8, seed: 25,
    path: (t) => Geo.destination(48.85, 2.35, 360 * ((t * SPEED) / 2000), R)
  });
  const err = Math.abs(r.counted - 2000) / 2000;
  assert.ok(err < 0.05,
    `${Math.round(r.counted)} m pour 2 000 (${(err * 100).toFixed(1)} %)`);
});

test('distance — même sous bruit blanc, la mesure reste exploitable', () => {
  /* Cas volontairement pessimiste : bruit sans corrélation, le pire pour un
     détecteur de saut. C'est ce cas qui a révélé que le seuil de téléportation
     se déclenchait sur du bruit ordinaire et amputait la distance de moitié —
     ce test est le garde-fou de cette correction. */
  const r = replay({
    seconds: 2000 / SPEED, hz: 1, acc: 8, seed: 27, tauS: 0,
    path: straight(48.85, 2.35, 42, SPEED)
  });
  const err = Math.abs(r.counted - 2000) / 2000;
  assert.ok(err < 0.15,
    `${Math.round(r.counted)} m pour 2 000 (${(err * 100).toFixed(1)} %)`);
  assert.ok(r.counted > 1800, 'la distance ne doit plus être amputée');
});

test('distance — le bruit ordinaire n\'est jamais pris pour une téléportation', () => {
  /* Régression directe : à ±8 m, deux points bruts consécutifs diffèrent
     couramment de 15 à 20 m sans que personne n'ait bougé. */
  const f = new Metrics.DistanceFilter();
  const noise = positionNoise(rng(28), { sigma: 4, dt: 1, tauS: 0 });
  const t0 = 1700000000000;
  let jumps = 0, n = 0;
  for (let i = 0; i <= 600; i++) {
    const truth = Geo.destination(48.85, 2.35, 42, SPEED * i);
    const e = noise();
    const lat = truth.lat + e.north / 111194.93;
    const lon = truth.lon + e.east / (111194.93 * Math.cos(48.85 * Math.PI / 180));
    const r = f.push(lat, lon, 8, t0 + i * 1000);
    n++;
    if (r.status === 'jump') jumps++;
  }
  assert.strictEqual(jumps, 0, `${jumps} faux sauts sur ${n} points`);
});

test('distance — une vraie téléportation est toujours écartée', () => {
  const f = new Metrics.DistanceFilter();
  const t0 = 1700000000000;
  let total = 0;
  for (let i = 0; i < 60; i++) {
    const p = Geo.destination(48.85, 2.35, 90, SPEED * i);
    total += f.push(p.lat, p.lon, 8, t0 + i * 1000).d;
  }
  assert.ok(total > 100, `témoin : ${Math.round(total)} m avant le saut`);

  /* Le GPS raccroche ailleurs : 5 km en une seconde. */
  const far = Geo.destination(48.85, 2.35, 90, 5000);
  const jump = f.push(far.lat, far.lon, 8, t0 + 60000);
  assert.strictEqual(jump.status, 'jump', 'le saut doit être reconnu');
  assert.strictEqual(jump.d, 0, 'et ne rien ajouter');
});

test('distance — un point trop imprécis est écarté, pas deviné', () => {
  const f = new Metrics.DistanceFilter();
  const t0 = 1700000000000;
  f.push(48.85, 2.35, 8, t0);
  const far = Geo.destination(48.85, 2.35, 90, 300);
  const r = f.push(far.lat, far.lon, 150, t0 + 10000);
  assert.strictEqual(r.status, 'inaccurate');
  assert.strictEqual(r.d, 0);
  assert.strictEqual(r.acc, 150, 'la précision est rendue, pour pouvoir le dire');
});

test('distance — un horodatage qui recule ne compte pas', () => {
  const f = new Metrics.DistanceFilter();
  const t0 = 1700000000000;
  f.push(48.85, 2.35, 8, t0);
  const p = Geo.destination(48.85, 2.35, 90, 50);
  assert.strictEqual(f.push(p.lat, p.lon, 8, t0 - 5000).status, 'stale');
  assert.strictEqual(f.push(p.lat, p.lon, 8, t0).status, 'stale');
});

test('distance — reset() oublie la position sans rien inventer', () => {
  /* C'est ce qui se passe à la reprise d'une pause et au réveil d'un gel : la
     distance parcourue entre-temps est inconnue, et ne doit surtout pas être
     comblée par une ligne droite entre les deux bords. */
  const f = new Metrics.DistanceFilter();
  const t0 = 1700000000000;
  f.push(48.85, 2.35, 8, t0);
  f.reset();
  const far = Geo.destination(48.85, 2.35, 90, 3000);
  const r = f.push(far.lat, far.lon, 8, t0 + 600000);
  assert.strictEqual(r.status, 'first', 'on repart d\'une origine neuve');
  assert.strictEqual(r.d, 0, '3 km non mesurés ne deviennent pas 3 km comptés');
});

test('distance — la vitesse rendue est celle du coureur', () => {
  const f = new Metrics.DistanceFilter();
  const t0 = 1700000000000;
  const seen = [];
  for (let i = 0; i <= 300; i++) {
    const p = Geo.destination(48.85, 2.35, 90, SPEED * i);
    const r = f.push(p.lat, p.lon, 8, t0 + i * 1000);
    if (r.status === 'move' && i > 30) seen.push(r.speed);
  }
  assert.ok(seen.length > 20, 'assez de bonds pour juger');
  const avg = seen.reduce((a, b) => a + b, 0) / seen.length;
  assert.ok(Math.abs(avg - SPEED) < 0.3, `vitesse moyenne ${avg.toFixed(2)} m/s`);
});

/* ---------- à l'arrêt ---------- */

test('distance — à l\'arrêt, le filtre coupe l\'essentiel de la dérive', () => {
  const r = replay({
    seconds: 3600, hz: 1, acc: 8, seed: 21,
    path: () => ({ lat: 48.85, lon: 2.35 })
  });
  assert.ok(r.naive > 3000, `témoin : sans filtre, ${Math.round(r.naive)} m en une heure`);
  assert.ok(r.counted < r.naive / 6,
    `${Math.round(r.counted)} m contre ${Math.round(r.naive)} m sans filtre`);
});

test('distance — à l\'arrêt avec un bon signal, rien ne bouge', () => {
  const r = replay({
    seconds: 1800, hz: 1, acc: 4, sigma: 1.5, seed: 22,
    path: () => ({ lat: 48.85, lon: 2.35 })
  });
  assert.strictEqual(Math.round(r.counted), 0,
    `${Math.round(r.counted)} m inventés avec un bon signal`);
});

/* Connu et non résolu : à ±8 m annoncés, une station debout prolongée fait
   encore grimper le compteur de quelques centaines de mètres à l'heure. Ce
   n'est pas un défaut d'implémentation mais un réglage — le rayon d'ancre
   (1,2 × précision) vaut environ 3,5 écarts-types de la position lissée, et un
   franchissement finit par arriver. L'élargir figerait l'arrêt mais
   sous-estimerait les trajets sinueux : c'est un arbitrage à trancher, pas un
   correctif évident. Le test reste ici, en `todo`, pour qu'on sache ce qu'on
   gagne le jour où le réglage change. */
test('distance — à l\'arrêt, le compteur devrait être rigoureusement figé',
  { todo: 'rayon d\'ancre à trancher — voir le commentaire ci-dessus' },
  () => {
    const r = replay({
      seconds: 3600, hz: 1, acc: 8, seed: 21,
      path: () => ({ lat: 48.85, lon: 2.35 })
    });
    assert.ok(r.counted < 100,
      `${Math.round(r.counted)} m inventés en une heure d'immobilité`);
  });

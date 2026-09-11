/* geo.test.js — la géométrie sur laquelle tout le reste s'appuie.
   Une erreur ici ne se voit nulle part et fausse tout : distance affichée,
   dénivelé, forme de la boucle, historique des sorties. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { engine, rng } = require('./harness');

/* Les tableaux que rendent les modules naissent dans le contexte `vm` du
   harnais : leur prototype n'est pas celui de Node, et deepStrictEqual les
   refuserait pour cette seule raison. On compare donc les contenus. */
function sameList(actual, expected, msg) {
  assert.deepEqual(Array.from(actual), expected, msg);
}

const { Geo } = engine();

/* 1° de latitude sur la sphère de rayon 6 371 008,8 m */
const DEG_M = 111194.93;

test('haversine — échelles connues', () => {
  assert.ok(Math.abs(Geo.haversine(0, 0, 1, 0) - DEG_M) < 1,
    'un degré de latitude vaut ~111,195 km');
  assert.ok(Math.abs(Geo.haversine(0, 0, 0, 1) - DEG_M) < 1,
    'à l\'équateur, un degré de longitude aussi');
  /* À 60°, un degré de longitude ne vaut plus que la moitié. */
  assert.ok(Math.abs(Geo.haversine(60, 0, 60, 1) - DEG_M / 2) < 60);
  assert.strictEqual(Geo.haversine(48.85, 2.35, 48.85, 2.35), 0);
});

test('haversine — symétrique et additive le long d\'un méridien', () => {
  const a = Geo.haversine(48.85, 2.35, 45.76, 4.83);
  const b = Geo.haversine(45.76, 4.83, 48.85, 2.35);
  assert.ok(Math.abs(a - b) < 1e-6);

  const total = Geo.haversine(10, 0, 12, 0);
  const half1 = Geo.haversine(10, 0, 11, 0);
  const half2 = Geo.haversine(11, 0, 12, 0);
  assert.ok(Math.abs(total - (half1 + half2)) < 0.01);
});

test('bearing — les quatre points cardinaux', () => {
  assert.ok(Math.abs(Geo.bearing(0, 0, 1, 0) - 0) < 1e-6, 'nord');
  assert.ok(Math.abs(Geo.bearing(0, 0, 0, 1) - 90) < 1e-6, 'est');
  assert.ok(Math.abs(Geo.bearing(1, 0, 0, 0) - 180) < 1e-6, 'sud');
  assert.ok(Math.abs(Geo.bearing(0, 1, 0, 0) - 270) < 1e-6, 'ouest');
});

test('angleDiff — passe le nord sans se tromper', () => {
  assert.strictEqual(Geo.angleDiff(350, 10), 20);
  assert.strictEqual(Geo.angleDiff(10, 350), 20);
  assert.strictEqual(Geo.angleDiff(0, 180), 180);
  assert.strictEqual(Geo.angleDiff(90, 90), 0);
  assert.ok(Geo.angleDiff(359, 1) === 2);
});

test('destination — aller puis mesurer redonne la distance', () => {
  const rand = rng(7);
  for (let i = 0; i < 200; i++) {
    const lat = -70 + rand() * 140, lon = -180 + rand() * 360;
    const brg = rand() * 360, dist = 50 + rand() * 20000;
    const p = Geo.destination(lat, lon, brg, dist);
    const back = Geo.haversine(lat, lon, p.lat, p.lon);
    assert.ok(Math.abs(back - dist) < 0.5, `écart ${back - dist} m`);
    assert.ok(p.lon >= -180 && p.lon <= 180, 'longitude normalisée');
  }
});

test('compass — huit secteurs, bornes comprises', () => {
  assert.strictEqual(Geo.compass(0), 'N');
  assert.strictEqual(Geo.compass(90), 'E');
  assert.strictEqual(Geo.compass(180), 'S');
  assert.strictEqual(Geo.compass(270), 'O');
  assert.strictEqual(Geo.compass(359), 'N', 'le tour est bouclé');
  assert.strictEqual(Geo.compass(-90), 'O', 'un cap négatif reste lisible');
});

test('pointInPolygon — dedans, dehors, et le trou d\'un U', () => {
  const square = [
    { lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 0 }
  ];
  assert.ok(Geo.pointInPolygon(0.5, 0.5, square));
  assert.ok(!Geo.pointInPolygon(1.5, 0.5, square));
  assert.ok(!Geo.pointInPolygon(0.5, -0.5, square));

  /* Un U : le creux central est dehors. */
  const u = [
    { lat: 0, lon: 0 }, { lat: 3, lon: 0 }, { lat: 3, lon: 1 }, { lat: 1, lon: 1 },
    { lat: 1, lon: 2 }, { lat: 3, lon: 2 }, { lat: 3, lon: 3 }, { lat: 0, lon: 3 }
  ];
  assert.ok(Geo.pointInPolygon(0.5, 1.5, u), 'la base du U');
  assert.ok(!Geo.pointInPolygon(2.5, 1.5, u), 'le creux du U');
});

/* ---------- compacité : ce qui distingue une vraie boucle d'un aller-retour ---------- */

function circle(lat, lon, radiusM, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const p = Geo.destination(lat, lon, (360 * i) / n, radiusM);
    pts.push([p.lat, p.lon]);
  }
  return pts;
}

test('compactness — un cercle vaut 1, un aller-retour vaut 0', () => {
  const pts = circle(48.85, 2.35, 500, 180);
  let per = 0;
  for (let i = 1; i < pts.length; i++) {
    per += Geo.haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  }
  const c = Geo.compactness(pts, per);
  assert.ok(c > 0.97 && c <= 1, `cercle : compacité ${c.toFixed(3)}`);

  /* Même longueur, mais parcourue en ligne droite puis rebroussée. */
  const line = [];
  for (let i = 0; i <= 50; i++) {
    const p = Geo.destination(48.85, 2.35, 90, i * 30);
    line.push([p.lat, p.lon]);
  }
  const there = line.concat(line.slice(0, -1).reverse());
  const back = Geo.compactness(there, 50 * 30 * 2);
  assert.ok(back < 0.01, `aller-retour : compacité ${back}`);
});

test('compactness — un carré est entre les deux, et jamais > 1', () => {
  const s = 500;
  const p0 = { lat: 48.85, lon: 2.35 };
  const p1 = Geo.destination(p0.lat, p0.lon, 90, s);
  const p2 = Geo.destination(p1.lat, p1.lon, 0, s);
  const p3 = Geo.destination(p2.lat, p2.lon, 270, s);
  const sq = [[p0.lat, p0.lon], [p1.lat, p1.lon], [p2.lat, p2.lon], [p3.lat, p3.lon], [p0.lat, p0.lon]];
  const c = Geo.compactness(sq, 4 * s);
  /* 4π·s² / (4s)² = π/4 ≈ 0,785 */
  assert.ok(Math.abs(c - Math.PI / 4) < 0.02, `carré : ${c.toFixed(3)}`);
  assert.strictEqual(Geo.compactness(sq, 0), 0, 'périmètre nul : pas de division');
});

/* ---------- allure ajustée à la pente ---------- */

test('gradeFactor — plat neutre, montée pénalisante, descente gagnante', () => {
  assert.strictEqual(Geo.gradeFactor(0), 1);
  assert.ok(Geo.gradeFactor(0.10) > 1.4, '10 % de montée coûte au moins 40 %');
  assert.ok(Geo.gradeFactor(-0.05) < 1, 'une pente douce en descente fait gagner');
  assert.ok(Geo.gradeFactor(-0.30) > Geo.gradeFactor(-0.09),
    'une descente très raide coûte de nouveau');
});

test('gradeFactor — strictement croissant en montée, et continu aux ruptures', () => {
  for (let g = 0; g < 0.4; g += 0.005) {
    assert.ok(Geo.gradeFactor(g + 0.005) > Geo.gradeFactor(g),
      `non monotone autour de ${g.toFixed(3)}`);
  }
  /* Les formules changent à 12 % en montée et 9 % en descente : sans continuité,
     deux tronçons presque identiques recevraient des durées très différentes. */
  const eps = 1e-6;
  assert.ok(Math.abs(Geo.gradeFactor(0.12 + eps) - Geo.gradeFactor(0.12 - eps)) < 1e-4);
  assert.ok(Math.abs(Geo.gradeFactor(-0.09 - eps) - Geo.gradeFactor(-0.09 + eps)) < 1e-3);
});

test('gradeFactor — une boucle rend la moyenne des deux sens ~neutre', () => {
  /* C'est l'hypothèse qui permet de viser une durée : sur une boucle, D+ = D−,
     donc la moyenne des deux sens doit rester proche de 1 aux pentes courantes. */
  for (const g of [0.02, 0.04, 0.06, 0.08]) {
    const avg = (Geo.gradeFactor(g) + Geo.gradeFactor(-g)) / 2;
    assert.ok(avg > 1 && avg < 1.35, `pente ${g} : moyenne ${avg.toFixed(3)}`);
  }
});

/* ---------- polyline ---------- */

test('encodePolyline / decodePolyline — aller-retour à 1e-5 près', () => {
  const rand = rng(11);
  const pts = [];
  for (let i = 0; i < 500; i++) {
    pts.push([48 + rand() * 2, 2 + rand() * 2]);
  }
  const back = Geo.decodePolyline(Geo.encodePolyline(pts));
  assert.strictEqual(back.length, pts.length);
  for (let i = 0; i < pts.length; i++) {
    assert.ok(Math.abs(back[i][0] - pts[i][0]) < 1e-5, `lat ${i}`);
    assert.ok(Math.abs(back[i][1] - pts[i][1]) < 1e-5, `lon ${i}`);
  }
});

test('encodePolyline — supporte les coordonnées négatives et le vide', () => {
  const pts = [[-33.86, 151.21], [-34.0, -58.38], [0, 0]];
  const back = Geo.decodePolyline(Geo.encodePolyline(pts));
  for (let i = 0; i < pts.length; i++) {
    assert.ok(Math.abs(back[i][0] - pts[i][0]) < 1e-5);
    assert.ok(Math.abs(back[i][1] - pts[i][1]) < 1e-5);
  }
  sameList(Geo.decodePolyline(''), []);
  assert.strictEqual(Geo.encodePolyline([]), '');
});

/* ---------- historique des sorties ---------- */

test('cellsAlong — aucun trou sur un tronçon long', () => {
  /* Le générateur écrit l'historique avec cellsAlong et le relit avec cellKey :
     si l'échantillonnage laisse des trous, des rues « déjà courues » repassent
     au travers et l'anti-répétition ne sert plus à rien. */
  const a = [48.85, 2.35];
  const b = Geo.destination(a[0], a[1], 42, 1000);
  const cells = Geo.cellsAlong([a, [b.lat, b.lon]]);

  /* ~35 m par cellule sur 1 000 m : il en faut au moins la vingtaine. */
  assert.ok(cells.length > 20, `seulement ${cells.length} cellules`);

  /* Et chaque point intermédiaire doit tomber dans une cellule connue. */
  const known = new Set(cells);
  for (let t = 0; t <= 1; t += 0.002) {
    const lat = a[0] + (b.lat - a[0]) * t;
    const lon = a[1] + (b.lon - a[1]) * t;
    assert.ok(known.has(Geo.cellKey(lat, lon)), `trou à t=${t.toFixed(3)}`);
  }
});

test('cellsAlong — dédoublonne et supporte les cas dégénérés', () => {
  sameList(Geo.cellsAlong([]), []);
  const one = Geo.cellsAlong([[48.85, 2.35]]);
  assert.strictEqual(one.length, 1);
  /* Un point répété ne doit pas gonfler la liste. */
  const same = Geo.cellsAlong([[48.85, 2.35], [48.85, 2.35], [48.85, 2.35]]);
  assert.strictEqual(same.length, 1);
});

/* ---------- simplification ---------- */

test('simplifyTo — respecte le plafond et garde les extrémités', () => {
  const pts = circle(48.85, 2.35, 800, 900);
  const out = Geo.simplifyTo(pts, 9);
  assert.ok(out.length <= 9, `${out.length} points`);
  sameList(out[0], pts[0]);
  sameList(out[out.length - 1], pts[pts.length - 1]);
});

test('simplifyTo — ne touche pas à une trace déjà courte', () => {
  const pts = [[48.85, 2.35], [48.86, 2.36], [48.87, 2.37]];
  assert.deepEqual(Array.from(Geo.simplifyTo(pts, 9), function (p) { return Array.from(p); }), pts);
});

test('simplifyIndices — une ligne droite se réduit à ses deux bouts', () => {
  const pts = [];
  for (let i = 0; i <= 100; i++) {
    const p = Geo.destination(48.85, 2.35, 90, i * 10);
    pts.push([p.lat, p.lon]);
  }
  sameList(Geo.simplifyIndices(pts, 5), [0, 100]);
});

/* ---------- affichage ---------- */

test('fmtDist / fmtDur — les formes vues par l\'utilisateur', () => {
  assert.strictEqual(Geo.fmtDist(0), '0 m');
  assert.strictEqual(Geo.fmtDist(999), '999 m');
  assert.strictEqual(Geo.fmtDist(1000), '1.00 km');
  assert.strictEqual(Geo.fmtDur(0), '0 min');
  assert.strictEqual(Geo.fmtDur(90), '2 min');
  assert.strictEqual(Geo.fmtDur(3600), '1 h 00');
  assert.strictEqual(Geo.fmtDur(3599), '1 h 00', '59 min 59 s ne doit pas donner « 0 h 60 »');
});

/* router.test.js — le moteur d'itinéraires, sur un quartier synthétique.

   Une grille régulière n'a rien d'un vrai tissu urbain, mais elle a deux
   qualités qu'aucune zone réelle n'offre : on connaît les distances exactes
   entre deux carrefours, et on peut donc affirmer qu'un résultat est faux.

   Une bonne part de ce fichier garde les tampons de travail réutilisés : ils
   remplacent des tableaux fraîchement alloués et remis à Infinity par un
   compteur de génération. C'est un gain franc, et une mécanique qui ne pardonne
   pas — d'où des tests qui comparent explicitement « avec » et « sans ». */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { engine, gridGraph, rng } = require('./harness');

const E = engine();
const { Geo, RGraph, Router } = E;

/* ================= construction du graphe ================= */

test('build — une grille donne le nombre de nœuds et de tronçons attendu', () => {
  const { G } = gridGraph(E, { side: 11, spacing: 100, uniform: true });
  assert.strictEqual(G.n, 121, 'onze par onze carrefours');
  /* 11 rues horizontales × 10 tronçons + autant à la verticale */
  assert.strictEqual(G.m, 220);
  assert.ok(G.off.length === G.n + 1, 'adjacence CSR cohérente');
});

test('build — les longueurs correspondent à l\'espacement demandé', () => {
  const { G } = gridGraph(E, { side: 6, spacing: 100 });
  for (let e = 0; e < G.m; e++) {
    assert.ok(Math.abs(G.elen[e] - 100) < 1.5, `tronçon ${e} : ${G.elen[e]} m`);
  }
});

test('build — un carrefour est relié à ses quatre voisins', () => {
  const { G, area } = gridGraph(E, { side: 11, spacing: 100 });
  const mid = RGraph.nearest(G, area.at(5, 5).lat, area.at(5, 5).lon).node;
  assert.strictEqual(G.off[mid + 1] - G.off[mid], 4);
  const corner = RGraph.nearest(G, area.at(0, 0).lat, area.at(0, 0).lon).node;
  assert.strictEqual(G.off[corner + 1] - G.off[corner], 2, 'un coin n\'en a que deux');
});

test('weight — le type de voie se retrouve dans le coût', () => {
  const calme = gridGraph(E, { side: 6, highway: 'residential', uniform: true }).G;
  const sentier = gridGraph(E, { side: 6, highway: 'path', uniform: true }).G;
  /* Un sentier doit coûter moins cher qu'une rue à longueur égale. */
  assert.ok(sentier.cost[0] < calme.cost[0],
    `sentier ${sentier.cost[0].toFixed(1)} vs rue ${calme.cost[0].toFixed(1)}`);
});

test('weight — le mode nuit renverse la préférence pour les sentiers', () => {
  const { G } = gridGraph(E, { side: 6, highway: 'path', uniform: true });
  const jour = G.cost[0];
  RGraph.weight(G, { nature: 0.6, night: true, paceSecPerKm: 360 });
  assert.ok(G.cost[0] > jour,
    'un sentier non éclairé doit devenir cher la nuit');
});

test('weight — la durée estimée suit l\'allure demandée', () => {
  const { G } = gridGraph(E, { side: 6, spacing: 100, uniform: true }, { paceSecPerKm: 300 });
  /* 100 m à 5:00 /km = 30 s, sans relief. */
  assert.ok(Math.abs(G.etime[0] - 30) < 1, `${G.etime[0].toFixed(1)} s`);
});

/* ================= nearest ================= */

test('nearest — rend le nœud le plus proche et la distance d\'accrochage', () => {
  const { G, area } = gridGraph(E, { side: 11, spacing: 100 });
  const p = area.at(3, 7);
  const r = RGraph.nearest(G, p.lat, p.lon);
  assert.ok(r.dist < 1, `accroché à ${r.dist.toFixed(2)} m d'un carrefour`);
  assert.ok(Math.abs(G.lats[r.node] - p.lat) < 1e-9);
});

test('nearest — dit la vérité quand le départ est loin de tout', () => {
  /* C'est le point du §1 : un départ posé au milieu d'un champ était ramené en
     silence sur le réseau, et le parcours ne commençait pas là où l'utilisateur
     croyait. La distance permet désormais de l'en avertir. */
  const { G, area } = gridGraph(E, { side: 11, spacing: 100 });
  const far = Geo.destination(area.at(5, 5).lat, area.at(5, 5).lon, 90, 3000);
  const r = RGraph.nearest(G, far.lat, far.lon);
  assert.ok(r.node >= 0, 'un nœud est tout de même trouvé');
  /* Le bord de la grille est à 500 m du centre : il reste 2 500 m. */
  assert.ok(Math.abs(r.dist - 2500) < 60, `accrochage annoncé à ${Math.round(r.dist)} m`);
});

test('nearest — trouve bien le plus proche, et rend la vraie distance', () => {
  /* La recherche se fait sur une distance plane, par économie ; la distance
     rendue, elle, doit être une vraie distance en mètres — c'est elle qu'on
     affiche à l'utilisateur. On vérifie les deux contre l'exhaustif. */
  const { G, area } = gridGraph(E, { side: 21, spacing: 100 });
  const rand = rng(31);

  function brute(lat, lon) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < G.n; i++) {
      if (G.off[i] === G.off[i + 1]) continue;
      const d = Geo.haversine(G.lats[i], G.lons[i], lat, lon);
      if (d < bd) { bd = d; best = i; }
    }
    return { node: best, dist: bd };
  }

  for (let k = 0; k < 300; k++) {
    /* Dedans, sur les bords, et bien au-delà. */
    const lat = area.lat0 + (rand() * 3 - 1) * area.dLat * area.side;
    const lon = area.lon0 + (rand() * 3 - 1) * area.dLon * area.side;
    const r = RGraph.nearest(G, lat, lon);
    const ref = brute(lat, lon);

    /* La distance annoncée est bien celle du nœud rendu. */
    const vraie = Geo.haversine(G.lats[r.node], G.lons[r.node], lat, lon);
    assert.ok(Math.abs(r.dist - vraie) < 1e-6, 'distance annoncée incohérente');

    /* Et ce nœud est le plus proche — l'approximation plane ne doit pas
       coûter plus de quelques centimètres à l'échelle d'une ville. */
    assert.ok(r.dist - ref.dist < 0.5,
      `à ${lat.toFixed(5)},${lon.toFixed(5)} : ${r.dist.toFixed(2)} m au lieu de ${ref.dist.toFixed(2)} m`);
  }
});

test('nearest — un graphe sans aucun nœud relié le dit', () => {
  const G = RGraph.build([{ type: 'node', id: 1, lat: 48.85, lon: 2.35 }], []);
  const r = RGraph.nearest(G, 48.85, 2.35);
  assert.strictEqual(r.node, -1);
  assert.strictEqual(r.dist, Infinity);
});

/* ================= Dijkstra et tampons réutilisés ================= */

test('dijkstra — la distance sur une grille est celle de Manhattan', () => {
  const { G, area } = gridGraph(E, { side: 11, spacing: 100, uniform: true });
  const src = RGraph.nearest(G, area.at(0, 0).lat, area.at(0, 0).lon).node;
  const dst = RGraph.nearest(G, area.at(4, 3).lat, area.at(4, 3).lon).node;
  const res = Router.dijkstra(G, src);
  /* Quatre pas à l'est, trois au nord : 700 m, quel que soit le détour choisi. */
  assert.ok(Math.abs(res.lenOf(dst) - 700) < 10, `${res.lenOf(dst)} m`);
});

test('dijkstra — maxLen borne vraiment l\'exploration', () => {
  const { G, area } = gridGraph(E, { side: 21, spacing: 100 });
  const src = RGraph.nearest(G, area.at(10, 10).lat, area.at(10, 10).lon).node;
  const res = Router.dijkstra(G, src, { maxLen: 300 });
  for (const v of res.seen) {
    assert.ok(res.lenOf(v) <= 300 + 1e-6, `nœud à ${res.lenOf(v)} m retenu`);
  }
  assert.ok(res.seen.length < G.n, 'tout le graphe n\'a pas été parcouru');
});

test('dijkstra — un tampon réutilisé donne le même résultat qu\'un tampon neuf', () => {
  /* Le cœur de l'optimisation : les tableaux ne sont plus remis à zéro entre
     deux parcours, seul un compteur de génération distingue le frais du
     périmé. Si ce compteur fuit, un parcours hérite silencieusement du
     précédent — exactement le genre de bogue qu'on ne voit jamais.
     On enchaîne donc plusieurs parcours différents sur le même tampon, et on
     exige à chaque fois l'égalité avec un tampon vierge. */
  const { G, area } = gridGraph(E, { side: 15, spacing: 100 });
  const partage = Router.scratch(G);
  const rand = rng(41);

  for (let k = 0; k < 12; k++) {
    const ix = Math.floor(rand() * 15), iy = Math.floor(rand() * 15);
    const src = RGraph.nearest(G, area.at(ix, iy).lat, area.at(ix, iy).lon).node;
    const maxLen = 200 + Math.floor(rand() * 800);

    const reutilise = Router.dijkstra(G, src, { maxLen, scratch: partage });
    const vus = reutilise.seen.slice();
    const longueurs = vus.map((v) => reutilise.lenOf(v));
    const couts = vus.map((v) => reutilise.costOf(v));

    const neuf = Router.dijkstra(G, src, { maxLen, scratch: Router.scratch(G) });
    assert.strictEqual(vus.length, neuf.seen.length, `tour ${k} : nombre de nœuds`);
    for (let i = 0; i < vus.length; i++) {
      assert.strictEqual(vus[i], neuf.seen[i], `tour ${k}, ordre au rang ${i}`);
      assert.ok(Math.abs(longueurs[i] - neuf.lenOf(vus[i])) < 1e-9, `tour ${k}, longueur`);
      assert.ok(Math.abs(couts[i] - neuf.costOf(vus[i])) < 1e-9, `tour ${k}, coût`);
    }
  }
});

test('dijkstra — deux tampons distincts ne se marchent pas dessus', () => {
  /* C'est la situation réelle du calcul de boucle : l'aller reste lu pendant
     que le retour se calcule. Avec un seul jeu de tampons, l'aller serait
     écrasé et l'itinéraire reconstruit n'aurait aucun sens. */
  const { G, area } = gridGraph(E, { side: 15, spacing: 100 });
  const a = RGraph.nearest(G, area.at(2, 2).lat, area.at(2, 2).lon).node;
  const b = RGraph.nearest(G, area.at(12, 12).lat, area.at(12, 12).lon).node;

  const sA = Router.scratch(G), sB = Router.scratch(G);
  const resA = Router.dijkstra(G, a, { scratch: sA });
  const avant = resA.seen.map((v) => resA.lenOf(v));

  Router.dijkstra(G, b, { scratch: sB });        // second parcours, autre tampon

  const apres = resA.seen.map((v) => resA.lenOf(v));
  for (let i = 0; i < avant.length; i++) {
    assert.ok(Math.abs(avant[i] - apres[i]) < 1e-9,
      `le premier parcours a été corrompu au rang ${i}`);
  }
});

test('dijkstra — un nœud jamais atteint reste à l\'infini', () => {
  /* Sans les accesseurs, un nœud non visité rendrait la valeur laissée par le
     parcours précédent : une distance plausible, et fausse. */
  const { G, area } = gridGraph(E, { side: 15, spacing: 100 });
  const partage = Router.scratch(G);
  const loin = RGraph.nearest(G, area.at(14, 14).lat, area.at(14, 14).lon).node;

  Router.dijkstra(G, loin, { scratch: partage });          // remplit le tampon
  const coin = RGraph.nearest(G, area.at(0, 0).lat, area.at(0, 0).lon).node;
  const court = Router.dijkstra(G, coin, { maxLen: 150, scratch: partage });

  assert.strictEqual(court.lenOf(loin), Infinity, 'hors de portée : infini');
  assert.strictEqual(court.costOf(loin), Infinity);
  assert.ok(!court.has(loin));
});

/* ================= statistiques ================= */

test('stats — longueur, familles et recouvrement', () => {
  const { G, area } = gridGraph(E, { side: 11, spacing: 100, uniform: true });
  const src = RGraph.nearest(G, area.at(0, 0).lat, area.at(0, 0).lon).node;
  const dst = RGraph.nearest(G, area.at(3, 0).lat, area.at(3, 0).lon).node;
  const res = Router.dijkstra(G, src, { stopAt: dst });

  /* Reconstruction manuelle du chemin, pour rester indépendant de plan(). */
  const nodes = [dst], edges = [];
  let cur = dst;
  while (cur !== src) { edges.push(res.pe[cur]); nodes.push(res.pv[cur]); cur = res.pv[cur]; }
  nodes.reverse(); edges.reverse();

  const s = Router.stats(G, nodes, edges);
  assert.ok(Math.abs(s.total - 300) < 5, `${s.total} m`);
  assert.strictEqual(s.overlap, 0, 'aucun tronçon parcouru deux fois');
  assert.ok(s.fam.calme > 0, 'une rue résidentielle est « calme »');
});

test('stats — le dénivelé filtre le bruit des tuiles d\'altitude', () => {
  /* Un terrain rigoureusement plat, mais dont les altitudes portent ±1 m de
     bruit : sans hystérésis, un parcours de 2 km accumulerait des dizaines de
     mètres de D+ imaginaire. */
  const bruit = rng(51);
  const { G, area } = gridGraph(E, {
    side: 21, spacing: 100, elevation: () => 100 + (bruit() - 0.5) * 2
  });
  const src = RGraph.nearest(G, area.at(0, 10).lat, area.at(0, 10).lon).node;
  const dst = RGraph.nearest(G, area.at(20, 10).lat, area.at(20, 10).lon).node;
  const res = Router.dijkstra(G, src, { stopAt: dst });

  const nodes = [dst], edges = [];
  let cur = dst;
  while (cur !== src) { edges.push(res.pe[cur]); nodes.push(res.pv[cur]); cur = res.pv[cur]; }
  nodes.reverse(); edges.reverse();

  const s = Router.stats(G, nodes, edges);
  assert.ok(s.climb <= 5, `${s.climb} m de D+ inventés sur un terrain plat`);
});

test('stats — une vraie côte est bien comptée', () => {
  /* Même parcours, mais le terrain monte de 2 m par carrefour vers l'est :
     vingt tronçons, donc 40 m de D+ réels. */
  const { G, area } = gridGraph(E, {
    side: 21, spacing: 100, elevation: (ix) => 100 + ix * 2
  });
  const src = RGraph.nearest(G, area.at(0, 10).lat, area.at(0, 10).lon).node;
  const dst = RGraph.nearest(G, area.at(20, 10).lat, area.at(20, 10).lon).node;
  const res = Router.dijkstra(G, src, { stopAt: dst });

  const nodes = [dst], edges = [];
  let cur = dst;
  while (cur !== src) { edges.push(res.pe[cur]); nodes.push(res.pv[cur]); cur = res.pv[cur]; }
  nodes.reverse(); edges.reverse();

  const s = Router.stats(G, nodes, edges);
  assert.ok(Math.abs(s.climb - 40) < 6, `${s.climb} m de D+ pour 40 réels`);
});

/* ================= planification ================= */

function planOn(G, extra) {
  return Router.plan(G, Object.assign({
    target: 2000, objective: 'dist', mode: 'loop',
    direction: null, sector: 180, overlap: 7, tolerance: 0.14,
    variants: 5, loopShape: 0.6, dplus: 0, waterEvery: 0
  }, extra));
}

test('plan — une boucle tient la distance visée', async () => {
  const { G, area } = gridGraph(E, { side: 21, spacing: 100 });
  const src = RGraph.nearest(G, area.at(10, 10).lat, area.at(10, 10).lon).node;
  const res = await planOn(G, { src });

  assert.ok(res.routes.length > 0, 'au moins un tracé');
  for (const r of res.routes) {
    const err = Math.abs(r.stats.total - 2000) / 2000;
    assert.ok(err <= 0.15, `${Math.round(r.stats.total)} m pour 2 000`);
  }
});

test('plan — une boucle se referme sur son départ', async () => {
  const { G, area } = gridGraph(E, { side: 21, spacing: 100 });
  const src = RGraph.nearest(G, area.at(10, 10).lat, area.at(10, 10).lon).node;
  const res = await planOn(G, { src });
  const r = res.routes[0];
  const n = r.coords.length / 2;
  assert.ok(Math.abs(r.coords[0] - r.coords[2 * (n - 1)]) < 1e-9, 'latitude de retour');
  assert.ok(Math.abs(r.coords[1] - r.coords[2 * (n - 1) + 1]) < 1e-9, 'longitude de retour');
});

test('plan — la distance cumulée est cohérente avec le total annoncé', async () => {
  const { G, area } = gridGraph(E, { side: 21, spacing: 100 });
  const src = RGraph.nearest(G, area.at(10, 10).lat, area.at(10, 10).lon).node;
  const res = await planOn(G, { src });
  for (const r of res.routes) {
    const n = r.cum.length;
    assert.ok(Math.abs(r.cum[n - 1] - r.stats.total) < 1,
      `cumul ${r.cum[n - 1]} vs total ${r.stats.total}`);
    for (let i = 1; i < n; i++) {
      assert.ok(r.cum[i] >= r.cum[i - 1], `cumul non croissant au rang ${i}`);
    }
  }
});

test('plan — un cap demandé est respecté', async () => {
  const { G, area } = gridGraph(E, { side: 25, spacing: 100 });
  const src = RGraph.nearest(G, area.at(12, 12).lat, area.at(12, 12).lon).node;
  const res = await planOn(G, { src, direction: 90, sector: 60 });
  assert.ok(res.routes.length > 0);
  for (const r of res.routes) {
    assert.ok(Geo.angleDiff(r.brg, 90) <= 30 + 1e-6,
      `tracé proposé vers ${Math.round(r.brg)}° alors qu'on visait l'est`);
  }
});

test('plan — l\'aller-retour fait exactement deux fois l\'aller', async () => {
  const { G, area } = gridGraph(E, { side: 25, spacing: 100 });
  const src = RGraph.nearest(G, area.at(12, 12).lat, area.at(12, 12).lon).node;
  const res = await planOn(G, { src, mode: 'outback' });
  assert.ok(res.routes.length > 0);
  const r = res.routes[0];
  /* Tout est parcouru deux fois, donc le recouvrement vaut la moitié du total. */
  assert.ok(Math.abs(r.overlapFrac - 0.5) < 0.02,
    `recouvrement ${(r.overlapFrac * 100).toFixed(0)} %`);
});

test('plan — un point à point relie bien le départ à l\'arrivée', async () => {
  const { G, area } = gridGraph(E, { side: 25, spacing: 100 });
  const src = RGraph.nearest(G, area.at(4, 12).lat, area.at(4, 12).lon).node;
  const dst = RGraph.nearest(G, area.at(20, 12).lat, area.at(20, 12).lon).node;
  const res = await planOn(G, { src, dst, mode: 'p2p', target: 2500, loopShape: 0 });

  assert.ok(res.routes.length > 0, res.reason || 'aucun tracé');
  const r = res.routes[0];
  const n = r.coords.length / 2;
  assert.ok(Math.abs(r.coords[0] - G.lats[src]) < 1e-9, 'part du départ');
  assert.ok(Math.abs(r.coords[2 * (n - 1)] - G.lats[dst]) < 1e-9, 'arrive à l\'arrivée');
});

test('plan — sans arrivée valable, le point à point le dit', async () => {
  const { G, area } = gridGraph(E, { side: 11, spacing: 100 });
  const src = RGraph.nearest(G, area.at(5, 5).lat, area.at(5, 5).lon).node;
  const res = await planOn(G, { src, dst: src, mode: 'p2p' });
  assert.strictEqual(res.routes.length, 0);
  assert.strictEqual(res.reason, 'nodst');
});

test('plan — les variantes proposées sont réellement différentes', async () => {
  const { G, area } = gridGraph(E, { side: 25, spacing: 100 });
  const src = RGraph.nearest(G, area.at(12, 12).lat, area.at(12, 12).lon).node;
  const res = await planOn(G, { src });
  if (res.routes.length < 2) return;             // rien à vérifier
  for (let i = 0; i < res.routes.length; i++) {
    for (let j = i + 1; j < res.routes.length; j++) {
      const memeCap = Geo.angleDiff(res.routes[i].brg, res.routes[j].brg) < 35;
      const memeLongueur =
        Math.abs(res.routes[i].stats.total - res.routes[j].stats.total) < 2000 * 0.06;
      assert.ok(!(memeCap && memeLongueur),
        `variantes ${i} et ${j} trop semblables`);
    }
  }
});

test('plan — renoncer interrompt vraiment le calcul', async () => {
  /* Le §1 : jusqu'ici, « Annuler » ne pouvait que masquer un résultat dont le
     calcul continuait de tourner. */
  const { G, area } = gridGraph(E, { side: 31, spacing: 100 });
  const src = RGraph.nearest(G, area.at(15, 15).lat, area.at(15, 15).lon).node;

  let vus = 0;
  await assert.rejects(
    () => planOn(G, {
      src, target: 4000,
      shouldStop: () => { vus++; return vus >= 1; }
    }),
    (err) => err.cancelled === true,
    'l\'annulation doit remonter comme telle'
  );
});

test('plan — un graphe trop pauvre ne produit rien plutôt qu\'un tracé absurde', async () => {
  const { G, area } = gridGraph(E, { side: 4, spacing: 100 });
  const src = RGraph.nearest(G, area.at(0, 0).lat, area.at(0, 0).lon).node;
  const res = await planOn(G, { src, target: 20000 });
  assert.strictEqual(res.routes.length, 0);
  assert.ok(res.reason, 'et il dit pourquoi');
});

test('plan — deux appels successifs donnent le même résultat', async () => {
  /* Les tampons sont maintenant partagés d'un calcul à l'autre : un second
     calcul ne doit rien hériter du premier. */
  const { G, area } = gridGraph(E, { side: 21, spacing: 100 });
  const src = RGraph.nearest(G, area.at(10, 10).lat, area.at(10, 10).lon).node;

  const a = await planOn(G, { src });
  const b = await planOn(G, { src });

  assert.strictEqual(a.routes.length, b.routes.length);
  for (let i = 0; i < a.routes.length; i++) {
    assert.ok(Math.abs(a.routes[i].stats.total - b.routes[i].stats.total) < 1e-6,
      `variante ${i} : ${a.routes[i].stats.total} puis ${b.routes[i].stats.total}`);
    assert.strictEqual(a.routes[i].coords.length, b.routes[i].coords.length);
  }
});

/* ================= sérialisation ================= */

test('serialize / deserialize — le graphe survit au cache', async () => {
  const { G, area } = gridGraph(E, {
    side: 15, spacing: 100, elevation: (ix, iy) => 100 + ix + iy
  });
  const H = RGraph.deserialize(RGraph.serialize(G));
  assert.strictEqual(H.n, G.n);
  assert.strictEqual(H.m, G.m);
  assert.strictEqual(H.hasEle, G.hasEle);

  /* Et il calcule la même chose. */
  RGraph.weight(H, { nature: 0.6, preferGreen: true, hilliness: 0, paceSecPerKm: 360 });
  const src = RGraph.nearest(G, area.at(7, 7).lat, area.at(7, 7).lon).node;
  const a = await planOn(G, { src });
  const b = await planOn(H, { src: RGraph.nearest(H, area.at(7, 7).lat, area.at(7, 7).lon).node });
  assert.strictEqual(a.routes.length, b.routes.length);
  if (a.routes.length) {
    assert.ok(Math.abs(a.routes[0].stats.total - b.routes[0].stats.total) < 1e-6);
  }
});

test('plan — quand tout se vaut, les boucles raccourcissent, mais c\'est annoncé', () => {
  /* Découvert en écrivant ces tests. Le point de demi-tour est choisi par
     secteur angulaire, et départagé sur l'agrément moyen de l'aller. Dans un
     quartier où toutes les voies ont le même coût — une cité pavillonnaire
     homogène, un lotissement — tous les candidats d'un secteur sont à égalité
     parfaite, et c'est alors l'ordre de sortie du tas qui tranche : le plus
     proche. Toutes les boucles proposées tirent donc vers le court.

     Ce n'est pas silencieux — `relaxed` est levé et l'interface affiche
     « distance approchée » — et c'est ce contrat-là qu'on verrouille ici.
     Départager les ex æquo par proximité à la distance visée serait la vraie
     correction ; elle change le choix d'itinéraire, donc elle se décide. */
  return (async () => {
    const { G, area } = gridGraph(E, { side: 21, spacing: 100, uniform: true });
    const src = RGraph.nearest(G, area.at(10, 10).lat, area.at(10, 10).lon).node;
    const res = await planOn(G, { src });

    assert.ok(res.routes.length > 0, 'un tracé est tout de même proposé');
    const hors = res.routes.filter((r) => Math.abs(r.stats.total - 2000) / 2000 > 0.14);
    if (hors.length) {
      assert.strictEqual(res.relaxed, true,
        'une distance hors tolérance doit être signalée comme approchée');
    }
  })();
});

/* worker.js — le moteur tourne hors du thread principal : l'interface reste
   fluide pendant la construction du graphe et les Dijkstra.
   Le worker détient le graphe ; la page ne reçoit que les tracés (coordonnées,
   profil, statistiques) et une copie compacte du graphe pour son cache. */
'use strict';

importScripts('geo.js', 'graph.js', 'router.js');

var G = null;          // graphe courant
var lastWeights = null;

/* Calculs que la page a renoncé à attendre. Router.plan respire régulièrement
   et consulte cet ensemble : un « Annuler » cesse donc de coûter du CPU au
   lieu de se contenter de masquer le résultat. */
var cancelled = new Set();

function send(msg, transfer) { self.postMessage(msg, transfer || []); }

function summary(id) {
  return {
    type: 'ready', id: id, n: G.n, m: G.m, greens: G.greens,
    hasEle: G.hasEle, waterCount: G.waterCount, pois: G.pois || []
  };
}

self.onmessage = function (ev) {
  var msg = ev.data, id = msg.id;
  try {
    switch (msg.type) {

      case 'build':
        send({ type: 'progress', id: id, frac: 0.55, msg: 'Construction du graphe…' });
        G = RGraph.build(msg.net, msg.green);
        if (G.n < 20) {
          send({ type: 'error', id: id, message: 'Zone trop pauvre en chemins cartographiés.' });
          return;
        }
        if (msg.tiles && msg.tiles.length) {
          send({ type: 'progress', id: id, frac: 0.7, msg: 'Analyse du relief…' });
          RGraph.attachElevation(G, msg.tiles);
        }
        RGraph.attachWater(G, msg.pois || []);
        /* copie (pas de transfert) : le worker garde son graphe */
        send(Object.assign(summary(id), { blob: RGraph.serialize(G) }));
        break;

      case 'load':                       // graphe restauré depuis le cache
        G = RGraph.deserialize(msg.blob);
        send(summary(id));
        break;

      case 'water':                      // points d'eau rafraîchis seuls
        if (!G) return;
        RGraph.attachWater(G, msg.pois || []);
        send(summary(id));
        break;

      case 'elevation':                  // relief ajouté après coup
        if (!G) return;
        RGraph.attachElevation(G, msg.tiles || []);
        send(Object.assign(summary(id), { blob: RGraph.serialize(G) }));
        break;

      case 'plan':
        if (!G) { send({ type: 'error', id: id, message: 'Graphe absent.' }); return; }
        plan(msg);
        break;

      case 'cancel':                     // la page a renoncé à ce calcul
        cancelled.add(msg.target);
        break;

      case 'reset':
        G = null;
        break;
    }
  } catch (err) {
    send({ type: 'error', id: id, message: (err && err.message) || String(err) });
  }
};

async function plan(msg) {
  var id = msg.id, p = msg.p, w = msg.weights;

  /* L'historique arrive sous forme de paires [clé, poids] : on reconstruit la
     Map côté worker (les Map traversent postMessage, mais les tableaux sont
     plus légers à sérialiser). */
  var hist = null;
  if (msg.history && msg.history.length) {
    hist = new Map();
    for (var i = 0; i < msg.history.length; i++) hist.set(msg.history[i][0], msg.history[i][1]);
  }
  w = Object.assign({}, w, { history: hist });
  lastWeights = w;
  RGraph.weight(G, w);

  /* `nearest` rend aussi la distance d'accrochage : un départ posé loin de
     toute voie cartographiée est ramené en silence sur le réseau, et le
     parcours ne commence alors pas là où l'utilisateur croit. La page le dira. */
  var start = RGraph.nearest(G, p.startLat, p.startLon);
  if (start.node < 0) {
    send({ type: 'error', id: id, message: 'Aucun chemin trouvé près du départ.' });
    return;
  }
  p.src = start.node;
  var end = null;
  if (p.mode === 'p2p' && p.endLat !== undefined && p.endLat !== null) {
    end = RGraph.nearest(G, p.endLat, p.endLon);
    p.dst = end.node;
  }

  p.shouldStop = function () { return cancelled.has(id); };

  var res;
  try {
    res = await Router.plan(G, p, function (frac, m) {
      send({ type: 'progress', id: id, frac: frac, msg: m });
    });
  } catch (err) {
    cancelled.delete(id);
    if (err && err.cancelled) { send({ type: 'cancelled', id: id }); return; }
    send({ type: 'error', id: id, message: (err && err.message) || String(err) });
    return;
  }
  cancelled.delete(id);

  var transfer = [];
  for (var k = 0; k < res.routes.length; k++) {
    transfer = transfer.concat(Router.transferOf(res.routes[k]));
  }
  send({
    type: 'planned', id: id, routes: res.routes, reason: res.reason,
    relaxed: res.relaxed, all: res.all,
    start: [G.lats[p.src], G.lons[p.src]], snapStart: start.dist,
    end: p.dst !== undefined && p.dst >= 0 ? [G.lats[p.dst], G.lons[p.dst]] : null,
    snapEnd: end ? end.dist : null
  }, transfer);
}

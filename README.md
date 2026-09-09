# JogRoute — générateur de parcours de jogging

Application web (100 % navigateur, aucun serveur applicatif) qui calcule un
parcours de course à pied optimisé pour être **agréable** : chemins, sentiers,
parcs et rues calmes plutôt que grands axes.

## Lancer

Double-cliquer sur `start.bat` (ouvre un petit serveur local + le navigateur),
ou manuellement :

```
cd F:\Test\Jogging
python -m http.server 8765
```
puis ouvrir <http://localhost:8765/index.html>.

> `index.html` fonctionne aussi en double-clic (`file://`), mais un serveur
> local est plus fiable (certains navigateurs bloquent les requêtes réseau
> depuis `file://`).

## Utilisation

1. **Départ** — clic sur la carte, marqueur déplaçable, recherche d'adresse
   (Nominatim) ou bouton « Ma position ».
2. **Parcours** — distance visée (1–42 km), boucle ou aller-retour, allure
   (pour l'estimation de durée).
3. **Direction** — cap général souhaité (N, NE, E…) et largeur du secteur
   autorisé, ou « peu importe ».
4. **Agrément** — curseur de 0 % (le plus court) à 100 % (le plus agréable,
   quitte à rallonger), plus trois options : espaces verts, escaliers,
   éviter de repasser au même endroit.
5. **Générer** — le tracé apparaît, coloré par type de voie, avec bornes
   kilométriques, statistiques, jusqu'à 5 variantes et un export **GPX**
   (montre GPS, Garmin Connect, Strava…).

## Comment fonctionne le moteur

1. **Données** — le réseau piéton OSM (`highway=path|footway|track|residential|…`,
   hors voies interdites d'accès) est téléchargé autour du départ via l'API
   Overpass, en parallèle des polygones d'espaces verts (parcs, bois, prés).
2. **Graphe pondéré** — chaque tronçon reçoit un coût
   `longueur × agrément^k` où l'agrément dépend du type de voie
   (sentier 0,55 · trottoir 0,70 · rue résidentielle 1,05 · départementale 2,7 ·
   axe primaire 4,2), du revêtement (naturel ×0,85), du fait d'être dans un
   espace vert (×0,70) ou d'être un trottoir longeant une route (×1,18).
   L'exposant `k` (0 → 2) est piloté par le curseur « priorité chemins & nature » :
   à 0 le moteur cherche le plus court, à 100 % il paie volontiers un détour
   pour rester sur les chemins.
3. **Boucles** — un Dijkstra depuis le départ fournit tous les points situés à
   ~½ distance ; les meilleurs (agrément moyen le plus bas) sont retenus comme
   points de mi-parcours, un par secteur angulaire pour varier les propositions.
   Pour chacun, le retour est calculé par un second Dijkstra où les tronçons
   déjà empruntés sont pénalisés (×7), ce qui produit une vraie boucle plutôt
   qu'un aller-retour.
4. **Notation** — chaque candidat est noté sur
   `agrément moyen + 6 × écart de distance + 1,4 × part parcourue deux fois +
   écart au cap demandé` ; les 5 meilleurs tracés distincts sont proposés.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | structure de la page et panneau de paramètres |
| `style.css` | thème sombre, panneau, carte |
| `js/geo.js` | distances, caps, point-dans-polygone |
| `js/overpass.js` | requêtes Overpass (3 miroirs, bascule automatique) + géocodage |
| `js/graph.js` | construction du graphe et pondération « agrément » |
| `js/router.js` | tas binaire, Dijkstra borné, recherche et notation des boucles |
| `js/app.js` | carte Leaflet, interface, rendu, export GPX |

Console du navigateur : `JogRoute.state`, `JogRoute.run()`, `JogRoute.setStart(lat, lon, true)`.

## Limites connues

- Le téléchargement Overpass prend **10 à 60 s** selon la zone et la charge des
  serveurs publics (au-delà de 45 s, l'app bascule sur un autre miroir). Le
  réseau est mis en cache : les générations suivantes au même départ sont
  immédiates.
- Pas de profil altimétrique : le dénivelé n'est pas pris en compte.
- La qualité du résultat dépend de la cartographie OSM locale (un chemin non
  cartographié n'existe pas pour le moteur).
- Zones très denses (centre de Paris) : rayon de téléchargement plus lourd,
  donc calcul plus long.

Données © contributeurs OpenStreetMap (ODbL) · fonds de carte OSM, OpenTopoMap,
CyclOSM · géocodage Nominatim.

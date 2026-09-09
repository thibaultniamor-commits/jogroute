# JogRoute — générateur de parcours de jogging

Application web (100 % navigateur, aucun serveur applicatif) qui calcule un
parcours de course à pied optimisé pour être **agréable** : chemins, sentiers,
parcs et rues calmes plutôt que grands axes.

**▶ Essayer en ligne : <https://thibaultniamor-commits.github.io/jogroute/>**
(rien à installer, s'installe aussi comme application, fonctionne hors ligne)

Aucune clé d'API, aucun compte, aucun quota : toutes les sources utilisées sont
ouvertes et anonymes. Rien ne quitte l'appareil hormis les requêtes aux serveurs
publics OpenStreetMap.

## Lancer

### En ligne
Ouvrir <https://thibaultniamor-commits.github.io/jogroute/>. Sur téléphone,
« Ajouter à l'écran d'accueil » installe l'app ; elle démarre ensuite sans
réseau.

### En local
Double-cliquer sur `start.bat` (ouvre un petit serveur local + le navigateur),
ou manuellement :

```
cd F:\Test\Jogging
python -m http.server 8765
```
puis ouvrir <http://localhost:8765/index.html>.

> Un serveur local est nécessaire : le Web Worker et le service worker ne
> fonctionnent pas depuis `file://`. L'app reste utilisable en `file://`, mais
> le calcul se fait alors dans le thread de la page et sans mode hors ligne.

## Utilisation

1. **Départ** — clic sur la carte, marqueur déplaçable, recherche d'adresse
   (Nominatim), bouton « Ma position », ou **départs favoris** enregistrés.
2. **Parcours** — boucle, aller-retour ou **point à point** (départ ≠ arrivée) ;
   objectif en **distance** ou en **durée** ; allure.
3. **Direction** — cap général, largeur du secteur, ou **« partir face au
   vent »** (météo courante, retour poussé par le vent).
4. **Relief** — curseur *plat ↔ vallonné* et **dénivelé positif visé**.
5. **Agrément** — priorité aux chemins et à la nature, espaces verts, escaliers,
   éviter de repasser au même endroit, privilégier les **vraies boucles**,
   et un **mode nuit** (rues éclairées, éviter les coins isolés).
6. **Nouveauté & ravitaillement** — éviter ce qui a déjà été couru les N derniers
   jours, et exiger un **point d'eau** tous les N kilomètres.
7. **Générer** — tracé coloré par type de voie, bornes kilométriques,
   **profil altimétrique** survolable, statistiques, jusqu'à 5 variantes.

### Emporter le parcours

| Bouton | Effet |
|---|---|
| **🗺 Ouvrir dans Google Maps** | ouvre l'itinéraire à pied dans Maps (tracé approché par ~8 étapes clés) |
| **📱 QR pour le téléphone** | QR du lien Maps : on scanne depuis le PC, Maps s'ouvre sur le téléphone |
| **🔗 Partager le lien** | lien JogRoute contenant les réglages **et le tracé exact** — s'affiche instantanément, sans recalcul |
| **⬇ GPX** | trace exacte avec altitudes (montre GPS, Garmin Connect, Strava…) |
| **✓ J'ai couru ça** | mémorise le parcours localement pour que les suivants évitent ces rues |

> Google Maps n'accepte que 9 étapes intermédiaires et recalcule le chemin entre
> elles : le tracé y est **approché**. Pour la trace fidèle au mètre, utiliser le
> GPX.

## Comment fonctionne le moteur

1. **Données** — le réseau piéton OSM est téléchargé autour du départ via
   l'API Overpass, puis les espaces verts, puis les points d'eau —
   **séquentiellement**, les serveurs publics n'accordant que deux créneaux
   simultanés par adresse IP.
2. **Relief** — les tuiles *Terrarium* (AWS Open Data, sans clé) sont décodées
   dans le navigateur : `altitude = R×256 + G + B/256 − 32768`. Chaque nœud reçoit
   une altitude, lissée sur ses voisins.
3. **Graphe pondéré** — chaque tronçon reçoit un coût `longueur × agrément^k` où
   l'agrément dépend du type de voie (sentier 0,55 · trottoir 0,70 · rue
   résidentielle 1,05 · départementale 2,7 · axe primaire 4,2), du revêtement, de
   la présence d'un espace vert, de la **pente**, de l'**éclairage** (mode nuit)
   et de l'**historique des sorties récentes**. L'exposant `k` (0 → 2) est piloté
   par le curseur « priorité chemins & nature ».
4. **Temps** — chaque tronçon reçoit une durée estimée par une *allure ajustée à
   la pente*, moyennée sur les deux sens : sur une boucle, D+ = D−, donc la somme
   donne un total juste. C'est ce qui permet de viser une **durée** plutôt qu'une
   distance.
5. **Boucles** — un Dijkstra depuis le départ fournit les points situés à
   ~½ distance ; les meilleurs sont retenus comme points de mi-parcours, un par
   secteur angulaire. Pour chacun, le retour est calculé par un second Dijkstra
   où les tronçons déjà empruntés sont pénalisés. En **point à point**, le même
   schéma relie départ et arrivée en passant par un détour de la bonne longueur.
6. **Notation** — `agrément moyen + 6 × écart à l'objectif + 1,4 × part parcourue
   deux fois + écart au cap + (1 − compacité) + écart au D+ visé + manque d'eau`.
   La **compacité** (aire de l'enveloppe convexe / périmètre², 1 = cercle) est ce
   qui distingue une vraie boucle d'un aller-retour déguisé.

Tout ce calcul tourne dans un **Web Worker** : l'interface ne se fige jamais.

## Hors ligne

- Le graphe d'une zone est stocké en **IndexedDB** sous forme compacte
  (tableaux typés, ~1 Mo pour un rayon de 2 km), avec les tuiles d'altitude.
- Un **service worker** met en cache l'application et les fonds de carte
  consultés.
- Résultat : une zone visitée une fois se recalcule **sans aucun réseau** — en
  forêt, à l'étranger, en avion. Le bouton « Garder cette zone hors ligne »
  télécharge volontairement un rayon plus large.
- Le rayon de téléchargement est arrondi à des **paliers** (1,5 / 2 / 2,6 / 3,4 /
  4,4 / 5,6 / 7 km) : bouger le curseur de distance d'un kilomètre ne redéclenche
  donc pas 60 s d'Overpass.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `style.css` | page, panneau de paramètres, thème sombre |
| `js/geo.js` | distances, caps, simplification, compacité, allure/pente, polyline |
| `js/overpass.js` | requêtes Overpass (3 miroirs, séquentielles) + géocodage |
| `js/elevation.js` | tuiles d'altitude Terrarium, décodage et cache |
| `js/weather.js` | météo courante (Open-Meteo) pour l'orientation au vent |
| `js/store.js` | IndexedDB (zones, tuiles) + favoris, historique, préférences |
| `js/graph.js` | construction du graphe, altitude, pondération, sérialisation |
| `js/router.js` | tas binaire, Dijkstra borné, recherche et notation des tracés |
| `js/worker.js` | héberge le moteur hors du thread principal |
| `js/share.js` | lien JogRoute, lien Google Maps, QR code |
| `js/app.js` | carte Leaflet, interface, rendu, profil, export |
| `sw.js`, `manifest.webmanifest` | installation et fonctionnement hors ligne |
| `vendor/` | Leaflet et qrcode-generator, embarqués (aucun CDN) |

Console du navigateur : `JogRoute.state`, `JogRoute.run()`,
`JogRoute.setStart(lat, lon, true)`.

## Limites connues

- Le premier téléchargement d'une zone prend **10 à 60 s** selon la charge des
  serveurs Overpass publics. Les calculs suivants au même endroit sont immédiats.
- Le relief vient de tuiles à ~30 m : le dénivelé est un bon ordre de grandeur,
  pas une mesure barométrique. Un filtre à hystérésis de 2,5 m évite d'accumuler
  le bruit des tuiles.
- La qualité du résultat dépend de la cartographie OSM locale : un chemin non
  cartographié n'existe pas pour le moteur, et le mode nuit dépend du tag `lit`,
  souvent absent hors des grandes villes.
- Zones très denses (centre de Paris) : téléchargement plus lourd, calcul plus long.
- L'itinéraire Google Maps est une approximation à ~8 étapes (limite de l'API
  d'URL Maps).

## Licence

MIT — voir [LICENSE](LICENSE).

Données © contributeurs OpenStreetMap (ODbL) · fonds de carte OSM, OpenTopoMap,
CyclOSM · géocodage Nominatim · relief AWS Terrarium · météo Open-Meteo.

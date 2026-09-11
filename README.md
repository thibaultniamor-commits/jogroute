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
8. **Suivi en direct** — pendant la sortie, l'app compte la **distance
   parcourue** et le **nombre de pas**, et affiche durée, allure et cadence.

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

### Compter sa sortie

Le bouton **« ▶ Démarrer la sortie »** ouvre un compteur qui fonctionne avec ou
sans parcours généré :

| Mesure | Source |
|---|---|
| **Distance** | positions GPS, lissées et cumulées par bonds (voir plus bas) |
| **Pas** | accéléromètre du téléphone ; à défaut, estimation par la foulée |
| Trous de mesure | battement d'une seconde : tout gel est détecté et déclaré |
| Durée, allure | chronomètre de la sortie, pause comprise |
| Cadence, foulée | pas des 12 dernières secondes, distance ÷ pas |

Un compteur en gros caractères s'affiche **par-dessus la carte** (le toucher
recentre la vue), la trace réelle se dessine au fil de la course, et si un
parcours est affiché, une barre indique l'**avancement** et ce qu'il reste.

À l'arrêt : **⬇ GPX de la sortie** exporte la trace réellement parcourue, avec
les horodatages — Strava et les montres en recalculent l'allure. **✓ Ajouter à
l'historique** l'ajoute aux sorties mémorisées, que le générateur évite ensuite.

L'écran est maintenu allumé pendant la course (Wake Lock), et la sortie est
recopiée localement toutes les 5 secondes : si la page est rechargée ou l'onglet
tué, elle est retrouvée **en pause**, distance et pas intacts.

#### Courir téléphone en poche

Une page web n'a **aucun accès au GPS ni à l'accéléromètre quand l'écran est
éteint** : iOS gèle l'onglet en quelques secondes, Android le suspend, et aucune
API ne contourne cela (un service worker n'a pas droit à la géolocalisation).
Deux réponses, dans cet ordre :

1. **« 🌙 Écran noir »** — l'écran reste techniquement allumé, donc tout continue
   d'être mesuré, mais n'affiche plus qu'un fond noir et quatre chiffres à peine
   éclairés. Sur dalle OLED la consommation est négligeable, et le téléphone
   peut rester en poche sans appuis intempestifs. Un toucher revient à la carte.
   **C'est la méthode fiable.**
2. **« Tenter de continuer écran éteint »** (case à cocher) — l'app diffuse une
   piste d'une seconde bouclée dont les échantillons valent ±1 sur 16 bits, soit
   −90 dBFS : rigoureusement inaudible, mais un flux sonore aux yeux du
   navigateur, qui cesse alors de geler l'onglet. Cela fonctionne en général sur
   Android, pas toujours sur iPhone, et **peut mettre votre musique en pause**
   (la page prend le focus audio). La ligne *Veille écran éteint* indique si le
   navigateur a réellement accordé la lecture, ou l'a refusée.

Et quoi qu'il arrive, **les trous sont déclarés**. Si la page a malgré tout été
gelée, le battement d'une seconde s'en aperçoit au réveil : le temps perdu est
compté à part (« ⚠ 4:12 non mesurées »), les deux bords du trou ne sont **pas**
reliés par une ligne droite — la distance parcourue entre-temps est inconnue,
pas nulle — et l'allure se calcule sur le seul temps réellement mesuré, pour ne
pas afficher un 30:00/km absurde. Mieux vaut une distance sous-estimée et
signalée qu'un chiffre inventé.

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

## Comment comptent les compteurs

**Distance.** Compter bêtement la distance entre deux points GPS successifs ne
marche pas : à l'arrêt le point « danse » de quelques mètres et le compteur
grimpe tout seul, et en courant le bruit ajoute 15 à 20 % à chaque segment de
3 m. D'où deux étages :

1. un **lissage à constante de temps** (τ ≈ 1 s pour ±8 m de précision annoncée,
   3 s pour ±25 m) — le gain suit l'intervalle réel entre deux points, sinon un
   GPS qui ne parle qu'une fois toutes les 5 s traînerait loin derrière ;
2. une **ancre** : rien n'est compté tant que la position lissée n'a pas quitté
   un rayon d'environ une précision GPS (au moins 8 m) autour du dernier point
   validé ; au-delà, la corde entière est ajoutée et l'ancre s'y déplace.

En mouvement, la distance est donc mesurée par cordes d'une dizaine de mètres,
bien moins sensibles au bruit. À l'arrêt, le compteur est figé tant que le
signal est bon ; avec une précision annoncée de ±8 m il dérive encore de
quelques centaines de mètres par heure de station debout — le rayon d'ancre ne
vaut qu'environ 3,5 écarts-types de la position lissée, et un franchissement
finit par arriver. L'élargir figerait l'arrêt mais sous-estimerait les trajets
sinueux : l'arbitrage reste à trancher (voir le test marqué `todo`).

Les **sauts de position** sont ignorés : au-delà de ce que la vitesse maximale
d'un coureur *et* le bruit annoncé peuvent expliquer ensemble. Ne regarder que
la vitesse ne suffit pas — deux points bruts consécutifs d'un GPS à ±8 m
diffèrent couramment de 15 à 20 m sans que personne n'ait bougé, et prendre cela
pour une téléportation coupait la distance de moitié.

**Pas.** La magnitude de l'accélération oscille autour de *g* d'environ ±2 m/s²
à la marche et ±6 m/s² en courant. On la lisse légèrement puis on compte une
crête par pas, le seuil étant la moyenne des extrêmes de la dernière seconde :
il s'adapte donc tout seul à l'allure et à la façon de porter le téléphone
(main, poche, brassard). Un intervalle minimal de 250 ms évite les rebonds, et
une amplitude minimale évite de compter les vibrations d'un appareil posé.

Sur le banc d'essai (`test/metrics.test.js`, lancé par `npm test`), le comptage
des pas tombe au pas près en marche, en course et en sprint, et reste juste
quand l'allure change en cours de route ; la distance se tient à ±3 % sur 2 km,
et à ±5 % avec un GPS dégradé à ±25 m ne donnant qu'un point toutes les
5 secondes.

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
| `js/metrics.js` | podomètre et filtre de distance GPS, sans dépendance au navigateur |
| `js/tracker.js` | suivi en direct : capteurs, cumuls, pause, gels, reprise |
| `js/app.js` | carte Leaflet, interface, rendu, profil, export |
| `sw.js`, `manifest.webmanifest` | installation et fonctionnement hors ligne |
| `test/` | banc d'essai (voir plus bas) |
| `vendor/` | Leaflet et qrcode-generator, embarqués (aucun CDN) |

Console du navigateur : `JogRoute.state`, `JogRoute.run()`,
`JogRoute.setStart(lat, lon, true)`.

## Tests

```
npm test
```

Aucune dépendance à installer : le banc d'essai n'utilise que le lanceur intégré
de Node (≥ 18). Les modules de l'application y sont chargés **tels quels**, dans
un contexte où `self` existe — il n'y a donc pas de « version pour les tests »
qui pourrait diverger de ce qui part en production.

| Fichier | Ce qu'il vérifie |
|---|---|
| `test/geo.test.js` | distances, caps, compacité, allure/pente, polyline, couverture de l'historique |
| `test/metrics.test.js` | comptage des pas et mesure de distance sur signaux synthétiques |
| `test/router.test.js` | graphe, accrochage au réseau, Dijkstra, statistiques, planification |
| `test/harness.js` | chargement des modules, générateurs semés, quartier synthétique |
| `test/bench.js` | coût d'une génération (`node test/bench.js`, hors suite) |

Tout l'aléatoire sort d'un générateur semé : un échec est reproductible. Le bruit
GPS est modélisé par un processus autocorrélé, comme l'est l'erreur réelle d'un
récepteur ; le cas du bruit blanc est conservé à part, comme borne pessimiste.

Un test est marqué `todo` : il décrit la dérive résiduelle du compteur à l'arrêt,
qui relève d'un réglage à trancher et non d'un correctif (voir plus haut).

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
- Écran éteint, aucune page web ne peut mesurer quoi que ce soit : utiliser
  **« Écran noir »**, ou la case *continuer écran éteint* (son inaudible, sans
  garantie sur iPhone). Tout gel est détecté et annoncé plutôt que comblé.
- Le comptage des pas exige un accéléromètre et une page en **https** ; sur
  ordinateur, ou si la permission de mouvement est refusée (iOS la demande), les
  pas sont *estimés* à partir de la distance et de la vitesse, et affichés
  précédés de « ≈ ».

## Licence

MIT — voir [LICENSE](LICENSE).

Données © contributeurs OpenStreetMap (ODbL) · fonds de carte OSM, OpenTopoMap,
CyclOSM · géocodage Nominatim · relief AWS Terrarium · météo Open-Meteo.

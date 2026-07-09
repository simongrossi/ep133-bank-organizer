# EP Bank Organizer

Application web locale (PWA) pour organiser les banques de samples du Teenage
Engineering EP-133 K.O. II : elle **lit la mémoire de l'appareil directement en
MIDI**, range les nouveaux sons dans les slots libres de la bonne banque, et peut
**écrire réellement** sur la machine (protocole validé). Les plages respectées :

| Banque | Plage |
|---|---:|
| KICK | 001–099 |
| SNARE | 100–199 |
| CYMB / HH | 200–299 |
| PERC | 300–399 |
| BASS | 400–499 |
| MELOD | 500–599 |
| LOOP | 600–699 |
| USER 1 | 700–799 |
| USER 2 | 800–899 |
| SFX | 900–999 |

## Ce qui fonctionne déjà

### Lire l'appareil directement (MIDI, sans backup)
- **scan MIDI de la mémoire** : « Connecter MIDI » puis « Scanner la mémoire » (ou
  scan auto à la connexion) lit **directement** les sons présents, leurs tailles,
  la mémoire libre/utilisée annoncée par la machine — sans passer par un `.pak` ;
- **persistance** : l'état de l'appareil (slots occupés, mémoire) est mémorisé et
  restauré au chargement — plus besoin de re-scanner/ré-importer à chaque fois ;
- **bouton « Rescanner »** pour relire à la demande.

### Écriture réelle (validée octet-pour-octet)
- **envoi réel** d'un son vers un slot **USER (700–899)**, via Web MIDI, avec des
  garde-fous (confirmation, banques USER only) ; protocole **validé** contre des
  dumps de référence (voir [`docs/PROTOCOL.md`](docs/PROTOCOL.md)) ;
- **réorganisation des slots** de l'appareil par glisser-déposer, puis application
  des déplacements sur la machine.

### Organisation et préparation
- dépôt de fichiers WAV et import d’un dossier complet ;
- classification automatique par nom de fichier et chemin de dossier ;
- allocation dans le premier slot libre de la bonne banque, **en évitant les slots
  réellement occupés sur l'appareil** (scan ou `.pak`) ;
- respect facultatif d’un numéro placé au début du nom (`208 HAT CLOSED.wav`) ;
- saisie des slots déjà occupés (`1-12, 100, 205-220`) ;
- correction manuelle de la catégorie, du nom et du slot ;
- inspection du WAV : fréquence, résolution, canaux, durée ;
- **lecture d’une sauvegarde `.pak`** : importe un backup exporté par l’EP Sample Tool officiel pour voir le contenu réel de l’appareil — tous les sons en mémoire (écoutables) et l’affectation des pads (groupes A/B/C/D × 12) projet par projet ;
- **grille de pads** par banque : visualise les slots occupés / à importer / libres et clique un pad chargé pour l’écouter ;
- **panneau mémoire** : estimation de l’occupation du plan face à la capacité de l’appareil (64 ou 128 Mo, configurable), répartition par banque et durée totale d’audio ;
- **test du matériel** : requête d’identité MIDI standard (sans risque) pour confirmer que l’appareil répond, et affichage de l’activité MIDI en direct (presse un pad, tu le vois) ;
- **pads en live (MIDI standard, sûr)** : presse un pad de l’appareil → il s’allume dans la grille du projet ; active le « mode live » pour qu’un clic sur un pad de l’app **joue le son sur l’appareil** (notes MIDI 36–83, groupes A–D, canal réglable) ;
- préécoute ;
- validation des doublons, collisions et sorties de plage ;
- export CSV et JSON ;
- création et réimport d’un pack `.epack` contenant le manifest et les WAV ;
- export d’un **dossier de transfert** (`.zip`) : WAV renommés `SLOT_BANQUE_nom.wav`, `mapping.csv` et notice, à charger avec un outil d’upload EP-133 (voie sûre, sans risque) ;
- conversion facultative en WAV PCM 16 bits, mono et 46 875 Hz ;
- connexion Web MIDI et détection probable de l’EP-133 ;
- mode simulation complet de l’envoi ;
- PWA installable et utilisable hors ligne après le premier chargement.

## Envoyer réellement les samples

Le protocole d'écriture SysEx a été **rétro-ingénieré et validé octet-pour-octet**
contre des dumps de référence (voir [`docs/PROTOCOL.md`](docs/PROTOCOL.md)). Deux voies :

1. **Envoi direct dans l'app (Web MIDI).** Connecte l'EP-133, place un sample sur
   un slot **USER (700–899)**, décoche « Mode simulation » et envoie. L'écriture
   reste protégée : confirmation explicite, **slots USER uniquement** par défaut,
   et un verrou logiciel (`unlockWrite`) côté transport. ⚠️ L'écriture remplace le
   contenu d'un slot — commence toujours par un slot sacrifiable.

2. **Voie sans écriture — dossier de transfert.** « Dossier de transfert (ZIP) »
   produit des WAV prêts + un `mapping.csv`, à charger avec un outil externe. Aucune
   écriture faite par l'app.

Le protocole complet (en-tête TE, PUT INIT/DATA, chunk 433 o, lecture/scan) est
documenté dans [`docs/PROTOCOL.md`](docs/PROTOCOL.md). La procédure de capture pour
recalibrer si besoin est dans [`docs/CAPTURE_SYSEX.md`](docs/CAPTURE_SYSEX.md).

## Démarrage

Prérequis : Node.js 20 ou plus récent.

### Windows

Double-cliquer sur `start_windows.bat`. Le navigateur s'ouvre automatiquement
sur la bonne adresse (par exemple `http://localhost:8080`).

Le serveur choisit tout seul un port libre : si `8080` est déjà pris ou réservé
par Windows (Hyper-V, WSL, un agent système…), il se rabat automatiquement sur
`3000`, `5173`, etc. L'adresse exacte est affichée dans la fenêtre et ouverte
dans le navigateur.

Pour forcer un port précis :

    set PORT=3000
    npm start

### macOS / Linux

    ./start_mac_linux.sh

Ou, sur tous les systèmes :

    npm start

Pour empêcher l'ouverture automatique du navigateur, définir `NO_OPEN=1`.

Web MIDI exige Chrome ou Edge et une page servie depuis `localhost` ou HTTPS.

## Démonstration incluse

- `examples/demo-bank.epack` : pack immédiatement réimportable dans l’application ;
- `examples/demo_samples/` : six petits WAV de test répartis dans plusieurs banques.

## Tests

    npm test

## Structure

- `src/config.js` : banques, mots-clés, capacités mémoire ;
- `src/classifier.js` : détection des catégories ;
- `src/allocator.js` : attribution et validation des slots ;
- `src/wav.js` : lecture, conversion audio et PCM brut (`convertWavToRawPcm`) ;
- `src/pack.js` : formats `.epack` (écriture) et `.pak` (lecture backup) ;
- `src/padmap.js` : disposition physique des pads ↔ notes MIDI ;
- `src/stats.js` : estimation mémoire du plan d'import ;
- `src/midi.js` : Web MIDI, Identity Reply, activité et capture SysEx ;
- `src/transport.js` : protocole d'écriture SysEx **validé** (upload, delete) ;
- `src/device-scan.js` : requêtes et parsing du **scan MIDI** de la mémoire ;
- `src/device-sync.js` : plage d'écriture sûre et faisabilité des déplacements ;
- `src/device-audio.js` : état de lecture des sons appareil ;
- `src/app.js` : interface et orchestration.

Protocole SysEx complet : [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Format de sauvegarde `.pak` (lecture)

Rétro-ingénieré en clean-room à partir d’un vrai backup, implémenté dans
[`src/pak.js`](src/pak.js) (lecture seule) :

    backup.pak                  = archive ZIP (deflate)
      /sounds/NNN nom.wav       = un WAV par son ; NNN = slot 001–999,
                                  PCM mono 16 bits 46875 Hz
      /projects/PXX.tar         = un projet ; TAR contenant :
         fx_settings
         pads/{a,b,c,d}/pNN     = 27 octets/pad ; octet 0 = flag,
                                  uint16 LE @ offset 1 = slot du son affecté
                                  (0 = pad vide)

L’appareil expose 4 groupes (A/B/C/D) de 12 pads par projet.

## Format EPACK

Un `.epack` est un ZIP non compressé contenant :

    manifest.json
    audio/001_KICK_01.wav
    audio/100_SNARE_01.wav

Le format est volontairement simple, lisible et versionné.

## Sources et licences

Implémentation **originale sous licence MIT**, rétro-ingénierée en **clean-room** :
on réutilise des *faits* de protocole (non protégeables), corroborés par des projets
publics, **sans copier leur code**. `phones24/ep133-export-to-daw` étant AGPL-3.0,
l'absence de reprise de son code est vérifiée — donc pas de contamination de licence.

L'attribution détaillée, l'audit de copie et l'origine de chaque brique de code sont
dans **[`CREDITS.md`](CREDITS.md)**.

Le projet n’est ni affilié ni approuvé par Teenage Engineering.

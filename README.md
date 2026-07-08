# EP Bank Organizer — squelette fonctionnel

Application web locale destinée à préparer des banques de samples pour le Teenage Engineering EP-133 K.O. II en respectant strictement les plages :

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

- dépôt de fichiers WAV et import d’un dossier complet ;
- classification automatique par nom de fichier et chemin de dossier ;
- allocation dans le premier slot libre de la bonne banque ;
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

Deux voies :

1. **Voie sûre (recommandée) — dossier de transfert.** Clique sur « Dossier de
   transfert (ZIP) ». Tu obtiens un `.zip` de WAV prêts (active la conversion
   pour du 46 875 Hz / 16 bits mono) + un `mapping.csv` indiquant le slot cible.
   Décompresse-le et charge les fichiers avec un outil d’upload EP-133 éprouvé.
   Aucune écriture n’est faite par cette application : zéro risque d’écrasement.

2. **Écriture SysEx native (avancé, à calibrer).** Le bouton « Envoyer vers
   l’EP-133 » reste en **simulation** par défaut. L’écriture réelle est
   volontairement verrouillée tant que le protocole propriétaire n’a pas été
   relevé et vérifié sur l’appareil : envoyer des trames non validées peut
   écraser ou corrompre des données. Le squelette clean-room et ses garde-fous
   (banques USER uniquement, déverrouillage explicite) sont dans
   `src/transport.js` ; la procédure de calibration est détaillée dans
   [`docs/CAPTURE_SYSEX.md`](docs/CAPTURE_SYSEX.md). La couche Web MIDI générique
   est dans `src/midi.js`.

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

- `src/config.js` : banques et mots-clés ;
- `src/classifier.js` : détection des catégories ;
- `src/allocator.js` : attribution et validation des slots ;
- `src/wav.js` : lecture et conversion audio ;
- `src/pack.js` : format `.epack` ZIP non compressé ;
- `src/midi.js` : accès Web MIDI ;
- `src/transport.js` : adaptateur d’upload réel à compléter ;
- `src/app.js` : interface et orchestration.

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

Ce squelette est une implémentation originale sous licence MIT. Il ne copie pas le code des projets de référence.

- `phones24/ep133-export-to-daw` est sous AGPL-3.0. Toute reprise directe de son code doit respecter cette licence.
- `garrettjwilke/ep_133_sysex_thingy` documente des essais SysEx mais ne fournit pas, au moment de la conception de ce squelette, une licence explicite autorisant la copie de son code ou de ses fichiers binaires.

Le projet n’est ni affilié ni approuvé par Teenage Engineering.

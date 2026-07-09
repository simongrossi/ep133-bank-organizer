# Protocole SysEx EP-133 K.O. II (rétro-ingénieré)

Documentation du protocole MIDI SysEx propriétaire, tel qu'implémenté dans
`src/transport.js` (écriture) et `src/device-scan.js` (lecture). Chaque fait est
annoté de sa **source** : validé contre les dumps `.syx` de garrettjwilke,
capturé depuis l'appareil de l'utilisateur, ou décodé depuis son `.pak`.

Voir [`../CREDITS.md`](../CREDITS.md) pour l'audit de licence (clean-room).

## Enveloppe commune (en-tête TE)

Toutes les trames propriétaires suivent :

```
F0 00 20 76 33 40 <flags> <reqIdLo> <command> [payload…] F7
   └─ manufacturer ─┘  │    │         │          │
      Teenage Eng.    0x40  │         │          └─ octets 7 bits (voir encodage)
      (00 20 76)       TE   │         └─ commande (voir plus bas)
                    subsystem│
                             └─ flags = 0x60 | ((reqId >> 7) & 0x1f)
                                reqIdLo = reqId & 0x7f
```

- `33` = code produit EP-133. `40` = sous-système « file/sysex ».
- **`flags`** : bit `0x40` = requête, bit `0x20` = « request-id présent », et les
  5 bits bas portent les bits hauts d'un compteur de requête 14 bits. L'ID de
  requête est purement un numéro de séquence renvoyé par l'appareil ; sa valeur
  n'a pas d'importance fonctionnelle.
- *Source : décodage des en-têtes dans les dumps `.syx` garrettjwilke.*

### Encodage 7 bits du payload

Les octets de données SysEx doivent rester `< 0x80`. Le payload est donc encodé
par blocs de 7 : un octet « MSB » porte le bit de poids fort de chacun des 7
octets suivants (`pack8to7` / `unpack7to8` dans `src/transport.js`).
*Source : schéma MIDI standard, confirmé sur les dumps.*

## Commandes

| Commande | Sens | Rôle |
|---:|---|---|
| `01` | requête | Handshake / infos appareil (« greet ») |
| `05` | requête | Opérations sur le système de fichiers (voir sous-commandes) |

### Sous-commandes fichier (premier octet du payload décodé, commande `05`)

| Sous-cmd | Opération | Détails |
|---:|---|---|
| `01 01` | FILE INIT | Init du gestionnaire de fichiers ; `00 40 00 00` = taille max réponse (4 Mo) |
| `02 00` | PUT INIT | Début d'écriture d'un fichier (voir structure) |
| `02 01` | PUT DATA | Un chunk de données (page indexée) ; page vide = fin (EOF) |
| `03` | GET | Lecture d'un fichier (*source : `unknown_sample_tool_01.syx`*) |
| `06` | DELETE | Suppression d'un nœud (`06 <slot16 BE>`) |
| `07 02` | META | Lecture/écriture des métadonnées d'un nœud (`07 02 <node16 BE> 00 00`) |
| `0b` | INFO | Infos/stat d'un nœud (`0b <node16 BE>`) |

*Source des sous-commandes : dumps garrettjwilke (`send_tiny_sound`, `send_1234`,
`delete_sample_011`, `unknown_sample_tool_01`) + réponses capturées sur l'appareil.*

## Écriture d'un son (validée octet-pour-octet)

Séquence pour écrire un WAV dans un slot (implémentée dans `#framesForSample`) :

1. **PUT INIT** — payload décodé :
   ```
   02 00 05 <slot16 BE> <parent16 BE=1000> <size32 BE> <nom>\0 {"channels":N}
   ```
   - `slot` = numéro de sample cible (= node id). `parent` = 1000 (« sound »).
   - `size` = octets de **PCM brut** (pas le WAV : mono 16 bits 46875 Hz, sans
     en-tête RIFF). `nom` = nom d'affichage du sample (ex. `tiny_01`), pas `.pcm`.
2. **PUT DATA × N** — `02 01 <page16 BE> <chunk PCM>`, **chunk = 433 octets**
   (maintient la trame encodée sous ~510 o).
3. **EOF** — `02 01 <page16 BE>` sans données (page vide).
4. **Finalisation** — info `0b`, file-init, info `0b`, méta `07 02` du nœud, méta
   `07 02` du parent 1000. *(Modèle « single sample » de `send_tiny_sound` ; un
   envoi multi-samples diffère cette finalisation.)*

**Validation** *(tests + comparaison hors ligne)* :
- `send_tiny_sound` (196 o) → **8/8 trames identiques**.
- `send_1234/01_kick` (11 Ko, 27 chunks) → **29/29 trames** (PUT INIT + data + EOF).

Garde-fous : `PROTOCOL_CALIBRATED`, `unlockWrite` requis côté appelant, banques
USER (700–899) uniquement par défaut. Voir `src/transport.js` et `src/device-sync.js`.

## Lecture de la mémoire (scan MIDI)

`src/device-scan.js` construit les requêtes et parse les réponses :

- **Inventaire** : pour chaque slot 1–999, une requête INFO `0b <slot16 BE>`.
  Les slots occupés répondent avec les infos fichier ; les vides répondent en
  erreur (statut ≠ 0).
- **Réponse INFO fichier** (payload décodé) :
  ```
  <slot16 BE> <parent16 BE> <flags> <size32 BE> <nom C-string>
  ```
  Le nom `NNN.pcm` confirme un son au slot `NNN`.
- **Métadonnées** : `07 02 <slot16 BE> 00 00` → JSON `{"name":…,"channels":…,
  "samplerate":…,"format":…,"crc":…}`.
- **Mémoire globale** : réponse JSON contenant `max_capacity` et
  `free_space_in_bytes` (utilisé = capacité − libre).
- *Source : réponses réelles de l'appareil de l'utilisateur (359 sons, 1362 trames
  valides). Ces clés JSON ne figurent dans aucun dépôt de référence.*

### Appariement requête ↔ réponse

`parseDeviceScanRecords` associe chaque réponse à sa requête par `requestId`
(compteur 14 bits de l'en-tête), puis reconstruit l'inventaire des sons + la
mémoire annoncée.

## Notes MIDI des pads (jeu en direct)

Hors SysEx : chaque groupe de 12 pads occupe 12 notes consécutives —
**A = 36–47, B = 48–59, C = 60–71, D = 72–83**. Disposition physique type
calculatrice (7-8-9 en haut, `.` `0` `⏎` en bas). Voir `src/padmap.js`.
*Source : guide MIDI TE public + photo de la façade de l'appareil.*

## Sécurité

- Toute écriture est verrouillée par défaut ; un premier test doit viser un slot
  **USER (700–899)** sacrifiable.
- La lecture (scan) et le jeu de notes sont **sans risque** (aucune donnée écrite).
- Une trame d'écriture erronée peut écraser/corrompre la mémoire de l'appareil.

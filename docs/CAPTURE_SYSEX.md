# Calibrer l’écriture SysEx réelle vers l’EP-133 K.O. II

Ce guide explique comment relever le protocole propriétaire d’écriture pour
renseigner les constantes de [`src/transport.js`](../src/transport.js). Tant que
`PROTOCOL_CALIBRATED` y vaut `false`, l’application refuse toute écriture réelle
et n’utilise que la simulation. **C’est volontaire** : envoyer des trames non
validées peut écraser ou corrompre les données de l’appareil.

## Pourquoi une capture est indispensable

Teenage Engineering ne publie pas le protocole. Les dépôts de référence
(`garrettjwilke/ep_133_sysex_thingy`, `ep_133_sample_tool`) le documentent, mais
sans licence permettant d’en copier le code. La voie propre et légale ici est le
**clean-room** : on relève soi-même les *faits* du protocole (structure des
trames) sur son propre appareil, puis on les réimplémente. On ne copie aucun
code tiers.

> ⚠️ Toute écriture se fait à tes risques. Commence toujours par un slot **USER**
> (700–899) sacrifiable, jamais sur des données que tu tiens à garder.

## Matériel / logiciels

- L’**EP Sample Tool officiel** de Teenage Engineering (c’est lui qu’on observe).
- Un moniteur SysEx :
  - **Windows** : [MIDI-OX](http://www.midiox.com/) + un port MIDI loopback
    ([loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html)) pour
    intercaler l’espion entre l’outil officiel et l’appareil.
  - **macOS** : `SysEx Librarian` / `MIDI Monitor`.
- Un tout petit WAV mono (quelques kilo-octets) pour limiter la taille des dumps.

## Procédure

1. **Intercaler l’espion.** Crée un port loopMIDI. Configure MIDI-OX pour logger
   l’entrée et la sortie SysEx. L’objectif est de voir toutes les trames `F0 … F7`
   que l’outil officiel envoie à l’appareil.
2. **Capturer un upload.** Depuis l’outil officiel, envoie **un seul** petit
   sample vers un slot **USER** connu (ex. 701). Enregistre le flux SysEx complet.
3. **Capturer un delete.** Supprime ce même slot depuis l’outil. Enregistre.
4. **Capturer le handshake.** Note la ou les premières trames émises avant tout
   transfert (souvent une trame d’« init »).

## Ce qu’il faut extraire des dumps

Reporte ensuite ces valeurs dans l’objet `PROTOCOL` de `src/transport.js` :

| Constante | Comment la trouver |
|---|---|
| `manufacturerId` | Les octets juste après `F0`. 1 octet, ou 3 octets si le premier est `00`. Identiques dans toutes les trames. |
| `commands.handshake` | Octet(s) de commande de la trame d’init (avant tout transfert). |
| `commands.uploadBegin` | Commande de la trame qui porte le **numéro de slot** et les métadonnées. |
| `commands.uploadData` | Commande des trames qui transportent l’audio (les plus grosses / répétées). |
| `commands.uploadEnd` | Commande de la trame finale (souvent courte, possible checksum). |
| `commands.deleteSlot` | Commande de la capture « delete », avec le slot en payload. |

Points à vérifier sur les trames de données :

- **Encodage 7 bits** : aucun octet entre `F0` et `F7` ne doit dépasser `0x7F`.
  Si l’audio brut (qui contient des octets ≥ `0x80`) passe quand même, c’est
  qu’il est ré-encodé — presque toujours en 8→7 bits. Les helpers `pack8to7` /
  `unpack7to8` de `transport.js` implémentent ce schéma standard : vérifie qu’il
  correspond en ré-encodant ton WAV et en comparant à la capture.
- **Position du slot** : repère où apparaît `701` (probablement `0x05 0x25` en
  7 bits : `701 = 0b101_0111101` → hi `0x05`, lo `0x3D`… à confirmer).
- **Taille des chunks** : longueur des trames de données (adapte la constante
  `CHUNK`).
- **En-tête JSON de métadonnées** : champs réels (playmode, rootnote, pitch, pan,
  amplitude, enveloppe, timemode) et leur emplacement. Ajuste
  `buildMetadataHeader`.

## Activer l’écriture

Une fois les constantes renseignées **et vérifiées** :

1. Mets `PROTOCOL_CALIBRATED = true` dans `src/transport.js`.
2. Teste d’abord un **delete** sur un slot USER vide :
   `new Ep133Transport(midi, { simulation:false, unlockWrite:true }).deleteSlot(701)`.
3. Puis un **upload** d’un seul sample sur un slot USER.
4. Vérifie sur l’appareil avant d’élargir. Ne passe `allowAllBanks: true`
   qu’en toute connaissance de cause.

Les garde-fous de `transport.js` (banques USER uniquement, déverrouillage
explicite `unlockWrite`, refus tant que non calibré) sont là pour t’éviter un
mauvais envoi. Ne les retire pas tant que tu n’es pas sûr du protocole.

# Crédits, sources et audit de licence

Ce projet est une implémentation **originale, sous licence MIT**. Le protocole
propriétaire de l'EP-133 K.O. II n'est pas publié par Teenage Engineering : il a
été **rétro-ingénieré en clean-room** à partir de données observées (les fichiers
de sauvegarde et les réponses MIDI de l'appareil de l'utilisateur), en s'appuyant
sur des travaux de référence **comme documentation** — jamais en copiant leur code.

> Rappel juridique : les **faits** d'un format (offsets d'octets, noms de champs,
> disposition physique des pads, structure des trames) ne sont pas protégeables par
> le droit d'auteur. Le **code** qui les exploite l'est. Ce projet réutilise des
> faits ; il ne réutilise le code d'aucune source ci-dessous.

## Sources de référence

### garrettjwilke/ep_133_sysex_thingy
- https://github.com/garrettjwilke/ep_133_sysex_thingy
- **Ce qu'on en a tiré (données, pas code) :** ses dumps `.syx` ont servi de
  **vérité terrain** pour valider nos trames octet par octet. Précisément :
  - `syx/send_tiny_sound/01.syx`…`08.syx` — séquence complète d'upload d'un son
    (196 o). Nos 8 trames y sont identiques (hors l'ID de requête de session).
  - `syx/send_1234/01_kick/*.syx` — upload d'un vrai kick (11 Ko, 27 chunks).
    Nos trames PUT INIT + data + EOF y sont identiques (29/29).
  - `syx/init.syx`, `syx/delete_sample_011.syx`, `syx/get_device_info.syx`,
    `syx/unknown_sample_tool_01.syx` — ont révélé le handshake, la suppression,
    la commande d'infos (01) et l'opération de lecture GET (0x03).
  - `notes/` (dont `github.com_wmealing_KO2-SYSEX.pdf`, un blog echevarria.io) —
    documentation de contexte.
- **Licence :** aucune licence explicite au moment de la conception. On n'a donc
  **copié ni son code ni ses fichiers** ; les `.syx` n'ont servi que de mesures de
  référence pour comparer nos propres trames.

### phones24/ep133-export-to-daw
- https://github.com/phones24/ep133-export-to-daw — **AGPL-3.0**.
- **Ce qu'on en a tiré (faits, pas code) :** son `docs/EP133_FORMATS.md` documente
  le format binaire des pads et patterns d'un backup (mêmes faits que ceux qu'on a
  redécouverts en décodant le `.pak` réel de l'utilisateur : instrument aux octets
  1-2, disposition calculatrice des pads, etc.).
- **Ce qu'on n'en a PAS tiré :** aucun code. Vérification faite — nos constantes
  distinctives du scan MIDI (`max_capacity`, `free_space_in_bytes`, commandes
  `0x0b` info-nœud, `0x07 0x02` métadonnées, énumération des nœuds) **n'existent
  pas** dans le dépôt phones24 : elles proviennent des **réponses réelles de la
  machine** capturées via le bouton « Scanner la mémoire ».
- **Conséquence licence :** comme aucun code AGPL n'est réutilisé, il n'y a **pas
  de contamination** ; la licence MIT de ce projet reste valide.

### Teenage Engineering
- L'EP Sample Tool officiel (application propriétaire) et l'appareil lui-même sont
  la source première : c'est en observant ses sauvegardes `.pak` et les réponses
  MIDI de l'appareil qu'on a établi les formats.
- Ce projet **n'est ni affilié, ni approuvé, ni soutenu** par Teenage Engineering.

## D'où vient chaque brique du code

| Fichier | Fait rétro-ingénieré | Source de vérité |
|---|---|---|
| `src/pak.js` | ZIP→TAR, sons `NNN nom.wav`, pads 27 o (slot @ offset 1) | Le `.pak` réel de l'utilisateur (décodé octet par octet) |
| `src/padmap.js` | Disposition calculatrice (7-8-9 en haut), notes 36–83 | Photo de la façade de l'utilisateur + guide MIDI TE public |
| `src/transport.js` | En-tête TE, PUT INIT/DATA/EOF, chunk 433 o, `{"channels":N}` | Dumps `.syx` garrettjwilke (comparaison octet par octet) |
| `src/device-scan.js` | Requêtes info/enfants (0x0b, 0x07 02), parsing des réponses | Réponses de l'appareil de l'utilisateur (capture MIDI) |
| `src/midi.js` | Identity Reply, activité, capture SysEx | Standard MIDI public + réponses de l'appareil |

## Position de licence, en une phrase

MIT, clean-room : on réutilise des **faits** de protocole (non protégeables),
corroborés par des projets publics, sans jamais copier leur **code** — donc sans
contrainte AGPL héritée.

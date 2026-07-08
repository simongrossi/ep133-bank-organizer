// =============================================================================
// Transport SysEx EP-133 K.O. II — squelette clean-room
// =============================================================================
//
// IMPORTANT — statut légal et sécurité
// -------------------------------------
// Ce fichier est une réimplémentation ORIGINALE (clean-room). Il ne copie aucun
// code des dépôts de référence. Il s'appuie uniquement sur des *faits* de
// protocole (structure des trames), qui ne sont pas protégeables, pour offrir un
// point d'intégration. Les constantes propriétaires ci-dessous NE SONT PAS
// renseignées : tant que `PROTOCOL_CALIBRATED` vaut `false`, toute écriture
// réelle est refusée et le mode simulation reste seul actif.
//
// Pour activer l'écriture réelle il faut CALIBRER les constantes à partir de
// captures MIDI faites sur TON appareil. Voir docs/CAPTURE_SYSEX.md.
//
// Sources de référence (documentation, PAS copiées) :
//   - garrettjwilke/ep_133_sysex_thingy  (framing upload/delete, WAV 46875 Hz
//     + header JSON) — aucune licence publiée : utilisable comme référence de
//     compréhension, non copiable.
//   - garrettjwilke/ep_133_sample_tool   (transfert bidirectionnel) — idem.
//   - phones24/ep133-export-to-daw       (AGPL-3.0, LECTURE SEULE) — n'écrit pas
//     et resterait incompatible avec la licence MIT de ce projet s'il était repris.
// =============================================================================

// Passe à `true` UNIQUEMENT après avoir renseigné et vérifié les constantes de
// PROTOCOL ci-dessous sur un vrai appareil. Ne jamais committer `true` à
// l'aveugle : cela retirerait le garde-fou anti-brick.
export const PROTOCOL_CALIBRATED = false;

// Plages de slots considérées « sûres » pour un premier test d'écriture réelle :
// les banques USER 1 (700–799) et USER 2 (800–899), les moins risquées à écraser.
const SAFE_WRITE_RANGE = { start: 700, end: 899 };

// ----------------------------------------------------------------------------
// Constantes de PROTOCOLE — À CALIBRER (voir docs/CAPTURE_SYSEX.md)
// ----------------------------------------------------------------------------
// Tout ce qui suit est un GABARIT. Les valeurs réelles doivent être extraites de
// tes captures. Les octets marqués `null` doivent être remplis avant activation.
export const PROTOCOL = {
  // ID fabricant SysEx de Teenage Engineering (1 ou 3 octets, chacun < 0x80).
  // À relever au début de chaque trame F0 émise par l'EP Sample Tool officiel.
  manufacturerId: null, // ex. [0x00, 0x20, 0x76]  ← À VÉRIFIER

  // Octet(s) de commande observés pour chaque opération.
  commands: {
    handshake: null, // trame d'init ("init.syx") envoyée avant tout transfert
    uploadBegin: null, // début de transfert d'un sample (slot + longueur + méta)
    uploadData: null, // paquet(s) de données audio
    uploadEnd: null, // fin de transfert / checksum
    deleteSlot: null // suppression du sample d'un slot ("delete_sample_XXX.syx")
  },

  // L'appareil attend un WAV PCM 16 bits mono à cette fréquence, précédé d'un
  // en-tête JSON de métadonnées (playmode, rootnote, pitch, pan, amplitude,
  // enveloppe, timemode). Le schéma exact est à confirmer depuis une capture.
  audio: { sampleRate: 46875, bitsPerSample: 16, channels: 1 },

  // true si le payload est encodé sur 7 bits (obligatoire dès qu'un octet
  // dépasse 0x7F, ce qui est le cas de l'audio brut). Presque certainement true.
  sevenBitEncoded: true
};

export class ProtocolNotImplementedError extends Error {
  constructor(detail = '') {
    super(
      'Le transport SysEx d’écriture EP-133 n’est pas encore calibré. ' +
        'Utilise le mode simulation, ou renseigne src/transport.js à partir de ' +
        'captures MIDI réelles (voir docs/CAPTURE_SYSEX.md).' +
        (detail ? ` [${detail}]` : '')
    );
    this.name = 'ProtocolNotImplementedError';
  }
}

export class UnsafeWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeWriteError';
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ----------------------------------------------------------------------------
// Encodage SysEx 7 bits (schéma MIDI standard, réimplémenté)
// ----------------------------------------------------------------------------
// Les octets de données SysEx doivent tous être < 0x80. On regroupe les octets
// 8 bits par blocs de 7 : chaque bloc est précédé d'un octet « MSB » portant le
// bit de poids fort de chacun des 7 octets suivants.

export function pack8to7(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const out = [];
  for (let i = 0; i < input.length; i += 7) {
    const group = input.subarray(i, i + 7);
    let msb = 0;
    for (let j = 0; j < group.length; j += 1) msb |= ((group[j] >> 7) & 1) << j;
    out.push(msb);
    for (let j = 0; j < group.length; j += 1) out.push(group[j] & 0x7f);
  }
  return Uint8Array.from(out);
}

export function unpack7to8(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const out = [];
  for (let i = 0; i < input.length; i += 8) {
    const msb = input[i];
    for (let j = 0; j < 7 && i + 1 + j < input.length; j += 1) {
      const value = input[i + 1 + j] | (((msb >> j) & 1) << 7);
      out.push(value & 0xff);
    }
  }
  return Uint8Array.from(out);
}

// ----------------------------------------------------------------------------
// Construction d'une trame SysEx complète
// ----------------------------------------------------------------------------
// Assemble F0 <manufacturerId...> <command...> <payload7bit...> F7 et vérifie
// qu'aucun octet interne ne dépasse 0x7F (sinon la trame serait invalide).

export function buildSysExFrame({ manufacturerId, command, payload = [] } = {}) {
  const idBytes = Array.isArray(manufacturerId) ? manufacturerId : [manufacturerId];
  const cmdBytes = Array.isArray(command) ? command : [command];
  const body = [...idBytes, ...cmdBytes, ...payload];

  for (const byte of body) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0x7f) {
      throw new RangeError(`Octet SysEx invalide (${byte}) : tout octet entre F0 et F7 doit rester < 0x80.`);
    }
  }
  return Uint8Array.from([0xf0, ...body, 0xf7]);
}

// ----------------------------------------------------------------------------
// Transport
// ----------------------------------------------------------------------------

export class Ep133Transport {
  /**
   * @param {import('./midi.js').MidiManager} midiManager
   * @param {object} options
   * @param {boolean} [options.simulation=true] mode sans écriture matérielle
   * @param {boolean} [options.unlockWrite=false] déverrouille l'écriture réelle
   *        (nécessite aussi PROTOCOL_CALIBRATED === true)
   * @param {boolean} [options.allowAllBanks=false] autorise l'écriture hors des
   *        banques USER (déconseillé pour un premier test réel)
   * @param {(msg:string)=>void} [options.logger]
   */
  constructor(midiManager, { simulation = true, unlockWrite = false, allowAllBanks = false, logger = () => {} } = {}) {
    this.midi = midiManager;
    this.simulation = simulation;
    this.unlockWrite = unlockWrite;
    this.allowAllBanks = allowAllBanks;
    this.logger = logger;
  }

  /** Vérifie que l'écriture réelle est permise, sinon lève une erreur explicite. */
  assertWriteAllowed(samples) {
    if (!PROTOCOL_CALIBRATED) throw new ProtocolNotImplementedError('constantes non calibrées');
    if (!this.unlockWrite) {
      throw new UnsafeWriteError('Écriture réelle verrouillée : passe { unlockWrite: true } après avoir lu les avertissements.');
    }
    if (!this.midi?.getSelectedOutput?.()) {
      throw new UnsafeWriteError('Aucune sortie MIDI sélectionnée.');
    }
    if (!this.allowAllBanks) {
      const outside = samples.filter(s => !(s.slot >= SAFE_WRITE_RANGE.start && s.slot <= SAFE_WRITE_RANGE.end));
      if (outside.length) {
        throw new UnsafeWriteError(
          `${outside.length} sample(s) hors des banques USER (${SAFE_WRITE_RANGE.start}–${SAFE_WRITE_RANGE.end}). ` +
            'Pour un premier test réel, limite-toi aux slots USER, ou passe { allowAllBanks: true } en connaissance de cause.'
        );
      }
    }
  }

  async uploadBatch(samples, onProgress = () => {}) {
    if (!samples.length) throw new Error('Aucun sample à envoyer.');

    if (this.simulation) return this.#simulate(samples, onProgress);

    // --- Chemin d'écriture réelle -------------------------------------------
    this.assertWriteAllowed(samples); // lève si non calibré / non déverrouillé / hors plage

    this.logger('Écriture réelle : envoi du handshake…');
    this.#send(this.#frameHandshake());
    await delay(50);

    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      this.logger(`Envoi ${String(sample.slot).padStart(3, '0')} — ${sample.name}`);
      for (const frame of await this.#framesForSample(sample)) {
        this.#send(frame);
        await delay(8); // laisse respirer le buffer MIDI ; à ajuster selon capture
      }
      onProgress({ index: index + 1, total: samples.length, sample });
    }
    this.logger(`Terminé : ${samples.length} sample(s) envoyés.`);
  }

  async #simulate(samples, onProgress) {
    this.logger('SIMULATION : aucune donnée ne sera écrite sur le périphérique.');
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      this.logger(`Préparation ${String(sample.slot).padStart(3, '0')} — ${sample.name}`);
      await delay(Math.min(180, 35 + Math.round((sample.file?.size ?? 0) / 100000)));
      onProgress({ index: index + 1, total: samples.length, sample });
    }
    this.logger(`Simulation terminée : ${samples.length} sample(s) prêts.`);
  }

  #send(frame) {
    this.midi.send(frame);
  }

  // --- Construction des trames (GABARIT à compléter depuis les captures) -----

  #frameHandshake() {
    return buildSysExFrame({
      manufacturerId: PROTOCOL.manufacturerId,
      command: PROTOCOL.commands.handshake,
      payload: []
    });
  }

  /**
   * Retourne la liste des trames pour un sample : begin (slot + méta), data…, end.
   * Le découpage exact (taille des chunks, place de la longueur, checksum) est à
   * confirmer sur capture. La structure est volontairement explicite pour être
   * facile à corriger.
   */
  async #framesForSample(sample) {
    const audioBytes = new Uint8Array(await (sample.audioBlob ?? sample.file).arrayBuffer());
    const meta = buildMetadataHeader(sample);
    const encoded = PROTOCOL.sevenBitEncoded ? pack8to7(audioBytes) : audioBytes;

    const slotHi = (sample.slot >> 7) & 0x7f;
    const slotLo = sample.slot & 0x7f;

    const begin = buildSysExFrame({
      manufacturerId: PROTOCOL.manufacturerId,
      command: PROTOCOL.commands.uploadBegin,
      payload: [slotHi, slotLo, ...pack8to7(new TextEncoder().encode(JSON.stringify(meta)))]
    });

    // Découpage en paquets — taille de chunk à caler sur ce que tolère l'appareil.
    const CHUNK = 512;
    const dataFrames = [];
    for (let offset = 0; offset < encoded.length; offset += CHUNK) {
      dataFrames.push(
        buildSysExFrame({
          manufacturerId: PROTOCOL.manufacturerId,
          command: PROTOCOL.commands.uploadData,
          payload: [...encoded.subarray(offset, offset + CHUNK)]
        })
      );
    }

    const end = buildSysExFrame({
      manufacturerId: PROTOCOL.manufacturerId,
      command: PROTOCOL.commands.uploadEnd,
      payload: [slotHi, slotLo]
    });

    return [begin, ...dataFrames, end];
  }

  /** Supprime le sample d'un slot (opération unitaire, plus sûre à tester d'abord). */
  async deleteSlot(slot) {
    this.assertWriteAllowed([{ slot }]);
    const frame = buildSysExFrame({
      manufacturerId: PROTOCOL.manufacturerId,
      command: PROTOCOL.commands.deleteSlot,
      payload: [(slot >> 7) & 0x7f, slot & 0x7f]
    });
    this.logger(`Suppression du slot ${String(slot).padStart(3, '0')}…`);
    this.#send(frame);
  }
}

/**
 * En-tête de métadonnées attendu par l'appareil (schéma provisoire, à confirmer).
 * Les valeurs par défaut sont neutres ; les vrais champs/plages sont à relever
 * dans une capture de l'EP Sample Tool officiel.
 */
export function buildMetadataHeader(sample = {}) {
  return {
    name: sample.name ?? 'SAMPLE',
    playmode: 'oneshot',
    rootnote: 60,
    pitch: 0,
    pan: 0,
    amplitude: 1,
    envelope: { attack: 0, decay: 0, sustain: 1, release: 0 },
    timemode: 'repitch'
  };
}

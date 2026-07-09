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
const SAFE_WRITE_RANGE = { start: 700, end: 899 };

// Constantes de PROTOCOLE basées sur ep133-export-to-daw
export const PROTOCOL = {
  // ID fabricant SysEx de Teenage Engineering (0, 32, 118)
  manufacturerId: [0x00, 0x20, 0x76], 

  commands: {
    handshake: 1,      // TE_SYSEX_GREET
    // Note : ep133-export-to-daw utilise 5 (TE_SYSEX_FILE) pour lire. 
    // Il faudra vérifier si l'écriture utilise la même commande ou une autre (ex: 2, 5, ou 6).
    uploadBegin: 5, 
    uploadData: 5, 
    uploadEnd: 5, 
    deleteSlot: 5 
  },

  audio: { sampleRate: 46875, bitsPerSample: 16, channels: 1 },
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

// Compteur global pour tracer les requêtes
let currentRequestId = 1;

export function buildSysExFrame({ manufacturerId, command, payload = [] } = {}) {
  // Constantes de structure TE (issues de ep133-export-to-daw)
  const IDENTITY_CODE = 0x33; // 0x33 = 51 est le code produit de l'EP-133
  const MIDI_SYSEX_TE = 64; // 0x40
  const BIT_IS_REQUEST = 64;
  const BIT_REQUEST_ID_AVAILABLE = 32;

  // Récupération et incrémentation de l'ID de requête (1 à 127 max)
  const requestId = currentRequestId;
  currentRequestId = (currentRequestId % 127) + 1; 

  const idBytes = Array.isArray(manufacturerId) ? manufacturerId : [manufacturerId];
  
  // Construction de l'en-tête propriétaire Teenage Engineering
  const header = [
    ...idBytes,
    IDENTITY_CODE,
    MIDI_SYSEX_TE,
    BIT_IS_REQUEST | BIT_REQUEST_ID_AVAILABLE | ((requestId >> 7) & 0x1f),
    requestId & 0x7f,
    command
  ];

  const body = [...header, ...payload];

  for (const byte of body) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0x7f) {
      throw new RangeError(`Octet SysEx invalide (${byte}) : tout octet entre F0 et F7 doit rester < 0x80.`);
    }
  }
  
  // Encapsulation dans les marqueurs MIDI standard (F0 ... F7)
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

    this.logger('Initialisation du gestionnaire de fichiers…');
    this.#send(this.#frameFileInit());
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

  #frameFileInit() {
    // 0x01 (TE_SYSEX_FILE_INIT), flags = 0x01, maxResponseLength = 4MB (0x00400000)
    const initData = new Uint8Array([0x01, 0x01, 0x00, 0x40, 0x00, 0x00]);
    return buildSysExFrame({
      manufacturerId: PROTOCOL.manufacturerId,
      command: 5,
      payload: pack8to7(initData)
    });
  }

  /**
   * Retourne la liste des trames pour un sample : begin (slot + méta), data…, end.
   */
  async #framesForSample(sample) {
    const audioBytes = new Uint8Array(await (sample.audioBlob ?? sample.file).arrayBuffer());
    const meta = buildMetadataHeader(sample);

    // 1. Initialiser le transfert du fichier (PUT INIT)
    // Le nom de fichier est obligatoirement du type "XXX.pcm" (ex: "701.pcm") pour l'EP-133.
    const filename = `${String(sample.slot).padStart(3, '0')}.pcm`;
    const filenameBytes = new TextEncoder().encode(filename + '\0');
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));

    const initData = new Uint8Array(11 + filenameBytes.length + metaBytes.length);
    const view = new DataView(initData.buffer);

    view.setUint8(0, 0x02); // PUT
    view.setUint8(1, 0x00); // INIT
    view.setUint8(2, 0x05); // Flags
    view.setUint16(3, sample.slot); // Node ID (slot)
    view.setUint16(5, 1000); // Parent ID (1000 = "sound")
    view.setUint32(7, audioBytes.length); // size of raw audio

    initData.set(filenameBytes, 11);
    initData.set(metaBytes, 11 + filenameBytes.length);

    const begin = buildSysExFrame({
      manufacturerId: PROTOCOL.manufacturerId,
      command: 5,
      payload: pack8to7(initData)
    });

    // 2. Transférer les données par chunks (PUT DATA)
    const CHUNK_SIZE = 512; // Taille d'un chunk audio non encodé
    const dataFrames = [];
    let pageIndex = 0;

    for (let offset = 0; offset < audioBytes.length; offset += CHUNK_SIZE) {
      const chunk = audioBytes.subarray(offset, offset + CHUNK_SIZE);
      const chunkData = new Uint8Array(4 + chunk.length);
      const chunkView = new DataView(chunkData.buffer);

      chunkView.setUint8(0, 0x02); // PUT
      chunkView.setUint8(1, 0x01); // DATA
      chunkView.setUint16(2, pageIndex); // Index de page

      chunkData.set(chunk, 4);

      dataFrames.push(
        buildSysExFrame({
          manufacturerId: PROTOCOL.manufacturerId,
          command: 5,
          payload: pack8to7(chunkData)
        })
      );
      pageIndex += 1;
    }

    // 3. Clôturer le transfert en envoyant une page vide (EOF)
    const eofData = new Uint8Array(4);
    const eofView = new DataView(eofData.buffer);
    eofView.setUint8(0, 0x02); // PUT
    eofView.setUint8(1, 0x01); // DATA
    eofView.setUint16(2, pageIndex); // Index de page de fin

    const end = buildSysExFrame({
      manufacturerId: PROTOCOL.manufacturerId,
      command: 5,
      payload: pack8to7(eofData)
    });

    // 4. Trames de vérification post-transfert (simule le comportement de l'outil officiel)
    const infoFrame = buildSysExFrame({
      manufacturerId: PROTOCOL.manufacturerId,
      command: 5,
      payload: pack8to7(new Uint8Array([0x0b, (sample.slot >> 8) & 0xff, sample.slot & 0xff]))
    });

    const refManagerInit = buildSysExFrame({
      manufacturerId: PROTOCOL.manufacturerId,
      command: 5,
      payload: pack8to7(new Uint8Array([0x01, 0x01, 0x00, 0x40, 0x00, 0x00]))
    });

    const metaFrame = buildSysExFrame({
      manufacturerId: PROTOCOL.manufacturerId,
      command: 5,
      payload: pack8to7(new Uint8Array([0x07, 0x02, (sample.slot >> 8) & 0xff, sample.slot & 0xff, 0x00, 0x00]))
    });

    const parentMetaFrame = buildSysExFrame({
      manufacturerId: PROTOCOL.manufacturerId,
      command: 5,
      payload: pack8to7(new Uint8Array([0x07, 0x02, 0x03, 0xE8, 0x00, 0x00]))
    });

    return [
      begin,
      ...dataFrames,
      end,
      infoFrame,
      refManagerInit,
      infoFrame,
      metaFrame,
      parentMetaFrame
    ];
  }

  /** Supprime le sample d'un slot. */
  async deleteSlot(slot) {
    this.assertWriteAllowed([{ slot }]);
    const payloadData = new Uint8Array([0x06, (slot >> 8) & 0xff, slot & 0xff]);
    const frame = buildSysExFrame({
      manufacturerId: PROTOCOL.manufacturerId,
      command: 5,
      payload: pack8to7(payloadData)
    });
    this.logger(`Suppression du slot ${String(slot).padStart(3, '0')}…`);
    this.#send(frame);
  }

  getHandshakeFrame() {
    return this.#frameHandshake();
  }

  getFileInitFrame() {
    return this.#frameFileInit();
  }

  async getFramesForSample(sample) {
    return this.#framesForSample(sample);
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

/**
 * Décode une réponse SysEx « Universal Identity Reply » (standard MIDI, non
 * propriétaire) : F0 7E <dev> 06 02 <manuId…> <family> <member> <version…> F7.
 * Retourne null si le message n'est pas une identity reply valide.
 */
export function parseIdentityReply(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (data.length < 6 || data[0] !== 0xf0 || data[1] !== 0x7e) return null;
  if (data[3] !== 0x06 || data[4] !== 0x02) return null; // sub-ID 06 02 = identity reply

  let offset = 5;
  let manufacturerId;
  if (data[offset] === 0x00) {
    manufacturerId = [data[offset], data[offset + 1], data[offset + 2]];
    offset += 3;
  } else {
    manufacturerId = [data[offset]];
    offset += 1;
  }

  const toHex = value => value.toString(16).padStart(2, '0').toUpperCase();
  const rest = [...data.slice(offset, data.length - 1)]; // sans le F7 final
  return {
    manufacturerId,
    manufacturerHex: manufacturerId.map(toHex).join(' '),
    family: rest.slice(0, 2),
    member: rest.slice(2, 4),
    version: rest.slice(4, 8),
    raw: [...data]
  };
}

export class MidiManager extends EventTarget {
  constructor() {
    super();
    this.access = null;
    this.selectedOutputId = '';
    this.identity = null;
    this.boundInputs = new Set();
  }

  get supported() {
    return Boolean(navigator.requestMIDIAccess);
  }

  async connect() {
    if (!this.supported) throw new Error('Web MIDI n’est pas disponible dans ce navigateur. Utilise Chrome ou Edge sur localhost/HTTPS.');
    this.access = await navigator.requestMIDIAccess({ sysex: true });
    this.access.addEventListener('statechange', () => {
      this.#bindInputs();
      this.dispatchEvent(new Event('change'));
    });
    this.#bindInputs();
    this.dispatchEvent(new Event('change'));
    return this.listOutputs();
  }

  /** Attache un écouteur à chaque entrée MIDI pour capter identity reply + activité. */
  #bindInputs() {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      if (this.boundInputs.has(input.id)) continue;
      this.boundInputs.add(input.id);
      input.onmidimessage = event => this.#handleMessage(event, input);
    }
  }

  #handleMessage(event, input = null) {
    const bytes = event.data;
    const inputInfo = input ? {
      id: input.id,
      name: input.name || 'Entree MIDI sans nom',
      manufacturer: input.manufacturer || '',
      state: input.state
    } : null;
    const identity = parseIdentityReply(bytes);
    if (identity) {
      this.identity = identity;
      this.dispatchEvent(new CustomEvent('identity', { detail: { ...identity, input: inputInfo } }));
      return;
    }
    // Réponse SysEx propriétaire (F0 … F7) : on la transmet telle quelle pour
    // le scan de l'appareil (lecture de la mémoire).
    if (bytes[0] === 0xf0) {
      this.dispatchEvent(new CustomEvent('sysex', { detail: { data: [...bytes], input: inputInfo, timeStamp: event.timeStamp } }));
      return;
    }
    // Activité « live » : notes et autres messages courts, pour voir le matériel réagir.
    const status = bytes[0] & 0xf0;
    const channel = bytes[0] & 0x0f;
    const kind = status === 0x90 && bytes[2] > 0 ? 'noteOn'
      : status === 0x80 || (status === 0x90 && bytes[2] === 0) ? 'noteOff'
      : status === 0xb0 ? 'cc'
      : 'other';
    this.dispatchEvent(new CustomEvent('activity', {
      detail: { kind, channel, data: [...bytes], note: bytes[1], velocity: bytes[2], input: inputInfo }
    }));
  }

  listOutputs() {
    if (!this.access) return [];
    return [...this.access.outputs.values()].map(output => ({
      id: output.id,
      name: output.name || 'Sortie MIDI sans nom',
      manufacturer: output.manufacturer || '',
      state: output.state,
      connection: output.connection
    }));
  }

  listInputs() {
    if (!this.access) return [];
    return [...this.access.inputs.values()].map(input => ({
      id: input.id,
      name: input.name || 'Entrée MIDI sans nom',
      manufacturer: input.manufacturer || '',
      state: input.state
    }));
  }

  selectOutput(id) {
    this.selectedOutputId = id;
  }

  getSelectedOutput() {
    return this.access?.outputs.get(this.selectedOutputId) ?? null;
  }

  findLikelyEp133Output() {
    return this.listOutputs().find(output => /EP-?133|K\.O\.\s?II|KO\s?II/i.test(`${output.manufacturer} ${output.name}`)) ?? null;
  }

  send(bytes, timestamp) {
    const output = this.getSelectedOutput();
    if (!output) throw new Error('Aucune sortie MIDI sélectionnée.');
    output.send(bytes, timestamp);
  }

  sendUniversalIdentityRequest() {
    this.send([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);
  }
}

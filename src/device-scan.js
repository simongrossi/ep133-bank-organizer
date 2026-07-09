import { buildSysExFrame, pack8to7, unpack7to8, PROTOCOL } from './transport.js';
import { bankKeyForSlot } from './pak.js';

const FILE_COMMAND = 5;
const DEFAULT_NODE_IDS = [1000, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 701, 800];
const SOUND_PARENT_ID = 1000;
const SOUND_SLOTS = Array.from({ length: 999 }, (_, index) => index + 1);

const textDecoder = new TextDecoder();

function u16be(value) {
  return [(value >> 8) & 0xff, value & 0xff];
}

function uniqueNodeIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const value = Number(id);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function packedFrame(label, bytes, description) {
  return {
    label,
    description,
    frame: buildSysExFrame({
      manufacturerId: PROTOCOL.manufacturerId,
      command: FILE_COMMAND,
      payload: pack8to7(Uint8Array.from(bytes))
    })
  };
}

export function buildNodeInfoRequest(id) {
  return packedFrame(`node-info-${id}`, [0x0b, ...u16be(id)], `Demande les infos du noeud ${id}`);
}

export function buildNodeChildrenRequest(id) {
  return packedFrame(`node-children-${id}`, [0x07, 0x02, ...u16be(id), 0x00, 0x00], `Demande les enfants/metadonnees du noeud ${id}`);
}

export function buildDeviceScanRequests({ nodeIds = [], sampleSlots = [], includeDefaultNodes = true, includeChildren = true } = {}) {
  const defaults = includeDefaultNodes ? DEFAULT_NODE_IDS : [];
  const ids = uniqueNodeIds([...defaults, ...nodeIds, ...sampleSlots]);
  const requests = [
    {
      label: 'greet',
      description: 'Handshake proprietaire TE',
      frame: buildSysExFrame({ manufacturerId: PROTOCOL.manufacturerId, command: 1, payload: [] })
    },
    packedFrame('file-manager-init', [0x01, 0x01, 0x00, 0x40, 0x00, 0x00], 'Initialise le gestionnaire de fichiers')
  ];

  for (const id of ids) {
    requests.push(buildNodeInfoRequest(id));
    if (includeChildren) requests.push(buildNodeChildrenRequest(id));
  }

  return requests;
}

export function buildInventoryScanRequests({ slots = SOUND_SLOTS } = {}) {
  return [
    ...buildDeviceScanRequests({ nodeIds: [SOUND_PARENT_ID], includeDefaultNodes: false, includeChildren: false }),
    buildNodeChildrenRequest(SOUND_PARENT_ID),
    ...uniqueNodeIds(slots).map(slot => buildNodeInfoRequest(slot))
  ];
}

export function buildMetadataRequestsForSlots(slots = []) {
  return uniqueNodeIds(slots).map(slot => buildNodeChildrenRequest(slot));
}

export function bytesToHex(bytes, limit = Infinity) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  const slice = data.subarray(0, Math.min(data.length, limit));
  const text = [...slice].map(byte => byte.toString(16).padStart(2, '0')).join(' ');
  return data.length > slice.length ? `${text} ...` : text;
}

export function validateSysExMessage(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  const errors = [];
  const invalidBytes = [];

  if (data.length < 2 || data[0] !== 0xf0 || data[data.length - 1] !== 0xf7) {
    errors.push('Message non encadre par F0/F7');
  }
  for (let index = 1; index < data.length - 1; index += 1) {
    if (data[index] > 0x7f) invalidBytes.push({ index, value: data[index] });
  }
  if (invalidBytes.length) errors.push('Octets > 0x7F dans le corps SysEx');

  return { valid: errors.length === 0, errors, invalidBytes };
}

function parseFrame(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  const validation = validateSysExMessage(data);
  if (!validation.valid) return { valid: false, ...validation };

  const body = data.subarray(1, data.length - 1);
  const manufacturerId = [...body.subarray(0, 3)];
  const payload = body.subarray(8);
  const flags = body[5];
  const requestId = ((flags & 0x1f) << 7) | body[6];
  const isRequest = Boolean(flags & 0x40);
  const status = !isRequest && payload.length ? payload[0] : null;
  const packedData = !isRequest && payload.length ? payload.subarray(1) : payload;
  const data8 = packedData.length ? unpack7to8(packedData) : new Uint8Array();

  return {
    valid: true,
    manufacturerId,
    product: body[3],
    subsystem: body[4],
    flags,
    requestId,
    command: body[7],
    isRequest,
    status,
    payload,
    data: data8
  };
}

function printableAscii(bytes) {
  return textDecoder
    .decode(bytes)
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '.')
    .slice(0, 360);
}

export function describeTeSysEx(bytes) {
  const parsed = parseFrame(bytes);
  if (!parsed.valid) return parsed;

  return {
    valid: true,
    manufacturerIdHex: bytesToHex(parsed.manufacturerId),
    product: parsed.product,
    subsystem: parsed.subsystem,
    flags: parsed.flags,
    requestId: parsed.requestId,
    command: parsed.command,
    isRequest: parsed.isRequest,
    status: parsed.status,
    payloadHex: bytesToHex(parsed.payload, 160),
    unpackedPayloadHex: bytesToHex(parsed.data, 200),
    unpackedAscii: printableAscii(parsed.data)
  };
}

export function createCaptureRecord({ direction, label, bytes, source = null, description = '' }) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  const validation = validateSysExMessage(data);
  return {
    at: new Date().toISOString(),
    direction,
    label,
    description,
    source,
    length: data.length,
    validSysEx: validation.valid,
    errors: validation.errors,
    invalidBytes: validation.invalidBytes.map(item => ({
      index: item.index,
      valueHex: item.value.toString(16).padStart(2, '0')
    })),
    hex: bytesToHex(data),
    decoded: validation.valid ? describeTeSysEx(data) : null
  };
}

function bytesFromHex(hex) {
  if (!hex) return new Uint8Array();
  return Uint8Array.from(String(hex).trim().split(/\s+/).filter(Boolean).map(part => parseInt(part, 16)));
}

function bytesFromRecord(record) {
  if (record?.bytes) return Uint8Array.from(record.bytes);
  return bytesFromHex(record?.hex);
}

function readU16be(bytes, offset) {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readU32be(bytes, offset) {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function readCString(bytes, offset) {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  return textDecoder.decode(bytes.subarray(offset, end));
}

function parseKeyValues(text) {
  return Object.fromEntries(String(text)
    .split(';')
    .map(part => part.split(':'))
    .filter(parts => parts.length >= 2 && parts[0])
    .map(([key, ...rest]) => [key, rest.join(':')]));
}

function jsonTextFromData(data) {
  const text = textDecoder.decode(data).replace(/\0/g, '');
  const start = text.indexOf('{');
  return start >= 0 ? text.slice(start) : '';
}

function parseJsonPrefix(data) {
  const text = jsonTextFromData(data);
  if (!text) return { text: '', complete: false, value: null };
  try {
    return { text, complete: true, value: JSON.parse(text) };
  } catch {
    return { text, complete: false, value: null };
  }
}

function stringField(text, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text).match(new RegExp(`"${escaped}"\\s*:\\s*"([^"]*)"`));
  return match?.[1] ?? '';
}

function numberField(text, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text).match(new RegExp(`"${escaped}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : null;
}

function parseFileInfo(data) {
  if (!data || data.length < 10) return null;
  const filename = readCString(data, 9);
  if (!filename) return null;
  const slot = readU16be(data, 0);
  return {
    slot,
    parent: readU16be(data, 2),
    flags: data[4],
    size: readU32be(data, 5),
    filename
  };
}

function normalizedSlot(value) {
  const slot = Number(value);
  return Number.isInteger(slot) && slot >= 1 && slot <= 999 ? slot : null;
}

function refreshSlotMetadata(sound, slot) {
  sound.slot = slot;
  sound.bank = bankKeyForSlot(slot);
  if (/^\d{3}\.pcm$/i.test(sound.filename ?? '')) {
    sound.filename = `${String(slot).padStart(3, '0')}.pcm`;
  }
}

function updateProjectSlotReferences(device, fromSlot, toSlot, swapped) {
  for (const project of device.projects ?? []) {
    for (const pads of Object.values(project.groups ?? {})) {
      if (!Array.isArray(pads)) continue;
      for (const pad of pads) {
        if (!pad || pad.slot == null) continue;
        if (pad.slot === fromSlot) pad.slot = toSlot;
        else if (swapped && pad.slot === toSlot) pad.slot = fromSlot;
      }
    }
  }
}

export function rebuildDeviceSoundIndex(device) {
  const sounds = Array.isArray(device?.sounds) ? device.sounds : [];
  sounds.sort((a, b) => a.slot - b.slot);
  device.soundBySlot = new Map(sounds.map(sound => [sound.slot, sound]));
  return device.soundBySlot;
}

export function moveDeviceSoundSlot(device, fromSlotValue, toSlotValue) {
  const fromSlot = normalizedSlot(fromSlotValue);
  const toSlot = normalizedSlot(toSlotValue);
  if (!device || fromSlot == null || toSlot == null) return { ok: false, reason: 'invalid-slot' };
  if (fromSlot === toSlot) return { ok: false, reason: 'same-slot', fromSlot, toSlot };

  if (!(device.soundBySlot instanceof Map)) rebuildDeviceSoundIndex(device);
  const source = device.soundBySlot.get(fromSlot);
  if (!source) return { ok: false, reason: 'missing-source', fromSlot, toSlot };

  const target = device.soundBySlot.get(toSlot) ?? null;
  refreshSlotMetadata(source, toSlot);
  if (target) refreshSlotMetadata(target, fromSlot);
  updateProjectSlotReferences(device, fromSlot, toSlot, Boolean(target));
  rebuildDeviceSoundIndex(device);

  return {
    ok: true,
    fromSlot,
    toSlot,
    swapped: Boolean(target),
    sound: source,
    targetSound: target
  };
}

export function parseDeviceScanRecords(records = []) {
  const pendingById = new Map();
  const requestByResponse = new Map();
  for (const record of records) {
    if (record?.direction === 'out') {
      const requestId = record.decoded?.requestId ?? describeTeSysEx(bytesFromRecord(record)).requestId;
      if (!Number.isInteger(requestId)) continue;
      if (!pendingById.has(requestId)) pendingById.set(requestId, []);
      pendingById.get(requestId).push(record);
    } else if (record?.direction === 'in') {
      const frame = parseFrame(bytesFromRecord(record));
      if (!frame.valid) continue;
      const queue = pendingById.get(frame.requestId);
      const request = queue?.shift();
      if (request) requestByResponse.set(record, request);
    }
  }

  const soundsBySlot = new Map();
  const errors = [];
  let memory = null;
  let deviceInfo = null;

  for (const record of records) {
    if (record?.direction !== 'in') continue;
    const frame = parseFrame(bytesFromRecord(record));
    if (!frame.valid) continue;
    const request = requestByResponse.get(record);
    const label = request?.label ?? '';

    if (frame.command === 1 && frame.status === 0) {
      deviceInfo = parseKeyValues(textDecoder.decode(frame.data).replace(/\0/g, ''));
      continue;
    }

    if (frame.command !== FILE_COMMAND) continue;

    if (frame.status !== 0) {
      const message = textDecoder.decode(frame.data).replace(/\0/g, '').trim();
      errors.push({ requestId: frame.requestId, label, message });
      continue;
    }

    const parsedJson = parseJsonPrefix(frame.data);
    if (parsedJson.value?.max_capacity) {
      memory = {
        capacityBytes: Number(parsedJson.value.max_capacity) || 0,
        freeBytes: Number(parsedJson.value.free_space_in_bytes) || 0,
        usedBytes: Math.max(0, (Number(parsedJson.value.max_capacity) || 0) - (Number(parsedJson.value.free_space_in_bytes) || 0))
      };
      continue;
    }

    const info = parseFileInfo(frame.data);
    if (info?.filename?.toLowerCase().endsWith('.pcm') && info.slot >= 1 && info.slot <= 999) {
      const current = soundsBySlot.get(info.slot) ?? {};
      soundsBySlot.set(info.slot, {
        ...current,
        slot: info.slot,
        name: current.name || info.filename.replace(/\.pcm$/i, ''),
        bank: bankKeyForSlot(info.slot),
        size: info.size,
        compressedSize: info.size,
        duration: current.duration,
        filename: info.filename,
        parent: info.parent,
        scanOnly: true
      });
      continue;
    }

    if (parsedJson.text && label.startsWith('node-children-')) {
      const slot = Number(label.replace('node-children-', ''));
      const current = soundsBySlot.get(slot);
      if (!current) continue;
      const channels = numberField(parsedJson.text, 'channels') || 1;
      const samplerate = numberField(parsedJson.text, 'samplerate') || 46875;
      const name = stringField(parsedJson.text, 'name');
      const duration = current.size > 0 ? current.size / (samplerate * channels * 2) : 0;
      soundsBySlot.set(slot, {
        ...current,
        name: name || current.name,
        duration,
        samplerate,
        channels,
        format: stringField(parsedJson.text, 'format') || '',
        crc: numberField(parsedJson.text, 'crc'),
        metadataComplete: parsedJson.complete
      });
    }
  }

  const soundBySlot = new Map();
  const sounds = [...soundsBySlot.values()]
    .map(sound => ({
      duration: sound.duration ?? (sound.size > 0 ? sound.size / (46875 * 2) : 0),
      async getBlob() {
        throw new Error('Audio non disponible via le scan MIDI. Importe un .pak pour écouter ce son.');
      },
      ...sound
    }))
    .sort((a, b) => a.slot - b.slot);
  for (const sound of sounds) soundBySlot.set(sound.slot, sound);

  return {
    device: {
      sounds,
      soundBySlot,
      projects: [],
      source: 'midi-scan',
      memory,
      deviceInfo,
      errors
    },
    memory,
    deviceInfo,
    errors
  };
}

import { safeFilename } from './utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concatArrays(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  };
}

function writeU16(view, offset, value) { view.setUint16(offset, value, true); }
function writeU32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

export async function createStoreZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const stamp = dosDateTime();

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(await entry.data.arrayBuffer());
    const crc = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0x0800);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, stamp.time);
    writeU16(localView, 12, stamp.date);
    writeU32(localView, 14, crc);
    writeU32(localView, 18, data.length);
    writeU32(localView, 22, data.length);
    writeU16(localView, 26, nameBytes.length);
    writeU16(localView, 28, 0);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0x0800);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, stamp.time);
    writeU16(centralView, 14, stamp.date);
    writeU32(centralView, 16, crc);
    writeU32(centralView, 20, data.length);
    writeU32(centralView, 24, data.length);
    writeU16(centralView, 28, nameBytes.length);
    writeU16(centralView, 30, 0);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, 0);
    writeU32(centralView, 42, localOffset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    localOffset += localHeader.length + data.length;
  }

  const central = concatArrays(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 4, 0);
  writeU16(endView, 6, 0);
  writeU16(endView, 8, entries.length);
  writeU16(endView, 10, entries.length);
  writeU32(endView, 12, central.length);
  writeU32(endView, 16, localOffset);
  writeU16(endView, 20, 0);

  return new Blob([...localParts, central, end], { type: 'application/zip' });
}

export async function createEpack(samples, manifest, resolveAudioBlob = sample => sample.file) {
  const entries = [];
  const usedNames = new Set();
  const manifestCopy = structuredClone(manifest);
  const manifestById = new Map((manifestCopy.samples ?? []).map(sample => [sample.id, sample]));

  for (const sample of samples) {
    let base = `${String(sample.slot ?? 0).padStart(3, '0')}_${safeFilename(sample.name)}.wav`;
    let candidate = base;
    let suffix = 2;
    while (usedNames.has(candidate.toLowerCase())) {
      candidate = base.replace(/\.wav$/i, `_${suffix}.wav`);
      suffix += 1;
    }
    usedNames.add(candidate.toLowerCase());
    const audioPath = `audio/${candidate}`;
    const blob = await resolveAudioBlob(sample);
    entries.push({ name: audioPath, data: blob });
    const manifestSample = manifestById.get(sample.id);
    if (manifestSample) manifestSample.audioPath = audioPath;
  }

  entries.unshift({ name: 'manifest.json', data: encoder.encode(JSON.stringify(manifestCopy, null, 2)) });
  return createStoreZip(entries);
}

/**
 * Bundle « handoff » : un ZIP contenant les WAV prêts à l'emploi (idéalement déjà
 * convertis en 46 875 Hz / 16 bits mono), un mapping lisible et une notice. Pensé
 * pour être décompressé puis les fichiers glissés, slot par slot, dans un outil
 * d'upload éprouvé (ex. ep_133_sample_tool de garrettjwilke). Aucune écriture
 * matérielle n'est effectuée par ce projet : c'est la voie sûre et sans risque.
 */
export async function createHandoffBundle(samples, meta = {}, resolveAudioBlob = sample => sample.file) {
  const entries = [];
  const usedNames = new Set();
  const rows = [['slot', 'banque', 'nom', 'fichier', 'fichier_source']];

  const bankOf = slot => {
    const start = Math.floor((Number(slot) || 0) / 100) * 100;
    return { 0: 'KICK', 100: 'SNARE', 200: 'CYMB', 300: 'PERC', 400: 'BASS', 500: 'MELOD', 600: 'LOOP', 700: 'USER1', 800: 'USER2', 900: 'SFX' }[start] ?? '—';
  };

  const ordered = [...samples].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  for (const sample of ordered) {
    const bank = bankOf(sample.slot);
    let base = `${String(sample.slot ?? 0).padStart(3, '0')}_${bank}_${safeFilename(sample.name)}.wav`;
    let candidate = base;
    let suffix = 2;
    while (usedNames.has(candidate.toLowerCase())) {
      candidate = base.replace(/\.wav$/i, `_${suffix}.wav`);
      suffix += 1;
    }
    usedNames.add(candidate.toLowerCase());
    const filePath = `wav/${candidate}`;
    entries.push({ name: filePath, data: await resolveAudioBlob(sample) });
    rows.push([sample.slot ?? '', bank, sample.name, candidate, sample.file?.name ?? '']);
  }

  const csv = '﻿' + rows.map(row => row.map(csvEscapeSemicolon).join(';')).join('\r\n');
  entries.unshift({ name: 'mapping.csv', data: encoder.encode(csv) });
  entries.unshift({ name: 'LISEZ-MOI.txt', data: encoder.encode(handoffReadme(ordered.length, meta)) });

  return createStoreZip(entries);
}

function csvEscapeSemicolon(value) {
  const text = String(value ?? '');
  return /[";\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function handoffReadme(count, meta) {
  const converted = meta.converted ? 'déjà convertis en 46 875 Hz / 16 bits mono' : 'AUX FORMATS D’ORIGINE (pense à activer la conversion avant l’export)';
  return [
    'EP-133 K.O. II — dossier de transfert (handoff)',
    '================================================',
    '',
    `Ce dossier contient ${count} sample(s) ${converted}.`,
    '',
    'Contenu :',
    '  - wav/         : les fichiers audio, nommés SLOT_BANQUE_nom.wav',
    '  - mapping.csv  : le slot cible de chaque fichier (ouvre-le dans un tableur)',
    '',
    'Comment les charger sur l’appareil :',
    '  1. Ouvre ton outil d’upload EP-133 (ex. ep_133_sample_tool de garrettjwilke).',
    '  2. Pour chaque ligne du mapping, assigne le fichier wav/ au slot indiqué.',
    '  3. Le numéro de slot est aussi en tête de chaque nom de fichier (ex. 701_USER1_… → slot 701).',
    '',
    'Rappel des plages de banques :',
    '  KICK 001–099 · SNARE 100–199 · CYMB/HH 200–299 · PERC 300–399 · BASS 400–499',
    '  MELOD 500–599 · LOOP 600–699 · USER 1 700–799 · USER 2 800–899 · SFX 900–999',
    '',
    'Ce projet n’écrit rien lui-même sur l’appareil : le transfert reste à la charge',
    'de l’outil que tu utilises, ce qui évite tout risque d’écrasement non maîtrisé.',
    ''
  ].join('\r\n');
}

function findEndOfCentralDirectory(bytes) {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true) === 0x06054b50) return offset;
  }
  return -1;
}

export async function readStoreZip(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) throw new Error('Archive ZIP invalide.');
  const eocd = new DataView(bytes.buffer, bytes.byteOffset + eocdOffset, 22);
  const entriesCount = eocd.getUint16(10, true);
  let offset = eocd.getUint32(16, true);
  const entries = new Map();

  for (let index = 0; index < entriesCount; index += 1) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    if (view.getUint32(0, true) !== 0x02014b50) throw new Error('Répertoire ZIP invalide.');
    const method = view.getUint16(10, true);
    const compressedSize = view.getUint32(20, true);
    const nameLength = view.getUint16(28, true);
    const extraLength = view.getUint16(30, true);
    const commentLength = view.getUint16(32, true);
    const localHeaderOffset = view.getUint32(42, true);
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    if (method !== 0) throw new Error('Ce squelette lit uniquement les packs EPACK non compressés qu’il génère lui-même.');

    const localView = new DataView(bytes.buffer, bytes.byteOffset + localHeaderOffset);
    if (localView.getUint32(0, true) !== 0x04034b50) throw new Error('Entrée ZIP locale invalide.');
    const localNameLength = localView.getUint16(26, true);
    const localExtraLength = localView.getUint16(28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, bytes.slice(dataOffset, dataOffset + compressedSize));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function readEpack(file) {
  const entries = await readStoreZip(file);
  const manifestBytes = entries.get('manifest.json');
  if (!manifestBytes) throw new Error('manifest.json absent du pack.');
  const manifest = JSON.parse(decoder.decode(manifestBytes));
  const audioEntries = [...entries.entries()].filter(([name]) => name.startsWith('audio/') && name.toLowerCase().endsWith('.wav'));
  return {
    manifest,
    files: audioEntries.map(([name, bytes]) => new File([bytes], name.split('/').pop(), { type: 'audio/wav' }))
  };
}

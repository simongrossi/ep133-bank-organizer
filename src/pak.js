// =============================================================================
// Lecteur de sauvegarde .pak de l'EP-133 K.O. II (clean-room)
// =============================================================================
//
// Format rétro-ingénieré à partir d'un vrai fichier de sauvegarde exporté par
// l'EP Sample Tool officiel. Aucune donnée n'est écrite : lecture seule, sûre.
//
// Structure observée :
//   .pak                     = archive ZIP (deflate)
//     /sounds/NNN nom.wav    = un WAV par son ; NNN = numéro de slot (001–999),
//                              PCM mono 16 bits 46875 Hz (+ chunk smpl)
//     /projects/PXX.tar      = un projet ; TAR contenant :
//        fx_settings
//        pads/{a,b,c,d}/pNN  = 27 octets par pad. Octet 0 = flag,
//                              uint16 LE à l'offset 1 = numéro de slot du son
//                              affecté (0 = pad vide).
//
// L'appareil a 4 groupes (A/B/C/D) de 12 pads chacun, par projet.
// =============================================================================

import { BANK_BY_KEY, BANKS } from './config.js';

const PAD_GROUPS = ['a', 'b', 'c', 'd'];
const PADS_PER_GROUP = 12;

export function bankKeyForSlot(slot) {
  const bank = BANKS.find(b => slot >= b.start && slot <= b.end);
  return bank ? bank.key : null;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }

/** Lit le répertoire central d'un ZIP et renvoie Map<nom, {method, raw}>. */
export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (u32(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Archive .pak invalide (fin de ZIP introuvable).');

  const count = u16(view, eocd + 10);
  let offset = u32(view, eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (u32(view, offset) !== 0x02014b50) throw new Error('Répertoire ZIP corrompu.');
    const method = u16(view, offset + 10);
    const compSize = u32(view, offset + 20);
    const uncompSize = u32(view, offset + 24);
    const nameLen = u16(view, offset + 28);
    const extraLen = u16(view, offset + 30);
    const commentLen = u16(view, offset + 32);
    const localOffset = u32(view, offset + 42);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));

    const localView = new DataView(bytes.buffer, bytes.byteOffset + localOffset);
    const localNameLen = u16(localView, 26);
    const localExtraLen = u16(localView, 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    entries.set(name, { method, uncompSize, raw: bytes.subarray(dataStart, dataStart + compSize) });

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function readZipEntry(entry) {
  if (!entry) return null;
  if (entry.method === 0) return entry.raw;
  if (entry.method === 8) return inflateRaw(entry.raw);
  throw new Error(`Méthode de compression ZIP non gérée : ${entry.method}`);
}

/** Parse un TAR (format ustar/gnu) et renvoie Map<chemin, Uint8Array>. */
export function parseTar(bytes) {
  const files = new Map();
  const dec = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const name = dec.decode(bytes.subarray(offset, offset + 100)).replace(/\0.*$/, '');
    if (!name) break;
    const sizeField = dec.decode(bytes.subarray(offset + 124, offset + 136)).replace(/[\0 ]/g, '');
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(bytes[offset + 156]);
    const dataOffset = offset + 512;
    if (type === '0' || type === '\0' || type === '') {
      files.set(name, bytes.subarray(dataOffset, dataOffset + size));
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Décode un blob de pad : renvoie { slot, flag } ou null si le pad est vide. */
export function parsePad(bytes) {
  if (!bytes || bytes.length < 3) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const slot = view.getUint16(1, true);
  if (!slot) return null;
  return { slot, flag: bytes[0] };
}

function parseProject(id, tarBytes) {
  const files = parseTar(tarBytes);
  const groups = {};
  let assigned = 0;
  for (const group of PAD_GROUPS) {
    groups[group] = [];
    for (let i = 1; i <= PADS_PER_GROUP; i += 1) {
      const pad = parsePad(files.get(`pads/${group}/p${String(i).padStart(2, '0')}`));
      if (pad) assigned += 1;
      groups[group].push({ index: i, slot: pad?.slot ?? null });
    }
  }
  return { id, groups, assignedCount: assigned };
}

/**
 * Lit un fichier .pak et renvoie la bibliothèque de sons + les projets.
 * Les sons sont paresseux : `getBlob()` décompresse le WAV à la demande.
 */
export async function parsePak(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const zip = readZip(bytes);

  const sounds = [];
  const soundBySlot = new Map();
  const blobCache = new Map();

  for (const [name, entry] of zip) {
    const match = name.match(/\/sounds\/(\d{3})\s+(.*)\.wav$/i);
    if (!match) continue;
    const slot = parseInt(match[1], 10);
    const size = entry.uncompSize || entry.raw.length;
    const sound = {
      slot,
      name: match[2],
      bank: bankKeyForSlot(slot),
      compressedSize: entry.raw.length,
      size, // taille réelle du WAV (octets), telle qu'occupée en mémoire
      // durée approx. : PCM mono 16 bits @ 46875 Hz, en-tête WAV ~44 octets
      duration: Math.max(0, size - 44) / (46875 * 2),
      async getBlob() {
        if (!blobCache.has(slot)) {
          const data = await readZipEntry(entry);
          blobCache.set(slot, new Blob([data], { type: 'audio/wav' }));
        }
        return blobCache.get(slot);
      }
    };
    sounds.push(sound);
    soundBySlot.set(slot, sound);
  }
  sounds.sort((a, b) => a.slot - b.slot);

  const projects = [];
  for (const [name, entry] of zip) {
    const match = name.match(/\/projects\/(P\d+)\.tar$/i);
    if (!match) continue;
    projects.push(parseProject(match[1], await readZipEntry(entry)));
  }
  projects.sort((a, b) => a.id.localeCompare(b.id));

  return { sounds, soundBySlot, projects };
}

export const DEVICE_LAYOUT = { groups: PAD_GROUPS, padsPerGroup: PADS_PER_GROUP };
export { BANK_BY_KEY };

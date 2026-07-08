import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePad, parseTar, readZip, readZipEntry, bankKeyForSlot } from '../src/pak.js';
import { createStoreZip } from '../src/pack.js';

test('parsePad lit le slot (uint16 LE) à l’offset 1', () => {
  const pad = new Uint8Array(27);
  pad[0] = 0x00; // flag
  new DataView(pad.buffer).setUint16(1, 445, true);
  assert.deepEqual(parsePad(pad), { slot: 445, flag: 0 });
});

test('parsePad renvoie null pour un pad vide (slot 0)', () => {
  assert.equal(parsePad(new Uint8Array(27)), null);
  assert.equal(parsePad(new Uint8Array(1)), null);
});

test('bankKeyForSlot associe le bon banc', () => {
  assert.equal(bankKeyForSlot(25), 'KICK');
  assert.equal(bankKeyForSlot(117), 'SNARE');
  assert.equal(bankKeyForSlot(445), 'BASS');
  assert.equal(bankKeyForSlot(700), 'USER1');
});

test('parseTar extrait un fichier régulier', () => {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode('pads/a/p01'), 0); // nom
  header.set(enc.encode('0000004\0'), 124); // taille = 4 octets (octal)
  header[156] = '0'.charCodeAt(0); // typeflag fichier
  const data = new Uint8Array(512);
  data.set([1, 2, 3, 4]);
  const tar = new Uint8Array([...header, ...data]);

  const files = parseTar(tar);
  assert.deepEqual([...files.get('pads/a/p01')], [1, 2, 3, 4]);
});

test('readZip + readZipEntry relisent une archive store', async () => {
  const zip = await createStoreZip([
    { name: '/sounds/001 kick.wav', data: new Uint8Array([9, 8, 7]) }
  ]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const entries = readZip(bytes);
  const entry = entries.get('/sounds/001 kick.wav');
  assert.ok(entry, 'entrée présente');
  assert.equal(entry.uncompSize, 3, 'taille décompressée lue depuis le répertoire central');
  assert.deepEqual([...(await readZipEntry(entry))], [9, 8, 7]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffBundle, readStoreZip } from '../src/pack.js';

const wav = name => ({ name, slot: null, file: { name: `${name}.wav`, size: 4 } });

test('le bundle handoff contient les WAV renommés, un mapping et une notice', async () => {
  const samples = [
    { ...wav('Kick'), slot: 701 },
    { ...wav('Snare'), slot: 800 }
  ];
  const zip = await createHandoffBundle(samples, { converted: true }, async () => new Uint8Array([1, 2, 3, 4]));
  const entries = await readStoreZip(zip);
  const names = [...entries.keys()];

  assert.ok(names.includes('mapping.csv'));
  assert.ok(names.includes('LISEZ-MOI.txt'));
  assert.ok(names.includes('wav/701_USER1_Kick.wav'));
  assert.ok(names.includes('wav/800_USER2_Snare.wav'));

  const csv = new TextDecoder().decode(entries.get('mapping.csv'));
  assert.ok(csv.includes('701'));
  assert.ok(csv.includes('USER1'));
  assert.ok(csv.includes('800'));
});

test('les noms en collision sont dédupliqués', async () => {
  const samples = [
    { ...wav('Hat'), slot: 701 },
    { ...wav('Hat'), slot: 701 }
  ];
  const zip = await createHandoffBundle(samples, {}, async () => new Uint8Array([0]));
  const entries = await readStoreZip(zip);
  const wavs = [...entries.keys()].filter(n => n.startsWith('wav/'));
  assert.equal(wavs.length, 2);
  assert.equal(new Set(wavs).size, 2, 'les deux fichiers doivent avoir des noms distincts');
});

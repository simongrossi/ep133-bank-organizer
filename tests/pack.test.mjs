import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreZip, readStoreZip } from '../src/pack.js';

test('crée et relit un ZIP store-only', async () => {
  const zip = await createStoreZip([
    { name: 'manifest.json', data: new TextEncoder().encode('{"ok":true}') },
    { name: 'audio/test.wav', data: new Uint8Array([1, 2, 3, 4]) }
  ]);
  const entries = await readStoreZip(zip);
  assert.equal(new TextDecoder().decode(entries.get('manifest.json')), '{"ok":true}');
  assert.deepEqual([...entries.get('audio/test.wav')], [1, 2, 3, 4]);
});

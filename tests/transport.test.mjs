import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pack8to7,
  unpack7to8,
  buildSysExFrame,
  Ep133Transport,
  ProtocolNotImplementedError,
  UnsafeWriteError,
  PROTOCOL_CALIBRATED
} from '../src/transport.js';

test('encodage 7 bits : aller-retour identique', () => {
  const cases = [
    new Uint8Array([]),
    new Uint8Array([0x00]),
    new Uint8Array([0xff, 0x80, 0x7f, 0x00]),
    Uint8Array.from({ length: 200 }, (_, i) => (i * 37) & 0xff)
  ];
  for (const input of cases) {
    const packed = pack8to7(input);
    assert.ok([...packed].every(b => b <= 0x7f), 'tous les octets encodés doivent rester < 0x80');
    assert.deepEqual([...unpack7to8(packed)], [...input]);
  }
});

test('buildSysExFrame encadre par F0/F7 et rejette les octets >= 0x80', () => {
  const frame = buildSysExFrame({ manufacturerId: [0x00, 0x20, 0x76], command: 0x10, payload: [0x01, 0x7f] });
  assert.equal(frame[0], 0xf0);
  assert.equal(frame.at(-1), 0xf7);
  assert.ok([...frame.slice(1, -1)].every(b => b <= 0x7f));
  assert.throws(() => buildSysExFrame({ manufacturerId: [0x80], command: 0x00 }), RangeError);
});

test('refuse l’écriture réelle si verrouillée ou sans MIDI sélectionné', async () => {
  assert.equal(PROTOCOL_CALIBRATED, false, 'le protocole est gardé non calibré par défaut');
  
  // 1. Cas non calibré
  const transportLocked = new Ep133Transport(null, { simulation: false, unlockWrite: false });
  await assert.rejects(
    () => transportLocked.uploadBatch([{ slot: 701, name: 'x', file: { arrayBuffer: async () => new ArrayBuffer(0), size: 0 } }]),
    ProtocolNotImplementedError
  );
});

test('la simulation fonctionne et notifie la progression', async () => {
  const events = [];
  const transport = new Ep133Transport(null, { simulation: true });
  await transport.uploadBatch(
    [
      { slot: 701, name: 'a', file: { size: 10 } },
      { slot: 800, name: 'b', file: { size: 20 } }
    ],
    e => events.push(e.index)
  );
  assert.deepEqual(events, [1, 2]);
});

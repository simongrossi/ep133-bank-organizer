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

test('protocole calibré, mais écriture réelle verrouillée sans unlockWrite', async () => {
  assert.equal(PROTOCOL_CALIBRATED, true, 'protocole validé contre les dumps de référence');

  const sample = { slot: 701, name: 'x', file: { arrayBuffer: async () => new ArrayBuffer(0), size: 0 } };

  // unlockWrite absent → refus explicite (garde-fou principal)
  const locked = new Ep133Transport(null, { simulation: false, unlockWrite: false });
  await assert.rejects(() => locked.uploadBatch([sample]), UnsafeWriteError);

  // unlockWrite présent mais aucune sortie MIDI → refus aussi
  const noOutput = new Ep133Transport({ getSelectedOutput: () => null }, { simulation: false, unlockWrite: true });
  await assert.rejects(() => noOutput.uploadBatch([sample]), UnsafeWriteError);
});

test('écriture réelle refusée hors des banques USER', async () => {
  const midi = { getSelectedOutput: () => ({ send() {} }), send() {} };
  const transport = new Ep133Transport(midi, { simulation: false, unlockWrite: true });
  const kickSample = { slot: 1, name: 'kick', file: { arrayBuffer: async () => new ArrayBuffer(0), size: 0 } };
  await assert.rejects(() => transport.uploadBatch([kickSample]), UnsafeWriteError);
});

test('la trame delete correspond à la référence garrettjwilke (hors reqId)', () => {
  // send_tiny_sound / delete_sample_011.syx : f0 00 20 76 33 40 7e 07 05 00 06 00 0b f7
  // (octets 6 et 7 = flags+reqId de session, masqués)
  const reference = [0xf0, 0x00, 0x20, 0x76, 0x33, 0x40, 0x7e, 0x07, 0x05, 0x00, 0x06, 0x00, 0x0b, 0xf7];
  const ours = buildSysExFrame({
    manufacturerId: [0x00, 0x20, 0x76],
    command: 5,
    payload: pack8to7([0x06, 0x00, 0x0b]) // DELETE, node 11 (big-endian)
  });
  const mask = arr => [...arr].map((b, i) => (i === 6 || i === 7 ? 0xff : b));
  assert.deepEqual(mask(ours), mask(reference));
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeviceScanRequests,
  createCaptureRecord,
  describeTeSysEx,
  moveDeviceSoundSlot,
  parseDeviceScanRecords,
  validateSysExMessage
} from '../src/device-scan.js';
import { pack8to7 } from '../src/transport.js';

const enc = new TextEncoder();

function responseFrame(requestId, data, { status = 0, command = 5 } = {}) {
  return Uint8Array.from([
    0xf0, 0x00, 0x20, 0x76, 0x33, 0x40, 0x20, requestId, command,
    status,
    ...pack8to7(data),
    0xf7
  ]);
}

function outRecord(label, requestId) {
  return { direction: 'out', label, decoded: { requestId } };
}

test('detecte les reponses SysEx invalides comme AA BB CC', () => {
  const fake = Uint8Array.from([0xf0, 0x00, 0x20, 0x76, 0x33, 0x40, 0x40, 0x05, 0x01, 0xaa, 0xbb, 0xcc, 0xf7]);
  const validation = validateSysExMessage(fake);
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.invalidBytes.map(item => item.value), [0xaa, 0xbb, 0xcc]);

  const record = createCaptureRecord({ direction: 'in', label: 'response', bytes: fake, source: { name: 'loopback' } });
  assert.equal(record.validSysEx, false);
  assert.equal(record.source.name, 'loopback');
});

test('decrit une trame TE valide et decompresse son payload', () => {
  const deleteReference = Uint8Array.from([
    0xf0, 0x00, 0x20, 0x76, 0x33, 0x40, 0x7e, 0x07, 0x05, 0x00, 0x06, 0x00, 0x0b, 0xf7
  ]);
  const description = describeTeSysEx(deleteReference);
  assert.equal(description.valid, true);
  assert.equal(description.command, 5);
  assert.equal(description.unpackedPayloadHex, '06 00 0b');
});

test('construit une sequence de scan avec init fichiers et probes de noeuds', () => {
  const requests = buildDeviceScanRequests({ sampleSlots: [42] });
  const labels = requests.map(request => request.label);
  assert.ok(labels.includes('greet'));
  assert.ok(labels.includes('file-manager-init'));
  assert.ok(labels.includes('node-info-1000'));
  assert.ok(labels.includes('node-children-1000'));
  assert.ok(labels.includes('node-info-42'));
  for (const request of requests) {
    assert.equal(request.frame[0], 0xf0);
    assert.equal(request.frame.at(-1), 0xf7);
    assert.ok([...request.frame.slice(1, -1)].every(byte => byte <= 0x7f));
  }
});

test('decode un scan MIDI en appareil exploitable', () => {
  const fileInfo = Uint8Array.from([
    0x00, 0x01, // slot 001
    0x03, 0xe8, // parent sound
    0x1d,
    0x00, 0x00, 0xaf, 0x18, // taille PCM
    ...enc.encode('001.pcm\0')
  ]);
  const metadata = enc.encode('\0\0{"channels":1,"samplerate":46875,"format":"s16","crc":2874448156,"sound.loopstart":-1,"name":"micro kick","sound.amplitude":100}');
  const memory = enc.encode('\0\0{"max_capacity":62853120,"free_space_in_bytes":27273180,"formats":[]}');
  const records = [
    outRecord('node-children-1000', 4),
    createCaptureRecord({ direction: 'in', label: 'response', bytes: responseFrame(4, memory) }),
    outRecord('node-info-1', 5),
    createCaptureRecord({ direction: 'in', label: 'response', bytes: responseFrame(5, fileInfo) }),
    outRecord('node-children-1', 6),
    createCaptureRecord({ direction: 'in', label: 'response', bytes: responseFrame(6, metadata) })
  ];

  const parsed = parseDeviceScanRecords(records);
  assert.equal(parsed.device.sounds.length, 1);
  assert.equal(parsed.device.sounds[0].slot, 1);
  assert.equal(parsed.device.sounds[0].name, 'micro kick');
  assert.equal(parsed.device.sounds[0].size, 0xaf18);
  assert.equal(parsed.device.sounds[0].bank, 'KICK');
  assert.equal(parsed.memory.capacityBytes, 62853120);
  assert.equal(parsed.memory.freeBytes, 27273180);
});

test('associe les reponses dans l ordre meme si les requestId bouclent', () => {
  const fileInfo = slot => Uint8Array.from([
    (slot >> 8) & 0xff, slot & 0xff,
    0x03, 0xe8,
    0x1d,
    0x00, 0x00, 0x10, slot,
    ...enc.encode(`${String(slot).padStart(3, '0')}.pcm\0`)
  ]);
  const metadata = name => enc.encode(`\0\0{"channels":1,"samplerate":46875,"name":"${name}"}`);
  const records = [
    outRecord('node-info-1', 5),
    createCaptureRecord({ direction: 'in', label: 'response', bytes: responseFrame(5, fileInfo(1)) }),
    outRecord('node-children-1', 5),
    createCaptureRecord({ direction: 'in', label: 'response', bytes: responseFrame(5, metadata('first')) }),
    outRecord('node-info-2', 5),
    createCaptureRecord({ direction: 'in', label: 'response', bytes: responseFrame(5, fileInfo(2)) }),
    outRecord('node-children-2', 5),
    createCaptureRecord({ direction: 'in', label: 'response', bytes: responseFrame(5, metadata('second')) })
  ];

  const parsed = parseDeviceScanRecords(records);
  assert.equal(parsed.device.soundBySlot.get(1).name, 'first');
  assert.equal(parsed.device.soundBySlot.get(2).name, 'second');
});

test('deplace un son scanne vers un slot libre', () => {
  const sound = { slot: 150, name: 'snare', bank: 'SNARE', filename: '150.pcm', size: 100, duration: 1 };
  const device = {
    sounds: [sound],
    soundBySlot: new Map([[150, sound]]),
    projects: [{ id: 'p1', groups: { a: [{ slot: 150 }] } }]
  };

  const result = moveDeviceSoundSlot(device, 150, 701);

  assert.equal(result.ok, true);
  assert.equal(result.swapped, false);
  assert.equal(sound.slot, 701);
  assert.equal(sound.bank, 'USER1');
  assert.equal(sound.filename, '701.pcm');
  assert.equal(device.soundBySlot.get(701), sound);
  assert.equal(device.soundBySlot.has(150), false);
  assert.equal(device.projects[0].groups.a[0].slot, 701);
});

test('echange deux sons quand le slot cible est occupe', () => {
  const snare = { slot: 150, name: 'snare', bank: 'SNARE', filename: '150.pcm', size: 100, duration: 1 };
  const user = { slot: 701, name: 'voice', bank: 'USER1', filename: '701.pcm', size: 200, duration: 2 };
  const device = {
    sounds: [snare, user],
    soundBySlot: new Map([[150, snare], [701, user]]),
    projects: [{ id: 'p1', groups: { a: [{ slot: 150 }, { slot: 701 }] } }]
  };

  const result = moveDeviceSoundSlot(device, 150, 701);

  assert.equal(result.ok, true);
  assert.equal(result.swapped, true);
  assert.equal(snare.slot, 701);
  assert.equal(snare.bank, 'USER1');
  assert.equal(user.slot, 150);
  assert.equal(user.bank, 'SNARE');
  assert.deepEqual(device.sounds.map(sound => sound.slot), [150, 701]);
  assert.equal(device.soundBySlot.get(701), snare);
  assert.equal(device.soundBySlot.get(150), user);
  assert.deepEqual(device.projects[0].groups.a.map(pad => pad.slot), [701, 150]);
});

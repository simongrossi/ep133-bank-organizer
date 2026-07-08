import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIdentityReply } from '../src/midi.js';

test('décode une identity reply à ID fabricant 3 octets', () => {
  const msg = [0xf0, 0x7e, 0x00, 0x06, 0x02, 0x00, 0x20, 0x76, 0x01, 0x00, 0x02, 0x00, 0x10, 0x00, 0x00, 0x00, 0xf7];
  const parsed = parseIdentityReply(msg);
  assert.deepEqual(parsed.manufacturerId, [0x00, 0x20, 0x76]);
  assert.equal(parsed.manufacturerHex, '00 20 76');
  assert.deepEqual(parsed.family, [0x01, 0x00]);
});

test('décode une identity reply à ID fabricant 1 octet', () => {
  const msg = [0xf0, 0x7e, 0x7f, 0x06, 0x02, 0x43, 0x01, 0x02, 0x03, 0x04, 0xf7];
  const parsed = parseIdentityReply(msg);
  assert.deepEqual(parsed.manufacturerId, [0x43]);
});

test('rejette les messages qui ne sont pas des identity replies', () => {
  assert.equal(parseIdentityReply([0x90, 0x40, 0x7f]), null); // note on
  assert.equal(parseIdentityReply([0xf0, 0x7e, 0x00, 0x06, 0x01, 0xf7]), null); // identity request
  assert.equal(parseIdentityReply([0xf0, 0x7d, 0x00]), null);
});

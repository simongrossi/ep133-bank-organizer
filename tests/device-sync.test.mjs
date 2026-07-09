import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDeviceChangeReadiness } from '../src/device-sync.js';

test('refuse un deplacement issu du scan sans audio et avec source hors USER', () => {
  const readiness = analyzeDeviceChangeReadiness([
    { fromSlot: 150, toSlot: 701, hasAudio: false, swapped: false }
  ]);

  assert.equal(readiness.exactWritable, false);
  assert.equal(readiness.missingAudio.length, 1);
  assert.equal(readiness.deleteOutsideUser.length, 1);
  assert.equal(readiness.targetOutsideUser.length, 0);
});

test('autorise un deplacement exact dans USER quand l audio est disponible', () => {
  const readiness = analyzeDeviceChangeReadiness([
    { fromSlot: 701, toSlot: 702, hasAudio: true, swapped: false }
  ]);

  assert.equal(readiness.exactWritable, true);
  assert.equal(readiness.missingAudio.length, 0);
  assert.equal(readiness.deleteOutsideUser.length, 0);
  assert.equal(readiness.targetOutsideUser.length, 0);
});

test('refuse une cible hors USER en mode securise', () => {
  const readiness = analyzeDeviceChangeReadiness([
    { fromSlot: 701, toSlot: 150, hasAudio: true, swapped: false }
  ]);

  assert.equal(readiness.exactWritable, false);
  assert.equal(readiness.targetOutsideUser.length, 1);
});

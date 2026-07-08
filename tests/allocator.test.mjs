import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateSamples, parseOccupiedSlots, validatePlan } from '../src/allocator.js';

test('analyse les plages de slots', () => {
  const { occupied, invalid } = parseOccupiedSlots('1-3, 100, 205-206');
  assert.deepEqual([...occupied], [1, 2, 3, 100, 205, 206]);
  assert.deepEqual(invalid, []);
});

test('respecte les banques et les slots occupés', () => {
  const samples = [
    { id: 'a', category: 'KICK', preferredSlot: null },
    { id: 'b', category: 'SNARE', preferredSlot: null },
    { id: 'c', category: 'CYMB', preferredSlot: 208 }
  ];
  const occupied = new Set([1, 2, 100]);
  const allocated = allocateSamples(samples, { occupied, strict: true, preferFilenameSlot: true });
  assert.equal(allocated[0].slot, 3);
  assert.equal(allocated[1].slot, 101);
  assert.equal(allocated[2].slot, 208);
  assert.deepEqual(validatePlan(allocated, occupied, true), []);
});

test('refuse un slot hors banque en mode strict', () => {
  const errors = validatePlan([{ id: 'x', category: 'KICK', slot: 500 }], new Set(), true);
  assert.equal(errors.length, 1);
});

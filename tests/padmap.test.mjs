import test from 'node:test';
import assert from 'node:assert/strict';
import { noteToGroupPad, groupPadToNote } from '../src/padmap.js';

test('noteToGroupPad mappe les 4 groupes', () => {
  assert.deepEqual(noteToGroupPad(36), { group: 'a', padIndex: 1 });
  assert.deepEqual(noteToGroupPad(47), { group: 'a', padIndex: 12 });
  assert.deepEqual(noteToGroupPad(48), { group: 'b', padIndex: 1 });
  assert.deepEqual(noteToGroupPad(60), { group: 'c', padIndex: 1 });
  assert.deepEqual(noteToGroupPad(72), { group: 'd', padIndex: 1 });
  assert.deepEqual(noteToGroupPad(83), { group: 'd', padIndex: 12 });
});

test('noteToGroupPad renvoie null hors plage', () => {
  assert.equal(noteToGroupPad(35), null);
  assert.equal(noteToGroupPad(84), null);
});

test('groupPadToNote est l’inverse de noteToGroupPad', () => {
  for (let note = 36; note <= 83; note += 1) {
    const gp = noteToGroupPad(note);
    assert.equal(groupPadToNote(gp.group, gp.padIndex), note);
  }
});

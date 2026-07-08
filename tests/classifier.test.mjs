import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySample, extractPreferredSlot } from '../src/classifier.js';

test('classe les kicks dans KICK', () => {
  assert.equal(classifySample('Kick_MPC_01.wav').category, 'KICK');
});

test('utilise le dossier avec une priorité élevée', () => {
  assert.equal(classifySample('001.wav', 'Drums/Snares/001.wav').category, 'SNARE');
});

test('classe un loop BPM dans LOOP', () => {
  assert.equal(classifySample('funky_break_92bpm.wav').category, 'LOOP');
});

test('extrait un slot en début de nom', () => {
  assert.equal(extractPreferredSlot('208 HAT CLOSED.wav'), 208);
  assert.equal(extractPreferredSlot('kick 208.wav'), null);
});

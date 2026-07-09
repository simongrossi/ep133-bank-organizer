import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceSoundAudioStatus } from '../src/device-audio.js';

test('un son issu du scan MIDI est signale comme non lisible localement', () => {
  const status = deviceSoundAudioStatus({ slot: 150, scanOnly: true });

  assert.equal(status.playable, false);
  assert.equal(status.label, 'scan MIDI');
  assert.match(status.message, /slot 150/);
  assert.match(status.message, /\.pak/);
});

test('un son restaure sans blob audio demande de reimporter le pak', () => {
  const status = deviceSoundAudioStatus({ slot: 701, restored: true });

  assert.equal(status.playable, false);
  assert.equal(status.label, 'audio non chargé');
  assert.match(status.message, /Réimporte le \.pak/);
});

test('un son issu du pak courant reste lisible localement', () => {
  const status = deviceSoundAudioStatus({ slot: 1, name: 'kick' });

  assert.equal(status.playable, true);
  assert.equal(status.label, 'audio local');
  assert.equal(status.message, '');
});

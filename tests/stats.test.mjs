import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateSampleBytes, secondsForBytes, summarizeMemory } from '../src/stats.js';

test('estime la taille via la conversion cible', () => {
  const sample = { category: 'KICK', wavInfo: { duration: 1, channels: 2, dataSize: 999999 } };
  const bytes = estimateSampleBytes(sample, { enabled: true, mono: true, targetSampleRate: 46875 });
  // 1 s mono 16 bits @ 46875 Hz = 46875 * 2 + entête
  assert.equal(bytes, 46875 * 2 + 44);
});

test('sans conversion, utilise dataSize réel', () => {
  const sample = { wavInfo: { duration: 1, dataSize: 1000 }, file: { size: 5000 } };
  assert.equal(estimateSampleBytes(sample, { enabled: false }), 1044);
});

test('sans info WAV, retombe sur la taille du fichier', () => {
  assert.equal(estimateSampleBytes({ file: { size: 1234 } }, {}), 1234);
});

test('secondsForBytes calcule la durée mono', () => {
  assert.equal(Math.round(secondsForBytes(46875 * 2, 46875, 1)), 1);
});

test('summarizeMemory agrège total, banques et dépassement', () => {
  const samples = [
    { category: 'KICK', wavInfo: { duration: 1, dataSize: 100 } },
    { category: 'KICK', wavInfo: { duration: 1, dataSize: 200 } },
    { category: 'SNARE', wavInfo: { duration: 1, dataSize: 300 } }
  ];
  const summary = summarizeMemory(samples, { capacityBytes: 500, conversion: { enabled: false } });
  assert.equal(summary.count, 3);
  assert.equal(summary.totalBytes, 100 + 200 + 300 + 44 * 3);
  assert.ok(summary.overCapacity, 'doit détecter le dépassement de 500 octets');
  const kick = summary.perBank.find(b => b.key === 'KICK');
  assert.equal(kick.count, 2);
  assert.equal(kick.bytes, 100 + 200 + 44 * 2);
});

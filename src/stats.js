import { BANKS } from './config.js';

const WAV_HEADER_BYTES = 44;

/**
 * Estime la taille (octets) qu'occupera un sample sur l'appareil.
 * - Si la conversion est active : on modélise le WAV cible (fréquence, mono/stéréo,
 *   16 bits) à partir de la durée détectée.
 * - Sinon : on prend la taille réelle des données audio du WAV (dataSize), ou à
 *   défaut la taille du fichier.
 * Retourne 0 si aucune information exploitable n'est disponible.
 */
export function estimateSampleBytes(sample, conversion = {}) {
  const info = sample.wavInfo;
  if (conversion.enabled && info && Number.isFinite(info.duration)) {
    const channels = conversion.mono ? 1 : Math.min(2, info.channels || 1);
    const rate = conversion.targetSampleRate || 46875;
    const frames = Math.ceil(info.duration * rate);
    return frames * channels * 2 + WAV_HEADER_BYTES;
  }
  if (info && Number.isFinite(info.dataSize) && info.dataSize > 0) {
    return info.dataSize + WAV_HEADER_BYTES;
  }
  return sample.file?.size ?? 0;
}

/** Secondes d'audio mono que peut contenir une mémoire donnée à une fréquence. */
export function secondsForBytes(bytes, sampleRate = 46875, channels = 1) {
  const bytesPerSecond = sampleRate * channels * 2;
  return bytesPerSecond > 0 ? bytes / bytesPerSecond : 0;
}

/**
 * Récapitule l'occupation mémoire du plan courant : total, par banque, et part
 * de la capacité de l'appareil utilisée.
 */
export function summarizeMemory(samples, { capacityBytes, conversion = {} } = {}) {
  const perBank = new Map(BANKS.map(bank => [bank.key, { key: bank.key, label: bank.label, bytes: 0, count: 0 }]));
  let totalBytes = 0;
  let totalDuration = 0;

  for (const sample of samples) {
    const bytes = estimateSampleBytes(sample, conversion);
    totalBytes += bytes;
    if (Number.isFinite(sample.wavInfo?.duration)) totalDuration += sample.wavInfo.duration;
    const bank = perBank.get(sample.category);
    if (bank) {
      bank.bytes += bytes;
      bank.count += 1;
    }
  }

  const capacity = capacityBytes || 0;
  return {
    totalBytes,
    totalDuration,
    count: samples.length,
    capacityBytes: capacity,
    freeBytes: Math.max(0, capacity - totalBytes),
    usedRatio: capacity > 0 ? Math.min(1, totalBytes / capacity) : 0,
    overCapacity: capacity > 0 && totalBytes > capacity,
    perBank: [...perBank.values()]
  };
}

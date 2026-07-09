import { clamp } from './utils.js';

function readAscii(view, offset, length) {
  let result = '';
  for (let i = 0; i < length; i += 1) result += String.fromCharCode(view.getUint8(offset + i));
  return result;
}

export async function inspectWav(file) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  if (buffer.byteLength < 44 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Le fichier n’est pas un WAV RIFF valide.');
  }

  let offset = 12;
  let format = null;
  let dataSize = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > view.byteLength) break;

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      format = {
        audioFormat: view.getUint16(dataOffset, true),
        channels: view.getUint16(dataOffset + 2, true),
        sampleRate: view.getUint32(dataOffset + 4, true),
        byteRate: view.getUint32(dataOffset + 8, true),
        blockAlign: view.getUint16(dataOffset + 12, true),
        bitsPerSample: view.getUint16(dataOffset + 14, true)
      };
    }
    if (chunkId === 'data') dataSize = chunkSize;
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  if (!format) throw new Error('Chunk fmt introuvable.');
  const duration = format.byteRate > 0 ? dataSize / format.byteRate : null;
  return { ...format, dataSize, duration };
}

function interleaveChannels(buffer, mono) {
  const channels = mono ? 1 : Math.min(2, buffer.numberOfChannels);
  const length = buffer.length;
  const interleaved = new Float32Array(length * channels);

  for (let frame = 0; frame < length; frame += 1) {
    if (mono) {
      let sum = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        sum += buffer.getChannelData(channel)[frame] || 0;
      }
      interleaved[frame] = sum / Math.max(1, buffer.numberOfChannels);
    } else {
      for (let channel = 0; channel < channels; channel += 1) {
        interleaved[frame * channels + channel] = buffer.getChannelData(channel)[frame] || 0;
      }
    }
  }
  return { interleaved, channels, sampleRate: buffer.sampleRate };
}

function trimFloatData(data, channels, threshold = 0.0008) {
  const frames = Math.floor(data.length / channels);
  let first = 0;
  let last = frames - 1;
  const framePeak = frame => {
    let peak = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      peak = Math.max(peak, Math.abs(data[frame * channels + channel] || 0));
    }
    return peak;
  };
  while (first < frames && framePeak(first) <= threshold) first += 1;
  while (last > first && framePeak(last) <= threshold) last -= 1;
  return data.slice(first * channels, (last + 1) * channels);
}

function normalizeFloatData(data) {
  let peak = 0;
  for (const value of data) peak = Math.max(peak, Math.abs(value));
  if (peak <= 0 || peak >= 0.999) return data;
  const gain = 0.98 / peak;
  const output = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 1) output[i] = data[i] * gain;
  return output;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

export function encodePcm16Wav(floatData, channels, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = floatData.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of floatData) {
    const clamped = clamp(sample, -1, 1);
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function convertWav(file, options = {}) {
  const {
    targetSampleRate = 46875,
    mono = true,
    normalize = false,
    trimSilence = false
  } = options;

  const audioContext = new AudioContext();
  try {
    const decoded = await audioContext.decodeAudioData(await file.arrayBuffer());
    const targetChannels = mono ? 1 : Math.min(2, decoded.numberOfChannels);
    const targetLength = Math.max(1, Math.ceil(decoded.duration * targetSampleRate));
    const offline = new OfflineAudioContext(targetChannels, targetLength, targetSampleRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    if (mono && decoded.numberOfChannels > 1) {
      const merger = offline.createChannelMerger(1);
      const gain = offline.createGain();
      gain.gain.value = 1 / decoded.numberOfChannels;
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const splitter = offline.createChannelSplitter(decoded.numberOfChannels);
        source.connect(splitter);
        splitter.connect(gain, channel, 0);
      }
      gain.connect(merger, 0, 0);
      merger.connect(offline.destination);
    } else {
      source.connect(offline.destination);
    }
    source.start();
    const rendered = await offline.startRendering();
    let { interleaved, channels } = interleaveChannels(rendered, mono);
    if (trimSilence) interleaved = trimFloatData(interleaved, channels);
    if (normalize) interleaved = normalizeFloatData(interleaved);
    return encodePcm16Wav(interleaved, channels, targetSampleRate);
  } finally {
    await audioContext.close().catch(() => {});
  }
}

export function encodeRawPcm16(floatData) {
  const bytesPerSample = 2;
  const dataSize = floatData.length * bytesPerSample;
  const buffer = new ArrayBuffer(dataSize);
  const view = new DataView(buffer);

  let offset = 0;
  for (const sample of floatData) {
    const clamped = clamp(sample, -1, 1);
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'application/octet-stream' });
}

export async function convertWavToRawPcm(file, options = {}) {
  const {
    targetSampleRate = 46875,
    mono = true,
    normalize = false,
    trimSilence = false
  } = options;

  const audioContext = new AudioContext();
  try {
    const decoded = await audioContext.decodeAudioData(await file.arrayBuffer());
    const targetChannels = mono ? 1 : Math.min(2, decoded.numberOfChannels);
    const targetLength = Math.max(1, Math.ceil(decoded.duration * targetSampleRate));
    const offline = new OfflineAudioContext(targetChannels, targetLength, targetSampleRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    if (mono && decoded.numberOfChannels > 1) {
      const merger = offline.createChannelMerger(1);
      const gain = offline.createGain();
      gain.gain.value = 1 / decoded.numberOfChannels;
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const splitter = offline.createChannelSplitter(decoded.numberOfChannels);
        source.connect(splitter);
        splitter.connect(gain, channel, 0);
      }
      gain.connect(merger, 0, 0);
      merger.connect(offline.destination);
    } else {
      source.connect(offline.destination);
    }
    source.start();
    const rendered = await offline.startRendering();
    let { interleaved, channels } = interleaveChannels(rendered, mono);
    if (trimSilence) interleaved = trimFloatData(interleaved, channels);
    if (normalize) interleaved = normalizeFloatData(interleaved);
    return encodeRawPcm16(interleaved);
  } finally {
    await audioContext.close().catch(() => {});
  }
}

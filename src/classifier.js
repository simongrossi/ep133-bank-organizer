import { DEFAULT_CATEGORY, KEYWORDS } from './config.js';

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifySample(fileName, relativePath = '') {
  const filename = normalize(fileName);
  const path = normalize(relativePath);
  const fullText = `${path} ${filename}`.trim();
  const scores = {};

  for (const [category, words] of Object.entries(KEYWORDS)) {
    let score = 0;
    for (const word of words) {
      const normalizedWord = normalize(word);
      if (!normalizedWord) continue;
      if (filename.includes(normalizedWord)) score += 5;
      if (path.includes(normalizedWord)) score += 8;
      if (fullText === normalizedWord) score += 3;
    }
    scores[category] = score;
  }

  // Les termes très explicites priment sur les ambiguïtés classiques.
  if (/\b(kick|bd|bass drum|bassdrum)\b/.test(fullText)) scores.KICK += 20;
  if (/\b(snare|clap|rim)\b/.test(fullText)) scores.SNARE += 20;
  if (/\b(hh|hihat|hi hat|closed hat|open hat)\b/.test(fullText)) scores.CYMB += 20;
  if (/\b(loop|break)\b/.test(fullText) || /\b\d{2,3}\s?bpm\b/.test(fullText)) scores.LOOP += 18;
  if (/\b808\b/.test(fullText) && !/kick|bd/.test(fullText)) scores.BASS += 8;

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [category, score] = ranked[0] ?? [DEFAULT_CATEGORY, 0];

  return {
    category: score > 0 ? category : DEFAULT_CATEGORY,
    confidence: score >= 20 ? 'high' : score >= 8 ? 'medium' : 'low',
    scores
  };
}

export function extractPreferredSlot(fileName) {
  const match = String(fileName ?? '').match(/^\s*(\d{1,3})(?:[\s_\-.]|$)/);
  if (!match) return null;
  const slot = Number(match[1]);
  return slot >= 1 && slot <= 999 ? slot : null;
}

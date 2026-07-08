export const BANKS = [
  { key: 'KICK', label: 'KICK', start: 1, end: 99 },
  { key: 'SNARE', label: 'SNARE', start: 100, end: 199 },
  { key: 'CYMB', label: 'CYMB / HH', start: 200, end: 299 },
  { key: 'PERC', label: 'PERC', start: 300, end: 399 },
  { key: 'BASS', label: 'BASS', start: 400, end: 499 },
  { key: 'MELOD', label: 'MELOD', start: 500, end: 599 },
  { key: 'LOOP', label: 'LOOP', start: 600, end: 699 },
  { key: 'USER1', label: 'USER 1', start: 700, end: 799 },
  { key: 'USER2', label: 'USER 2', start: 800, end: 899 },
  { key: 'SFX', label: 'SFX', start: 900, end: 999 }
];

export const BANK_BY_KEY = Object.fromEntries(BANKS.map(bank => [bank.key, bank]));

export const KEYWORDS = {
  KICK: ['kick', 'bd', 'bassdrum', 'bass drum', 'grosse caisse', 'kik'],
  SNARE: ['snare', 'sd', 'clap', 'rim', 'sidestick', 'side stick', 'caisse claire'],
  CYMB: ['closed hat', 'open hat', 'hihat', 'hi hat', 'hh', 'cymbal', 'cymb', 'crash', 'ride', 'china', 'splash'],
  PERC: ['perc', 'percussion', 'tom', 'conga', 'bongo', 'clave', 'cowbell', 'shaker', 'tamb', 'guiro', 'woodblock'],
  BASS: ['bass', 'sub', 'reese', 'low end', '808 bass'],
  MELOD: ['melod', 'chord', 'lead', 'pad', 'keys', 'piano', 'organ', 'synth', 'pluck', 'guitar', 'vocal', 'voice', 'stab'],
  LOOP: ['loop', 'break', 'groove', 'bpm', 'phrase', 'drumloop', 'drum loop'],
  SFX: ['sfx', 'fx', 'riser', 'impact', 'sweep', 'noise', 'foley', 'transition', 'texture']
};

export const DEFAULT_CATEGORY = 'USER1';
export const EP133_TARGET_SAMPLE_RATE = 46875;

// Le K.O. II existe en deux tailles de mémoire d'échantillons : 64 Mo (première
// série) et 128 Mo (version actuelle). Configurable dans l'interface.
export const EP133_MEMORY_OPTIONS = [
  { key: '64', label: '64 Mo', bytes: 64 * 1024 * 1024 },
  { key: '128', label: '128 Mo', bytes: 128 * 1024 * 1024 }
];
export const EP133_DEFAULT_MEMORY_KEY = '64';

// Mapping MIDI officiel des pads de l'EP-133 K.O. II.
// Chaque groupe occupe 12 notes consécutives :
//   A = 36–47, B = 48–59, C = 60–71, D = 72–83.
// Source : guide MIDI Teenage Engineering. La note p01 du .pak correspond à la
// première note du groupe (index 1 → base).

export const GROUP_BASE_NOTE = { a: 36, b: 48, c: 60, d: 72 };
export const GROUP_LABELS = { a: 'A', b: 'B', c: 'C', d: 'D' };

/** note MIDI → { group, padIndex (1–12) } ou null si hors plage pads. */
export function noteToGroupPad(note) {
  for (const [group, base] of Object.entries(GROUP_BASE_NOTE)) {
    if (note >= base && note < base + 12) return { group, padIndex: note - base + 1 };
  }
  return null;
}

/** { group, padIndex (1–12) } → note MIDI. */
export function groupPadToNote(group, padIndex) {
  return GROUP_BASE_NOTE[group] + (padIndex - 1);
}

// Étiquette de chaque pad, indexée par offset dans le groupe (0–11).
// note = base+offset : 36='.', 37='0', 38='⏎', 39='1' … 47='9'.
export const PAD_LABELS = ['.', '0', '⏎', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

// Ordre d'AFFICHAGE de la grille (position visuelle → offset dans le groupe),
// pour coller à la disposition physique de l'EP-133 (clavier type calculatrice,
// confirmé sur la façade) :
//   rangée haut : 7 8 9
//                 4 5 6
//                 1 2 3
//   rangée bas  : . 0 ⏎
export const PAD_DISPLAY_ORDER = [9, 10, 11, 6, 7, 8, 3, 4, 5, 0, 1, 2];

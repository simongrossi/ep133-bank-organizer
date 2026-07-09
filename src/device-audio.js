function slotLabel(sound) {
  return String(sound?.slot ?? 0).padStart(3, '0');
}

export function deviceSoundAudioStatus(sound) {
  if (!sound) {
    return {
      playable: false,
      label: 'indisponible',
      message: 'Aucun son sélectionné.'
    };
  }

  if (sound.scanOnly) {
    return {
      playable: false,
      label: 'scan MIDI',
      message: `Le slot ${slotLabel(sound)} vient du scan MIDI : l’app connaît ses infos, mais pas son audio. Importe un .pak pour l’écouter dans le navigateur.`
    };
  }

  if (sound.restored) {
    return {
      playable: false,
      label: 'audio non chargé',
      message: `Le slot ${slotLabel(sound)} a été restauré depuis la session précédente, mais l’audio n’est pas stocké dans le navigateur. Réimporte le .pak pour l’écouter.`
    };
  }

  return { playable: true, label: 'audio local', message: '' };
}

import { BANKS, BANK_BY_KEY, EP133_TARGET_SAMPLE_RATE, EP133_MEMORY_OPTIONS, EP133_DEFAULT_MEMORY_KEY } from './config.js';
import { summarizeMemory, secondsForBytes } from './stats.js';
import { classifySample, extractPreferredSlot } from './classifier.js';
import { allocateSamples, parseOccupiedSlots, summarizeBanks, validatePlan, isSlotInsideBank } from './allocator.js';
import { inspectWav, convertWav, convertWavToRawPcm } from './wav.js';
import { createEpack, readEpack, createHandoffBundle } from './pack.js';
import { parsePak, DEVICE_LAYOUT } from './pak.js';
import { noteToGroupPad, groupPadToNote, GROUP_LABELS, PAD_LABELS, PAD_DISPLAY_ORDER } from './padmap.js';
import { MidiManager } from './midi.js';
import { deviceSoundAudioStatus } from './device-audio.js';
import { analyzeDeviceChangeReadiness } from './device-sync.js';
import { buildInventoryScanRequests, buildMetadataRequestsForSlots, createCaptureRecord, moveDeviceSoundSlot, parseDeviceScanRecords } from './device-scan.js';
import { Ep133Transport, ProtocolNotImplementedError } from './transport.js';
import { createId, csvEscape, downloadBlob, formatBytes, sanitizeName } from './utils.js';

const state = {
  samples: [],
  occupied: new Set(),
  midi: new MidiManager(),
  audio: new Audio(),
  currentAudioUrl: null,
  padBank: null,
  playingSampleId: null,
  memoryKey: EP133_DEFAULT_MEMORY_KEY,
  device: null,
  deviceProject: null,
  deviceSearch: '',
  playingDeviceSlot: null,
  midiChannel: 0,
  draggingDeviceSlot: null,
  deviceChanges: [],
  deviceOccupied: new Set(),   // slots réellement occupés sur l'appareil (.pak ou scan MIDI)
  useDeviceOccupied: true       // bloquer ces slots lors de l'allocation
};

/**
 * Slots à éviter lors de l'allocation : saisie manuelle + (option) slots déjà
 * occupés sur l'appareil d'après la sauvegarde .pak ou le scan MIDI.
 */
function effectiveOccupied() {
  const set = new Set(state.occupied);
  if (state.useDeviceOccupied) {
    for (const slot of state.deviceOccupied) set.add(slot);
  }
  return set;
}

const el = Object.fromEntries([
  'deviceBadge', 'connectMidiBtn', 'midiOutputSelect', 'simulationMode', 'occupiedSlots',
  'applyOccupiedBtn', 'loadDemoOccupiedBtn', 'blockDeviceSlots', 'strictMode', 'fallbackUserBanks',
  'preferFilenameSlot', 'convertOnExport', 'convertMono', 'normalizeAudio', 'trimSilence',
  'targetSampleRate', 'wavFileInput', 'folderInput', 'epackInput', 'dropZone', 'bankSummary',
  'padBankTabs', 'padGrid',
  'sampleTableBody', 'sampleCountLabel', 'reallocateBtn', 'clearBtn', 'exportCsvBtn',
  'exportJsonBtn', 'exportPackBtn', 'exportHandoffBtn', 'exportSysexBtn', 'uploadBtn', 'logOutput', 'clearLogBtn',
  'testDeviceBtn', 'scanDeviceBtn', 'deviceInfo', 'midiActivity', 'midiActivityText',
  'memoryCapacity', 'memoryBarFill', 'memoryStats', 'memoryBanks',
  'pakInput', 'deviceEmpty', 'deviceContent', 'deviceSummary', 'deviceBarFill', 'deviceBanks', 'projectSelect',
  'projectPads', 'deviceSearch', 'deviceSounds', 'midiChannel', 'livePads', 'liveStatus',
  'syncSummary', 'syncHint', 'saveLocalStateBtn', 'applyDeviceChangesBtn',
  'confirmDialog', 'confirmTitle', 'confirmMessage'
].map(id => [id, document.getElementById(id)]));

function log(message, level = 'info') {
  const timestamp = new Date().toLocaleTimeString('fr-FR');
  const prefix = level === 'error' ? 'ERREUR' : level === 'warn' ? 'ATTENTION' : 'INFO';
  const existing = el.logOutput.textContent === 'Prêt.' ? '' : `${el.logOutput.textContent}\n`;
  el.logOutput.textContent = `${existing}[${timestamp}] ${prefix} — ${message}`;
  el.logOutput.scrollTop = el.logOutput.scrollHeight;
}

function getOptions() {
  return {
    occupied: effectiveOccupied(),
    strict: el.strictMode.checked,
    fallbackUserBanks: el.fallbackUserBanks.checked,
    preferFilenameSlot: el.preferFilenameSlot.checked
  };
}

function reallocate() {
  state.samples = allocateSamples(state.samples, getOptions());
  render();
}

function stopAudio() {
  state.audio.pause();
  state.audio.currentTime = 0;
  if (state.currentAudioUrl) URL.revokeObjectURL(state.currentAudioUrl);
  state.currentAudioUrl = null;
  state.playingSampleId = null;
  state.playingDeviceSlot = null;
}

async function previewDeviceSound(sound) {
  const audio = deviceSoundAudioStatus(sound);
  if (!audio.playable) {
    explainDeviceSoundPlayback(sound);
    return;
  }

  try {
    const blob = await sound.getBlob();
    stopAudio();
    state.currentAudioUrl = URL.createObjectURL(blob);
    state.audio.src = state.currentAudioUrl;
    state.playingDeviceSlot = sound.slot;
    await state.audio.play();
    renderDevice();
  } catch (error) {
    log(`Lecture impossible (${sound.name}) : ${error.message}`, 'warn');
  }
}

function explainDeviceSoundPlayback(sound) {
  const audio = deviceSoundAudioStatus(sound);
  log(audio.message, audio.playable ? 'info' : 'warn');
}

function previewSample(sample) {
  if (!sample?.file) return;
  stopAudio();
  state.currentAudioUrl = URL.createObjectURL(sample.file);
  state.audio.src = state.currentAudioUrl;
  state.playingSampleId = sample.id;
  state.audio.play().catch(error => log(`Préécoute impossible : ${error.message}`, 'warn'));
  renderPads();
}

async function addWavFiles(fileList, importedManifest = null) {
  const files = [...fileList].filter(file => /\.wav$/i.test(file.name) || file.type === 'audio/wav' || file.type === 'audio/x-wav');
  if (!files.length) {
    log('Aucun fichier WAV détecté.', 'warn');
    return;
  }

  log(`Analyse de ${files.length} fichier(s) WAV…`);
  const manifestSamples = importedManifest?.samples ?? [];
  const manifestByPath = new Map(manifestSamples.filter(item => item.audioPath).map(item => [item.audioPath.split('/').pop(), item]));

  const additions = await Promise.all(files.map(async (file, index) => {
    const relativePath = file.webkitRelativePath || file.name;
    const imported = manifestByPath.get(file.name) ?? manifestSamples[index] ?? null;
    const detection = imported ? null : classifySample(file.name, relativePath);
    let wavInfo = null;
    let formatError = '';
    try {
      wavInfo = await inspectWav(file);
    } catch (error) {
      formatError = error.message;
    }

    const category = imported?.category && BANK_BY_KEY[imported.category] ? imported.category : detection?.category ?? 'USER1';
    return {
      id: imported?.id || createId(),
      file,
      relativePath,
      name: sanitizeName(imported?.name || file.name),
      category,
      confidence: imported?.confidence || detection?.confidence || 'high',
      preferredSlot: Number(imported?.slot) || extractPreferredSlot(file.name),
      slot: Number(imported?.slot) || null,
      wavInfo,
      formatError,
      allocationStatus: formatError ? 'error' : 'ok',
      allocationMessage: formatError
    };
  }));

  state.samples.push(...additions);
  reallocate();
  log(`${additions.length} sample(s) ajouté(s).`);
}

function sampleStatus(sample, planErrors) {
  if (sample.formatError) return { kind: 'error', label: 'WAV invalide', title: sample.formatError };
  const planError = planErrors.find(error => error.id === sample.id);
  if (planError) return { kind: 'error', label: 'À corriger', title: planError.message };
  if (sample.allocationStatus === 'warn' || sample.confidence === 'low') {
    return { kind: 'warn', label: sample.confidence === 'low' ? 'À vérifier' : 'Débordement', title: sample.allocationMessage || 'Catégorie détectée avec une faible confiance.' };
  }
  return { kind: 'ok', label: 'Prêt', title: '' };
}

function formatWavInfo(sample) {
  if (!sample.wavInfo) return '—';
  const info = sample.wavInfo;
  const duration = Number.isFinite(info.duration) ? `${info.duration.toFixed(2)} s` : '? s';
  return `${info.sampleRate} Hz · ${info.bitsPerSample} bit · ${info.channels} ch · ${duration}`;
}

function renderBankSummary() {
  const summaries = summarizeBanks(state.samples, effectiveOccupied());
  el.bankSummary.innerHTML = summaries.map(bank => {
    const usage = Math.min(100, ((bank.occupied + bank.planned) / bank.capacity) * 100);
    return `<article class="bank-card" data-bank="${bank.key}">
      <h3>${bank.label}</h3>
      <div class="bank-range">${String(bank.start).padStart(3, '0')}–${String(bank.end).padStart(3, '0')}</div>
      <div class="bank-count">${bank.planned} <small>à importer · ${bank.freeAfterPlan} libres</small></div>
      <div class="bank-progress" title="${bank.occupied} occupés + ${bank.planned} prévus"><span style="width:${usage}%"></span></div>
    </article>`;
  }).join('');
}

function plannedBySlot() {
  const map = new Map();
  for (const sample of state.samples) {
    if (Number.isInteger(sample.slot)) map.set(sample.slot, sample);
  }
  return map;
}

function activePadBank() {
  if (state.padBank && BANK_BY_KEY[state.padBank]) return state.padBank;
  const planned = plannedBySlot();
  const firstUsed = BANKS.find(bank => [...planned.keys()].some(slot => slot >= bank.start && slot <= bank.end));
  return (firstUsed ?? BANKS[0]).key;
}

function renderPads() {
  const active = activePadBank();
  const planned = plannedBySlot();
  const countInBank = bank => state.samples.filter(s => Number.isInteger(s.slot) && s.slot >= bank.start && s.slot <= bank.end).length;

  el.padBankTabs.innerHTML = BANKS.map(bank => {
    const count = countInBank(bank);
    return `<button class="pad-tab ${bank.key === active ? 'is-active' : ''}" role="tab" data-bank="${bank.key}">
      ${bank.label}${count ? `<span class="tab-count">${count}</span>` : ''}
    </button>`;
  }).join('');

  const bank = BANK_BY_KEY[active];
  const occupied = effectiveOccupied();
  const pads = [];
  for (let slot = bank.start; slot <= bank.end; slot += 1) {
    const sample = planned.get(slot);
    const deviceSound = state.device?.soundBySlot.get(slot) ?? null;
    const label = String(slot).padStart(3, '0');
    if (sample) {
      const error = sample.formatError || sample.allocationStatus === 'error';
      const playing = sample.id === state.playingSampleId ? ' is-playing' : '';
      pads.push(`<button class="pad is-planned${error ? ' has-error' : ''}${playing}" data-id="${sample.id}" data-slot="${slot}" title="${escapeHtml(`${label} · ${sample.name} — cliquer pour écouter`)}">
        <span class="pad-num">${label}</span>
        <span class="pad-name">${escapeHtml(sample.name)}</span>
      </button>`);
    } else if (occupied.has(slot)) {
      const dragging = slot === state.draggingDeviceSlot ? ' is-dragging' : '';
      const soundName = deviceSound?.name ?? '';
      const title = deviceSound
        ? `${label} · ${soundName} — glisser ou déposer pour déplacer/échanger`
        : `${label} · déjà occupé sur l’appareil`;
      pads.push(`<div class="pad is-occupied${dragging}" data-slot="${slot}" ${deviceSound ? 'draggable="true"' : ''} title="${escapeHtml(title)}">
        <span class="pad-num">${label}</span>
        ${soundName ? `<span class="pad-name">${escapeHtml(soundName)}</span>` : ''}
      </div>`);
    } else {
      pads.push(`<div class="pad is-free" data-slot="${slot}" title="${label} · libre"><span class="pad-num">${label}</span></div>`);
    }
  }
  el.padGrid.innerHTML = pads.join('');
}

function categoryOptions(selected) {
  return BANKS.map(bank => `<option value="${bank.key}" ${bank.key === selected ? 'selected' : ''}>${bank.label}</option>`).join('');
}

function renderTable() {
  const planErrors = validatePlan(state.samples, effectiveOccupied(), el.strictMode.checked);
  el.sampleCountLabel.textContent = `${state.samples.length} sample${state.samples.length > 1 ? 's' : ''} · ${planErrors.length} erreur${planErrors.length > 1 ? 's' : ''}`;

  if (!state.samples.length) {
    el.sampleTableBody.innerHTML = '<tr class="empty-row"><td colspan="8">Aucun sample chargé.</td></tr>';
    return;
  }

  el.sampleTableBody.innerHTML = state.samples.map(sample => {
    const status = sampleStatus(sample, planErrors);
    return `<tr data-id="${sample.id}">
      <td><button class="button audio-button" data-action="play" title="Préécouter">▶</button></td>
      <td><input class="name-input" data-field="name" value="${escapeHtml(sample.name)}" /></td>
      <td><select class="category-select" data-field="category">${categoryOptions(sample.category)}</select></td>
      <td><input class="slot-input" data-field="slot" type="number" min="1" max="999" value="${sample.slot ?? ''}" /></td>
      <td title="${escapeHtml(sample.formatError || '')}">${escapeHtml(formatWavInfo(sample))}</td>
      <td>${formatBytes(sample.file?.size ?? 0)}</td>
      <td><span class="status-pill status-${status.kind}" title="${escapeHtml(status.title)}">${status.label}</span></td>
      <td><button class="button button-ghost remove-button" data-action="remove" title="Retirer">×</button></td>
    </tr>`;
  }).join('');
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s';
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min} min ${String(sec).padStart(2, '0')} s`;
}

function currentConversion() {
  return {
    enabled: el.convertOnExport.checked,
    targetSampleRate: Number(el.targetSampleRate.value) || EP133_TARGET_SAMPLE_RATE,
    mono: el.convertMono.checked
  };
}

function currentCapacityBytes() {
  return state.device?.memory?.capacityBytes
    || (EP133_MEMORY_OPTIONS.find(option => option.key === state.memoryKey) ?? EP133_MEMORY_OPTIONS[0]).bytes;
}

function renderMemory() {
  const capacityBytes = currentCapacityBytes();
  const summary = summarizeMemory(state.samples, { capacityBytes, conversion: currentConversion() });

  // Si un appareil est connu (.pak ou scan MIDI), le plan d'import s'ajoute par-dessus.
  const deviceBytes = state.device ? state.device.sounds.reduce((sum, sound) => sum + sound.size, 0) : 0;
  const combined = deviceBytes + summary.totalBytes;
  const usedRatio = capacityBytes > 0 ? Math.min(1, combined / capacityBytes) : 0;
  const over = combined > capacityBytes;

  el.memoryBarFill.style.width = `${Math.round(usedRatio * 100)}%`;
  el.memoryBarFill.classList.toggle('is-over', over);

  const percent = (usedRatio * 100).toFixed(usedRatio >= 0.1 ? 0 : 1);
  el.memoryStats.innerHTML = [
    `<span><b>${formatBytes(combined)}</b> / ${formatBytes(capacityBytes)} <small class="${over ? 'stat-over' : 'muted'}">(${percent}%${over ? ' — dépassement !' : ''})</small></span>`,
    deviceBytes ? `<span><b>${formatBytes(deviceBytes)}</b> déjà sur l’appareil</span>` : '',
    `<span><b>${summary.count}</b> sample(s) à importer (${formatBytes(summary.totalBytes)})</span>`,
    `<span><b>${formatBytes(Math.max(0, capacityBytes - combined))}</b> resteront libres</span>`,
    `<span>≈ <b>${formatDuration(summary.totalDuration)}</b> d’audio à importer</span>`
  ].filter(Boolean).join('');

  const maxBank = Math.max(1, ...summary.perBank.map(bank => bank.bytes));
  el.memoryBanks.innerHTML = summary.perBank.map(bank => `
    <div class="mem-bank ${bank.count ? '' : 'is-empty'}">
      <div class="mem-bank-label">${bank.label}</div>
      <div class="mem-bank-size">${bank.count} · ${formatBytes(bank.bytes)}</div>
      <div class="bank-progress"><span style="width:${Math.round((bank.bytes / maxBank) * 100)}%"></span></div>
    </div>
  `).join('');
}

function slotLabel(slot) {
  return String(slot).padStart(3, '0');
}

function renderSyncActions() {
  if (!el.syncSummary) return;
  const changeReadiness = analyzeDeviceChangeReadiness(state.deviceChanges);
  const sampleCount = state.samples.length;

  if (changeReadiness.count) {
    el.syncSummary.textContent = `${changeReadiness.count} déplacement(s) local(aux) en attente d’application sur la machine.`;
  } else if (sampleCount) {
    el.syncSummary.textContent = `${sampleCount} nouveau(x) sample(s) prêt(s) à exporter ou envoyer.`;
  } else if (state.device) {
    el.syncSummary.textContent = 'État appareil chargé. Les prochains glisser-déposer apparaîtront ici.';
  } else {
    el.syncSummary.textContent = 'Aucun changement à envoyer pour l’instant.';
  }

  const blockers = [];
  if (changeReadiness.missingAudio.length) blockers.push('importe un .pak pour fournir l’audio des sons déplacés');
  if (changeReadiness.targetOutsideUser.length) blockers.push('la cible doit rester dans USER 700–899 en mode sécurisé');
  if (changeReadiness.deleteOutsideUser.length) blockers.push('la source à supprimer doit aussi être dans USER 700–899');

  el.syncHint.textContent = changeReadiness.count
    ? (blockers.length
      ? `Application bloquée : ${blockers.join(' · ')}.`
      : 'Prêt : ces déplacements peuvent être appliqués en mode simulation ou en écriture réelle confirmée.')
    : 'Les déplacements faits par glisser-déposer restent locaux tant qu’ils ne sont pas appliqués.';

  el.saveLocalStateBtn.disabled = !state.device;
  el.applyDeviceChangesBtn.disabled = !changeReadiness.count;
  el.applyDeviceChangesBtn.title = changeReadiness.count
    ? 'Vérifie puis applique les déplacements locaux à la machine quand c’est possible'
    : 'Déplace d’abord un son entre deux slots';
  el.uploadBtn.disabled = !sampleCount;
  el.uploadBtn.title = sampleCount
    ? 'Envoie le plan d’import vers l’EP-133 (simulation par défaut)'
    : 'Ajoute des WAV au plan d’import pour activer cet envoi';
}

function render() {
  renderBankSummary();
  renderPads();
  renderMemory();
  renderLivePads();
  renderTable();
  const hasSamples = state.samples.length > 0;
  el.exportCsvBtn.disabled = !hasSamples;
  el.exportJsonBtn.disabled = !hasSamples;
  el.exportPackBtn.disabled = !hasSamples;
  el.exportHandoffBtn.disabled = !hasSamples;
  el.uploadBtn.disabled = !hasSamples;
  renderSyncActions();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function applyOccupiedSlots() {
  const { occupied, invalid } = parseOccupiedSlots(el.occupiedSlots.value);
  state.occupied = occupied;
  if (invalid.length) log(`Éléments ignorés : ${invalid.join(', ')}`, 'warn');
  log(`${occupied.size} slot(s) marqué(s) comme occupé(s).`);
  reallocate();
}

function createManifest() {
  return {
    format: 'epack',
    formatVersion: 1,
    app: 'EP Bank Organizer',
    appVersion: '0.1.0',
    createdAt: new Date().toISOString(),
    device: 'EP-133 K.O. II',
    rules: {
      strict: el.strictMode.checked,
      fallbackUserBanks: el.fallbackUserBanks.checked,
      banks: BANKS
    },
    conversion: {
      enabled: el.convertOnExport.checked,
      targetSampleRate: Number(el.targetSampleRate.value) || EP133_TARGET_SAMPLE_RATE,
      mono: el.convertMono.checked,
      normalize: el.normalizeAudio.checked,
      trimSilence: el.trimSilence.checked
    },
    samples: state.samples.map(sample => ({
      id: sample.id,
      name: sample.name,
      originalFilename: sample.file.name,
      relativePath: sample.relativePath,
      category: sample.category,
      slot: sample.slot,
      confidence: sample.confidence,
      size: sample.file.size,
      wav: sample.wavInfo
    }))
  };
}

function validateBeforeExport() {
  const errors = validatePlan(state.samples, effectiveOccupied(), el.strictMode.checked);
  if (errors.length) {
    const unique = [...new Set(errors.map(error => error.message))];
    throw new Error(`Le plan contient ${errors.length} erreur(s) : ${unique.slice(0, 4).join(' / ')}`);
  }
  if (state.samples.some(sample => sample.formatError)) throw new Error('Un ou plusieurs fichiers WAV sont invalides.');
}

async function resolveExportAudio(sample) {
  if (!el.convertOnExport.checked) return sample.file;
  log(`Conversion : ${sample.name}`);
  return convertWav(sample.file, {
    targetSampleRate: Number(el.targetSampleRate.value) || EP133_TARGET_SAMPLE_RATE,
    mono: el.convertMono.checked,
    normalize: el.normalizeAudio.checked,
    trimSilence: el.trimSilence.checked
  });
}

async function exportPack() {
  try {
    validateBeforeExport();
    el.exportPackBtn.disabled = true;
    log('Création du pack EPACK…');
    const blob = await createEpack(state.samples, createManifest(), resolveExportAudio);
    const filename = `EP133_pack_${new Date().toISOString().slice(0, 10)}.epack`;
    downloadBlob(blob, filename);
    log(`Pack créé : ${filename} (${formatBytes(blob.size)}).`);
  } catch (error) {
    log(error.message, 'error');
  } finally {
    el.exportPackBtn.disabled = false;
  }
}

async function exportHandoff() {
  try {
    validateBeforeExport();
    el.exportHandoffBtn.disabled = true;
    log('Création du dossier de transfert…');
    const blob = await createHandoffBundle(state.samples, { converted: el.convertOnExport.checked }, resolveExportAudio);
    const filename = `EP133_transfert_${new Date().toISOString().slice(0, 10)}.zip`;
    downloadBlob(blob, filename);
    log(`Dossier de transfert créé : ${filename} (${formatBytes(blob.size)}). Décompresse-le puis charge les WAV avec ton outil d’upload.`);
    if (!el.convertOnExport.checked) log('Astuce : active « convertir à l’export » pour des WAV directement au format 46 875 Hz / 16 bits mono.', 'warn');
  } catch (error) {
    log(error.message, 'error');
  } finally {
    el.exportHandoffBtn.disabled = false;
  }
}

async function exportSysex() {
  try {
    validateBeforeExport();
    el.exportSysexBtn.disabled = true;
    log('Génération du fichier SysEx (.syx)…');

    // 1. Initialiser le transport en mode virtuel/neutre (pour générer les trames sans envoyer)
    const transport = new Ep133Transport(null, {
      simulation: true,
      unlockWrite: true,
      allowAllBanks: true,
      logger: () => {}
    });

    // 2. Conversion préalable de tous les fichiers WAV en PCM brut
    const convertedSamples = [];
    log('Conversion des fichiers audio en PCM brut (46875 Hz, 16-bit mono)…');
    for (const sample of state.samples) {
      log(`Conversion : ${sample.name}…`);
      try {
        const rawBlob = await convertWavToRawPcm(sample.file, {
          targetSampleRate: EP133_TARGET_SAMPLE_RATE,
          mono: true,
          normalize: el.normalizeAudio.checked,
          trimSilence: el.trimSilence.checked
        });
        convertedSamples.push({
          ...sample,
          audioBlob: rawBlob
        });
      } catch (err) {
        throw new Error(`Erreur lors de la conversion de ${sample.name} : ${err.message}`);
      }
    }

    // 3. Récupérer toutes les trames sous forme d'octets
    const allBytes = [];
    
    // Handshake
    allBytes.push(...transport.getHandshakeFrame());
    
    // File Init
    allBytes.push(...transport.getFileInitFrame());

    for (const sample of convertedSamples) {
      const frames = await transport.getFramesForSample(sample);
      for (const frame of frames) {
        allBytes.push(...frame);
      }
    }

    const sysexData = new Uint8Array(allBytes);
    const blob = new Blob([sysexData], { type: 'application/octet-stream' });
    const filename = `ep133_transfer_${new Date().toISOString().slice(0, 10)}.syx`;
    downloadBlob(blob, filename);
    log(`Fichier SysEx généré avec succès : ${filename} (${formatBytes(blob.size)}).`);
    log('Tu peux maintenant comparer ce fichier octet par octet avec send_tiny_sound.syx.');
  } catch (error) {
    log(error.message, 'error');
  } finally {
    el.exportSysexBtn.disabled = false;
  }
}

function exportJson() {
  try {
    validateBeforeExport();
    const blob = new Blob([JSON.stringify(createManifest(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, `EP133_manifest_${new Date().toISOString().slice(0, 10)}.json`);
    log('Manifest JSON exporté.');
  } catch (error) {
    log(error.message, 'error');
  }
}

function exportCsv() {
  try {
    validateBeforeExport();
    const rows = [['slot', 'category', 'name', 'original_filename', 'sample_rate', 'bits', 'channels', 'size_bytes']];
    for (const sample of state.samples) {
      rows.push([
        sample.slot, sample.category, sample.name, sample.file.name,
        sample.wavInfo?.sampleRate ?? '', sample.wavInfo?.bitsPerSample ?? '',
        sample.wavInfo?.channels ?? '', sample.file.size
      ]);
    }
    const content = rows.map(row => row.map(csvEscape).join(';')).join('\n');
    downloadBlob(new Blob([`\ufeff${content}`], { type: 'text/csv;charset=utf-8' }), `EP133_plan_${new Date().toISOString().slice(0, 10)}.csv`);
    log('Plan CSV exporté.');
  } catch (error) {
    log(error.message, 'error');
  }
}

async function importEpack(file) {
  try {
    log(`Ouverture du pack ${file.name}…`);
    const { manifest, files } = await readEpack(file);
    await addWavFiles(files, manifest);
    log(`Pack importé : ${manifest.samples?.length ?? files.length} sample(s).`);
  } catch (error) {
    log(error.message, 'error');
  }
}

const DEVICE_STORE_KEY = 'ep133-device-snapshot';

/** Sauvegarde un instantané léger de l'appareil (sans l'audio) pour survivre aux rechargements. */
function persistDevice(device, filename) {
  try {
    const snapshot = {
      filename,
      savedAt: Date.now(),
      source: device.source ?? 'pak',
      memory: device.memory ?? null,
      deviceInfo: device.deviceInfo ?? null,
      sounds: device.sounds.map(s => ({
        slot: s.slot,
        name: s.name,
        bank: s.bank,
        size: s.size,
        compressedSize: s.compressedSize,
        duration: s.duration,
        scanOnly: Boolean(s.scanOnly)
      })),
      projects: device.projects.map(p => ({ id: p.id, assignedCount: p.assignedCount, groups: p.groups }))
    };
    localStorage.setItem(DEVICE_STORE_KEY, JSON.stringify(snapshot));
  } catch { /* quota dépassé ou stockage indisponible : on ignore */ }
}

/** Restaure l'instantané appareil. L'audio n'est pas conservé : getBlob invite à réimporter. */
function restoreDevice() {
  let snap;
  try { snap = JSON.parse(localStorage.getItem(DEVICE_STORE_KEY) || 'null'); } catch { return null; }
  if (!snap?.sounds?.length) return null;
  const soundBySlot = new Map();
  const sounds = snap.sounds.map(s => ({
    ...s,
    scanOnly: Boolean(s.scanOnly || snap.source === 'midi-scan'),
    restored: true,
    async getBlob() { throw new Error('Audio non conservé entre les sessions. Réimporte un .pak pour écouter ce son.'); }
  }));
  for (const s of sounds) soundBySlot.set(s.slot, s);
  return {
    sounds,
    soundBySlot,
    projects: snap.projects ?? [],
    filename: snap.filename,
    savedAt: snap.savedAt,
    source: snap.source ?? 'pak',
    memory: snap.memory ?? null,
    deviceInfo: snap.deviceInfo ?? null,
    restored: true
  };
}

function applyDevice(device) {
  state.device = device;
  state.deviceProject = device.projects[0]?.id ?? null;
  state.deviceSearch = '';
  state.deviceChanges = [];
  if (el.deviceSearch) el.deviceSearch.value = '';
  state.deviceOccupied = new Set(device.sounds.map(sound => sound.slot));
  if (el.blockDeviceSlots) el.blockDeviceSlots.checked = state.useDeviceOccupied;
}

function clearDropHovers() {
  document.querySelectorAll('.is-drop-hover').forEach(node => node.classList.remove('is-drop-hover'));
}

function clearSlotDropState() {
  clearDropHovers();
  document.querySelectorAll('.is-dragging').forEach(node => node.classList.remove('is-dragging'));
}

function slotFromDragEvent(event) {
  const raw = event.dataTransfer?.getData('text/x-ep133-slot')
    || event.dataTransfer?.getData('text/plain')
    || state.draggingDeviceSlot;
  const slot = Number(raw);
  return Number.isInteger(slot) ? slot : null;
}

function isDeviceSlotDrag(event) {
  return state.draggingDeviceSlot != null || [...(event.dataTransfer?.types ?? [])].includes('text/x-ep133-slot');
}

function startDeviceSlotDrag(event, slot) {
  if (!state.device?.soundBySlot.get(slot)) return;
  state.draggingDeviceSlot = slot;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/x-ep133-slot', String(slot));
    event.dataTransfer.setData('text/plain', String(slot));
  }
  event.target.closest('[data-slot]')?.classList.add('is-dragging');
}

function recordDeviceSlotChange(result) {
  const addChange = (sound, fromSlot, toSlot, swapped) => {
    if (!sound) return;
    state.deviceChanges.push({
      id: createId(),
      fromSlot,
      toSlot,
      swapped,
      soundName: sound.name,
      hasAudio: deviceSoundAudioStatus(sound).playable
    });
  };

  addChange(result.sound, result.fromSlot, result.toSlot, result.swapped);
  if (result.swapped) addChange(result.targetSound, result.toSlot, result.fromSlot, true);
}

function acceptDeviceSlotDrop(event, targetSlot) {
  const fromSlot = slotFromDragEvent(event);
  if (!fromSlot || !targetSlot || fromSlot === targetSlot) return;
  event.preventDefault();
  event.stopPropagation();

  const result = moveDeviceSoundSlot(state.device, fromSlot, targetSlot);
  if (!result.ok) {
    log('Déplacement impossible : le slot source n’existe plus dans l’inventaire.', 'warn');
    state.draggingDeviceSlot = null;
    clearSlotDropState();
    return;
  }

  if (state.playingDeviceSlot === result.fromSlot) state.playingDeviceSlot = result.toSlot;
  else if (result.swapped && state.playingDeviceSlot === result.toSlot) state.playingDeviceSlot = result.fromSlot;

  recordDeviceSlotChange(result);
  state.deviceOccupied = new Set(state.device.sounds.map(sound => sound.slot));
  persistDevice(state.device, state.device.filename ?? 'réorganisation locale');
  state.draggingDeviceSlot = null;
  clearSlotDropState();
  renderDevice();
  reallocate();

  const fromLabel = String(result.fromSlot).padStart(3, '0');
  const toLabel = String(result.toSlot).padStart(3, '0');
  const action = result.swapped ? `slots ${fromLabel} et ${toLabel} échangés` : `${fromLabel} déplacé vers ${toLabel}`;
  log(`Réorganisation locale : ${action}. Utilise « Appliquer les déplacements » pour vérifier si l’écriture machine est possible.`);
}

function saveLocalState() {
  if (!state.device) {
    log('Aucun état appareil à sauvegarder pour l’instant.', 'warn');
    return;
  }
  persistDevice(state.device, state.device.filename ?? 'réorganisation locale');
  log('État local sauvegardé dans le navigateur. La machine n’a pas été modifiée.');
  renderSyncActions();
}

function explainDeviceChangeBlockers(readiness) {
  if (!readiness.count) {
    log('Aucun déplacement local à appliquer.', 'warn');
    return;
  }

  if (readiness.missingAudio.length) {
    const examples = readiness.missingAudio.slice(0, 3).map(change => `${slotLabel(change.fromSlot)}→${slotLabel(change.toSlot)}`).join(', ');
    log(`Application impossible pour ${readiness.missingAudio.length} déplacement(s) (${examples}) : le scan MIDI ne contient pas l’audio. Importe un .pak pour fournir les WAV source.`, 'warn');
  }
  if (readiness.targetOutsideUser.length) {
    const examples = readiness.targetOutsideUser.slice(0, 3).map(change => slotLabel(change.toSlot)).join(', ');
    log(`Application bloquée : cible(s) hors USER 700–899 (${examples}). L’écriture matérielle reste volontairement limitée aux banques USER.`, 'warn');
  }
  if (readiness.deleteOutsideUser.length) {
    const examples = readiness.deleteOutsideUser.slice(0, 3).map(change => slotLabel(change.fromSlot)).join(', ');
    log(`Application exacte bloquée : il faudrait supprimer une source hors USER 700–899 (${examples}). Le déplacement reste local pour éviter d’effacer une banque système.`, 'warn');
  }
}

async function uploadDeviceChangeSounds(changes, simulation) {
  const uploadSamples = [];
  for (const change of changes) {
    const sound = state.device?.soundBySlot.get(change.toSlot);
    if (!sound) throw new Error(`Le slot cible ${slotLabel(change.toSlot)} n’existe plus dans l’état local.`);
    const wavBlob = await sound.getBlob();
    const sample = {
      name: sound.name,
      slot: change.toSlot,
      file: wavBlob,
      channels: sound.channels ?? 1
    };
    if (!simulation) {
      sample.audioBlob = await convertWavToRawPcm(wavBlob, {
        targetSampleRate: EP133_TARGET_SAMPLE_RATE,
        mono: true,
        normalize: el.normalizeAudio.checked,
        trimSilence: el.trimSilence.checked
      });
    }
    uploadSamples.push(sample);
  }
  return uploadSamples;
}

async function applyDeviceChanges() {
  const readiness = analyzeDeviceChangeReadiness(state.deviceChanges);
  if (!readiness.exactWritable) {
    explainDeviceChangeBlockers(readiness);
    renderSyncActions();
    return;
  }

  const simulation = el.simulationMode.checked;
  if (!simulation && !state.midi.getSelectedOutput()) {
    log('Sélectionne d’abord une sortie MIDI pour appliquer les déplacements sur l’EP-133.', 'warn');
    return;
  }

  const confirmed = await confirmAction(
    simulation ? 'Simuler les déplacements ?' : 'Appliquer les déplacements sur l’EP-133 ?',
    simulation
      ? `${readiness.count} déplacement(s) seront simulés, sans modifier la machine.`
      : `${readiness.count} déplacement(s) vont être écrits dans USER 700–899. Les sources USER remplacées seront supprimées quand nécessaire.`
  );
  if (!confirmed) return;

  const previousText = el.applyDeviceChangesBtn.textContent;
  try {
    el.applyDeviceChangesBtn.disabled = true;
    el.applyDeviceChangesBtn.textContent = simulation ? 'Simulation…' : 'Application…';
    const transport = new Ep133Transport(state.midi, {
      simulation,
      unlockWrite: !simulation,
      allowAllBanks: false,
      logger: message => log(message)
    });

    const samples = await uploadDeviceChangeSounds(readiness.pending, simulation);
    await transport.uploadBatch(samples, ({ index, total, sample }) => {
      el.applyDeviceChangesBtn.textContent = `${index}/${total} · ${slotLabel(sample.slot)}`;
    });

    if (!simulation) {
      const deletions = readiness.pending.filter(change => !change.swapped).map(change => change.fromSlot);
      for (const slot of deletions) {
        await transport.deleteSlot(slot);
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      state.deviceChanges = [];
      persistDevice(state.device, state.device.filename ?? 'réorganisation appliquée');
      log('Déplacements appliqués sur l’EP-133 en mode sécurisé USER.');
    } else {
      log('Simulation terminée : les déplacements restent locaux tant que le mode simulation est actif.');
    }
  } catch (error) {
    if (error instanceof ProtocolNotImplementedError) log(error.message, 'warn');
    else log(`Application impossible : ${error.message}`, 'error');
  } finally {
    el.applyDeviceChangesBtn.textContent = previousText;
    renderDevice();
    renderSyncActions();
  }
}

async function importPak(file) {
  try {
    log(`Lecture de la sauvegarde ${file.name}…`);
    const device = await parsePak(file);
    if (!device.sounds.length && !device.projects.length) {
      throw new Error('Aucun son ni projet trouvé — ce fichier n’est peut-être pas un backup EP-133.');
    }
    persistDevice(device, file.name);
    applyDevice(device);
    renderDevice();
    reallocate();
    log(`Sauvegarde chargée : ${device.sounds.length} son(s), ${device.projects.length} projet(s). ${state.deviceOccupied.size} slot(s) occupé(s) sur l’appareil seront évités à l’import.`);
  } catch (error) {
    log(`Import .pak impossible : ${error.message}`, 'error');
  }
}

function renderDevice() {
  const device = state.device;
  el.deviceEmpty.hidden = Boolean(device);
  el.deviceContent.hidden = !device;
  if (!device) {
    const midiReady = Boolean(state.midi.access);
    el.deviceEmpty.classList.toggle('is-midi-connected', midiReady);
    el.deviceEmpty.innerHTML = midiReady
      ? `<p><strong>MIDI connecté, contenu pas encore lu.</strong></p>
        <p>Clique <code>Scanner la mémoire</code> pour lire les slots et les stats depuis l’EP-133, ou importe un <code>.pak</code> pour aussi écouter les sons et voir les projets.</p>`
      : '<p>Aucune donnée appareil chargée. Connecte le MIDI puis scanne la mémoire, ou importe un backup <code>.pak</code>.</p>';
    return;
  }
  el.deviceEmpty.classList.remove('is-midi-connected');

  const capacity = currentCapacityBytes();
  const totalBytes = device.sounds.reduce((sum, sound) => sum + sound.size, 0);
  const totalDuration = device.sounds.reduce((sum, sound) => sum + sound.duration, 0);
  const usedRatio = capacity > 0 ? Math.min(1, totalBytes / capacity) : 0;
  const percent = (usedRatio * 100).toFixed(usedRatio >= 0.1 ? 0 : 1);
  const projectLabel = device.projects.length ? `${device.projects.length} projet(s)` : (device.source === 'midi-scan' ? 'projets non lus' : '0 projet');

  el.deviceSummary.innerHTML = [
    `<span><b>${device.sounds.length}</b> son(s) · ${projectLabel}</span>`,
    `<span><b>${formatBytes(totalBytes)}</b> / ${formatBytes(capacity)} <small class="${totalBytes > capacity ? 'stat-over' : 'muted'}">(${percent}%)</small></span>`,
    `<span><b>${formatBytes(Math.max(0, capacity - totalBytes))}</b> restants</span>`,
    `<span>≈ <b>${formatDuration(totalDuration)}</b> d’audio</span>`
  ].join('');
  el.deviceBarFill.style.width = `${Math.round(usedRatio * 100)}%`;
  el.deviceBarFill.classList.toggle('is-over', totalBytes > capacity);

  // Répartition par banque (taille réelle occupée sur l'appareil)
  const perBank = new Map(BANKS.map(bank => [bank.key, { label: bank.label, bytes: 0, count: 0 }]));
  for (const sound of device.sounds) {
    const bank = perBank.get(sound.bank);
    if (bank) { bank.bytes += sound.size; bank.count += 1; }
  }
  const maxBank = Math.max(1, ...[...perBank.values()].map(bank => bank.bytes));
  el.deviceBanks.innerHTML = [...perBank.values()].map(bank => `
    <div class="mem-bank ${bank.count ? '' : 'is-empty'}">
      <div class="mem-bank-label">${bank.label}</div>
      <div class="mem-bank-size">${bank.count} · ${formatBytes(bank.bytes)}</div>
      <div class="bank-progress"><span style="width:${Math.round((bank.bytes / maxBank) * 100)}%"></span></div>
    </div>
  `).join('');

  el.projectSelect.innerHTML = device.projects
    .map(project => `<option value="${project.id}" ${project.id === state.deviceProject ? 'selected' : ''}>${project.id} · ${project.assignedCount} pad(s)</option>`)
    .join('');

  renderProjectPads();
  renderDeviceSounds();
  renderLivePads();
  renderSyncActions();
}

function renderProjectPads() {
  const device = state.device;
  const project = device.projects.find(p => p.id === state.deviceProject) ?? device.projects[0];
  if (!project) { el.projectPads.innerHTML = ''; return; }

  el.projectPads.innerHTML = DEVICE_LAYOUT.groups.map(group => {
    const cells = PAD_DISPLAY_ORDER.map(offset => {
      const pad = project.groups[group][offset];
      const note = groupPadToNote(group, offset + 1);
      const fn = `<span class="dpad-fn">${PAD_LABELS[offset]}</span>`;
      const noteAttr = `data-note="${note}"`;
      if (!pad || pad.slot == null) {
        return `<div class="dpad" ${noteAttr} title="Pad ${PAD_LABELS[offset]} · vide · note ${note}">${fn}</div>`;
      }
      const sound = device.soundBySlot.get(pad.slot);
      const playing = sound && sound.slot === state.playingDeviceSlot ? ' is-playing' : '';
      if (!sound) {
        return `<div class="dpad is-missing" ${noteAttr} title="Slot ${pad.slot} absent de la sauvegarde · note ${note}">${fn}<span class="dpad-slot">${String(pad.slot).padStart(3, '0')}</span><span class="dpad-name">(son absent)</span></div>`;
      }
      return `<button class="dpad is-filled${playing}" data-slot="${sound.slot}" ${noteAttr} title="${escapeHtml(`Pad ${PAD_LABELS[offset]} · ${String(sound.slot).padStart(3, '0')} · ${sound.name} · ${formatBytes(sound.size)} (${sound.duration.toFixed(2)} s) — cliquer pour écouter`)}">
        ${fn}<span class="dpad-slot">${String(sound.slot).padStart(3, '0')}</span>
        <span class="dpad-name">${escapeHtml(sound.name)}</span>
      </button>`;
    }).join('');
    return `<div class="pad-group">
      <h4><span class="grp-badge">${group.toUpperCase()}</span> Groupe ${group.toUpperCase()}</h4>
      <div class="pad-group-grid">${cells}</div>
    </div>`;
  }).join('');
}

function renderLivePads() {
  const connected = Boolean(state.midi.getSelectedOutput());
  const listening = Boolean(state.midi.access);

  el.livePads.hidden = !listening;
  el.liveStatus.classList.toggle('is-connected', listening);
  if (!listening) {
    el.liveStatus.textContent = 'Connecte le MIDI (bouton « Connecter MIDI » à gauche) pour activer les pads en direct.';
  } else if (!connected) {
    el.liveStatus.textContent = 'MIDI à l’écoute : presse un pad de l’appareil, il s’allume ci-dessous. Sélectionne la sortie EP-133 pour aussi jouer les pads au clic.';
  } else {
    el.liveStatus.textContent = 'Prêt : presse un pad de l’appareil pour le voir s’allumer, ou clique un pad ci-dessous pour le jouer sur la machine.';
  }
  if (!listening) return;

  // Les noms de sons sont affichés si un .pak et un projet sont chargés.
  const project = state.device?.projects.find(p => p.id === state.deviceProject) ?? null;

  el.livePads.innerHTML = DEVICE_LAYOUT.groups.map(group => {
    const cells = PAD_DISPLAY_ORDER.map(offset => {
      const note = groupPadToNote(group, offset + 1);
      const slot = project?.groups[group]?.[offset]?.slot ?? null;
      const sound = slot != null ? state.device?.soundBySlot.get(slot) : null;
      const name = sound ? escapeHtml(sound.name) : '';
      const slotLabel = slot != null ? String(slot).padStart(3, '0') : `♪ ${note}`;
      const clickable = connected ? ' is-live' : '';
      return `<button class="dpad is-filled${clickable}" data-note="${note}" title="${escapeHtml(`Groupe ${GROUP_LABELS[group]} · pad ${PAD_LABELS[offset]} · note ${note}`)}">
        <span class="dpad-fn">${PAD_LABELS[offset]}</span>
        <span class="dpad-slot">${slotLabel}</span>
        <span class="dpad-name">${name}</span>
      </button>`;
    }).join('');
    return `<div class="pad-group">
      <h4><span class="grp-badge">${GROUP_LABELS[group]}</span> Groupe ${GROUP_LABELS[group]}</h4>
      <div class="pad-group-grid">${cells}</div>
    </div>`;
  }).join('');
}

function renderDeviceSounds() {
  const query = state.deviceSearch.trim().toLowerCase();
  const sounds = state.device.sounds.filter(sound =>
    !query || sound.name.toLowerCase().includes(query) || String(sound.slot).padStart(3, '0').includes(query)
  );

  if (!sounds.length) {
    el.deviceSounds.innerHTML = '<div class="dsound"><span></span><span></span><span>Aucun son ne correspond au filtre.</span><span></span></div>';
    return;
  }

  el.deviceSounds.innerHTML = sounds.map(sound => {
    const playing = sound.slot === state.playingDeviceSlot ? ' is-playing' : '';
    const dragging = sound.slot === state.draggingDeviceSlot ? ' is-dragging' : '';
    const audio = deviceSoundAudioStatus(sound);
    const unavailable = audio.playable ? '' : ' is-unplayable';
    return `<div class="dsound${playing}${dragging}${unavailable}" data-slot="${sound.slot}" draggable="true" title="${escapeHtml(`Glisser ${String(sound.slot).padStart(3, '0')} vers un autre slot pour déplacer ou échanger`)}">
      <button class="button ds-play${audio.playable ? '' : ' is-unavailable'}" data-action="${audio.playable ? 'play' : 'explain'}" title="${escapeHtml(audio.playable ? 'Écouter' : audio.message)}">${audio.playable ? '▶' : 'i'}</button>
      <span class="ds-slot">${String(sound.slot).padStart(3, '0')}</span>
      <span class="ds-name">${escapeHtml(sound.name)}</span>
      <span class="ds-size">${formatBytes(sound.size)} · ${sound.duration.toFixed(2)} s${audio.playable ? '' : ` · <small>${escapeHtml(audio.label)}</small>`}</span>
      <span class="ds-bank">${sound.bank ?? ''}</span>
    </div>`;
  }).join('');
}

async function connectMidi() {
  try {
    el.connectMidiBtn.disabled = true;
    const outputs = await state.midi.connect();
    populateMidiOutputs(outputs);
    el.testDeviceBtn.disabled = false;
    el.scanDeviceBtn.disabled = false;
    const inputs = state.midi.listInputs();
    log(`${inputs.length} entrée(s) MIDI à l’écoute — presse un pad de l’appareil pour vérifier.`);
    const likely = state.midi.findLikelyEp133Output();
    if (likely) {
      el.midiOutputSelect.value = likely.id;
      state.midi.selectOutput(likely.id);
      log(`EP-133 probable détecté : ${likely.name}. Clique « Tester le matériel » pour confirmer.`);
    } else {
      log(`${outputs.length} sortie(s) MIDI disponible(s).`, outputs.length ? 'info' : 'warn');
    }
    updateDeviceBadge();
    renderLivePads();
    renderDevice();
    if (!state.device) {
      log('MIDI prêt. Clique « Scanner la mémoire » pour lire les slots et les stats directement depuis l’EP-133.');
    }
  } catch (error) {
    log(error.message, 'error');
    el.deviceBadge.textContent = 'Connexion MIDI impossible';
    el.deviceBadge.className = 'status-badge status-warn';
  } finally {
    el.connectMidiBtn.disabled = false;
  }
}

function populateMidiOutputs(outputs = state.midi.listOutputs()) {
  const selected = el.midiOutputSelect.value;
  el.midiOutputSelect.innerHTML = '<option value="">Aucune</option>' + outputs.map(output =>
    `<option value="${escapeHtml(output.id)}">${escapeHtml([output.manufacturer, output.name].filter(Boolean).join(' — '))}</option>`
  ).join('');
  if (outputs.some(output => output.id === selected)) el.midiOutputSelect.value = selected;
}

function testDevice() {
  try {
    if (!state.midi.getSelectedOutput()) throw new Error('Sélectionne d’abord une sortie MIDI.');
    log('Requête d’identité MIDI envoyée. En attente de la réponse de l’appareil…');
    state.midi.sendUniversalIdentityRequest();
    setTimeout(() => {
      if (!state.midi.identity) {
        log('Aucune réponse d’identité. L’appareil est peut-être éteint, non branché en USB-MIDI, ou n’implémente pas cette requête. L’écoute des pads reste active.', 'warn');
      }
    }, 1200);
  } catch (error) {
    log(error.message, 'error');
  }
}

/**
 * Scanne la mémoire de l'appareil : envoie les requêtes de lecture connues et
 * capture les réponses SysEx brutes. Le décodage du contenu (liste des sons) se
 * fait à partir de cette capture — étape indispensable pour la lecture directe.
 */
async function scanDevice() {
  const output = state.midi.getSelectedOutput();
  if (!output) { log('Sélectionne d’abord la sortie MIDI de l’EP-133.', 'warn'); return; }

  const portInfo = port => port ? {
    id: port.id,
    name: port.name || '',
    manufacturer: port.manufacturer || '',
    state: port.state || '',
    connection: port.connection || ''
  } : null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const inputs = state.midi.listInputs();
  const records = [];
  const validResponses = [];
  const invalidResponses = [];
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  const onSysex = event => {
    const bytes = Uint8Array.from(event.detail.data);
    const record = createCaptureRecord({
      direction: 'in',
      label: 'response',
      bytes,
      source: event.detail.input ?? null
    });
    records.push(record);
    if (record.validSysEx) validResponses.push(bytes);
    else invalidResponses.push(record);
  };

  const sendRequests = async (requests, { delayMs = 28 } = {}) => {
    for (const request of requests) {
      const frame = Uint8Array.from(request.frame);
      records.push(createCaptureRecord({
        direction: 'out',
        label: request.label,
        description: request.description,
        bytes: frame,
        source: portInfo(output)
      }));
      state.midi.send([...frame]);
      const wait = request.label === 'greet' ? 450 : request.label === 'file-manager-init' ? 220 : delayMs;
      await sleep(wait);
    }
  };

  state.midi.addEventListener('sysex', onSysex);
  el.scanDeviceBtn.disabled = true;
  const previousScanLabel = el.scanDeviceBtn.textContent;
  el.scanDeviceBtn.textContent = 'Scan en cours…';
  log(`Scan de l’appareil : sortie ${output.name || output.id}, ${inputs.length} entrée(s) écoutée(s).`);
  log('Inventaire MIDI complet : lecture des infos de slots 001–999. Ça peut prendre environ 30 à 60 s.');

  try {
    const inventoryRequests = buildInventoryScanRequests();
    await sendRequests(inventoryRequests, { delayMs: 28 });
    await sleep(1500);

    const firstPass = parseDeviceScanRecords(records);
    const foundSlots = firstPass.device.sounds.map(sound => sound.slot);
    if (foundSlots.length) {
      log(`${foundSlots.length} slot(s) occupé(s) détecté(s). Lecture des noms et métadonnées…`);
      await sendRequests(buildMetadataRequestsForSlots(foundSlots), { delayMs: 55 });
      await sleep(1500);
    } else {
      log('Aucun slot occupé détecté pendant l’inventaire.', 'warn');
    }

    const parsed = parseDeviceScanRecords(records);
    if (parsed.device.sounds.length) {
      persistDevice(parsed.device, `scan MIDI ${stamp}`);
      applyDevice(parsed.device);
      renderDevice();
      reallocate();
      const totalBytes = parsed.device.sounds.reduce((sum, sound) => sum + sound.size, 0);
      log(`Mémoire lue directement : ${parsed.device.sounds.length} son(s), ${formatBytes(totalBytes)} détectés sur l’EP-133.`);
      if (parsed.memory?.freeBytes != null) {
        log(`Mémoire annoncée par l’appareil : ${formatBytes(parsed.memory.usedBytes)} utilisés / ${formatBytes(parsed.memory.capacityBytes)}.`);
      }
    }
  } catch (error) {
    log(`Scan : envoi impossible (${error.message}).`, 'error');
  } finally {
    state.midi.removeEventListener('sysex', onSysex);
    el.scanDeviceBtn.disabled = false;
    el.scanDeviceBtn.textContent = previousScanLabel;
  }

  const inboundRecords = records.filter(record => record.direction === 'in');
  const outboundRecords = records.filter(record => record.direction === 'out');
  const validBytes = validResponses.reduce((sum, msg) => sum + msg.length, 0);
  const invalidSources = [...new Set(invalidResponses.map(record => record.source?.name || record.source?.id || 'entrée inconnue'))];
  const validSources = [...new Set(inboundRecords.filter(record => record.validSysEx).map(record => record.source?.name || record.source?.id || 'entrée inconnue'))];
  const parsed = parseDeviceScanRecords(records);

  const diagnostic = {
    format: 'ep133-scan-capture',
    version: 3,
    createdAt: new Date().toISOString(),
    selectedOutput: portInfo(output),
    inputs,
    requestCount: outboundRecords.length,
    inboundCount: inboundRecords.length,
    validResponseCount: validResponses.length,
    validResponseBytes: validBytes,
    invalidResponseCount: invalidResponses.length,
    parsed: {
      soundCount: parsed.device.sounds.length,
      sounds: parsed.device.sounds.map(({ slot, name, bank, size, duration, filename, samplerate, channels }) => ({ slot, name, bank, size, duration, filename, samplerate, channels })),
      memory: parsed.memory,
      deviceInfo: parsed.deviceInfo,
      errors: parsed.errors
    },
    records
  };

  const needsDiagnostic = !parsed.device.sounds.length || invalidResponses.length || !validResponses.length;
  if (needsDiagnostic) {
    downloadBlob(
      new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json;charset=utf-8' }),
      `ep133_scan_${stamp}.json`
    );
  }

  if (validResponses.length && parsed.device.sounds.length) {
    log(`Scan terminé : ${validResponses.length} réponse(s) SysEx valide(s), ${formatBytes(validBytes)}. Source(s) : ${validSources.join(', ')}.`);
    log('Scan appliqué dans l’app. Aucun fichier de capture téléchargé.');
  } else if (validResponses.length) {
    log(`Scan terminé : ${validResponses.length} réponse(s) SysEx valide(s), ${formatBytes(validBytes)}, mais aucun son décodable. Diagnostic .json téléchargé.`, 'warn');
  } else if (invalidResponses.length) {
    const first = invalidResponses[0];
    log(`Scan terminé : ${invalidResponses.length} réponse(s) SysEx invalides depuis ${invalidSources.join(', ')}. Diagnostic .json téléchargé.`, 'warn');
    log(`Premier message invalide : ${first.hex}. Vérifie que l’entrée MIDI écoutée est bien l’EP-133 et pas un port loopback/mock.`, 'warn');
    log('Envoie le .json si tu veux que je voie la source exacte et les octets capturés.');
  } else {
    log('Scan terminé : aucune réponse SysEx reçue. Le .json contient les requêtes envoyées et la liste des ports MIDI.', 'warn');
  }
}

function renderDeviceIdentity(identity) {
  const hex = list => list.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  el.deviceInfo.hidden = false;
  el.deviceInfo.classList.add('is-ok');
  el.deviceInfo.innerHTML = `<dl>
    <dt>Fabricant</dt><dd>${escapeHtml(identity.manufacturerHex)}</dd>
    <dt>Famille</dt><dd>${escapeHtml(hex(identity.family))}</dd>
    <dt>Modèle</dt><dd>${escapeHtml(hex(identity.member))}</dd>
    <dt>Version</dt><dd>${escapeHtml(hex(identity.version))}</dd>
  </dl>`;
  log(`✅ L’appareil répond ! Fabricant ${identity.manufacturerHex}. La communication MIDI fonctionne avec ton matériel.`);
  updateDeviceBadge();
}

let midiActivityTimer = null;
function showMidiActivity(detail) {
  el.midiActivity.hidden = false;
  el.midiActivity.classList.add('is-live');

  // On ne réagit qu'aux « note pressé » : ignorer les note-off et les autres
  // messages évite que la sidebar clignote en rafale quand tu joues.
  if (detail.kind !== 'noteOn') return;

  const gp = noteToGroupPad(detail.note);
  el.midiActivityText.textContent = gp
    ? `Groupe ${GROUP_LABELS[gp.group]} · pad ${gp.padIndex} (note ${detail.note}, canal ${detail.channel + 1})`
    : `Note ${detail.note} (canal ${detail.channel + 1})`;
  flashLivePad(detail.note);
  clearTimeout(midiActivityTimer);
  midiActivityTimer = setTimeout(() => el.midiActivity.classList.remove('is-live'), 350);
}

/** Allume brièvement le pad correspondant à une note reçue, dans les deux grilles. */
function flashLivePad(note) {
  const pads = document.querySelectorAll(`.dpad[data-note="${note}"]`);
  for (const pad of pads) {
    pad.classList.add('is-hit');
    setTimeout(() => pad.classList.remove('is-hit'), 220);
  }
}

/** Envoie une note (note-on puis note-off) pour déclencher un son sur l'appareil. */
function triggerNoteOnDevice(note, padEl) {
  try {
    const channel = state.midiChannel & 0x0f;
    state.midi.send([0x90 | channel, note, 100]);
    setTimeout(() => state.midi.send([0x80 | channel, note, 0]), 200);
    if (padEl) {
      padEl.classList.add('is-hit');
      setTimeout(() => padEl.classList.remove('is-hit'), 220);
    }
  } catch (error) {
    log(`Envoi de note impossible : ${error.message}`, 'error');
  }
}

function updateDeviceBadge() {
  const output = state.midi.getSelectedOutput();
  if (output) {
    el.deviceBadge.textContent = output.name || 'MIDI connecté';
    el.deviceBadge.className = 'status-badge status-on';
  } else if (state.midi.access) {
    el.deviceBadge.textContent = 'MIDI autorisé · aucune sortie';
    el.deviceBadge.className = 'status-badge status-warn';
  } else {
    el.deviceBadge.textContent = 'Aucun périphérique MIDI';
    el.deviceBadge.className = 'status-badge status-off';
  }
}

async function upload() {
  try {
    validateBeforeExport();
    const simulation = el.simulationMode.checked;
    if (!simulation && !state.midi.getSelectedOutput()) throw new Error('Sélectionne d’abord une sortie MIDI.');

    // Garde-fou : en envoi réel, on n'accepte que les slots USER (700–899).
    const outsideUser = simulation ? [] : state.samples.filter(s => !(s.slot >= 700 && s.slot <= 899));
    if (outsideUser.length) {
      throw new Error(`Envoi réel limité aux banques USER (700–899) pour ce premier test. ${outsideUser.length} sample(s) hors de cette plage — mets-les sur des slots USER, ou reste en simulation.`);
    }

    const confirmed = await confirmAction(
      simulation ? 'Lancer la simulation ?' : '⚠️ ÉCRITURE RÉELLE sur l’EP-133 ?',
      simulation
        ? `${state.samples.length} sample(s) seront simulés, sans aucune écriture.`
        : `${state.samples.length} sample(s) vont être ÉCRITS sur ta machine (slots USER 700–899). Cette action remplace le contenu de ces slots et n’est pas annulable. Vérifie que ce sont des slots sacrifiables.`
    );
    if (!confirmed) return;

    const transport = new Ep133Transport(state.midi, {
      simulation,
      unlockWrite: !simulation, // armé uniquement pour un envoi réel confirmé
      allowAllBanks: false,     // slots USER uniquement
      logger: message => log(message)
    });
    el.uploadBtn.disabled = true;

    // Conversion préalable des fichiers WAV en PCM brut (mono, 46875 Hz) pour le matériel
    const convertedSamples = [];
    if (!simulation) {
      log('Préparation et conversion des fichiers audio en PCM brut (46875 Hz, 16-bit mono)…');
      for (const sample of state.samples) {
        log(`Conversion : ${sample.name}…`);
        try {
          const rawBlob = await convertWavToRawPcm(sample.file, {
            targetSampleRate: EP133_TARGET_SAMPLE_RATE,
            mono: true,
            normalize: el.normalizeAudio.checked,
            trimSilence: el.trimSilence.checked
          });
          convertedSamples.push({
            ...sample,
            audioBlob: rawBlob
          });
        } catch (err) {
          throw new Error(`Erreur lors de la conversion de ${sample.name} : ${err.message}`);
        }
      }
    } else {
      convertedSamples.push(...state.samples);
    }

    await transport.uploadBatch(convertedSamples, ({ index, total, sample }) => {
      el.uploadBtn.textContent = `${index}/${total} · ${String(sample.slot).padStart(3, '0')}`;
    });
  } catch (error) {
    if (error instanceof ProtocolNotImplementedError) {
      log(error.message, 'warn');
    } else {
      log(error.message, 'error');
    }
  } finally {
    el.uploadBtn.disabled = false;
    el.uploadBtn.textContent = 'Envoyer vers l’EP-133';
  }
}

function confirmAction(title, message) {
  if (!el.confirmDialog?.showModal) return Promise.resolve(window.confirm(message));
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  el.confirmDialog.showModal();
  return new Promise(resolve => {
    el.confirmDialog.addEventListener('close', () => resolve(el.confirmDialog.returnValue === 'confirm'), { once: true });
  });
}

function bindEvents() {
  el.wavFileInput.addEventListener('change', event => addWavFiles(event.target.files));
  el.folderInput.addEventListener('change', event => addWavFiles(event.target.files));
  el.epackInput.addEventListener('change', event => event.target.files[0] && importEpack(event.target.files[0]));
  el.pakInput.addEventListener('change', event => event.target.files[0] && importPak(event.target.files[0]));

  el.projectSelect.addEventListener('change', event => {
    state.deviceProject = event.target.value;
    renderProjectPads();
    renderLivePads();
  });
  el.deviceSearch.addEventListener('input', event => {
    state.deviceSearch = event.target.value;
    renderDeviceSounds();
  });
  el.midiChannel.addEventListener('change', event => {
    state.midiChannel = Number(event.target.value) || 0;
  });
  el.projectPads.addEventListener('click', event => {
    const pad = event.target.closest('.dpad.is-filled[data-slot]');
    if (!pad) return;
    const sound = state.device?.soundBySlot.get(Number(pad.dataset.slot));
    if (sound) previewDeviceSound(sound);
  });

  el.livePads.addEventListener('click', event => {
    const pad = event.target.closest('.dpad[data-note]');
    if (!pad) return;
    if (!state.midi.getSelectedOutput()) {
      log('Sélectionne d’abord la sortie MIDI de l’EP-133 pour jouer les pads.', 'warn');
      return;
    }
    triggerNoteOnDevice(Number(pad.dataset.note), pad);
  });
  el.deviceSounds.addEventListener('click', event => {
    const row = event.target.closest('.dsound[data-slot]');
    if (!row) return;
    const sound = state.device?.soundBySlot.get(Number(row.dataset.slot));
    if (!sound) return;
    const button = event.target.closest('button[data-action]');
    if (button?.dataset.action === 'explain') {
      explainDeviceSoundPlayback(sound);
      return;
    }
    if (button?.dataset.action === 'play' || deviceSoundAudioStatus(sound).playable) {
      previewDeviceSound(sound);
      return;
    }
    explainDeviceSoundPlayback(sound);
  });
  el.deviceSounds.addEventListener('dragstart', event => {
    const row = event.target.closest('.dsound[data-slot]');
    if (!row) return;
    startDeviceSlotDrag(event, Number(row.dataset.slot));
  });
  el.deviceSounds.addEventListener('dragover', event => {
    const row = event.target.closest('.dsound[data-slot]');
    if (!row || !isDeviceSlotDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    clearDropHovers();
    row.classList.add('is-drop-hover');
  });
  el.deviceSounds.addEventListener('drop', event => {
    const row = event.target.closest('.dsound[data-slot]');
    if (!row) return;
    acceptDeviceSlotDrop(event, Number(row.dataset.slot));
  });
  el.deviceSounds.addEventListener('dragleave', event => {
    if (!el.deviceSounds.contains(event.relatedTarget)) clearDropHovers();
  });
  el.deviceSounds.addEventListener('dragend', () => {
    state.draggingDeviceSlot = null;
    clearSlotDropState();
    renderDeviceSounds();
    renderPads();
  });

  for (const eventName of ['dragenter', 'dragover']) {
    el.dropZone.addEventListener(eventName, event => {
      event.preventDefault();
      el.dropZone.classList.add('dragover');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    el.dropZone.addEventListener(eventName, event => {
      event.preventDefault();
      el.dropZone.classList.remove('dragover');
    });
  }
  el.dropZone.addEventListener('drop', event => {
    const files = [...event.dataTransfer.files];
    const epack = files.find(file => /\.epack$/i.test(file.name));
    if (epack) importEpack(epack);
    const wavs = files.filter(file => /\.wav$/i.test(file.name));
    if (wavs.length) addWavFiles(wavs);
  });

  el.applyOccupiedBtn.addEventListener('click', applyOccupiedSlots);
  el.loadDemoOccupiedBtn.addEventListener('click', () => {
    el.occupiedSlots.value = '1-16, 100-112, 200-228, 400-405';
    applyOccupiedSlots();
  });
  el.reallocateBtn.addEventListener('click', reallocate);
  for (const control of [el.strictMode, el.fallbackUserBanks, el.preferFilenameSlot]) {
    control.addEventListener('change', reallocate);
  }
  el.blockDeviceSlots.addEventListener('change', event => {
    state.useDeviceOccupied = event.target.checked;
    reallocate();
  });

  el.sampleTableBody.addEventListener('change', event => {
    const row = event.target.closest('tr[data-id]');
    if (!row) return;
    const sample = state.samples.find(item => item.id === row.dataset.id);
    if (!sample) return;
    const field = event.target.dataset.field;
    if (field === 'category') {
      sample.category = event.target.value;
      sample.confidence = 'high';
      reallocate();
    } else if (field === 'slot') {
      const value = Number(event.target.value);
      sample.slot = Number.isInteger(value) ? value : null;
      sample.effectiveCategory = sample.category;
      sample.allocationStatus = el.strictMode.checked && !isSlotInsideBank(sample.slot, sample.category) ? 'error' : 'ok';
      render();
    } else if (field === 'name') {
      sample.name = sanitizeName(event.target.value);
      render();
    }
  });

  el.sampleTableBody.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    const row = event.target.closest('tr[data-id]');
    if (!button || !row) return;
    const index = state.samples.findIndex(item => item.id === row.dataset.id);
    if (index < 0) return;
    const sample = state.samples[index];
    if (button.dataset.action === 'remove') {
      state.samples.splice(index, 1);
      reallocate();
    }
    if (button.dataset.action === 'play') {
      previewSample(sample);
    }
  });

  el.padBankTabs.addEventListener('click', event => {
    const tab = event.target.closest('button[data-bank]');
    if (!tab) return;
    state.padBank = tab.dataset.bank;
    renderPads();
  });

  el.padGrid.addEventListener('click', event => {
    const pad = event.target.closest('.pad.is-planned[data-id]');
    if (!pad) return;
    const sample = state.samples.find(item => item.id === pad.dataset.id);
    if (sample) previewSample(sample);
  });
  el.padGrid.addEventListener('dragstart', event => {
    const pad = event.target.closest('.pad.is-occupied[data-slot]');
    if (!pad) return;
    startDeviceSlotDrag(event, Number(pad.dataset.slot));
  });
  el.padGrid.addEventListener('dragover', event => {
    const pad = event.target.closest('.pad[data-slot]');
    if (!pad || !isDeviceSlotDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    clearDropHovers();
    pad.classList.add('is-drop-hover');
  });
  el.padGrid.addEventListener('drop', event => {
    const pad = event.target.closest('.pad[data-slot]');
    if (!pad) return;
    acceptDeviceSlotDrop(event, Number(pad.dataset.slot));
  });
  el.padGrid.addEventListener('dragleave', event => {
    if (!el.padGrid.contains(event.relatedTarget)) clearDropHovers();
  });
  el.padGrid.addEventListener('dragend', () => {
    state.draggingDeviceSlot = null;
    clearSlotDropState();
    renderDeviceSounds();
    renderPads();
  });

  state.audio.addEventListener('ended', () => {
    state.playingSampleId = null;
    state.playingDeviceSlot = null;
    renderPads();
    if (state.device) renderDevice();
  });

  el.clearBtn.addEventListener('click', async () => {
    if (!state.samples.length) return;
    if (await confirmAction('Vider le plan ?', 'Tous les samples chargés seront retirés.')) {
      stopAudio();
      state.samples = [];
      render();
      log('Plan vidé.');
    }
  });

  el.exportCsvBtn.addEventListener('click', exportCsv);
  el.exportJsonBtn.addEventListener('click', exportJson);
  el.exportPackBtn.addEventListener('click', exportPack);
  el.exportHandoffBtn.addEventListener('click', exportHandoff);
  el.exportSysexBtn.addEventListener('click', exportSysex);
  el.uploadBtn.addEventListener('click', upload);
  el.saveLocalStateBtn.addEventListener('click', saveLocalState);
  el.applyDeviceChangesBtn.addEventListener('click', applyDeviceChanges);
  el.connectMidiBtn.addEventListener('click', connectMidi);
  el.testDeviceBtn.addEventListener('click', testDevice);
  el.scanDeviceBtn.addEventListener('click', scanDevice);
  el.midiOutputSelect.addEventListener('change', event => {
    state.midi.selectOutput(event.target.value);
    updateDeviceBadge();
    renderLivePads();
    renderDevice();
  });
  state.midi.addEventListener('change', () => {
    populateMidiOutputs();
    updateDeviceBadge();
    renderLivePads();
    renderDevice();
  });
  state.midi.addEventListener('identity', event => renderDeviceIdentity(event.detail));
  state.midi.addEventListener('activity', event => showMidiActivity(event.detail));

  el.memoryCapacity.addEventListener('change', event => {
    state.memoryKey = event.target.value;
    renderMemory();
    if (state.device) renderDevice();
  });
  for (const control of [el.convertOnExport, el.convertMono, el.targetSampleRate]) {
    control.addEventListener('change', renderMemory);
  }
  el.clearLogBtn.addEventListener('click', () => { el.logOutput.textContent = 'Prêt.'; });
}

function populateMemoryOptions() {
  el.memoryCapacity.innerHTML = EP133_MEMORY_OPTIONS
    .map(option => `<option value="${option.key}">${option.label}</option>`)
    .join('');
  el.memoryCapacity.value = state.memoryKey;
}

function populateChannelOptions() {
  el.midiChannel.innerHTML = Array.from({ length: 16 }, (_, i) =>
    `<option value="${i}">${i + 1}</option>`).join('');
  el.midiChannel.value = String(state.midiChannel);
}

async function init() {
  bindEvents();
  populateMemoryOptions();
  populateChannelOptions();

  // Restaure l'appareil de la dernière session (slots occupés + mémoire), sans l'audio.
  const restored = restoreDevice();
  if (restored) {
    applyDevice(restored);
    const when = restored.savedAt ? new Date(restored.savedAt).toLocaleDateString('fr-FR') : '';
    log(`Appareil restauré depuis ${restored.filename ?? 'la dernière session'}${when ? ` (${when})` : ''} : ${restored.sounds.length} son(s), ${restored.deviceOccupied?.size ?? state.deviceOccupied.size} slot(s) occupé(s) pris en compte. Réimporte le .pak pour écouter les sons.`);
  }
  render();
  renderDevice();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./service-worker.js').catch(error => log(`PWA non enregistrée : ${error.message}`, 'warn'));
  }
  if (!state.midi.supported) log('Web MIDI absent : Chrome ou Edge est recommandé pour la connexion au matériel.', 'warn');
  log('Application initialisée. Le rangement strict 001–999 est actif.');
}

init();

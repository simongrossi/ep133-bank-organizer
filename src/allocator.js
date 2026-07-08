import { BANKS, BANK_BY_KEY } from './config.js';

export function parseOccupiedSlots(text) {
  const occupied = new Set();
  const invalid = [];
  const tokens = String(text ?? '').split(/[;,\s]+/).map(token => token.trim()).filter(Boolean);

  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d{1,3})-(\d{1,3})$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start < 1 || end > 999 || start > end) {
        invalid.push(token);
        continue;
      }
      for (let slot = start; slot <= end; slot += 1) occupied.add(slot);
      continue;
    }

    if (/^\d{1,3}$/.test(token)) {
      const slot = Number(token);
      if (slot >= 1 && slot <= 999) occupied.add(slot);
      else invalid.push(token);
      continue;
    }

    invalid.push(token);
  }

  return { occupied, invalid };
}

export function getBankForSlot(slot) {
  return BANKS.find(bank => slot >= bank.start && slot <= bank.end) ?? null;
}

export function isSlotInsideBank(slot, bankKey) {
  const bank = BANK_BY_KEY[bankKey];
  return Boolean(bank && slot >= bank.start && slot <= bank.end);
}

function firstFreeInBank(bank, used) {
  for (let slot = bank.start; slot <= bank.end; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  return null;
}

function firstFreeFallback(used) {
  for (const bankKey of ['USER1', 'USER2']) {
    const slot = firstFreeInBank(BANK_BY_KEY[bankKey], used);
    if (slot != null) return { slot, bankKey };
  }
  return null;
}

export function allocateSamples(samples, options = {}) {
  const {
    occupied = new Set(),
    strict = true,
    fallbackUserBanks = false,
    preferFilenameSlot = true
  } = options;

  const used = new Set(occupied);
  const result = [];

  for (const sample of samples) {
    const bank = BANK_BY_KEY[sample.category] ?? BANK_BY_KEY.USER1;
    let slot = null;
    let status = 'ok';
    let message = '';
    let effectiveCategory = bank.key;

    const preferred = Number(sample.preferredSlot);
    if (
      preferFilenameSlot &&
      Number.isInteger(preferred) &&
      preferred >= 1 && preferred <= 999 &&
      !used.has(preferred) &&
      (!strict || isSlotInsideBank(preferred, bank.key))
    ) {
      slot = preferred;
    }

    if (slot == null) slot = firstFreeInBank(bank, used);

    if (slot == null && fallbackUserBanks && !['USER1', 'USER2'].includes(bank.key)) {
      const fallback = firstFreeFallback(used);
      if (fallback) {
        slot = fallback.slot;
        effectiveCategory = fallback.bankKey;
        status = 'warn';
        message = `Banque ${bank.label} pleine : bascule vers ${BANK_BY_KEY[fallback.bankKey].label}.`;
      }
    }

    if (slot == null) {
      status = 'error';
      message = `Aucun slot libre dans ${bank.label}.`;
    } else {
      used.add(slot);
    }

    result.push({
      ...sample,
      slot,
      effectiveCategory,
      allocationStatus: status,
      allocationMessage: message
    });
  }

  return result;
}

export function validatePlan(samples, occupied = new Set(), strict = true) {
  const errors = [];
  const seen = new Map();

  for (const sample of samples) {
    if (!Number.isInteger(sample.slot) || sample.slot < 1 || sample.slot > 999) {
      errors.push({ id: sample.id, message: 'Slot invalide ou non attribué.' });
      continue;
    }
    if (occupied.has(sample.slot)) errors.push({ id: sample.id, message: `Le slot ${sample.slot} est déjà occupé.` });
    if (seen.has(sample.slot)) errors.push({ id: sample.id, message: `Le slot ${sample.slot} est utilisé plusieurs fois.` });
    seen.set(sample.slot, sample.id);
    const expectedBank = sample.effectiveCategory ?? sample.category;
    if (strict && !isSlotInsideBank(sample.slot, expectedBank)) {
      errors.push({ id: sample.id, message: `Le slot ${sample.slot} ne respecte pas la banque ${expectedBank}.` });
    }
  }

  return errors;
}

export function summarizeBanks(samples, occupied = new Set()) {
  return BANKS.map(bank => {
    const planned = samples.filter(sample => Number(sample.slot) >= bank.start && Number(sample.slot) <= bank.end).length;
    const occupiedCount = [...occupied].filter(slot => slot >= bank.start && slot <= bank.end).length;
    const capacity = bank.end - bank.start + 1;
    return { ...bank, planned, occupied: occupiedCount, capacity, freeAfterPlan: Math.max(0, capacity - occupiedCount - planned) };
  });
}

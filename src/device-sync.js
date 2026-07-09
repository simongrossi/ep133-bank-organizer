export const SAFE_WRITE_RANGE = { start: 700, end: 899 };

export function isSafeWriteSlot(slot) {
  return Number.isInteger(slot) && slot >= SAFE_WRITE_RANGE.start && slot <= SAFE_WRITE_RANGE.end;
}

export function analyzeDeviceChangeReadiness(changes = []) {
  const pending = changes.filter(change => change && Number.isInteger(change.fromSlot) && Number.isInteger(change.toSlot));
  const missingAudio = pending.filter(change => !change.hasAudio);
  const targetOutsideUser = pending.filter(change => !isSafeWriteSlot(change.toSlot));
  const deleteOutsideUser = pending.filter(change => !change.swapped && !isSafeWriteSlot(change.fromSlot));

  return {
    pending,
    count: pending.length,
    missingAudio,
    targetOutsideUser,
    deleteOutsideUser,
    exactWritable: Boolean(pending.length) && !missingAudio.length && !targetOutsideUser.length && !deleteOutsideUser.length
  };
}

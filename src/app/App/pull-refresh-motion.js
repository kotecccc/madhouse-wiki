export const PULL_THRESHOLD = 85;
const PULL_LIMIT = 120;
const TOUCH_IGNORE = 12;
const WHEEL_STEP_LIMIT = 45;
export const WHEEL_MIN_EVENTS = 4;

export function resistedPull(distance) {
  const extra = Math.max(0, distance - TOUCH_IGNORE);
  return PULL_LIMIT * (1 - Math.exp(-extra / 180));
}

export function accumulateWheel(distance, delta, mode, pageHeight) {
  const unit = mode === 1 ? 16 : mode === 2 ? pageHeight : 1;
  return distance + Math.min(WHEEL_STEP_LIMIT, Math.max(0, -delta * unit));
}

export function beginWheelSequence(sequence, atTop) {
  return sequence ?? { eligible: atTop, triggered: false };
}

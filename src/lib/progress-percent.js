export function progressPercent(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null;
  return Math.floor((Math.min(max, Math.max(0, value)) / max) * 100);
}

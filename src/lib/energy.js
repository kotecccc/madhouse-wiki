export function calculateCycleEnergy(cost, count) {
  if (
    !Number.isFinite(cost) ||
    cost < 0 ||
    !Number.isSafeInteger(count) ||
    count < 0
  )
    return null;
  const total = cost * count;
  return Number.isFinite(total) ? { total, count, cost } : null;
}

export function calculateRecovery(energy, limit) {
  if (![energy, limit].every((value) => Number.isFinite(value) && value >= 0))
    return null;
  const remaining = Math.max(0, energy - limit);
  return {
    remaining,
    minutes: remaining * 2,
    largeRefills: Math.ceil(remaining / 280),
    smallRefills: Math.ceil(remaining / 28),
  };
}

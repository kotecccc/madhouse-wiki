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

export function calculateRequirementEnergy(
  totalEnergy,
  maxEnergy,
  currentEnergy,
) {
  if (
    ![totalEnergy, maxEnergy, currentEnergy].every(
      (value) => Number.isFinite(value) && value >= 0,
    ) ||
    maxEnergy === 0
  )
    return null;

  const availableEnergy = Math.min(currentEnergy, maxEnergy);
  const remaining = Math.max(0, totalEnergy - availableEnergy);
  const smallRefillEnergy = maxEnergy * 0.1;
  const refillUnits = Math.ceil(remaining / smallRefillEnergy);
  const largeRefills = Math.floor(refillUnits / 10);
  const smallRefills = refillUnits % 10;
  const largeOnlyRefills = largeRefills + (smallRefills > 0 ? 1 : 0);
  const mixedCost = largeRefills * 10 + smallRefills * 2;
  const largeOnlyCost = largeOnlyRefills * 10;
  const useLargeOnly = largeOnlyCost < mixedCost;
  const selectedLargeRefills = useLargeOnly ? largeOnlyRefills : largeRefills;
  const selectedSmallRefills = useLargeOnly ? 0 : smallRefills;

  return {
    remaining,
    minutes: remaining * 2,
    maxEnergy,
    currentEnergy: availableEnergy,
    largeRefills: selectedLargeRefills,
    smallRefills: selectedSmallRefills,
    defibrillators: selectedLargeRefills + selectedSmallRefills,
    banknotes: selectedLargeRefills * 10 + selectedSmallRefills * 2,
  };
}

const isNonnegativeSafeInteger = (value) =>
  Number.isSafeInteger(value) && value >= 0;

/** Return the wins still needed for all supplied boss targets, or null if unknown. */
export function remainingBossWins(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return null;

  let maximumRemaining = 0;
  for (const target of targets) {
    if (
      !isNonnegativeSafeInteger(target?.required) ||
      !isNonnegativeSafeInteger(target?.current)
    ) {
      return null;
    }
    maximumRemaining = Math.max(
      maximumRemaining,
      Math.max(0, target.required - target.current),
    );
  }

  return maximumRemaining;
}

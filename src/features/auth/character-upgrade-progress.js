// A run may arrive after reconnection with already confirmed steps.
export function hasNewCharacterUpgradeProgress(previous, current) {
  if (
    !current ||
    typeof current.id !== "string" ||
    !Number.isSafeInteger(current.completed) ||
    current.completed < 0
  )
    return false;
  if (!previous || previous.id !== current.id) return current.completed > 0;
  return (
    Number.isSafeInteger(previous.completed) &&
    current.completed > previous.completed
  );
}

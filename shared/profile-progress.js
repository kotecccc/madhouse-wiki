// Refresh only progress metadata for an already authenticated game account.
// Optional Telegram restoration must never replace/clear its existing JWT.
export function projectLevelProgress(value) {
  if (
    !Number.isSafeInteger(value?.playerLevel) ||
    value.playerLevel < 1 ||
    !Number.isSafeInteger(value?.currentExp) ||
    value.currentExp < 0 ||
    !Number.isSafeInteger(value?.expToNextLevel) ||
    value.expToNextLevel < 1
  )
    return null;
  return {
    playerLevel: value.playerLevel,
    currentExp: value.currentExp,
    expToNextLevel: value.expToNextLevel,
  };
}

export async function refreshRetainedProfileProgress({
  telegramId,
  request,
  isCurrent,
  apply,
}) {
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) return false;
  try {
    const result = await request(String(telegramId));
    const progress =
      result?.status === "connected" && projectLevelProgress(result);
    if (!progress || !isCurrent()) return false;
    apply(progress);
    return true;
  } catch {
    return false;
  }
}

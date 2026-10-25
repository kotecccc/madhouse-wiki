export function bossLevelStatus(boss, playerLevel) {
  if (!Number.isSafeInteger(playerLevel) || playerLevel < 1) return null;
  if (
    Number.isSafeInteger(boss.requiredLevel) &&
    playerLevel < boss.requiredLevel
  )
    return { kind: "underlevel", level: boss.requiredLevel };
  if (
    Number.isSafeInteger(boss.rewardUntilLevel) &&
    playerLevel > boss.rewardUntilLevel
  )
    return { kind: "overlevel", level: boss.rewardUntilLevel };
  return null;
}

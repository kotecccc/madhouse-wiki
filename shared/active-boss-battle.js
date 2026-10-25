// Keep only the active fight reference needed by the UI, in account memory.
export function normalizeActiveBossBattle(value) {
  if (
    !value ||
    typeof value.battleId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value.battleId) ||
    !["number", "string"].includes(typeof value.bossId) ||
    !Number.isSafeInteger(Number(value.bossId)) ||
    Number(value.bossId) <= 0
  )
    return null;
  return {
    battleId: value.battleId,
    bossId: Number(value.bossId),
    expiresAtUtc: Number.isFinite(Date.parse(value.expiresAtUtc))
      ? value.expiresAtUtc
      : null,
    remainingSeconds:
      typeof value.remainingSeconds === "number" &&
      Number.isFinite(value.remainingSeconds) &&
      value.remainingSeconds >= 0
        ? value.remainingSeconds
        : null,
  };
}

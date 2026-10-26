const WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_OBSERVATIONS = 500;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const identifier = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value);

// Store only the fields needed to identify a distinct leader/boss battle.
export function observeRaids(previous, invitations, now) {
  const records = new Map();
  for (const item of Array.isArray(previous) ? previous : []) {
    if (
      positive(item?.leaderPlayerId) &&
      positive(item?.bossId) &&
      identifier(item?.battleId) &&
      Number.isFinite(item.seenAt) &&
      item.seenAt <= now &&
      item.seenAt > now - WINDOW_MS
    )
      records.set(`${item.leaderPlayerId}:${item.bossId}:${item.battleId}`, {
        leaderPlayerId: item.leaderPlayerId,
        bossId: item.bossId,
        battleId: item.battleId,
        seenAt: item.seenAt,
      });
  }
  for (const item of invitations) {
    if (
      !item.available ||
      !Number.isFinite(item.expiresAt) ||
      item.expiresAt <= now ||
      !positive(item.leaderPlayerId) ||
      !positive(item.bossId) ||
      !identifier(item.battleId)
    )
      continue;
    const key = `${item.leaderPlayerId}:${item.bossId}:${item.battleId}`;
    if (!records.has(key))
      records.set(key, {
        leaderPlayerId: item.leaderPlayerId,
        bossId: item.bossId,
        battleId: item.battleId,
        seenAt: now,
      });
  }
  return [...records.values()]
    .sort((a, b) => a.seenAt - b.seenAt)
    .slice(-MAX_OBSERVATIONS);
}

export function detectedRaids(observations, invitations, now) {
  const records = observeRaids(observations, [], now);
  const counts = new Map();
  for (const item of records) {
    const key = `${item.leaderPlayerId}:${item.bossId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const detected = new Map();
  for (const item of invitations) {
    const key = `${item.leaderPlayerId}:${item.bossId}`;
    if (
      item.available &&
      Number.isFinite(item.expiresAt) &&
      item.expiresAt > now &&
      counts.get(key) >= 3
    )
      detected.set(key, {
        leaderPlayerId: item.leaderPlayerId,
        bossId: item.bossId,
        bossName: item.bossName,
        sender: item.sender,
        ...(item.leaderUsername ? { leaderUsername: item.leaderUsername } : {}),
        count: counts.get(key),
      });
  }
  return [...detected.values()];
}

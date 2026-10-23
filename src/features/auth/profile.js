// Identity stays in page memory. The fallback route matches the game client's
// awl/awk avatar loader, keyed by the player ID returned from /api/me.
export function profileAvatarUrl(profile) {
  for (const value of [profile.avatarUrl, profile.photoUrl]) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const url = new URL(value.trim());
      if (url.protocol === "https:") return url.href;
    } catch {
      /* Ignore an unavailable or invalid photo URL. */
    }
  }
  const id = String(profile.playerId ?? "");
  return /^[1-9]\d*$/.test(id)
    ? `https://cdn.cargohustle.online/avatarPlayers/${id}.webp`
    : null;
}

export function normalizePlayerProfile(data) {
  const text = (value) =>
    typeof value === "string" ? value.trim().slice(0, 80) : "";
  const playerLevel = data?.exp?.level;
  return {
    playerId: data.playerId,
    playerLevel:
      Number.isSafeInteger(playerLevel) && playerLevel > 0 ? playerLevel : null,
    name:
      text(data.nickname) ||
      text(data.firstName) ||
      text(data.username) ||
      "Игрок",
    username: text(data.username).replace(/^@/, ""),
    avatarUrl: profileAvatarUrl(data),
    stats: [
      [
        "Безумие",
        data.characterStats?.madness?.total,
        data.characterStats?.maxHealth,
        "HP",
      ],
      [
        "Агрессия",
        data.characterStats?.aggression?.total,
        data.characterStats?.baseDamage,
        "урон",
      ],
      [
        "Ярость",
        data.characterStats?.rage?.total,
        data.characterStats?.critChancePercent,
        "% шанс крита",
      ],
    ].filter(([, value]) => Number.isFinite(value)),
    wallet: [
      ["Монеты", data.wallet?.gold, "coin"],
      ["Пилюли", data.wallet?.pills, "pill"],
      ["Доллары", data.wallet?.dollar, "banknote"],
    ].filter(([, value]) => Number.isFinite(value)),
    energy: {
      current: data.energy?.current,
      max: data.energy?.max,
      secondsToNext: data.energy?.secondsToNext,
      regenIntervalSeconds: data.energy?.regenIntervalSeconds,
      nextEnergyAtUtc: data.energy?.nextEnergyAtUtc,
      snapshotAtMs: Date.now(),
    },
    experience: {
      current: data.exp?.currentExp,
      toNextLevel: data.exp?.expToNextLevel,
    },
  };
}

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

const profileStatKeys = {
  Безумие: "madness",
  Агрессия: "aggression",
  Ярость: "rage",
};

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeImageUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

// The game client reads activeStashBuffs (and legacy activeStashBuff) from
// /api/me/bag. Its alq normalizer exposes these fields for the stash plaque.
export function normalizeActiveStashBuffs(bag) {
  const value = bag?.activeStashBuffs ?? bag?.activeStashBuff;
  const source = Array.isArray(value) ? value : value ? [value] : [];

  return source.flatMap((buff) => {
    if (!buff || typeof buff !== "object") return [];
    const setId = Number(buff.setId);
    const name =
      typeof (buff.name ?? buff.title) === "string"
        ? (buff.name ?? buff.title).trim().slice(0, 160)
        : "";
    const expiresAtUtc =
      typeof buff.expiresAtUtc === "string" ? buff.expiresAtUtc.trim() : "";
    const expiresAtMs = Date.parse(expiresAtUtc);
    if (!Number.isSafeInteger(setId) || setId <= 0 || !name) return [];
    if (!Number.isFinite(expiresAtMs)) return [];

    const normalized = {
      setId,
      name,
      expiresAtUtc,
      expiresAtMs,
      previewImageUrl: safeImageUrl(buff.previewImageUrl),
    };
    for (const statKey of Object.values(profileStatKeys)) {
      const amount = Number(buff[statKey]);
      normalized[statKey] =
        Number.isFinite(amount) && Number.isInteger(amount) && amount >= 0
          ? amount
          : 0;
    }
    return [normalized];
  });
}

export function getProfileStatDisplay(profile, name, total, now = Date.now()) {
  const numericTotal = finiteOrNull(total);
  if (numericTotal === null) return { value: total, temporary: 0 };
  const key = profileStatKeys[name];
  const breakdown = key ? profile?.statBreakdown?.[name] : null;
  if (
    !breakdown ||
    ![breakdown.base, breakdown.bonus, breakdown.total].every(
      Number.isFinite,
    ) ||
    breakdown.total !== numericTotal ||
    breakdown.total !== breakdown.base + breakdown.bonus
  )
    return { value: total, temporary: 0 };

  const temporary = (profile.stashBuffs || []).reduce((sum, buff) => {
    if (!Number.isFinite(buff.expiresAtMs) || buff.expiresAtMs <= now)
      return sum;
    return sum + buff[key];
  }, 0);
  if (
    !Number.isFinite(temporary) ||
    breakdown.bonus < temporary ||
    breakdown.total < temporary
  )
    return { value: total, temporary: 0 };
  return { value: numericTotal - temporary, temporary };
}

export function normalizePlayerProfile(data, bag) {
  const text = (value) =>
    typeof value === "string" ? value.trim().slice(0, 80) : "";
  const playerLevel = data?.exp?.level;
  const statBreakdown = Object.fromEntries(
    Object.entries(profileStatKeys).map(([name, statKey]) => {
      const stat = data.characterStats?.[statKey];
      return [
        name,
        {
          statKey,
          base: finiteOrNull(stat?.base),
          bonus: finiteOrNull(stat?.bonus),
          total: finiteOrNull(stat?.total),
        },
      ];
    }),
  );
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
    statBreakdown,
    stashBuffs: normalizeActiveStashBuffs(bag),
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

// Partial /me responses must not erase confirmed progress for the same player.
export function retainProfileProgress(profile, previous) {
  if (!profile.playerId || profile.playerId !== previous?.playerId)
    return profile;
  return {
    ...profile,
    playerLevel: profile.playerLevel ?? previous.playerLevel,
    experience:
      profile.playerLevel != null &&
      previous.playerLevel != null &&
      profile.playerLevel !== previous.playerLevel
        ? profile.experience
        : {
            current: profile.experience.current ?? previous.experience.current,
            toNextLevel:
              profile.experience.toNextLevel ?? previous.experience.toNextLevel,
          },
  };
}

export function applyWorkFarmEnergy(profile, view) {
  const energy = view?.energy;
  if (
    !profile ||
    !Number.isFinite(view?.updatedAt) ||
    view.updatedAt <= (profile.energy?.snapshotAtMs ?? 0) ||
    !Number.isFinite(energy?.current) ||
    !Number.isFinite(energy?.max) ||
    energy.current < 0 ||
    energy.max <= 0 ||
    energy.current > energy.max
  )
    return profile;
  return {
    ...profile,
    energy: { ...energy, snapshotAtMs: view.updatedAt },
  };
}

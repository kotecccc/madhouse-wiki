// /api/me does not currently include experience. Read the authenticated
// account's own public profile for its current level; never select a caller ID.
export function createPlayerProgressReader({ fetcher = fetch } = {}) {
  return async (profile, authorization) => {
    if (!Number.isSafeInteger(profile?.playerId) || profile.playerId <= 0)
      return profile;
    if (Number.isSafeInteger(profile.exp?.level) && profile.exp.level > 0)
      return profile;
    try {
      const response = await fetcher(
        `https://cargohustle.online/api/players/${profile.playerId}`,
        {
          headers: { Authorization: authorization, Accept: "application/json" },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!response.ok) return profile;
      const own = await response.json();
      if (
        own.playerId !== profile.playerId ||
        !Number.isSafeInteger(own.level) ||
        own.level < 1
      )
        return profile;
      // This response confirms level only. Never invent within-level XP from
      // leaderboard scores or historical notification payloads.
      return { ...profile, exp: { level: own.level } };
    } catch {
      return profile;
    }
  };
}
